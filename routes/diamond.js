const express = require('express');
const crypto = require('crypto');
const { protect } = require('../middleware/auth');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { sendPushToUser } = require('../utils/push');
const { isConfigured: payuConfigured, PAYU_KEY, IS_PROD, generateHash, buildCheckoutParams, verifyPayment } = require('../utils/payu');
const GiftCode = require('../models/GiftCode');

const router = express.Router();

// ANY paid pack unlocks Video SEO Optimizer; Channel SEO Score needs 'advance'.
const DIAMOND_PACKAGES_BASE = [
  { tier: 1, diamonds: 99,  priceINR: 10,  thumbnailPrompts: 1,  seoScoreLevel: 'basic',   competitorLevel: 'none' },
  { tier: 2, diamonds: 299, priceINR: 50,  thumbnailPrompts: 5,  seoScoreLevel: 'basic',   competitorLevel: 'none' },
  { tier: 3, diamonds: 599, priceINR: 100, thumbnailPrompts: 10, seoScoreLevel: 'advance', competitorLevel: 'basic' },
  { tier: 4, diamonds: 799, priceINR: 200, thumbnailPrompts: 20, seoScoreLevel: 'advance', competitorLevel: 'advance' },
];

const buildFeatureList = (pkg) => [
  { label: 'AI Title Generation', included: true },
  { label: 'AI Description Generation', included: true },
  { label: 'AI Hashtag Generation', included: true },
  {
    label: pkg.thumbnailPrompts === 1 ? '1 Thumbnail Prompt' : `${pkg.thumbnailPrompts} Thumbnail Prompts`,
    included: pkg.thumbnailPrompts > 0
  },
  { label: 'Video SEO Optimizer', included: pkg.seoScoreLevel !== 'none' },
  { label: 'Channel SEO Score (Suggestions)', included: pkg.seoScoreLevel === 'advance' },
  {
    label: pkg.competitorLevel === 'none' ? 'Competitor Analysing System' : `Competitor Analysing System (${pkg.competitorLevel === 'basic' ? 'Basic' : 'Advance'})`,
    included: pkg.competitorLevel !== 'none'
  }
];

const DIAMOND_PACKAGES = DIAMOND_PACKAGES_BASE.map((pkg) => ({ ...pkg, features: buildFeatureList(pkg) }));

router.get('/packages', protect, (req, res) => {
  res.json({ success: true, packages: DIAMOND_PACKAGES, currentBalance: req.user.diamondBalance, paymentGateway: 'payu', payuEnvironment: IS_PROD ? 'PRODUCTION' : 'TEST' });
});

// ONLY place that flips a transaction to 'approved' and credits diamonds.
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

// Asks PayU directly. Returns 'PAID' | 'FAILED' | 'PENDING'. Amount is always cross-checked.
const checkPayuStatus = async (transaction) => {
  const d = await verifyPayment(transaction.cashfreeOrderId); // txnid is stored in this field
  if (!d) return 'PENDING';
  const st = String(d.status || '').toLowerCase();
  if (st === 'success') {
    const paid = Number(d.amt ?? d.transaction_amount);
    if (!Number.isFinite(paid) || Math.abs(paid - transaction.amountINR) > 0.01) {
      console.error(`🚨 [PayU] AMOUNT MISMATCH txn=${transaction.cashfreeOrderId} paid=${paid} expected=${transaction.amountINR} — NOT crediting`);
      return 'PENDING';
    }
    return 'PAID';
  }
  if (['failure', 'failed', 'usercancelled', 'bounced', 'dropped'].includes(st)) return 'FAILED';
  return 'PENDING';
};

