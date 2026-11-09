const express = require('express');
const crypto = require('crypto');
const { protect } = require('../middleware/auth');
const Transaction = require('../models/Transaction');
const Subscription = require('../models/Subscription');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { sendPushToUser } = require('../utils/push');
const { isConfigured: payuConfigured, buildCheckoutParams, verifyPayment, revokeMandate } = require('../utils/payu');
const { isLocked } = require('../utils/paywall');

const router = express.Router();

// ---------------------------------------------------------------------------
// NEW PLAN (credit based):
//   Rs1  now                      -> 20 uploads (no diamonds)
//   upload credits reach 0        -> notice -> 24h later Rs10 auto-debit
//                                 -> 30 uploads + 99 diamonds, valid 1 month from the day credits ran out
// Only ONE Rs10 debit per paid month (PayU mandate rule + user safety). If the 30 uploads end mid-month the
// user continues with diamonds; the next Rs10 notice goes out when that month is over.
// Set SUBSCRIPTION_ALLOW_EARLY_REDEBIT=true to allow a new Rs10 debit immediately when credits end mid-month.
// ---------------------------------------------------------------------------
const PLAN = {
  tier: 1,
  diamonds: 99,            // given with every Rs10 debit
  thumbnailPrompts: 1,
  seoScoreLevel: 'basic',
  competitorLevel: 'none',
  introAmount: 1,
  introUploads: 20,        // given with the Rs1 payment
  planAmount: 10,
  planUploads: 30,         // given with every Rs10 debit
  cycleMonths: 1
};
const ALLOW_EARLY_REDEBIT = String(process.env.SUBSCRIPTION_ALLOW_EARLY_REDEBIT || '') === 'true';
// ADHOC = PayU debits whenever WE ask (credits ended), not on a fixed calendar day. Use 'MONTHLY' to fall back.
const BILLING_CYCLE = String(process.env.SUBSCRIPTION_BILLING_CYCLE || 'ADHOC').toUpperCase();
const MANDATE_YEARS = Number(process.env.SUBSCRIPTION_MANDATE_YEARS || 5);

