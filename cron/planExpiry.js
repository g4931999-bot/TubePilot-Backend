// ---------------------------------------------------------------------------
// Rs10 plan EXPIRY: 30 days after a one-time Rs10 purchase, the unused uploads / diamonds that came with
// it are removed and the user is told. (Rs1 intro uploads never expire.)
//
//  * Purchases are the approved subscription_charge transactions whose txnid starts with "TM".
//  * Expired purchases are marked with Transaction.utrNumber = 'EXPIRED' (so it runs once per purchase).
//  * Removes at most what the purchase gave (planUploads / diamonds) and never more than the user has left.
//  * If the user bought a NEWER month meanwhile, nothing is removed now (the newer purchase expires later
//    and cleans up everything).
//  * PLAN_VALID_DAYS (default 30) changes the length. Runs every hour; started from routes/subscription.js.
// ---------------------------------------------------------------------------
const cron = require('node-cron');
const Transaction = require('../models/Transaction');
const User = require('../models/User');

const VALID_DAYS = Number(process.env.PLAN_VALID_DAYS || 30);
const DAY = 24 * 3600 * 1000;

const runExpiry = async () => {
  const sub = require('../routes/subscription'); // lazy (circular import)
  const { PLAN, notify } = sub;
  const cutoff = new Date(Date.now() - VALID_DAYS * DAY);

  const due = await Transaction.find({
    type: 'subscription_charge',
    status: 'approved',
    cashfreeOrderId: /^TM/,
    utrNumber: { $ne: 'EXPIRED' },
    reviewedAt: { $lte: cutoff }
  }).limit(200);

  for (const t of due) {
    try {
      // claim (two servers must not both expire it)
      const claimed = await Transaction.findOneAndUpdate(
        { _id: t._id, utrNumber: { $ne: 'EXPIRED' } },
        { $set: { utrNumber: 'EXPIRED' } },
        { new: true }
      );
      if (!claimed) continue;

      const newer = await Transaction.exists({
        user: t.user,
        type: 'subscription_charge',
        status: 'approved',
        cashfreeOrderId: /^TM/,
        reviewedAt: { $gt: t.reviewedAt }
      });
      if (newer) continue;

      const user = await User.findById(t.user);
      if (!user) continue;
      const takeUploads = Math.min(Number(user.freeUploadsRemaining || 0), PLAN.planUploads);
      const takeDiamonds = Math.min(Number(user.diamondBalance || 0), PLAN.diamonds);
      if (takeUploads > 0 || takeDiamonds > 0) {
        await User.updateOne(
          { _id: user._id },
          { $inc: { freeUploadsRemaining: -takeUploads, diamondBalance: -takeDiamonds } }
        );
      }
      await notify(
        user,
        'subscription_cancelled',
        'Your ₹10 plan has ended',
        `Your ${VALID_DAYS}-day plan is over. Buy the ₹${PLAN.planAmount} plan again to get ${PLAN.planUploads} uploads and ${PLAN.diamonds} diamonds.`,
        `Your ${VALID_DAYS}-day plan ended. Buy it again to keep uploading.`
      );
      console.log(`⌛ [PlanExpiry] user ${user._id}: removed ${takeUploads} uploads, ${takeDiamonds} diamonds (txn ${t.cashfreeOrderId})`);
    } catch (e) {
      console.error('❌ [PlanExpiry] failed for txn', t.cashfreeOrderId, e.message);
    }
  }
};

let started = false;
const startPlanExpiry = () => {
  if (started) return;
  started = true;
  cron.schedule('7 * * * *', () => runExpiry().catch((e) => console.error('❌ [PlanExpiry]', e.message)), { timezone: 'Asia/Kolkata' });
  console.log(`⌛ Plan expiry job running (hourly, plans last ${VALID_DAYS} days)`);
};

module.exports = { startPlanExpiry, runExpiry };
