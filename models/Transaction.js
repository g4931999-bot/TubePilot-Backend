const mongoose = require('mongoose');

const TransactionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  userDisplayId: { type: String, required: true },

  // ⚠️ NEW: 'live_plan_purchase' added for Day Pass / Monthly Pass buys.
  type: {
    type: String,
    enum: ['diamond_purchase', 'diamond_spend', 'diamond_refund', 'live_plan_purchase'],
    default: 'diamond_purchase'
  },

  diamondPackage: { type: Number, enum: [99, 299, 599, 799], required: function () { return this.type === 'diamond_purchase'; } },
  amountINR: { type: Number, required: function () { return this.type === 'diamond_purchase' || this.type === 'live_plan_purchase'; } },

  planTier: { type: Number, default: null },
  thumbnailPrompts: { type: Number, default: 0 },
  seoScoreLevel: { type: String, enum: ['none', 'basic', 'advance'], default: 'none' },
  competitorLevel: { type: String, enum: ['none', 'basic', 'advance'], default: 'none' },

  // ⚠️ NEW: Live Streaming plan snapshot at purchase time — same reasoning
  // as planTier/seoScoreLevel above: keep it on the transaction itself so
  // it stays historically accurate even if LIVE_PLANS config changes later.
  livePlanCategory: { type: String, enum: ['day', 'month'], default: null },
  livePlanName: { type: String, default: null }, // e.g. 'Starter', 'Basic'
  liveHoursGranted: { type: Number, default: 0 }, // in hours (whole number)

  diamondsForSpend: { type: Number, default: 0 },
  relatedVideo: { type: mongoose.Schema.Types.ObjectId, ref: 'Video', default: null },

  paymentMethod: { type: String, enum: ['cashfree'], default: 'cashfree' },
  cashfreeOrderId: { type: String, default: null, index: true },
  paymentSessionId: { type: String, default: null },

  utrNumber: { type: String, default: '' },
  screenshotUrl: { type: String, default: '' },

  status: { type: String, enum: ['pending', 'approved', 'rejected', 'completed'], default: 'pending' },
  adminNote: { type: String, default: '' },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reviewedAt: { type: Date, default: null }
}, { timestamps: true });

module.exports = mongoose.model('Transaction', TransactionSchema);