const handleCreateOrder = async (req, res) => {
  try {
    const rawPackage = req.body.diamondPackage || req.body.packageId || req.body.amount;
    const pkg = DIAMOND_PACKAGES.find((p) => p.diamonds === Number(rawPackage));
    if (!pkg) {
      const validOptions = DIAMOND_PACKAGES.map((p) => p.diamonds).join(', ');
      return res.status(400).json({ success: false, message: `Invalid diamond package selection. Choose ${validOptions} diamonds.` });
    }

    const userIdentifier = String(req.user.userId || req.user._id.toString().slice(-6));
    // PayU txnid: alphanumeric only, max 25 chars
    const txnid = `TP${Date.now()}${crypto.randomBytes(2).toString('hex')}`;
    const productinfo = `${pkg.diamonds} Diamonds`;

    const payu = buildCheckoutParams({ txnid, amount: pkg.priceINR, productinfo, user: req.user, userIdentifier });

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
      paymentMethod: 'payu',
      cashfreeOrderId: txnid // reused field: holds the PayU txnid
    });

    console.log(`💳 [PayU] Order created — user ${req.user._id}, txnid=${txnid}, ₹${pkg.priceINR}, diamonds=${pkg.diamonds}`);

    res.status(201).json({ success: true, orderId: txnid, transactionId: transaction._id, payu });
  } catch (err) {
    if (err.code === 'PAYU_NOT_CONFIGURED') {
      return res.status(503).json({ success: false, message: err.message, code: err.code });
    }
    console.error('❌ [PayU] create-order failed:', err.response?.data || err.message);
    res.status(500).json({ success: false, message: 'Could not start payment. Please try again.' });
  }
};

const handleVerifyPayment = async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ success: false, message: 'orderId is required' });

    const transaction = await Transaction.findOne({ cashfreeOrderId: orderId, user: req.user._id, type: 'diamond_purchase' });
    if (!transaction) return res.status(404).json({ success: false, message: 'Transaction not found' });

    if (transaction.status === 'approved') {
      return res.json({ success: true, status: 'approved', message: 'Payment already confirmed', transaction });
    }
    if (transaction.status === 'rejected') {
      return res.json({ success: true, status: 'rejected', message: 'Payment was not completed', transaction });
    }

    const st = await checkPayuStatus(transaction);
    console.log(`💳 [PayU] Verify — txn ${orderId}: ${st}`);

    if (st === 'PAID') {
      const result = await creditApprovedTransaction(transaction._id, 'PayU');
      if (!result) {
        const current = await Transaction.findById(transaction._id);
        return res.json({ success: true, status: current.status, message: 'Payment already confirmed', transaction: current });
      }
      return res.json({
        success: true,
        status: 'approved',
        message: 'Payment confirmed, diamonds credited',
        transaction: result.claimed,
        diamondBalance: result.updatedUser?.diamondBalance
      });
    }

    // FAILED: DB stays 'pending' (a late success can still arrive); auto-check expires it after 24h.
    return res.json({ success: true, status: st === 'FAILED' ? 'failed' : 'pending', message: st === 'FAILED' ? 'Payment was not completed' : 'Payment not completed yet', transaction });
  } catch (err) {
    console.error('❌ [PayU] verify-payment failed:', err.response?.data || err.message);
    res.status(500).json({ success: false, message: 'Could not verify payment. Please check My Requests or contact support.' });
  }
};

// Hash signing for the PayU Flutter SDK. The client may only get a payment hash for
// ITS OWN pending order and the EXACT amount stored on the server.
router.post('/payu/hash', protect, async (req, res) => {
  try {
    if (!payuConfigured) return res.status(503).json({ success: false, message: 'PayU not configured' });
    const { hashName, hashString, hashType, postSalt } = req.body || {};
    if (!hashName || typeof hashString !== 'string' || !hashString) {
      return res.status(400).json({ success: false, message: 'hashName and hashString are required' });
    }
    const parts = hashString.split('|');
    const looksLikePayment = hashName === 'payment' || parts.length >= 10;
    if (looksLikePayment) {
      const txn = await Transaction.findOne({ cashfreeOrderId: parts[1], user: req.user._id, status: 'pending', paymentMethod: 'payu' });
      if (!txn || parts[0] !== PAYU_KEY || Math.abs(Number(parts[2]) - txn.amountINR) > 0.001) {
        console.warn(`🚨 [PayU] hash request refused for user ${req.user._id}, txn=${parts[1]}`);
        return res.status(403).json({ success: false, message: 'Hash request refused' });
      }
    }
    res.json({ success: true, hash: generateHash({ hashString, hashType, postSalt }) });
  } catch (err) {
    console.error('❌ [PayU] hash error:', err.message);
    res.status(500).json({ success: false, message: 'Could not generate hash' });
  }
});

router.post('/create-order', protect, handleCreateOrder);
router.post('/buy-diamonds', protect, handleCreateOrder);
router.post('/buy', protect, handleCreateOrder);

router.post('/verify-payment', protect, handleVerifyPayment);
router.post('/verify', protect, handleVerifyPayment);

