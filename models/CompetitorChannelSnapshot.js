const mongoose = require('mongoose');

// Daily channel-level numbers (subscribers / total views / video count) —
// the source for the channel trend chart. Auto-deleted after 180 days.
const CompetitorChannelSnapshotSchema = new mongoose.Schema({
  channelId: { type: String, required: true },
  day: { type: String, required: true },          // 'YYYY-MM-DD' (IST)
  subscriberCount: { type: Number, default: null }, // null = hidden by the channel
  viewCount: { type: Number, default: 0 },
  videoCount: { type: Number, default: 0 },
  capturedAt: { type: Date, required: true }
});

CompetitorChannelSnapshotSchema.index({ channelId: 1, day: 1 }, { unique: true });
CompetitorChannelSnapshotSchema.index({ capturedAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

module.exports = mongoose.model('CompetitorChannelSnapshot', CompetitorChannelSnapshotSchema);
