const mongoose = require('mongoose');

// One row per (video, IST day) — the real measured numbers YouTube gave us
// at `capturedAt`. Growth is ONLY ever computed from two of these rows, so
// nothing is estimated or back-filled. Auto-deleted after 90 days (TTL).
const CompetitorVideoSnapshotSchema = new mongoose.Schema({
  videoId: { type: String, required: true },
  channelId: { type: String, required: true },
  day: { type: String, required: true },          // 'YYYY-MM-DD' (IST)
  viewCount: { type: Number, default: 0 },
  likeCount: { type: Number, default: null },
  commentCount: { type: Number, default: null },
  capturedAt: { type: Date, required: true }
});

CompetitorVideoSnapshotSchema.index({ videoId: 1, day: 1 }, { unique: true });
CompetitorVideoSnapshotSchema.index({ videoId: 1, capturedAt: -1 });
CompetitorVideoSnapshotSchema.index({ channelId: 1, capturedAt: 1 });
CompetitorVideoSnapshotSchema.index({ capturedAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = mongoose.model('CompetitorVideoSnapshot', CompetitorVideoSnapshotSchema);
