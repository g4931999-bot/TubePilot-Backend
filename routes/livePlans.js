const express = require('express');
const { protect } = require('../middleware/auth');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { sendPushToUser } = require('../utils/push');
const { createCashfreeOrder, getCashfreeOrderStatus, isConfigured: cashfreeConfigured, CASHFREE_ENV } = require('../utils/cashfree');

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
    cashfreeEnvironment: CASHFREE_ENV
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

// @route POST /api/live-plans/create-order
// Body: { category: 'day' | 'month', planName: 'Starter' }
router.post('/create-order', protect, async (req, res) => {
  try {
    const { category, planName } = req.body;
    const plan = findPlan(category, planName);

    if (!plan) {
      return res.status(400).json({ success: false, message: 'Invalid plan selection.' });
    }

    const userIdentifier = req.user.userId || req.user._id.toString().slice(-6);
    const orderId = `TPLIVE${userIdentifier}_${Date.now()}`;

    const transaction = await Transaction.create({
      user: req.user._id,
      userDisplayId: userIdentifier,
      type: 'live_plan_purchase',
      amountINR: plan.priceINR,
      livePlanCategory: category,
      livePlanName: plan.name,
      liveHoursGranted: plan.hours,
      status: 'pending',
      paymentMethod: 'cashfree',
      cashfreeOrderId: orderId
    });

    let order;
    try {
      order = await createCashfreeOrder({
        orderId,
        amount: plan.priceINR,
        customerId: userIdentifier,
        customerPhone: req.user.phone,
        customerEmail: req.user.email,
        customerName: req.user.name
      });
    } catch (cfErr) {
      // Cashfree ne order banaya hi nahi — pending transaction ko turant
      // rejected mark karo, warna auto-check job 24 ghante tak har minute
      // is bekaar order ko check karti rahegi.
      transaction.status = 'rejected';
      transaction.adminNote = `Cashfree order creation failed: ${cfErr.response?.data?.message || cfErr.message}`;
      await transaction.save();
      throw cfErr;
    }

    transaction.paymentSessionId = order.paymentSessionId;
    await transaction.save();

    console.log(`💳 [Cashfree/Live] Order created — user ${req.user._id}, orderId=${orderId}, plan=${plan.name} (${category}), amount=₹${plan.priceINR}`);

    res.status(201).json({
      success: true,
      orderId: order.orderId,
      paymentSessionId: order.paymentSessionId,
      transactionId: transaction._id
    });
  } catch (err) {
    if (err.code === 'CASHFREE_NOT_CONFIGURED') {
      return res.status(503).json({ success: false, message: err.message, code: err.code });
    }
    if (err.response?.data?.code === 'payment_gateway_inactive') {
      console.error('❌ [Cashfree/Live] Cashfree account par Payment Gateway activate nahi hai.');
      return res.status(503).json({ success: false, message: 'Payment abhi available nahi hai. Kripya thodi der baad try karein.' });
    }
    console.error('❌ [Cashfree/Live] create-order failed:', err.response?.data || err.message);
    res.status(500).json({ success: false, message: 'Could not start payment. Please try again.' });
  }
});

