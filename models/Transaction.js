const mongoose = require('mongoose');

const TransactionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  userDisplayId: { type: String, required: true },

  type: { type: String, enum: ['diamond_purchase', 'diamond_spend', 'diamond_refund'], default: 'diamond_purchase' },

  diamondPackage: { type: Number, enum: [99, 299, 599, 799], required: function () { return this.type === 'diamond_purchase'; } },
  amountINR: { type: Number, required: function () { return this.type === 'diamond_purchase'; } },

  // ⚠️ NEW (Boss request — plan/quota system): snapshot of the tier's
  // entitlements AT PURCHASE TIME, saved on the transaction itself. Why:
  // creditApprovedTransaction() can be called by 3 different triggers
  // (app poll / webhook / auto-check job — see routes/diamond.js), and
  // whichever one fires needs to know what tier this specific order was
  // for WITHOUT re-deriving it from priceINR. Kept even if DIAMOND_PACKAGES
  // config changes later — this transaction stays historically accurate.
  planTier: { type: Number, default: null },
  thumbnailPrompts: { type: Number, default: 0 },
  seoScoreLevel: { type: String, enum: ['none', 'basic', 'advance'], default: 'none' },
  competitorLevel: { type: String, enum: ['none', 'basic', 'advance'], default: 'none' },

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
