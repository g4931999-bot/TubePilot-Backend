const cron = require('node-cron');
const crypto = require('crypto');
const Subscription = require('../models/Subscription');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const { isConfigured, verifyPayment, preDebitNotify, chargeRecurring, revokeMandate } = require('../utils/payu');
const sub = require('../routes/subscription');

const HOUR = 3600 * 1000;
const MIN_NOTICE_HOURS = 25;       // 24h between notice and debit (PayU/RBI rule) + 1h safety
const MAX_FAILS = 3;

const ymdIST = (d) => new Date(new Date(d).getTime() + 5.5 * HOUR).toISOString().slice(0, 10);
const istMidnight = (ymd) => new Date(`${ymd}T00:00:00+05:30`);
const ok = (r) => String(r?.status) === '1';

// 1) Credits ended -> notice, Rs10 debit follows ~24h later ------------------
// Rule: when a subscriber's upload credits are 0, tell them (and PayU) that Rs10 will be debited
// after 24 hours. The paid month starts from the day the credits ran out (cycleAnchor).
const sendPreDebitNotices = async () => {
  const now = new Date();

  // a) credits came back (refund / gift) before any notice -> forget the "zero" mark
  const marked = await Subscription.find({ status: 'active', creditsZeroSeenAt: { $ne: null }, preDebitSentAt: null }).limit(200);
  for (const s of marked) {
    const u = await User.findById(s.user).select('freeUploadsRemaining');
    if (u && (u.freeUploadsRemaining || 0) > 0) {
      await Subscription.updateOne({ _id: s._id }, { $set: { creditsZeroSeenAt: null } });
    }
  }

  // b) active subscribers whose upload credits are 0 and who have no notice pending
  const rows = await Subscription.aggregate([
    {
      $match: {
        status: 'active',
        preDebitSentAt: null,
        failCount: { $lt: MAX_FAILS },
        $or: [{ lastChargeAttemptAt: null }, { lastChargeAttemptAt: { $lt: new Date(now.getTime() - 24 * HOUR) } }]
      }
    },
    { $lookup: { from: User.collection.name, localField: 'user', foreignField: '_id', as: 'u' } },
    { $unwind: '$u' },
    { $match: { 'u.freeUploadsRemaining': { $lte: 0 } } },
    { $project: { _id: 1 } },
    { $limit: 100 }
  ]);

  for (const row of rows) {
    try {
      const s = await Subscription.findById(row._id);
      if (!s || s.status !== 'active' || s.preDebitSentAt) continue;

      const zeroSeen = s.creditsZeroSeenAt || now;
      if (!s.creditsZeroSeenAt) await Subscription.updateOne({ _id: s._id }, { $set: { creditsZeroSeenAt: zeroSeen } });

      // Only ONE Rs10 debit per paid month: if the 30 uploads ended mid-month, wait for the month to finish.
      if (!sub.ALLOW_EARLY_REDEBIT && s.currentPeriodEnd && now < s.currentPeriodEnd) continue;

      const anchor = !sub.ALLOW_EARLY_REDEBIT && s.currentPeriodEnd && s.currentPeriodEnd > zeroSeen ? s.currentPeriodEnd : zeroSeen;

      // debit date = IST date of (now + 25h) => PayU's 24h notice rule always holds
      const debitDay = ymdIST(new Date(now.getTime() + MIN_NOTICE_HOURS * HOUR));
      const r = await preDebitNotify({
        authPayuId: s.authPayuId,
        requestId: `PD${String(s._id).slice(-8)}${Date.now()}`,
        debitDate: debitDay,
        amount: s.planAmount,
        invoice: `TP${String(s._id).slice(-6)}${debitDay.replace(/-/g, '')}`
      });
      if (!ok(r)) {
        console.warn(`⚠️ [SubScheduler] pre-debit not accepted for ${s._id}:`, JSON.stringify(r));
        continue;
      }
      const debitOn = istMidnight(debitDay);
      await Subscription.updateOne(
        { _id: s._id },
        { $set: { preDebitSentAt: now, debitOn, nextDebitAt: debitOn, cycleAnchor: anchor, creditsZeroSeenAt: zeroSeen } }
      );
      const user = await User.findById(s.user);
      if (user) {
        await sub.notify(
          user,
          'subscription_predebit',
          'Your upload credits are over',
          `₹${s.planAmount} will be auto-debited on ${debitDay} (after 24 hours). You will get ${sub.PLAN.planUploads} uploads + ${sub.PLAN.diamonds} diamonds for 1 month. You can cancel anytime from Subscription.`,
          `₹${s.planAmount} autopay on ${debitDay} → ${sub.PLAN.planUploads} uploads + ${sub.PLAN.diamonds} diamonds.`
        );
      }
      console.log(`📣 [SubScheduler] credits over -> pre-debit sent for ${s._id}, debit on ${debitDay}`);
    } catch (e) {
      console.error(`❌ [SubScheduler] pre-debit failed for ${row._id}:`, e.response?.data || e.message);
    }
  }
};

