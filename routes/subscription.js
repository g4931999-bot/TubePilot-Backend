const express = require('express');
const crypto = require('crypto');
const { protect } = require('../middleware/auth');
const Transaction = require('../models/Transaction');
const Subscription = require('../models/Subscription');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { sendPushToUser } = require('../utils/push');
const { isConfigured: payuConfigured, buildCheckoutParams, verifyPayment, revokeMandate } = require('../utils/payu');

const router = express.Router();

// ---------------------------------------------------------------------------
// The plan = UPLOAD CREDITS only (stored in user.freeUploadsRemaining, the same
// counter the dashboard "Free Uploads  remaining / total" card already shows).
//   Rs1 now          -> +20 uploads
//   credits finish   -> Rs10 auto-debit (24h notice first) -> 20 uploads, new month starts that day
// ---------------------------------------------------------------------------
const PLAN = {
  uploads: Number(process.env.SUBSCRIPTION_UPLOADS || 20),
  introAmount: 1,
  planAmount: 10,
  cycleMonths: 1
};
// PayU billingCycle for the mandate. Debits are triggered by credits running out (not a fixed
// date), so ADHOC fits best. If PayU does not enable ADHOC for your account use MONTHLY.
const BILLING_CYCLE = process.env.SUBSCRIPTION_BILLING_CYCLE || 'ADHOC';
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

// Credits the upload pack ONCE per payment (atomic pending->approved claim).
//  registration (Rs1): +20 uploads on top of whatever the user still has
//  renewal (Rs10)    : top up to at least 20 (never takes credits away)
const creditPlan = async (txn, source, isRenewal) => {
  const claimed = await Transaction.findOneAndUpdate(
    { _id: txn._id, status: 'pending' },
    { $set: { status: 'approved', reviewedAt: new Date(), adminNote: `Auto-approved via ${source}` } },
    { new: true }
  );
  if (!claimed) return null;

  const user = await User.findById(claimed.user);
  if (!user) return null;

  const update = isRenewal
    ? { $max: { freeUploadsRemaining: PLAN.uploads } }
    : { $inc: { freeUploadsRemaining: PLAN.uploads } };
  const updated = await User.findByIdAndUpdate(user._id, update, { new: true });
  await notify(
    updated,
    'payment_approved',
    isRenewal ? 'Autopay successful 🎉' : 'Payment successful 🎉',
    `₹${claimed.amountINR} paid — ${PLAN.uploads} uploads added. You now have ${updated.freeUploadsRemaining} uploads.`,
    `${PLAN.uploads} uploads added to your account.`
  );
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
  const set = { failCount, lastChargeAttemptAt: new Date(), preDebitSentAt: null, debitOn: null };
  if (failCount >= 3) set.status = 'expired';
  await Subscription.updateOne({ _id: sub._id }, { $set: set });
  const user = await User.findById(sub.user);
  if (user) {
    await notify(
      user,
      'payment_failed',
      failCount >= 3 ? 'Subscription ended ❌' : 'Autopay failed ⚠️',
      failCount >= 3
        ? 'We could not collect your ₹10 payment 3 times, so autopay has ended. You can still upload using diamonds.'
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
    const now = new Date();
    // Rs1 phase: no month yet. The month starts on the day the Rs10 is debited.
    await Subscription.findOneAndUpdate(
      { _id: sub._id, status: 'pending' },
      {
        $set: {
          status: 'active',
          authPayuId: String(d.mihpayid || ''),
          firstPaidAt: now,
          currentPeriodEnd: null,
          nextDebitAt: null,
          preDebitSentAt: null,
          debitOn: null,
          failCount: 0
        }
      }
    );
    await creditPlan(txn, source, false);
    return { state: 'approved' };
  }

  // Rs10 autopay debit succeeded -> 20 uploads, and the new month starts TODAY
  // (only the call that wins the credit claim does this)
  const credited = await creditPlan(txn, source, true);
  if (credited) {
    const now = new Date();
    await Subscription.updateOne(
      { _id: sub._id },
      {
        $set: { currentPeriodEnd: addMonths(now, PLAN.cycleMonths), nextDebitAt: null, lastDebitAt: now, failCount: 0, preDebitSentAt: null, debitOn: null },
        $inc: { renewals: 1 }
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
    const shown = active || subs.find((s) => s.status === 'cancelled');

    res.json({
      success: true,
      offer: { introAmount: PLAN.introAmount, planAmount: PLAN.planAmount, uploads: PLAN.uploads, cycle: 'monthly' },
      uploadsLeft: Number(req.user.freeUploadsRemaining || 0),
      // the Rs1 intro is for first-time subscribers only
      eligible: !active && !everPaid && payuConfigured,
      introUsed: everPaid,
      subscription: shown
        ? {
            id: shown._id,
            status: shown.status,
            currentPeriodEnd: shown.currentPeriodEnd,
            // Rs10 is taken when the uploads finish (or the month ends); debitOn is set once the notice is sent
            debitOn: shown.status === 'active' ? shown.debitOn : null,
            renewals: shown.renewals || 0,
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
        message: 'The ₹1 offer was already used. You can buy a diamond pack from the Subscription page.',
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
      uploadCredits: PLAN.uploads,
      amountINR: PLAN.introAmount,
      status: 'pending',
      paymentMethod: 'payu',
      cashfreeOrderId: txnid,
      subscription: sub._id
    });

    // The Rs10 debit happens whenever the 20 uploads finish, so the mandate is valid from today.
    const start = new Date();
    const end = addMonths(start, MANDATE_YEARS * 12);
    const si = {
      isFreeTrial: false,
      billingAmount: PLAN.planAmount.toFixed(2),
      billingInterval: '1',
      billingCycle: BILLING_CYCLE,
      paymentStartDate: ymdIST(start),
      paymentEndDate: ymdIST(end),
      remarks: 'TubePilot uploads plan',
      billingCurrency: 'INR',
      billingLimit: 'ON',
      billingRule: 'MAX'
    };

    console.log(`💳 [Subscription] start — user ${req.user._id}, txnid=${txnid}, ₹${PLAN.introAmount} now (+${PLAN.uploads} uploads), then ₹${PLAN.planAmount} when the uploads finish`);
    res.status(201).json({ success: true, orderId: txnid, payu, si });
  } catch (err) {
    console.error('❌ [Subscription] start failed:', err.response?.data || err.message);
    res.status(500).json({ success: false, message: 'Could not start the subscription. Please try again.' });
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

    await notify(req.user, 'subscription_cancelled', 'Subscription cancelled', 'Autopay is cancelled. You will not be charged again. Your remaining uploads stay.');
    res.json({ success: true, message: 'Autopay cancelled. You will not be charged again.', mandateRevoked: revoked });
  } catch (err) {
    console.error('❌ [Subscription] cancel failed:', err.message);
    res.status(500).json({ success: false, message: 'Could not cancel. Please try again or contact support.' });
  }
});

router.finalizeFromPayu = finalizeFromPayu;
router.PLAN = PLAN;
router.notify = notify;
router.classify = classify;
router.applyFailed = applyFailed;
module.exports = router;
