const express = require('express');
const { protect } = require('../middleware/auth');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { sendPushToUser } = require('../utils/push');
const { createCashfreeOrder, getCashfreeOrderStatus, isConfigured: cashfreeConfigured, CASHFREE_ENV } = require('../utils/cashfree');
const GiftCode = require('../models/GiftCode');

const router = express.Router();

// Fixed packages: 1 Diamond = ₹1, only these 4 sizes are sold
const DIAMOND_PACKAGES = [10, 50, 100, 200];

// @route GET /api/diamonds/packages
router.get('/packages', protect, (req, res) => {
  const packages = DIAMOND_PACKAGES.map((d) => ({ diamonds: d, priceINR: d }));
  // The app reads this to decide CFEnvironment.SANDBOX vs .PRODUCTION at
  // runtime — so switching environments is purely a backend .env change
  // (CASHFREE_ENV=SANDBOX/PRODUCTION + matching keys) + server restart.
  // No Flutter rebuild ever needed for this.
  res.json({ success: true, packages, currentBalance: req.user.diamondBalance, cashfreeEnvironment: CASHFREE_ENV });
});

/**
 * Shared "claim + credit" logic. Used by handleVerifyPayment (app poll),
 * the webhook, and the background auto-check job below — three different
 * triggers can all race to be the one that confirms a given order, so this
 * is the ONLY place that ever flips a transaction to 'approved' and
 * increments diamondBalance.
 *
 * The findOneAndUpdate's `{ status: 'pending' }` filter is the atomic
 * claim: whichever caller's update lands first wins and gets a non-null
 * result back; every other (near-)simultaneous caller gets null and just
 * no-ops. This is what makes it safe for three independent triggers to
 * all be checking the same order at once without ever double-crediting.
 */