// 2) The monthly debit ------------------------------------------------------
const runDueDebits = async () => {
  const now = new Date();
  const due = await Subscription.find({
    status: 'active',
    preDebitSentAt: { $ne: null, $lte: new Date(now.getTime() - 24 * HOUR) },
    debitOn: { $ne: null, $lte: now },
    failCount: { $lt: MAX_FAILS }
  }).limit(100);

  for (const s of due) {
    // one attempt per 20h
    if (s.lastChargeAttemptAt && now - s.lastChargeAttemptAt < 20 * HOUR) continue;
    // claim this attempt atomically (two server instances must never both debit)
    const claimed = await Subscription.findOneAndUpdate(
      { _id: s._id, status: 'active', $or: [{ lastChargeAttemptAt: null }, { lastChargeAttemptAt: s.lastChargeAttemptAt }] },
      { $set: { lastChargeAttemptAt: now } },
      { new: true }
    );
    if (!claimed) continue;

    const user = await User.findById(s.user);
    if (!user) continue;

    // Credits came back after the notice (refund / gift / admin): do NOT debit, cancel this cycle quietly.
    if ((user.freeUploadsRemaining || 0) > 0) {
      await Subscription.updateOne(
        { _id: s._id },
        { $set: { preDebitSentAt: null, debitOn: null, nextDebitAt: null, cycleAnchor: null, creditsZeroSeenAt: null, lastChargeAttemptAt: s.lastChargeAttemptAt || null } }
      );
      console.log(`↩️ [SubScheduler] credits back for ${s._id} — debit skipped`);
      continue;
    }
    const txnid = `TR${Date.now()}${crypto.randomBytes(2).toString('hex')}`;
    const identifier = String(user.userId || user._id.toString().slice(-6));

    try {
      await Transaction.create({
        user: user._id,
        userDisplayId: identifier,
        type: 'subscription_charge',
        diamondPackage: sub.PLAN.diamonds,
        uploadsGranted: sub.PLAN.planUploads,
        amountINR: s.planAmount,
        planTier: sub.PLAN.tier,
        thumbnailPrompts: sub.PLAN.thumbnailPrompts,
        seoScoreLevel: sub.PLAN.seoScoreLevel,
        competitorLevel: sub.PLAN.competitorLevel,
        status: 'pending',
        paymentMethod: 'payu',
        cashfreeOrderId: txnid,
        subscription: s._id
      });

      const phoneDigits = String(user.phone || '').replace(/\D/g, '');
      const r = await chargeRecurring({
        authPayuId: s.authPayuId,
        txnid,
        amount: s.planAmount,
        invoice: `TP${String(s._id).slice(-6)}${ymdIST(now).replace(/-/g, '')}`,
        phone: phoneDigits.length >= 10 ? phoneDigits.slice(-10) : '9999999999',
        email: user.email && user.email.includes('@') ? user.email : `user_${identifier}@tubepilot.app`
      });

      const detail = r?.details?.[txnid];
      const st = String(detail?.status || '').toLowerCase();
      console.log(`💳 [SubScheduler] debit ${txnid} for ${s._id}: api=${r?.status} status=${st || '(none)'}`);

      if (st === 'captured' || st === 'success') {
        await sub.finalizeFromPayu((await Transaction.findOne({ cashfreeOrderId: txnid }))._id, 'autopay');
      } else if (st === 'failed' || st === 'failure' || (r && String(r.status) === '0')) {
        await sub.applyFailed(await Transaction.findOne({ cashfreeOrderId: txnid }));
      }
      // anything else (pending / in progress): step 3 below verifies it later
    } catch (e) {
      console.error(`❌ [SubScheduler] debit error for ${s._id}:`, e.response?.data || e.message);
    }
  }
};

// 3) Settle debits / registrations that were still pending --------------------
const settlePending = async () => {
  const pend = await Transaction.find({
    type: 'subscription_charge',
    status: 'pending',
    paymentMethod: 'payu',
    createdAt: { $gte: new Date(Date.now() - 5 * 24 * HOUR) }
  }).limit(100);

  for (const t of pend) {
    try {
      await sub.finalizeFromPayu(t._id, 'subscription job');
    } catch (e) {
      console.error(`❌ [SubScheduler] settle ${t.cashfreeOrderId}:`, e.response?.data || e.message);
    }
  }

  // abandoned Rs1 checkouts: close after 24h
  const cutoff = new Date(Date.now() - 24 * HOUR);
  const old = await Transaction.find({ type: 'subscription_charge', status: 'pending', createdAt: { $lt: cutoff } }).limit(100);
  for (const t of old) await sub.applyFailed(t);
};

// 4) Retry mandate cancellation that PayU did not confirm -----------------------
const retryRevokes = async () => {
  const list = await Subscription.find({ status: 'cancelled', mandateRevoked: false, authPayuId: { $ne: null } }).limit(50);
  for (const s of list) {
    try {
      const r = await revokeMandate({ authPayuId: s.authPayuId, requestId: `RV${Date.now()}${crypto.randomBytes(2).toString('hex')}` });
      if (ok(r)) await Subscription.updateOne({ _id: s._id }, { $set: { mandateRevoked: true } });
    } catch (e) {
      console.error(`❌ [SubScheduler] revoke retry ${s._id}:`, e.response?.data || e.message);
    }
  }
};

let running = false;
const tick = async () => {
  if (running) return;
  running = true;
  try {
    await settlePending();
    await sendPreDebitNotices();
    await runDueDebits();
    await retryRevokes();
  } catch (e) {
    console.error('❌ [SubScheduler] tick error:', e.message);
  } finally {
    running = false;
  }
};

const startSubscriptionScheduler = () => {
  if (!isConfigured) {
    console.warn('⚠️ [SubScheduler] PayU not configured — subscription job disabled.');
    return;
  }
  cron.schedule('*/30 * * * *', tick, { timezone: 'Asia/Kolkata' });
  console.log('🔁 Subscription scheduler running (every 30 min: pre-debit notice, ₹10 debit when credits end, settle, revoke)');
};

module.exports = { startSubscriptionScheduler };