const addMonths = (d, n) => {
  const x = new Date(d);
  const day = x.getDate();
  x.setMonth(x.getMonth() + n);
  if (x.getDate() < day) x.setDate(0); // 31 Jan + 1 month -> 28/29 Feb
  return x;
};
const ymdIST = (d) => new Date(new Date(d).getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

const isRegistrationTxn = (sub, txn) => !!sub && sub.registrationTxnid === txn.cashfreeOrderId;

// ---- PayU result -> 'PAID' | 'FAILED' | 'PENDING' (amount always cross-checked) ----
const classify = (d, txn) => {
  if (!d) return 'PENDING';
  const st = String(d.status || '').toLowerCase();
  if (st === 'success') {
    const paid = Number(d.amt ?? d.transaction_amount);
    if (!Number.isFinite(paid) || Math.abs(paid - txn.amountINR) > 0.01) {
      console.error(`🚨 [Subscription] AMOUNT MISMATCH txn=${txn.cashfreeOrderId} paid=${paid} expected=${txn.amountINR} — NOT crediting`);
      return 'PENDING';
    }
    return 'PAID';
  }
  if (['failure', 'failed', 'usercancelled', 'bounced', 'dropped'].includes(st)) return 'FAILED';
  return 'PENDING';
};

const notify = async (user, type, title, message, pushBody) => {
  try {
    await Notification.create({ user: user._id, type, title, message });
    await sendPushToUser(user, { title, body: pushBody || message, data: { type } });
  } catch (e) {
    console.error('[Subscription] notify failed:', e.message);
  }
};

// Credits ONCE per payment (atomic pending->approved claim).
//   kind 'intro'   (Rs1)  -> 20 uploads
//   kind 'monthly' (Rs10) -> 30 uploads + 99 diamonds (+ plan features)
const creditPlan = async (txn, source, kind) => {
  const claimed = await Transaction.findOneAndUpdate(
    { _id: txn._id, status: 'pending' },
    { $set: { status: 'approved', reviewedAt: new Date(), adminNote: `Auto-approved via ${source}` } },
    { new: true }
  );
  if (!claimed) return null;

  const user = await User.findById(claimed.user);
  if (!user) return null;

  let update;
  let title;
  let message;
  let push;
  if (kind === 'intro') {
    update = { $inc: { freeUploadsRemaining: PLAN.introUploads } };
    title = 'Payment successful 🎉';
    message = `₹${claimed.amountINR} paid — ${PLAN.introUploads} uploads added to your account.`;
    push = `${PLAN.introUploads} uploads added.`;
  } else {
    update = { $inc: { diamondBalance: PLAN.diamonds, freeUploadsRemaining: PLAN.planUploads } };
    if ((user.activeTier || 0) < PLAN.tier) {
      // never DOWNGRADE a user who already owns a bigger pack
      update.$set = {
        activeTier: PLAN.tier,
        thumbnailPromptsRemaining: PLAN.thumbnailPrompts,
        seoScoreLevel: PLAN.seoScoreLevel,
        competitorLevel: PLAN.competitorLevel
      };
    } else {
      update.$inc.thumbnailPromptsRemaining = PLAN.thumbnailPrompts;
    }
    title = 'Subscription payment successful 🎉';
    message = `₹${claimed.amountINR} paid — ${PLAN.planUploads} uploads and ${PLAN.diamonds} diamonds added for 1 month.`;
    push = `${PLAN.planUploads} uploads + ${PLAN.diamonds} diamonds added.`;
  }
  const updated = await User.findByIdAndUpdate(user._id, update, { new: true });
  await notify(updated, 'payment_approved', title, message, push);
  return { claimed, user: updated };
};

const applyFailed = async (txn) => {
  const rejected = await Transaction.findOneAndUpdate(
    { _id: txn._id, status: 'pending' },
    { $set: { status: 'rejected', adminNote: 'Payment failed at PayU' } },
    { new: true }
  );
  if (!rejected) return;
  const sub = await Subscription.findById(txn.subscription);
  if (!sub) return;

  if (isRegistrationTxn(sub, txn)) {
    await Subscription.updateOne({ _id: sub._id, status: 'pending' }, { $set: { status: 'failed' } });
    return;
  }
  // a monthly autopay debit failed
  const failCount = (sub.failCount || 0) + 1;
  const set = { failCount, lastChargeAttemptAt: new Date(), preDebitSentAt: null, debitOn: null, nextDebitAt: null, cycleAnchor: null };
  if (failCount >= 3) set.status = 'expired';
  await Subscription.updateOne({ _id: sub._id }, { $set: set });
  const user = await User.findById(sub.user);
  if (user) {
    await notify(
      user,
      'payment_failed',
      failCount >= 3 ? 'Subscription ended ❌' : 'Autopay failed ⚠️',
      failCount >= 3
        ? 'We could not collect your ₹10 subscription payment 3 times, so the subscription has ended.'
        : `Your ₹${PLAN.planAmount} autopay failed. We will try again soon — please keep balance in your account.`
    );
  }
};

// Called by /verify, the PayU webhook and the scheduler. Safe to call many times.
const finalizeFromPayu = async (transactionId, source) => {
  const txn = await Transaction.findById(transactionId);
  if (!txn || txn.type !== 'subscription_charge') return { state: 'none' };
  if (txn.status === 'approved') return { state: 'approved' };
  if (txn.status === 'rejected') return { state: 'failed' };

  const d = await verifyPayment(txn.cashfreeOrderId);
  const st = classify(d, txn);
  if (st === 'FAILED') {
    await applyFailed(txn);
    return { state: 'failed' };
  }
  if (st !== 'PAID') return { state: 'pending' };

  const sub = await Subscription.findById(txn.subscription);
  if (!sub) return { state: 'pending' };

  if (isRegistrationTxn(sub, txn)) {
    // Rs1 paid: mandate is registered, 20 uploads given. No fixed debit date - the Rs10 debit
    // happens only after the upload credits reach 0 (see cron/subscriptionScheduler.js).
    await Subscription.findOneAndUpdate(
      { _id: sub._id, status: 'pending' },
      {
        $set: {
          status: 'active',
          authPayuId: String(d.mihpayid || ''),
          firstPaidAt: new Date(),
          currentPeriodEnd: null,
          periodStart: null,
          nextDebitAt: null,
          failCount: 0
        }
      }
    );
    await creditPlan(txn, source, 'intro');
    return { state: 'approved' };
  }

  // Rs10 debit succeeded -> 30 uploads + 99 diamonds; the paid month starts on the day credits ran out.
  const credited = await creditPlan(txn, source, 'monthly');
  if (credited) {
    const anchor = sub.cycleAnchor || new Date();
    await Subscription.updateOne(
      { _id: sub._id },
      {
        $set: {
          periodStart: anchor,
          currentPeriodEnd: addMonths(anchor, PLAN.cycleMonths),
          nextDebitAt: null,
          lastDebitAt: new Date(),
          failCount: 0,
          preDebitSentAt: null,
          debitOn: null,
          cycleAnchor: null,
          creditsZeroSeenAt: null
        }
      }
    );
  }
  return { state: 'approved' };
};

// ---------------------------------------------------------------------------
// GET /api/subscription/status
// ---------------------------------------------------------------------------
router.get('/status', protect, async (req, res) => {
  try {
    const subs = await Subscription.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(10);
    const active = subs.find((s) => s.status === 'active');
    const everPaid = subs.some((s) => !!s.firstPaidAt);
    const shown = active || subs.find((s) => s.status === 'cancelled' && s.currentPeriodEnd && s.currentPeriodEnd > new Date());
    // locked = has not paid anything yet (no Rs1 plan, no diamond pack) -> app locks Upload / Live / channel connect
    const locked = await isLocked(req.user);

    res.json({
      success: true,
      locked,
      offer: {
        introAmount: PLAN.introAmount,
        introUploads: PLAN.introUploads,
        planAmount: PLAN.planAmount,
        planUploads: PLAN.planUploads,
        diamonds: PLAN.diamonds, // diamonds that come with the Rs10 month
        cycle: 'monthly'
      },
      credits: req.user.freeUploadsRemaining || 0,
      // the Rs1 intro is for first-time subscribers only
      eligible: !active && !everPaid && payuConfigured,
      introUsed: everPaid,
      subscription: shown
        ? {
            id: shown._id,
            status: shown.status,
            currentPeriodEnd: shown.currentPeriodEnd,
            // only set while a "your credits are over" notice is pending (the Rs10 debit date)
            nextDebitAt: shown.status === 'active' ? shown.debitOn : null,
            periodStart: shown.periodStart,
            cancelledAt: shown.cancelledAt
          }
        : null
    });
  } catch (err) {
    console.error('❌ [Subscription] status failed:', err.message);
    res.status(500).json({ success: false, message: 'Could not load subscription.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/subscription/start  -> Rs1 order + SI (autopay) details for the PayU SDK
// ---------------------------------------------------------------------------
router.post('/start', protect, async (req, res) => {
  try {
    if (!payuConfigured) return res.status(503).json({ success: false, message: 'Payments are not available right now.', code: 'PAYU_NOT_CONFIGURED' });

    const existing = await Subscription.find({ user: req.user._id });
    if (existing.some((s) => s.status === 'active')) {
      return res.status(409).json({ success: false, message: 'You already have an active subscription.', code: 'ALREADY_SUBSCRIBED' });
    }
    if (existing.some((s) => !!s.firstPaidAt)) {
      return res.status(403).json({
        success: false,
        message: 'The ₹1 intro offer was already used. You can buy a diamond pack from the Subscription page.',
        code: 'INTRO_USED'
      });
    }
    // drop any abandoned pending attempt
    await Subscription.updateMany({ user: req.user._id, status: 'pending' }, { $set: { status: 'failed' } });

    const userIdentifier = String(req.user.userId || req.user._id.toString().slice(-6));
    const txnid = `TS${Date.now()}${crypto.randomBytes(2).toString('hex')}`;

    const sub = await Subscription.create({
      user: req.user._id,
      status: 'pending',
      introAmount: PLAN.introAmount,
      planAmount: PLAN.planAmount,
      registrationTxnid: txnid
    });

    const payu = buildCheckoutParams({
      txnid,
      amount: PLAN.introAmount,
      productinfo: 'TubePilot Subscription',
      user: req.user,
      userIdentifier
    });

    await Transaction.create({
      user: req.user._id,
      userDisplayId: userIdentifier,
      type: 'subscription_charge',
      // (no diamondPackage: the Rs1 payment gives uploads only - an old Transaction schema rejects 0 there)
      uploadsGranted: PLAN.introUploads,
      amountINR: PLAN.introAmount,
      planTier: PLAN.tier,
      thumbnailPrompts: PLAN.thumbnailPrompts,
      seoScoreLevel: PLAN.seoScoreLevel,
      competitorLevel: PLAN.competitorLevel,
      status: 'pending',
      paymentMethod: 'payu',
      cashfreeOrderId: txnid,
      subscription: sub._id
    });

    // The Rs10 debit happens when the upload credits end (can be as early as tomorrow), so the mandate
    // starts tomorrow and runs for MANDATE_YEARS. billingAmount is the MAX PayU may debit.
    const start = new Date(Date.now() + 24 * 3600 * 1000);
    const end = addMonths(start, MANDATE_YEARS * 12);
    const si = {
      isFreeTrial: false,
      billingAmount: PLAN.planAmount.toFixed(2),
      billingInterval: '1',
      billingCycle: BILLING_CYCLE,
      paymentStartDate: ymdIST(start),
      paymentEndDate: ymdIST(end),
      remarks: 'TubePilot subscription',
      billingCurrency: 'INR',
      billingLimit: 'ON',
      billingRule: 'MAX'
    };

    console.log(`💳 [Subscription] start — user ${req.user._id}, txnid=${txnid}, ₹${PLAN.introAmount} now (${PLAN.introUploads} uploads), ₹${PLAN.planAmount} when credits end, mandate from ${si.paymentStartDate}`);
    res.status(201).json({ success: true, orderId: txnid, payu, si });
  } catch (err) {
    console.error('❌ [Subscription] start failed:', err.response?.data || err.stack || err.message);
    // PAYU_DEBUG=1 in the server .env -> the app toast shows the REAL reason (remove it after testing).
    const debug = process.env.PAYU_DEBUG === '1';
    res.status(500).json({
      success: false,
      message: debug ? `Could not start: ${err.message}` : 'Could not start the subscription. Please try again.'
    });
  }
});

// ---------------------------------------------------------------------------
// POST /api/subscription/verify  { orderId }
// ---------------------------------------------------------------------------
router.post('/verify', protect, async (req, res) => {
  try {
    const { orderId } = req.body || {};
    if (!orderId) return res.status(400).json({ success: false, message: 'orderId is required' });
    const txn = await Transaction.findOne({ cashfreeOrderId: orderId, user: req.user._id, type: 'subscription_charge' });
    if (!txn) return res.status(404).json({ success: false, message: 'Transaction not found' });

    const r = await finalizeFromPayu(txn._id, 'PayU verify');
    const message =
      r.state === 'approved' ? 'Subscription started' : r.state === 'failed' ? 'Payment was not completed' : 'Payment not completed yet';
    res.json({ success: true, status: r.state === 'none' ? 'pending' : r.state, message });
  } catch (err) {
    console.error('❌ [Subscription] verify failed:', err.response?.data || err.message);
    res.status(500).json({ success: false, message: 'Could not verify payment. Please check again in a minute.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/subscription/cancel
// Stops all future debits immediately; benefits stay until the paid period ends.
// ---------------------------------------------------------------------------
router.post('/cancel', protect, async (req, res) => {
  try {
    const sub = await Subscription.findOne({ user: req.user._id, status: 'active' });
    if (!sub) return res.status(404).json({ success: false, message: 'No active subscription found.' });

    // Our scheduler never debits a non-active subscription, so money is safe from this line on.
    sub.status = 'cancelled';
    sub.cancelledAt = new Date();
    sub.nextDebitAt = null;
    await sub.save();

    let revoked = false;
    try {
      const r = await revokeMandate({ authPayuId: sub.authPayuId, requestId: `RV${Date.now()}${crypto.randomBytes(2).toString('hex')}` });
      revoked = String(r?.status) === '1';
      if (!revoked) console.warn('[Subscription] mandate_revoke not confirmed:', JSON.stringify(r));
    } catch (e) {
      console.error('[Subscription] mandate_revoke failed:', e.response?.data || e.message);
    }
    if (revoked) await Subscription.updateOne({ _id: sub._id }, { $set: { mandateRevoked: true } });

    await notify(req.user, 'subscription_cancelled', 'Subscription cancelled', 'Autopay is cancelled. You will not be charged again.');
    res.json({ success: true, message: 'Subscription cancelled. You will not be charged again.', mandateRevoked: revoked });
  } catch (err) {
    console.error('❌ [Subscription] cancel failed:', err.message);
    res.status(500).json({ success: false, message: 'Could not cancel. Please try again or contact support.' });
  }
});

router.finalizeFromPayu = finalizeFromPayu;
router.ALLOW_EARLY_REDEBIT = ALLOW_EARLY_REDEBIT;
router.addMonths = addMonths;
router.ymdIST = ymdIST;
router.PLAN = PLAN;
router.notify = notify;
router.classify = classify;
router.applyFailed = applyFailed;
module.exports = router;