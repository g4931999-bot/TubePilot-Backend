const express = require('express');
const { protect } = require('../middleware/auth');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { sendPushToUser } = require('../utils/push');
const { createCashfreeOrder, getCashfreeOrderStatus } = require('../utils/cashfree');
const GiftCode = require('../models/GiftCode');

const router = express.Router();

// Fixed packages: 1 Diamond = ₹1, only these 4 sizes are sold
const DIAMOND_PACKAGES = [10, 50, 100, 200];

// @route GET /api/diamonds/packages
router.get('/packages', protect, (req, res) => {
  const packages = DIAMOND_PACKAGES.map((d) => ({ diamonds: d, priceINR: d }));
  res.json({ success: true, packages, currentBalance: req.user.diamondBalance });
});

/**
 * Controller: Create Order
 */
const handleCreateOrder = async (req, res) => {
  try {
    // Accepts 'diamondPackage', 'packageId', or 'amount' to ensure full frontend compatibility
    const rawPackage = req.body.diamondPackage || req.body.packageId || req.body.amount;
    const diamondPackage = Number(rawPackage);

    if (!DIAMOND_PACKAGES.includes(diamondPackage)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid diamond package selection. Choose 10, 50, 100 or 200.' 
      });
    }

    // Cashfree requires a unique order_id per attempt
    const userIdentifier = req.user.userId || req.user._id.toString().slice(-6);
    const orderId = `TP${userIdentifier}_${Date.now()}`;

    const transaction = await Transaction.create({
      user: req.user._id,
      userDisplayId: userIdentifier,
      type: 'diamond_purchase',
      diamondPackage,
      amountINR: diamondPackage, // 1 diamond = ₹1
      status: 'pending',
      paymentMethod: 'cashfree',
      cashfreeOrderId: orderId
    });

    const order = await createCashfreeOrder({
      orderId,
      amount: diamondPackage,
      customerId: userIdentifier,
      customerPhone: req.user.phone,
      customerEmail: req.user.email,
      customerName: req.user.name
    });

    transaction.paymentSessionId = order.paymentSessionId;
    await transaction.save();

    console.log(`💳 [Cashfree] Order created — user ${req.user._id}, orderId=${orderId}, amount=₹${diamondPackage}`);

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
    console.error('❌ [Cashfree] create-order failed:', err.response?.data || err.message);
    res.status(500).json({ success: false, message: 'Could not start payment. Please try again.' });
  }
};

/**
 * Controller: Verify Payment
 */
