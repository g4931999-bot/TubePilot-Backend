const cron = require('node-cron');
const crypto = require('crypto');
const Subscription = require('../models/Subscription');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const { isConfigured, verifyPayment, preDebitNotify, chargeRecurring, revokeMandate } = require('../utils/payu');
const sub = require('../routes/subscription');

const HOUR = 3600 * 1000;
const NOTICE_AT_UPLOADS = Number(process.env.SUBSCRIPTION_NOTICE_AT_UPLOADS || 3); // tell the user/bank when this many uploads are left
const PERIOD_NOTICE_DAYS = 3;      // also notice this many days before the 1-month period ends
const MIN_NOTICE_HOURS = 25;       // at least 24h between notice and debit (PayU/RBI rule) + safety
const MAX_FAILS = 3;

const ymdIST = (d) => new Date(new Date(d).getTime() + 5.5 * HOUR).toISOString().slice(0, 10);
const istMidnight = (ymd) => new Date(`${ymd}T00:00:00+05:30`);
const ok = (r) => String(r?.status) === '1';

// What makes a Rs10 renewal due for this subscription?
//   credits finished  -> renew (debit only once credits are really 0)
//   month ended       -> renew (same as the old monthly reset)
const state = (s, user, now) => {
  const credits = Number(user.freeUploadsRemaining || 0);
  const periodEnd = s.currentPeriodEnd ? new Date(s.currentPeriodEnd) : null;
  return {
    credits,
    needsNotice: credits <= NOTICE_AT_UPLOADS || (periodEnd && periodEnd <= new Date(now.getTime() + PERIOD_NOTICE_DAYS * 24 * HOUR)),
    debitNow: credits <= 0 || (periodEnd && periodEnd <= now),
    periodEnd
  };
};

// 1) Notice before debit ----------------------------------------------------
const sendPreDebitNotices = async () => {
  const now = new Date();
  const list = await Subscription.find({
    status: 'active',
    preDebitSentAt: null,
    authPayuId: { $ne: null },
    failCount: { $lt: MAX_FAILS }
  }).limit(500);

  for (const s of list) {
    try {
      const user = await User.findById(s.user);
      if (!user) continue;
      const st = state(s, user, now);
      if (!st.needsNotice) continue;

      // debit date: never earlier than ~a day from now; if only the month end triggered it, not before that
      const earliest = new Date(now.getTime() + MIN_NOTICE_HOURS * HOUR);
      const byPeriodOnly = st.credits > NOTICE_AT_UPLOADS && st.periodEnd;
      const debitDay = ymdIST(byPeriodOnly && st.periodEnd > earliest ? st.periodEnd : earliest);

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
      await Subscription.updateOne({ _id: s._id }, { $set: { preDebitSentAt: now, debitOn: istMidnight(debitDay) } });
      await sub.notify(
        user,
        'subscription_predebit',
        'Upcoming autopay',
        `You have ${st.credits} upload(s) left. When they finish, ₹${s.planAmount} will be auto-debited (on or after ${debitDay}) for your next ${sub.PLAN.uploads} uploads. Cancel anytime in Subscription.`,
        `₹${s.planAmount} autopay when your uploads finish. Cancel anytime in Subscription.`
      );
      console.log(`📣 [SubScheduler] pre-debit sent for ${s._id} (credits ${st.credits}), debit day ${debitDay}`);
    } catch (e) {
      console.error(`❌ [SubScheduler] pre-debit failed for ${s._id}:`, e.response?.data || e.message);
    }
  }
};

// A notice is only good for its own date. If the user did not finish the uploads in
// time, forget it so a fresh notice (new date) goes out.
const resetStaleNotices = async () => {
  const r = await Subscription.updateMany(
    { status: 'active', preDebitSentAt: { $ne: null }, debitOn: { $ne: null, $lte: new Date(Date.now() - 24 * HOUR) } },
    { $set: { preDebitSentAt: null, debitOn: null } }
  );
  if (r.modifiedCount) console.log(`♻️ [SubScheduler] ${r.modifiedCount} stale pre-debit notice(s) reset`);
};

// 2) The Rs10 debit ---------------------------------------------------------
const runDueDebits = async () => {
  const now = new Date();
  const due = await Subscription.find({
    status: 'active',
    preDebitSentAt: { $ne: null, $lte: new Date(now.getTime() - 24 * HOUR) },
    // only inside the notified date (debitOn .. debitOn+24h)
    debitOn: { $ne: null, $lte: now, $gt: new Date(now.getTime() - 24 * HOUR) },
    failCount: { $lt: MAX_FAILS }
  }).limit(100);

  for (const s of due) {
    // one attempt per 20h
    if (s.lastChargeAttemptAt && now - s.lastChargeAttemptAt < 20 * HOUR) continue;

    const user = await User.findById(s.user);
    if (!user) continue;
    // debit ONLY when the uploads are really finished (or the month ended)
    if (!state(s, user, now).debitNow) continue;

    // claim this attempt atomically (two server instances must never both debit)
    const claimed = await Subscription.findOneAndUpdate(
      { _id: s._id, status: 'active', $or: [{ lastChargeAttemptAt: null }, { lastChargeAttemptAt: s.lastChargeAttemptAt }] },
      { $set: { lastChargeAttemptAt: now } },
      { new: true }
    );
    if (!claimed) continue;

    const txnid = `TR${Date.now()}${crypto.randomBytes(2).toString('hex')}`;
    const identifier = String(user.userId || user._id.toString().slice(-6));

    try {
      await Transaction.create({
        user: user._id,
        userDisplayId: identifier,
        type: 'subscription_charge',
        uploadCredits: sub.PLAN.uploads,
        amountINR: s.planAmount,
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
      const stt = String(detail?.status || '').toLowerCase();
      console.log(`💳 [SubScheduler] debit ${txnid} for ${s._id}: api=${r?.status} status=${stt || '(none)'}`);

      if (stt === 'captured' || stt === 'success') {
        await sub.finalizeFromPayu((await Transaction.findOne({ cashfreeOrderId: txnid }))._id, 'autopay');
      } else if (stt === 'failed' || stt === 'failure' || (r && String(r.status) === '0')) {
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
    await resetStaleNotices();
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
  console.log('🔁 Subscription scheduler running (every 30 min: notice at 3 uploads left, ₹10 debit when uploads finish, settle, revoke)');
};

module.exports = { startSubscriptionScheduler };
