const mongoose = require('mongoose');

// Permanent list of every YouTube channel that has ever been connected to TubePilot.
// Never deleted (not even when a user disconnects or deletes their account), so we can tell
// "brand new channel" (card shows now) from "already in our database" (card comes after 15 days).
const KnownChannelSchema = new mongoose.Schema({
  channelId: { type: String, required: true, unique: true },
  firstUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  firstSeenAt: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = mongoose.model('KnownChannel', KnownChannelSchema);
