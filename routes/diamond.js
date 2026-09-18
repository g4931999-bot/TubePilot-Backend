const express = require('express');
const { protect } = require('../middleware/auth');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { sendPushToUser } = require('../utils/push');
const { createCashfreeOrder, getCashfreeOrderStatus, isConfigured: cashfreeConfigured, CASHFREE_ENV } = require('../utils/cashfree');
const GiftCode = require('../models/GiftCode');

const router = express.Router();

// ⚠️ BOSS RULE (final): ANY paid pack — even ₹10 — unlocks full Video SEO
// Optimizer copy/suggest access. Only a user who has NEVER purchased any
// pack (seoScoreLevel stays 'none' at the User schema default) sees the
// locked state there. Channel SEO Score is gated separately and more
// strictly (only 'advance' / ₹100+ unlocks it — see routes/analytics.js
// /audit route), even though it reads the SAME seoScoreLevel field.
//   tier 1 (₹10)  → 1 thumbnail prompt,  SEO: basic,     Competitor: none
//   tier 2 (₹50)  → 5 thumbnail prompts, SEO: basic,     Competitor: none
//   tier 3 (₹100) → 10 thumbnail prompts,SEO: advance,   Competitor: basic
//   tier 4 (₹200) → 20 thumbnail prompts,SEO: advance,   Competitor: advance
const DIAMOND_PACKAGES_BASE = [
  { tier: 1, diamonds: 99,  priceINR: 10,  thumbnailPrompts: 1,  seoScoreLevel: 'basic',   competitorLevel: 'none' },
  { tier: 2, diamonds: 299, priceINR: 50,  thumbnailPrompts: 5,  seoScoreLevel: 'basic',   competitorLevel: 'none' },
  { tier: 3, diamonds: 599, priceINR: 100, thumbnailPrompts: 10, seoScoreLevel: 'advance', competitorLevel: 'basic' },
  { tier: 4, diamonds: 799, priceINR: 200, thumbnailPrompts: 20, seoScoreLevel: 'advance', competitorLevel: 'advance' },
];

// Builds the honest "What's included" list the Flutter Diamond Store
// screen renders directly. Every package gets the SAME rows in the SAME
// order, each with `included` true/false — so a lower tier visibly shows
// what it's missing instead of silently listing features it doesn't grant.
// Video SEO Optimizer line reflects the (basic-unlocks-too) rule; Channel
// SEO Score line is called out separately since it needs 'advance'.
const buildFeatureList = (pkg) => [
  { label: 'AI Title Generation', included: true },
  { label: 'AI Description Generation', included: true },
  { label: 'AI Hashtag Generation', included: true },
  {
    label: pkg.thumbnailPrompts === 1 ? '1 Thumbnail Prompt' : `${pkg.thumbnailPrompts} Thumbnail Prompts`,
    included: pkg.thumbnailPrompts > 0
  },
  {
    label: 'Video SEO Optimizer',
    included: pkg.seoScoreLevel !== 'none'
  },
  {
    label: 'Channel SEO Score (Suggestions)',
    included: pkg.seoScoreLevel === 'advance'
  },
  {
    label: pkg.competitorLevel === 'none' ? 'Competitor Analysing System' : `Competitor Analysing System (${pkg.competitorLevel === 'basic' ? 'Basic' : 'Advance'})`,
    included: pkg.competitorLevel !== 'none'
  }
];

const DIAMOND_PACKAGES = DIAMOND_PACKAGES_BASE.map((pkg) => ({ ...pkg, features: buildFeatureList(pkg) }));

// @route GET /api/diamonds/packages
router.get('/packages', protect, (req, res) => {
  res.json({ success: true, packages: DIAMOND_PACKAGES, currentBalance: req.user.diamondBalance, cashfreeEnvironment: CASHFREE_ENV });
});

/**
 * Shared "claim + credit" logic. Used by handleVerifyPayment (app poll),
 * the webhook, and the background auto-check job below — three different
 * triggers can all race to be the one that confirms a given order, so this
 * is the ONLY place that ever flips a transaction to 'approved' and
 * increments diamondBalance / replaces the user's plan fields.
 */
