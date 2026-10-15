const mongoose = require('mongoose');

// One doc per PUBLIC YouTube video of a tracked competitor channel. Keyed by
// the YouTube channel ID (not by user), so if 10 users track the same
// channel we store and refresh its videos only once.
// `stats` always holds the LATEST numbers; the day-by-day history lives in
// CompetitorVideoSnapshot (that is what growth is measured from).
const CompetitorVideoSchema = new mongoose.Schema({
  videoId: { type: String, required: true, unique: true },
  channelId: { type: String, required: true, index: true },
  title: { type: String, default: '' },
  thumbnail: { type: String, default: '' },
  publishedAt: { type: Date, default: null },
  durationSec: { type: Number, default: null },
  tags: [{ type: String }],
  stats: {
    viewCount: { type: Number, default: 0 },
    likeCount: { type: Number, default: null },     // null = hidden by the uploader
    commentCount: { type: Number, default: null }   // null = comments disabled
  },
  statsAt: { type: Date, default: null },
  firstSeenAt: { type: Date, default: Date.now }
}, { timestamps: false });

CompetitorVideoSchema.index({ channelId: 1, publishedAt: -1 });

module.exports = mongoose.model('CompetitorVideo', CompetitorVideoSchema);
