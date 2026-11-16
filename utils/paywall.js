// ---------------------------------------------------------------------------
// PAYWALL: a user who has not paid anything yet must not
//   * connect a YouTube channel      (routes/youtube.js   GET /oauth/url)
//   * upload / bulk-upload videos    (routes/video.js     POST /upload, /bulk-upload)
//
// "Paid" = ANY of:
//   - the Rs1 plan was paid (Subscription.firstPaidAt) or a subscription is active
//   - a diamond pack / live plan / subscription charge was bought (approved Transaction)
//   - the user already owns a plan tier (activeTier > 0)
//   - admins are never locked
// If PayU is not configured nobody can pay, so nobody is locked either.
// ---------------------------------------------------------------------------
const Subscription = require('../models/Subscription');
const Transaction = require('../models/Transaction');
const { isConfigured: payuConfigured } = require('./payu');

const PAID_TXN_TYPES = ['diamond_purchase', 'live_plan_purchase', 'subscription_charge'];

const hasPaid = async (user) => {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if ((user.activeTier || 0) > 0) return true;
  if (user.subscription && user.subscription.isActive) return true;

  const sub = await Subscription.exists({
    user: user._id,
    $or: [{ status: 'active' }, { firstPaidAt: { $ne: null } }]
  });
  if (sub) return true;

  const txn = await Transaction.exists({ user: user._id, status: 'approved', type: { $in: PAID_TXN_TYPES } });
  return !!txn;
};

// NEW MODEL: no up-front payment. New accounts get 3 free uploads, then the one-time Rs10 plan is offered.
// The old "Rs1 or locked" behaviour only runs when PAYWALL_ENABLED=true is set in the server env.
const PAYWALL_ENABLED = () => process.env.PAYWALL_ENABLED === 'true';

const isLocked = async (user) => {
  if (!PAYWALL_ENABLED()) return false;
  if (!payuConfigured) return false;
  return !(await hasPaid(user));
};

// Express middleware (use AFTER `protect`, and BEFORE multer so the file is never read for a locked user).
const requirePaid = async (req, res, next) => {
  try {
    if (await isLocked(req.user)) {
      return res.status(402).json({
        success: false,
        code: 'PAYMENT_REQUIRED',
        message: 'Please activate the ₹1 plan to unlock this feature.'
      });
    }
    next();
  } catch (err) {
    console.error('❌ [Paywall] check failed:', err.message);
    res.status(500).json({ success: false, message: 'Could not check your plan. Please try again.' });
  }
};

module.exports = { hasPaid, isLocked, requirePaid, PAYWALL_ENABLED };
