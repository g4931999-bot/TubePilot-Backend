const mongoose = require('mongoose');

// Short-lived OAuth 2.1 + PKCE authorization codes. The TTL index below
// auto-expires unused codes after 10 minutes, so this collection never
// grows unbounded even if a client never completes the token exchange.
const OAuthCodeSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, index: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  clientId: { type: String, required: true },
  redirectUri: { type: String, required: true },
  codeChallenge: { type: String, required: true },
  codeChallengeMethod: { type: String, enum: ['S256', 'plain'], default: 'S256' },
  used: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now, expires: 600 } // 10 minutes, then Mongo auto-deletes it
});

module.exports = mongoose.model('OAuthCode', OAuthCodeSchema);
