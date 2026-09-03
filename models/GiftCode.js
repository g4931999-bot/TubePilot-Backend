const mongoose = require('mongoose');

// Admin-generated codes users can redeem once each for a small, fixed
// diamond bonus. One doc per code; redemptions are tracked inline via
// `redeemedBy` so "has THIS user already redeemed THIS code" is a single
// indexed query rather than a separate join/collection.
const GiftCodeSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, uppercase: true, trim: true, index: true },
  diamondValue: { type: Number, required: true, enum: [2, 3] }, // "exactly 2 or 3 diamonds" per spec
  label: { type: String, default: '' }, // optional admin-facing note, e.g. "Diwali giveaway"
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  active: { type: Boolean, default: true },
  maxRedemptions: { type: Number, default: null }, // null = unlimited unique users
  redeemedBy: [
    {
      user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
      redeemedAt: { type: Date, default: Date.now }
    }
  ]
}, { timestamps: true });

// Enforces "prevent multiple redemptions of the same code by the same
// user" at the query level in routes/diamond.js (findOne with both the
// code and a $ne on redeemedBy.user) rather than relying on a unique
// index here, since a single user's entry inside an array isn't something
// a plain Mongo index can uniquely constrain across documents.
GiftCodeSchema.index({ 'redeemedBy.user': 1 });

module.exports = mongoose.model('GiftCode', GiftCodeSchema);
