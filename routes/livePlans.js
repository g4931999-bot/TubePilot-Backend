const express = require('express');
const { protect } = require('../middleware/auth');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { sendPushToUser } = require('../utils/push');
const crypto = require('crypto');
const { isConfigured: payuConfigured, IS_PROD, buildCheckoutParams, verifyPayment } = require('../utils/payu');

const router = express.Router();

// -----------------------------------------------------------------------
// LIVE STREAMING PLANS — final list, boss ke saath confirm kiya gaya
// -----------------------------------------------------------------------
const DAY_PASSES = [
  { name: 'Starter', priceINR: 35, hours: 5 },
  { name: 'Standard', priceINR: 50, hours: 7 },
  { name: 'Advanced', priceINR: 75, hours: 10 },
  { name: 'Pro', priceINR: 120, hours: 15 },
  { name: 'Max', priceINR: 150, hours: 24 }
];

const MONTH_PASSES = [
  { name: 'Basic', priceINR: 250, hours: 20 },
  { name: 'Standard', priceINR: 500, hours: 40 },
  { name: 'Advanced', priceINR: 750, hours: 60 },
  { name: 'Premium', priceINR: 800, hours: 80 }
];

const MAX_VIDEO_SIZE_BYTES = 2 * 1024 * 1024 * 1024; // 2GB — sabhi plans ke liye same

function findPlan(category, planName) {
  const list = category === 'day' ? DAY_PASSES : category === 'month' ? MONTH_PASSES : null;
  if (!list) return null;
  return list.find((p) => p.name === planName) || null;
}

// @route GET /api/live-plans
router.get('/', protect, (req, res) => {
  res.json({
    success: true,
    dayPasses: DAY_PASSES,
    monthPasses: MONTH_PASSES,
    maxVideoSizeMB: MAX_VIDEO_SIZE_BYTES / (1024 * 1024),
    freeTrialMinutes: 5,
    freeTrialUsed: req.user.liveStream?.freeTrialUsed || false,
    currentPlan: req.user.liveStream || null,
    paymentGateway: 'payu',
    payuEnvironment: IS_PROD ? 'PRODUCTION' : 'TEST'
  });
});

// -----------------------------------------------------------------------
// Shared "claim + credit" logic — jaise diamond.js mein hai. Teen jagah se
// call ho sakta hai (app poll / webhook / auto-check), isliye status ko
// 'approved' banane wali JAGAH SIRF YE EK FUNCTION hai.
// -----------------------------------------------------------------------
const creditApprovedLivePlanTransaction = async (transactionId, source) => {
  const claimed = await Transaction.findOneAndUpdate(
    { _id: transactionId, status: 'pending' },
    { $set: { status: 'approved', reviewedAt: new Date(), adminNote: `Auto-approved via ${source}` } },
    { new: true }
  );
  if (!claimed) return null;

  const updatedUser = await User.findByIdAndUpdate(
    claimed.user,
    {
      $set: {
        'liveStream.planCategory': claimed.livePlanCategory,
        'liveStream.planName': claimed.livePlanName,
        'liveStream.hoursAllottedSeconds': claimed.liveHoursGranted * 3600,
        'liveStream.hoursUsedSeconds': 0,
        'liveStream.purchaseAt': new Date()
      }
    },
    { new: true }
  );

  if (updatedUser) {
    await Notification.create({
      user: updatedUser._id,
      type: 'payment_approved',
      title: 'Live Streaming Plan Activated 🎉',
      message: `₹${claimed.amountINR} paid — ${claimed.livePlanName} (${claimed.liveHoursGranted} hours) activated.`
    });
    await sendPushToUser(updatedUser, {
      title: 'Live plan activated 📡',
      body: `${claimed.livePlanName} — ${claimed.liveHoursGranted} hours ready to use.`,
      data: { type: 'live_plan_approved' }
    });
  }

  return { claimed, updatedUser };
};

// Asks PayU directly. Returns 'PAID' | 'FAILED' | 'PENDING'. Amount is always cross-checked.
// (txnid is stored in Transaction.cashfreeOrderId - old field name kept to avoid a migration.)
const checkPayuStatus = async (transaction) => {
  const d = await verifyPayment(transaction.cashfreeOrderId);
  if (!d) return 'PENDING';
  const st = String(d.status || '').toLowerCase();
  if (st === 'success') {
    const paid = Number(d.amt ?? d.transaction_amount);
    if (!Number.isFinite(paid) || Math.abs(paid - transaction.amountINR) > 0.01) {
      console.error(`🚨 [PayU/Live] AMOUNT MISMATCH txn=${transaction.cashfreeOrderId} paid=${paid} expected=${transaction.amountINR} — NOT crediting`);
      return 'PENDING';
    }
    return 'PAID';
  }
  if (['failure', 'failed', 'usercancelled', 'bounced', 'dropped'].includes(st)) return 'FAILED';
  return 'PENDING';
};

