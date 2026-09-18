const mongoose = require('mongoose');

// Registered MCP/OAuth clients — either pre-configured (ChatGPT, Claude) or
// dynamically registered via POST /oauth/register (RFC 7591), which is how
// Claude's and ChatGPT's connector setup typically auto-registers itself
// the first time a user tries to connect TubePilot, before ever showing
// them the login screen.
const OAuthClientSchema = new mongoose.Schema({
  clientId: { type: String, required: true, unique: true, index: true },
  clientSecret: { type: String, default: null }, // null for public clients (PKCE-only) — Claude/ChatGPT connectors are public clients
  clientName: { type: String, default: '' },
  redirectUris: [{ type: String, required: true }],
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('OAuthClient', OAuthClientSchema);