const creditApprovedTransaction = async (transactionId, source) => {
  const claimed = await Transaction.findOneAndUpdate(
    { _id: transactionId, status: 'pending' },
    { $set: { status: 'approved', reviewedAt: new Date(), adminNote: `Auto-approved via ${source}` } },
    { new: true }
  );
  if (!claimed) return null; // someone else already claimed/credited this order

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
  }

  return { claimed, updatedUser };
};

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
      const result = await creditApprovedTransaction(transaction._id, 'Cashfree');

      if (!result) {
        const current = await Transaction.findById(transaction._id);
        return res.json({
          success: true,
          status: current.status,
          message: current.status === 'approved' ? 'Payment already confirmed' : 'Payment not completed yet',
          transaction: current
        });
      }

      console.log(`✅ [Cashfree] Order ${orderId}: PAID — credited ${result.claimed.diamondPackage} diamonds to user ${req.user._id}`);
      return res.json({ 
        success: true, 
        status: 'approved', 
        message: 'Payment confirmed, diamonds credited', 
        transaction: result.claimed,
        diamondBalance: result.updatedUser?.diamondBalance 
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
      const result = await creditApprovedTransaction(transaction._id, 'Cashfree webhook');
      if (result) {
        console.log(`✅ [Cashfree Webhook] Order ${orderId}: PAID — credited ${result.claimed.diamondPackage} diamonds to user ${result.claimed.user}`);
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

// -----------------------------------------------------------------------
// Background Auto-Check Job
// -----------------------------------------------------------------------
// WHY THIS EXISTS: a pending order only gets credited today via (a) the
// app's own 18s poll loop right after checkout closes, or (b) Cashfree's
// webhook. If the user backgrounds/kills the app mid-poll, or the webhook
// URL isn't configured in the Cashfree dashboard, NEITHER fires — and the
// order sits as 'pending' forever, which is exactly why the admin panel
// had a stack of "Pending" orders needing a manual Approve click.
//
// This job is the safety net for both: every 60s it re-checks every
// pending Cashfree order directly against Cashfree's server and credits
// diamonds the moment it sees PAID — no admin action required, ever.
const AUTO_CHECK_INTERVAL_MS = 60 * 1000;      // run every 1 minute
const AUTO_CHECK_MAX_AGE_HOURS = 24;           // ignore/auto-expire anything older than this
const AUTO_CHECK_BATCH_SIZE = 10;              // check this many orders concurrently per batch
const AUTO_CHECK_BATCH_DELAY_MS = 400;         // gap between batches, so we don't hammer Cashfree's API
const AUTO_CHECK_MAX_PER_RUN = 200;            // hard cap per run, keeps the job cheap even if pending pile up

let autoCheckRunning = false; // re-entrancy guard: skip a tick if the previous one is still going

async function autoCheckPendingOrders() {
  if (autoCheckRunning) return; // previous run overran the 1-minute interval — skip this tick
  autoCheckRunning = true;

  try {
    const cutoff = new Date(Date.now() - AUTO_CHECK_MAX_AGE_HOURS * 60 * 60 * 1000);

    const pending = await Transaction.find({
      type: 'diamond_purchase',
      status: 'pending',
      paymentMethod: 'cashfree',
      createdAt: { $gte: cutoff }
    }).limit(AUTO_CHECK_MAX_PER_RUN);

    if (pending.length > 0) {
      console.log(`🔄 [Cashfree AutoCheck] checking ${pending.length} pending order(s)...`);

      for (let i = 0; i < pending.length; i += AUTO_CHECK_BATCH_SIZE) {
        const batch = pending.slice(i, i + AUTO_CHECK_BATCH_SIZE);

        await Promise.all(batch.map(async (transaction) => {
          try {
            const cfOrder = await getCashfreeOrderStatus(transaction.cashfreeOrderId);

            if (cfOrder.order_status === 'PAID') {
              const result = await creditApprovedTransaction(transaction._id, 'auto-check job');
              if (result) {
                console.log(`✅ [Cashfree AutoCheck] order ${transaction.cashfreeOrderId}: PAID — credited ${result.claimed.diamondPackage} diamonds to user ${result.claimed.user}`);
              }
            } else if (['EXPIRED', 'TERMINATED', 'CANCELLED'].includes(cfOrder.order_status)) {
              await Transaction.findOneAndUpdate(
                { _id: transaction._id, status: 'pending' },
                { $set: { status: 'rejected', adminNote: `Cashfree order status: ${cfOrder.order_status} (auto-check job)` } }
              );
            }
            // else still pending on Cashfree's side — leave it, next tick will retry
          } catch (err) {
            // One bad order (Cashfree API hiccup, network blip) must never
            // stop the rest of the batch or kill the interval.
            console.error(`❌ [Cashfree AutoCheck] order ${transaction.cashfreeOrderId} check failed:`, err.response?.data || err.message);
          }
        }));

        if (i + AUTO_CHECK_BATCH_SIZE < pending.length) {
          await new Promise((resolve) => setTimeout(resolve, AUTO_CHECK_BATCH_DELAY_MS));
        }
      }
    }

    // Anything past the cutoff is a genuinely abandoned checkout (user
    // never paid) — auto-expire it so "Pending" doesn't grow forever.
    await Transaction.updateMany(
      { type: 'diamond_purchase', status: 'pending', paymentMethod: 'cashfree', createdAt: { $lt: cutoff } },
      { $set: { status: 'rejected', adminNote: `Auto-expired — no payment confirmation within ${AUTO_CHECK_MAX_AGE_HOURS}h` } }
    );
  } catch (err) {
    console.error('❌ [Cashfree AutoCheck] job run failed:', err.response?.data || err.message);
  } finally {
    autoCheckRunning = false;
  }
}

if (cashfreeConfigured) {
  setInterval(autoCheckPendingOrders, AUTO_CHECK_INTERVAL_MS);
  console.log(`🔄 [Cashfree AutoCheck] background job started — checking pending orders every ${AUTO_CHECK_INTERVAL_MS / 1000}s`);
} else {
  console.warn('⚠️ [Cashfree AutoCheck] Cashfree credentials not configured — background auto-check job disabled.');
}

module.exports = router;