// @route POST /api/live-plans/create-order
// Body: { category: 'day' | 'month', planName: 'Starter' }
// Response: { orderId (PayU txnid), transactionId, payu: {key, txnid, amount, ...} } - same shape as the Diamond Store.
router.post('/create-order', protect, async (req, res) => {
  try {
    const { category, planName } = req.body;
    const plan = findPlan(category, planName);
    if (!plan) {
      return res.status(400).json({ success: false, message: 'Invalid plan selection.' });
    }

    const userIdentifier = String(req.user.userId || req.user._id.toString().slice(-6));
    // PayU txnid: alphanumeric only, max 25 chars
    const txnid = `TPL${Date.now()}${crypto.randomBytes(2).toString('hex')}`;
    const productinfo = `Live ${plan.name} ${category === 'day' ? 'Day' : 'Month'} Pass`.replace(/[^A-Za-z0-9 ]/g, '');

    const payu = buildCheckoutParams({ txnid, amount: plan.priceINR, productinfo, user: req.user, userIdentifier });

    const transaction = await Transaction.create({
      user: req.user._id,
      userDisplayId: userIdentifier,
      type: 'live_plan_purchase',
      amountINR: plan.priceINR,
      livePlanCategory: category,
      livePlanName: plan.name,
      liveHoursGranted: plan.hours,
      status: 'pending',
      paymentMethod: 'payu',
      cashfreeOrderId: txnid // reused field: holds the PayU txnid
    });

    console.log(`💳 [PayU/Live] Order created — user ${req.user._id}, txnid=${txnid}, plan=${plan.name} (${category}), ₹${plan.priceINR}`);

    res.status(201).json({ success: true, orderId: txnid, transactionId: transaction._id, payu });
  } catch (err) {
    if (err.code === 'PAYU_NOT_CONFIGURED') {
      return res.status(503).json({ success: false, message: err.message, code: err.code });
    }
    console.error('❌ [PayU/Live] create-order failed:', err.response?.data || err.message);
    res.status(500).json({ success: false, message: 'Could not start payment. Please try again.' });
  }
});

// @route POST /api/live-plans/verify-payment
router.post('/verify-payment', protect, async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ success: false, message: 'orderId is required' });

    const transaction = await Transaction.findOne({ cashfreeOrderId: orderId, user: req.user._id, type: 'live_plan_purchase' });
    if (!transaction) return res.status(404).json({ success: false, message: 'Transaction not found' });

    if (transaction.status === 'approved') {
      return res.json({ success: true, status: 'approved', message: 'Payment already confirmed', transaction });
    }
    if (transaction.status === 'rejected') {
      return res.json({ success: true, status: 'rejected', message: 'Payment was not completed', transaction });
    }

    const st = await checkPayuStatus(transaction);
    console.log(`💳 [PayU/Live] Verify — txn ${orderId}: ${st}`);

    if (st === 'PAID') {
      const result = await creditApprovedLivePlanTransaction(transaction._id, 'PayU');
      if (!result) {
        const current = await Transaction.findById(transaction._id);
        return res.json({
          success: true,
          status: current.status,
          message: current.status === 'approved' ? 'Payment already confirmed' : 'Payment not completed yet',
          transaction: current
        });
      }
      return res.json({ success: true, status: 'approved', message: 'Payment confirmed, live plan activated', transaction: result.claimed });
    }

    // FAILED: DB stays 'pending' (a late success can still arrive); auto-check expires it after 24h.
    return res.json({ success: true, status: st === 'FAILED' ? 'failed' : 'pending', message: st === 'FAILED' ? 'Payment was not completed' : 'Payment not completed yet', transaction });
  } catch (err) {
    console.error('❌ [PayU/Live] verify-payment failed:', err.response?.data || err.message);
    res.status(500).json({ success: false, message: 'Could not verify payment.' });
  }
});

// -----------------------------------------------------------------------
// Background auto-check (safety net) - pending live-plan PayU orders, every 60s.
// PayU's own webhook (/api/payment/payu/webhook, in diamonds.js) also hands live-plan
// orders to creditApprovedLivePlanTransaction below.
// -----------------------------------------------------------------------
const AUTO_CHECK_MAX_AGE_HOURS = 24;
let autoCheckRunning = false;

async function autoCheckPendingLiveOrders() {
  if (autoCheckRunning) return;
  autoCheckRunning = true;
  try {
    const cutoff = new Date(Date.now() - AUTO_CHECK_MAX_AGE_HOURS * 60 * 60 * 1000);
    const pending = await Transaction.find({
      type: 'live_plan_purchase', status: 'pending', paymentMethod: 'payu', createdAt: { $gte: cutoff }
    }).limit(100);

    for (const transaction of pending) {
      try {
        const st = await checkPayuStatus(transaction);
        if (st === 'PAID') {
          const result = await creditApprovedLivePlanTransaction(transaction._id, 'auto-check job');
          if (result) console.log(`✅ [PayU/Live AutoCheck] txn ${transaction.cashfreeOrderId}: plan activated`);
        }
      } catch (err) {
        console.error(`❌ [PayU/Live AutoCheck] txn ${transaction.cashfreeOrderId} failed:`, err.response?.data || err.message);
      }
    }

    await Transaction.updateMany(
      { type: 'live_plan_purchase', status: 'pending', paymentMethod: 'payu', createdAt: { $lt: cutoff } },
      { $set: { status: 'rejected', adminNote: `Auto-expired — no payment confirmation within ${AUTO_CHECK_MAX_AGE_HOURS}h` } }
    );
  } catch (err) {
    console.error('❌ [PayU/Live AutoCheck] job run failed:', err.message);
  } finally {
    autoCheckRunning = false;
  }
}

if (payuConfigured) {
  setInterval(autoCheckPendingLiveOrders, 60 * 1000);
  console.log('🔄 [PayU/Live AutoCheck] background job started for live-plan orders');
}

module.exports = router;
module.exports.creditApprovedLivePlanTransaction = creditApprovedLivePlanTransaction;