// @route POST /api/live-plans/verify-payment
router.post('/verify-payment', protect, async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ success: false, message: 'orderId is required' });

    const transaction = await Transaction.findOne({ cashfreeOrderId: orderId, user: req.user._id });
    if (!transaction) return res.status(404).json({ success: false, message: 'Transaction not found' });

    if (transaction.status === 'approved') {
      return res.json({ success: true, status: 'approved', message: 'Payment already confirmed', transaction });
    }

    const cfOrder = await getCashfreeOrderStatus(orderId);

    if (cfOrder.order_status === 'PAID') {
      const result = await creditApprovedLivePlanTransaction(transaction._id, 'Cashfree');

      if (!result) {
        const current = await Transaction.findById(transaction._id);
        return res.json({
          success: true,
          status: current.status,
          message: current.status === 'approved' ? 'Payment already confirmed' : 'Payment not completed yet',
          transaction: current
        });
      }

      return res.json({
        success: true,
        status: 'approved',
        message: 'Payment confirmed, live plan activated',
        transaction: result.claimed
      });
    }

    if (['EXPIRED', 'TERMINATED', 'CANCELLED'].includes(cfOrder.order_status)) {
      transaction.status = 'rejected';
      transaction.adminNote = `Cashfree order status: ${cfOrder.order_status}`;
      await transaction.save();
      return res.json({ success: true, status: 'rejected', message: 'Payment was not completed', transaction });
    }

    return res.json({ success: true, status: 'pending', message: 'Payment not completed yet', transaction });
  } catch (err) {
    console.error('❌ [Cashfree/Live] verify-payment failed:', err.response?.data || err.message);
    res.status(500).json({ success: false, message: 'Could not verify payment.' });
  }
});

// @route POST /api/live-plans/webhook
router.post('/webhook', async (req, res) => {
  try {
    const orderId = req.body?.data?.order?.order_id;
    if (!orderId) return res.status(200).json({ success: true });

    const transaction = await Transaction.findOne({ cashfreeOrderId: orderId, type: 'live_plan_purchase' });
    if (!transaction || transaction.status === 'approved') {
      return res.status(200).json({ success: true });
    }

    const cfOrder = await getCashfreeOrderStatus(orderId);

    if (cfOrder.order_status === 'PAID') {
      await creditApprovedLivePlanTransaction(transaction._id, 'Cashfree webhook');
    }

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('❌ [Cashfree/Live Webhook] error:', err.response?.data || err.message);
    res.status(200).json({ success: true });
  }
});

// -----------------------------------------------------------------------
// Background auto-check — pending live-plan orders ke liye (jaise
// diamond.js mein hai, isi pattern se). Har 60 second check karta hai.
// -----------------------------------------------------------------------
let autoCheckRunning = false;

async function autoCheckPendingLiveOrders() {
  if (autoCheckRunning) return;
  autoCheckRunning = true;

  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const pending = await Transaction.find({
      type: 'live_plan_purchase',
      status: 'pending',
      paymentMethod: 'cashfree',
      createdAt: { $gte: cutoff }
    }).limit(50);

    for (const transaction of pending) {
      // paymentSessionId tabhi save hota hai jab Cashfree ne order sach mein
      // banaya ho. Nahi hai matlab order Cashfree par exist hi nahi karta —
      // check karne ka koi matlab nahi, seedha rejected mark karo.
      if (!transaction.paymentSessionId) {
        await Transaction.findOneAndUpdate(
          { _id: transaction._id, status: 'pending' },
          { $set: { status: 'rejected', adminNote: 'Order never created at Cashfree (auto-check)' } }
        );
        continue;
      }
      try {
        const cfOrder = await getCashfreeOrderStatus(transaction.cashfreeOrderId);
        if (cfOrder.order_status === 'PAID') {
          await creditApprovedLivePlanTransaction(transaction._id, 'auto-check job');
        } else if (['EXPIRED', 'TERMINATED', 'CANCELLED'].includes(cfOrder.order_status)) {
          await Transaction.findOneAndUpdate(
            { _id: transaction._id, status: 'pending' },
            { $set: { status: 'rejected', adminNote: `Cashfree order status: ${cfOrder.order_status} (auto-check)` } }
          );
        }
      } catch (err) {
        console.error(`❌ [Live AutoCheck] order ${transaction.cashfreeOrderId} check failed:`, err.message);
      }
    }
  } catch (err) {
    console.error('❌ [Live AutoCheck] job run failed:', err.message);
  } finally {
    autoCheckRunning = false;
  }
}

if (cashfreeConfigured) {
  setInterval(autoCheckPendingLiveOrders, 60 * 1000);
  console.log('🔄 [Live AutoCheck] background job started for live-plan orders');
}

module.exports = router;