const handleVerifyPayment = async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ success: false, message: 'orderId is required' });

    const transaction = await Transaction.findOne({ cashfreeOrderId: orderId, user: req.user._id });
    if (!transaction) return res.status(404).json({ success: false, message: 'Transaction not found' });

    if (transaction.status === 'approved') {
      return res.json({ success: true, status: 'approved', message: 'Payment already confirmed', transaction });
    }

    const cfOrder = await getCashfreeOrderStatus(orderId);
    console.log(`💳 [Cashfree] Verify — order ${orderId}: status=${cfOrder.order_status}`);

    if (cfOrder.order_status === 'PAID') {
      // Atomic claim: only one concurrent caller (this request or the
      // webhook firing around the same time) can flip status from
      // 'pending' -> 'approved'. If we lose the race, someone else already
      // credited this order — return its current state instead of crediting again.
      const claimed = await Transaction.findOneAndUpdate(
        { _id: transaction._id, status: 'pending' },
        { $set: { status: 'approved', reviewedAt: new Date(), adminNote: 'Auto-approved via Cashfree' } },
        { new: true }
      );

      if (!claimed) {
        const current = await Transaction.findById(transaction._id);
        return res.json({
          success: true,
          status: current.status,
          message: current.status === 'approved' ? 'Payment already confirmed' : 'Payment not completed yet',
          transaction: current
        });
      }

      // Atomically credit user balance — safe now, this can only run once per order.
      const updatedUser = await User.findByIdAndUpdate(
        req.user._id,
        { $inc: { diamondBalance: claimed.diamondPackage } },
        { new: true }
      );

      await Notification.create({
        user: req.user._id,
        type: 'payment_approved',
        title: 'Payment Successful 🎉',
        message: `₹${claimed.amountINR} paid — ${claimed.diamondPackage} diamonds added to your wallet.`
      });

      await sendPushToUser(updatedUser, {
        title: 'Payment successful 💎',
        body: `${claimed.diamondPackage} diamonds added to your wallet.`,
        data: { type: 'payment_approved' }
      });

      console.log(`✅ [Cashfree] Order ${orderId}: PAID — credited ${claimed.diamondPackage} diamonds to user ${req.user._id}`);
      return res.json({ 
        success: true, 
        status: 'approved', 
        message: 'Payment confirmed, diamonds credited', 
        transaction: claimed,
        diamondBalance: updatedUser.diamondBalance 
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
    console.error('❌ [Cashfree] verify-payment failed:', err.response?.data || err.message);
    res.status(500).json({ success: false, message: 'Could not verify payment. Please check My Requests or contact support.' });
  }
};

// -----------------------------------------------------------------------
// Route Registrations (Supports main paths + all legacy aliases)
// -----------------------------------------------------------------------

// Create Order Routes
router.post('/create-order', protect, handleCreateOrder);
router.post('/buy-diamonds', protect, handleCreateOrder);
router.post('/buy', protect, handleCreateOrder);

// Verify Payment Routes
router.post('/verify-payment', protect, handleVerifyPayment);
router.post('/verify', protect, handleVerifyPayment);

// @route GET /api/payment/verify?order_id=...  (Cashfree's return_url —
// see utils/cashfree.js order_meta.return_url)
//
// ⚠️ FIX ("API route not found" + payment sheet closing immediately):
// order_meta.return_url points here, and Cashfree's checkout navigates to
// it (as a GET, inside its own webview) after any redirect-based payment
// method completes — UPI collect, netbanking, card 3DS. No GET route
// existed for this path before, only the POST /verify-payment above, so
// every such redirect hit Express's global `/api` 404 handler and the
// checkout webview closed/errored right after.
//
// This route does NOT credit diamonds — that still only ever happens
// through handleVerifyPayment (polled from the app after checkout closes)
// or the /webhook route below, both of which re-confirm directly with
// Cashfree's server. This route's only job is to hand the webview back a
// normal 200 page instead of a 404 so it can close cleanly; the app's own
// _confirmWithBackend() polling loop is what actually finishes the flow.
router.get('/verify', (req, res) => {
  res.status(200).send(`<!DOCTYPE html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Payment Received</title>
  </head>
  <body style="font-family:sans-serif;text-align:center;padding-top:60px;color:#222;">
    <h2>✅ Payment received</h2>
    <p>You can close this window and return to the app.</p>
  </body>
</html>`);
});

// @route POST /api/diamonds/webhook  (Cashfree server-to-server webhook)
router.post('/webhook', async (req, res) => {
  try {
    const orderId = req.body?.data?.order?.order_id;
    if (!orderId) return res.status(200).json({ success: true });

    const transaction = await Transaction.findOne({ cashfreeOrderId: orderId });
    if (!transaction || transaction.status === 'approved') {
      return res.status(200).json({ success: true });
    }

    const cfOrder = await getCashfreeOrderStatus(orderId);
    console.log(`💳 [Cashfree Webhook] Order ${orderId}: status=${cfOrder.order_status}`);

    if (cfOrder.order_status === 'PAID') {
      // Same atomic claim as handleVerifyPayment above — whichever of
      // (app calling verify-payment, Cashfree calling this webhook) gets
      // here first wins the credit; the other becomes a no-op.
      const claimed = await Transaction.findOneAndUpdate(
        { _id: transaction._id, status: 'pending' },
        { $set: { status: 'approved', reviewedAt: new Date(), adminNote: 'Auto-approved via Cashfree webhook' } },
        { new: true }
      );

      if (claimed) {
        const updatedUser = await User.findByIdAndUpdate(
          claimed.user,
          { $inc: { diamondBalance: claimed.diamondPackage } },
          { new: true }
        );

        if (updatedUser) {
          await Notification.create({
            user: updatedUser._id,
            type: 'payment_approved',
            title: 'Payment Successful 🎉',
            message: `₹${claimed.amountINR} paid — ${claimed.diamondPackage} diamonds added to your wallet.`
          });
          await sendPushToUser(updatedUser, {
            title: 'Payment successful 💎',
            body: `${claimed.diamondPackage} diamonds added to your wallet.`,
            data: { type: 'payment_approved' }
          });

          console.log(`✅ [Cashfree Webhook] Order ${orderId}: PAID — credited ${claimed.diamondPackage} diamonds to user ${updatedUser._id}`);
        }
      } else {
        console.log(`ℹ️ [Cashfree Webhook] Order ${orderId}: already claimed/processed by another request — skipping duplicate credit`);
      }
    }

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('❌ [Cashfree Webhook] error:', err.response?.data || err.message);
    res.status(200).json({ success: true });
  }
});

// @route POST /api/diamonds/redeem-gift-code  { code }
router.post('/redeem-gift-code', protect, async (req, res) => {
  try {
    const code = (req.body.code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ success: false, message: 'Enter a gift code' });

    const giftCode = await GiftCode.findOne({ code });
    if (!giftCode) return res.status(404).json({ success: false, message: 'Invalid gift code' });
    if (!giftCode.active) return res.status(400).json({ success: false, message: 'This gift code is no longer active' });
    if (giftCode.maxRedemptions !== null && giftCode.redeemedBy.length >= giftCode.maxRedemptions) {
      return res.status(400).json({ success: false, message: 'This gift code has reached its redemption limit' });
    }

    // Atomic claim: adds this user to redeemedBy ONLY if they're not
    // already in it (the $ne guard on the filter), so a double-tap or two
    // concurrent requests can't both succeed for the same user+code pair.
    const claimed = await GiftCode.findOneAndUpdate(
      { _id: giftCode._id, 'redeemedBy.user': { $ne: req.user._id } },
      { $push: { redeemedBy: { user: req.user._id, redeemedAt: new Date() } } },
      { new: true }
    );

    if (!claimed) {
      return res.status(409).json({ success: false, message: 'You have already redeemed this gift code' });
    }

    const updatedUser = await User.findByIdAndUpdate(
      req.user._id,
      { $inc: { diamondBalance: claimed.diamondValue } },
      { new: true }
    );

    await Notification.create({
      user: req.user._id,
      type: 'gift_code_redeemed',
      title: 'Gift Code Redeemed 🎁',
      message: `+${claimed.diamondValue} diamonds added to your wallet.`
    });

    res.json({
      success: true,
      message: `${claimed.diamondValue} diamonds added to your wallet!`,
      diamondsAwarded: claimed.diamondValue,
      diamondBalance: updatedUser.diamondBalance
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route GET /api/diamonds/my-requests
router.get('/my-requests', protect, async (req, res) => {
  const transactions = await Transaction.find({ user: req.user._id, type: 'diamond_purchase' }).sort({ createdAt: -1 });
  res.json({ success: true, transactions });
});

module.exports = router;
