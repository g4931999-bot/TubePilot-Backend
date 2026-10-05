const mongoose = require('mongoose');

// One doc per user: remembers which milestones were already shown, and when the next card is due.
const MilestoneTrackerSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  channelId: { type: String, default: '' },
  nextDueAt: { type: Date, default: Date.now, index: true }, // default = due immediately (first card right after connect)
  initialCheckDone: { type: Boolean, default: false }, // true after the first check on connect (popup or not)
  lastType: { type: String, enum: ['', 'subscribers', 'views'], default: '' },
  lastSubMilestone: { type: Number, default: 0 },
  videoMilestones: { type: Map, of: Number, default: {} } // videoId -> highest views milestone already shown
}, { timestamps: true });

module.exports = mongoose.model('MilestoneTracker', MilestoneTrackerSchema);
