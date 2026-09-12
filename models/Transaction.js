const mongoose = require('mongoose');

const TransactionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  userDisplayId: { type: String, required: true }, // TP102458, auto-filled

  type: { type: String, enum: ['diamond_purchase', 'diamond_spend', 'diamond_refund'], default: 'diamond_purchase' },

  // ⚠️ BOSS UPDATE: purchase package is now 99 / 299 / 599 / 799 diamonds
  // (for ₹10 / ₹50 / ₹100 / ₹200 respectively) — price is NO LONGER
  // diamonds x ₹1. amountINR below is what was actually charged; it is
  // independent of diamondPackage now, not derived from it.
  diamondPackage: { type: Number, enum: [99, 299, 599, 799], required: function () { return this.type === 'diamond_purchase'; } },
  amountINR: { type: Number, required: function () { return this.type === 'diamond_purchase'; } },

  diamondsForSpend: { type: Number, default: 0 }, // when type = diamond_spend/refund
  relatedVideo: { type: mongoose.Schema.Types.ObjectId, ref: 'Video', default: null },

  // Cashfree payment gateway fields — the manual UPI/QR + UTR + screenshot
  // flow has been fully replaced by Cashfree's in-app checkout SDK.
  paymentMethod: { type: String, enum: ['cashfree'], default: 'cashfree' },
  // Our own generated order id, sent to Cashfree and used to look up order
  // status later (verify-payment route, webhook). Indexed since both the
  // verify route and the webhook look transactions up by this field.
  cashfreeOrderId: { type: String, default: null, index: true },
  // Returned by Cashfree when the order is created — passed into the
  // Flutter SDK to open the checkout screen.
  paymentSessionId: { type: String, default: null },

  // Legacy fields from the old manual-UPI flow. Kept ONLY so historical
  // Transaction documents created before the Cashfree migration still read
  // back correctly (e.g. in the admin payments list) — never written to by
  // any current route.
  utrNumber: { type: String, default: '' },
  screenshotUrl: { type: String, default: '' },

  status: { type: String, enum: ['pending', 'approved', 'rejected', 'completed'], default: 'pending' },
  adminNote: { type: String, default: '' },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reviewedAt: { type: Date, default: null }
}, { timestamps: true });

module.exports = mongoose.model('Transaction', TransactionSchema);
