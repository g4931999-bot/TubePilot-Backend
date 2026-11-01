const mongoose = require('mongoose');

const TransactionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  userDisplayId: { type: String, required: true },

  // 'live_plan_purchase' = Day/Month Pass. 'subscription_charge' = Rs1 intro payment and every Rs10 autopay.
  type: {
    type: String,
    enum: ['diamond_purchase', 'diamond_spend', 'diamond_refund', 'live_plan_purchase', 'subscription_charge'],
    default: 'diamond_purchase'
  },

  diamondPackage: {
    type: Number,
    enum: [0, 99, 299, 599, 799], // 0 = the Rs1 intro payment (gives uploads only, no diamonds)
    required: function () { return this.type === 'diamond_purchase' || this.type === 'subscription_charge'; }
  },
  amountINR: {
    type: Number,
    required: function () { return ['diamond_purchase', 'live_plan_purchase', 'subscription_charge'].includes(this.type); }
  },

  planTier: { type: Number, default: null },
  thumbnailPrompts: { type: Number, default: 0 },
  seoScoreLevel: { type: String, enum: ['none', 'basic', 'advance'], default: 'none' },
  competitorLevel: { type: String, enum: ['none', 'basic', 'advance'], default: 'none' },

  // Live Streaming plan snapshot at purchase time.
  livePlanCategory: { type: String, enum: ['day', 'month'], default: null },
  livePlanName: { type: String, default: null },
  liveHoursGranted: { type: Number, default: 0 },

  // Uploads granted by this payment (Rs1 intro = 20, Rs10 monthly = 30).
  uploadsGranted: { type: Number, default: 0 },

  diamondsForSpend: { type: Number, default: 0 },
  relatedVideo: { type: mongoose.Schema.Types.ObjectId, ref: 'Video', default: null },

  // Which subscription this payment belongs to (subscription_charge only).
  subscription: { type: mongoose.Schema.Types.ObjectId, ref: 'Subscription', default: null, index: true },

  paymentMethod: { type: String, enum: ['cashfree', 'payu'], default: 'cashfree' },
  // NOTE: for PayU orders this field holds the PayU txnid (kept to avoid a schema migration).
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