const creditApprovedTransaction = async (transactionId, source) => {
  const claimed = await Transaction.findOneAndUpdate(
    { _id: transactionId, status: 'pending' },
    { $set: { status: 'approved', reviewedAt: new Date(), adminNote: `Auto-approved via ${source}` } },
    { new: true }
  );
  if (!claimed) return null;

  const updatedUser = await User.findByIdAndUpdate(
    claimed.user,
    {
      $inc: { diamondBalance: claimed.diamondPackage },
      $set: {
        activeTier: claimed.planTier,
        thumbnailPromptsRemaining: claimed.thumbnailPrompts,
        seoScoreLevel: claimed.seoScoreLevel,
        competitorLevel: claimed.competitorLevel
      }
    },
    { new: true }
  );

  if (updatedUser) {
    await Notification.create({
      user: updatedUser._id,
      type: 'payment_approved',
      title: 'Payment Successful 🎉',
      message: `₹${claimed.amountINR} paid — ${claimed.diamondPackage} diamonds added, plan upgraded.`
    });

    await sendPushToUser(updatedUser, {
      title: 'Payment successful 💎',
      body: `${claimed.diamondPackage} diamonds added to your wallet.`,
      data: { type: 'payment_approved' }
    });
  }

  return { claimed, updatedUser };
};

const handleCreateOrder = async (req, res) => {
  try {
    const rawPackage = req.body.diamondPackage || req.body.packageId || req.body.amount;
    const requestedDiamonds = Number(rawPackage);

    const pkg = DIAMOND_PACKAGES.find((p) => p.diamonds === requestedDiamonds);

    if (!pkg) {
      const validOptions = DIAMOND_PACKAGES.map((p) => p.diamonds).join(', ');
      return res.status(400).json({
        success: false,
        message: `Invalid diamond package selection. Choose ${validOptions} diamonds.`
      });
    }

    const userIdentifier = req.user.userId || req.user._id.toString().slice(-6);
    const orderId = `TP${userIdentifier}_${Date.now()}`;

    const transaction = await Transaction.create({
      user: req.user._id,
      userDisplayId: userIdentifier,
      type: 'diamond_purchase',
      diamondPackage: pkg.diamonds,
      amountINR: pkg.priceINR,
      planTier: pkg.tier,
      thumbnailPrompts: pkg.thumbnailPrompts,
      seoScoreLevel: pkg.seoScoreLevel,
      competitorLevel: pkg.competitorLevel,
      status: 'pending',
      paymentMethod: 'cashfree',
      cashfreeOrderId: orderId
    });

    const order = await createCashfreeOrder({
      orderId,
      amount: pkg.priceINR,
      customerId: userIdentifier,
      customerPhone: req.user.phone,
      customerEmail: req.user.email,
      customerName: req.user.name
    });

    transaction.paymentSessionId = order.paymentSessionId;
    await transaction.save();

    console.log(`💳 [Cashfree] Order created — user ${req.user._id}, orderId=${orderId}, amount=₹${pkg.priceINR}, diamonds=${pkg.diamonds}, tier=${pkg.tier}`);

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

router.post('/create-order', protect, handleCreateOrder);
router.post('/buy-diamonds', protect, handleCreateOrder);
router.post('/buy', protect, handleCreateOrder);

router.post('/verify-payment', protect, handleVerifyPayment);
router.post('/verify', protect, handleVerifyPayment);

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

router.get('/my-requests', protect, async (req, res) => {
  const transactions = await Transaction.find({ user: req.user._id, type: 'diamond_purchase' }).sort({ createdAt: -1 });
  res.json({ success: true, transactions });
});

const AUTO_CHECK_INTERVAL_MS = 60 * 1000;
const AUTO_CHECK_MAX_AGE_HOURS = 24;
const AUTO_CHECK_BATCH_SIZE = 10;
const AUTO_CHECK_BATCH_DELAY_MS = 400;
const AUTO_CHECK_MAX_PER_RUN = 200;

let autoCheckRunning = false;

async function autoCheckPendingOrders() {
  if (autoCheckRunning) return;
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
          } catch (err) {
            console.error(`❌ [Cashfree AutoCheck] order ${transaction.cashfreeOrderId} check failed:`, err.response?.data || err.message);
          }
        }));

        if (i + AUTO_CHECK_BATCH_SIZE < pending.length) {
          await new Promise((resolve) => setTimeout(resolve, AUTO_CHECK_BATCH_DELAY_MS));
        }
      }
    }

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
