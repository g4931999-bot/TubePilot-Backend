const mongoose = require('mongoose');

const MilestoneSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: { type: String, enum: ['subscribers', 'views'], required: true },
  value: { type: Number, required: true },
  videoId: { type: String, default: '' },
  videoTitle: { type: String, default: '' },
  channelTitle: { type: String, default: '' },
  seen: { type: Boolean, default: false, index: true },
  emailSent: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('Milestone', MilestoneSchema);
