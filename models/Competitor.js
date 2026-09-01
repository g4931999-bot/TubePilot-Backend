const mongoose = require('mongoose');

// One doc per tracked competitor channel, scoped to the user who added it.
// `lastStats` is a cache refreshed on read (see routes/analytics.js) so the
// list endpoint doesn't have to hit the YouTube Data API on every call.
const CompetitorSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  channelId: { type: String, default: null },   // YouTube channel ID, if known
  handle: { type: String, default: null },       // @handle, if that's what the user entered instead
  label: { type: String, default: '' },           // display name shown in the app
  lastStats: {
    subscriberCount: { type: Number, default: null },
    viewCount: { type: Number, default: null },
    videoCount: { type: Number, default: null },
    thumbnail: { type: String, default: '' },
    resolvedChannelId: { type: String, default: null },
    // Views Per Hour, averaged across the channel's most recent uploads —
    // the core "is this competitor trending up" signal VidIQ surfaces.
    vph: { type: Number, default: null },
    fetchedAt: { type: Date, default: null },
    error: { type: String, default: null } // set when the last refresh failed (e.g. no API key configured)
  }
}, { timestamps: true });

CompetitorSchema.index({ user: 1, channelId: 1 });
CompetitorSchema.index({ user: 1, handle: 1 });

module.exports = mongoose.model('Competitor', CompetitorSchema);
