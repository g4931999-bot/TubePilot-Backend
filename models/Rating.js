const mongoose = require('mongoose');

const RatingSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  email: { type: String, default: '' },
  stars: { type: Number, min: 1, max: 5, default: null },
  reviewText: { type: String, default: '' },
  skipped: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('Rating', RatingSchema);