const resultPage = (req, res) => {
  res.status(200).send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Payment</title></head>
<body style="font-family:sans-serif;text-align:center;padding-top:60px;color:#222;">
<h2>Processing your payment…</h2><p>You can close this window and return to the app. Diamonds are credited automatically once PayU confirms.</p></body></html>`);
};
router.get('/verify', resultPage);
// PayU POSTs the user here after checkout (surl/furl). Never trusted for crediting.
router.post('/payu/result', resultPage);
router.get('/payu/result', resultPage);

// PayU server-to-server webhook. Body is never trusted: we re-check with PayU's verify API.
router.post('/payu/webhook', async (req, res) => {
  try {
    const txnid = req.body?.txnid;
    if (!txnid) return res.status(200).json({ success: true });

    const transaction = await Transaction.findOne({ cashfreeOrderId: String(txnid), paymentMethod: 'payu' });
    if (!transaction || transaction.status === 'approved') return res.status(200).json({ success: true });

    // UPDATE23: Live Plan orders use the same PayU webhook - hand them to the live-plan credit logic
    // (never the diamond credit, which would add NaN diamonds to the wallet).
    if (transaction.type === 'live_plan_purchase') {
      const stLive = await checkPayuStatus(transaction);
      console.log(`💳 [PayU Webhook] live plan txn ${txnid}: ${stLive}`);
      if (stLive === 'PAID') {
        const live = require('./livePlans'); // lazy: avoids a circular import
        await live.creditApprovedLivePlanTransaction(transaction._id, 'PayU webhook');
      }
      return res.status(200).json({ success: true });
    }

    const st = await checkPayuStatus(transaction);
    console.log(`💳 [PayU Webhook] txn ${txnid}: ${st}`);
    if (st === 'PAID') {
      const result = await creditApprovedTransaction(transaction._id, 'PayU webhook');
      if (result) console.log(`✅ [PayU Webhook] txn ${txnid}: credited ${result.claimed.diamondPackage} diamonds`);
    }
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('❌ [PayU Webhook] error:', err.response?.data || err.message);
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
    if (!claimed) return res.status(409).json({ success: false, message: 'You have already redeemed this gift code' });

    const updatedUser = await User.findByIdAndUpdate(req.user._id, { $inc: { diamondBalance: claimed.diamondValue } }, { new: true });

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

// ---------------- Background auto-check (safety net) ----------------
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
      type: 'diamond_purchase', status: 'pending', paymentMethod: 'payu', createdAt: { $gte: cutoff }
    }).limit(AUTO_CHECK_MAX_PER_RUN);

    for (let i = 0; i < pending.length; i += AUTO_CHECK_BATCH_SIZE) {
      const batch = pending.slice(i, i + AUTO_CHECK_BATCH_SIZE);
      await Promise.all(batch.map(async (transaction) => {
        try {
          const st = await checkPayuStatus(transaction);
          if (st === 'PAID') {
            const result = await creditApprovedTransaction(transaction._id, 'auto-check job');
            if (result) console.log(`✅ [PayU AutoCheck] txn ${transaction.cashfreeOrderId}: credited ${result.claimed.diamondPackage} diamonds`);
          }
        } catch (err) {
          console.error(`❌ [PayU AutoCheck] txn ${transaction.cashfreeOrderId} failed:`, err.response?.data || err.message);
        }
      }));
      if (i + AUTO_CHECK_BATCH_SIZE < pending.length) {
        await new Promise((r) => setTimeout(r, AUTO_CHECK_BATCH_DELAY_MS));
      }
    }

    await Transaction.updateMany(
      { type: 'diamond_purchase', status: 'pending', paymentMethod: 'payu', createdAt: { $lt: cutoff } },
      { $set: { status: 'rejected', adminNote: `Auto-expired — no payment confirmation within ${AUTO_CHECK_MAX_AGE_HOURS}h` } }
    );
  } catch (err) {
    console.error('❌ [PayU AutoCheck] job run failed:', err.message);
  } finally {
    autoCheckRunning = false;
  }
}

if (payuConfigured) {
  setInterval(autoCheckPendingOrders, AUTO_CHECK_INTERVAL_MS);
  console.log('🔄 [PayU AutoCheck] background job started');
} else {
  console.warn('⚠️ [PayU AutoCheck] PayU credentials not configured — job disabled.');
}

module.exports = router;
