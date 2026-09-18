const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const OAuthClient = require('../models/OAuthClient');
const OAuthCode = require('../models/OAuthCode');

const router = express.Router();

// -----------------------------------------------------------------------
// This is the "login screen that opens in a browser when the user connects
// TubePilot inside Claude or ChatGPT" — a standard OAuth 2.1 authorization
// server with PKCE (required for public clients like AI connectors, which
// can't safely hold a client secret).
//
// Flow:
//   1. GET  /oauth/authorize   — shows a web login+consent page
//   2. POST /oauth/authorize   — verifies email/password, issues a short-
//                                 lived authorization code, redirects back
//                                 to Claude/ChatGPT's redirect_uri
//   3. POST /oauth/token       — exchanges that code (+ PKCE verifier) for
//                                 a real access token
//
// The access token issued here is a NORMAL TubePilot JWT — same secret,
// same { id: user._id } payload as every other login method — so
// middleware/auth.js's `protect` works on it unchanged, and routes/mcp.js
// (below) can reuse `protect` directly for every tool call.
// -----------------------------------------------------------------------

const ACCESS_TOKEN_EXPIRES_IN = process.env.MCP_ACCESS_TOKEN_EXPIRES_IN || '30d';
const AUTH_CODE_TTL_MS = 10 * 60 * 1000;

const generateOpaqueToken = () => crypto.randomBytes(32).toString('hex');

const base64UrlEncode = (buffer) =>
  buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const verifyPkce = (codeVerifier, codeChallenge, method) => {
  if (method === 'plain') return codeVerifier === codeChallenge;
  const hash = crypto.createHash('sha256').update(codeVerifier).digest();
  return base64UrlEncode(hash) === codeChallenge;
};

// -----------------------------------------------------------------------
// Discovery endpoints — Claude and ChatGPT both probe these
// .well-known URLs automatically when a user tries to connect, so they
// can find /oauth/authorize, /oauth/token, and /oauth/register without
// TubePilot needing to be manually configured on their side beyond the
// initial submission.
// -----------------------------------------------------------------------
router.get('/.well-known/oauth-authorization-server', (req, res) => {
  const base = process.env.PUBLIC_BACKEND_URL || `${req.protocol}://${req.get('host')}`;
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256', 'plain'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post']
  });
});

router.get('/.well-known/oauth-protected-resource', (req, res) => {
  const base = process.env.PUBLIC_BACKEND_URL || `${req.protocol}://${req.get('host')}`;
  res.json({
    resource: `${base}/mcp`,
    authorization_servers: [base]
  });
});

// -----------------------------------------------------------------------
// Dynamic Client Registration (RFC 7591) — Claude/ChatGPT call this once,
// automatically, the first time anyone tries to add the TubePilot
// connector. Returns a client_id they'll use for every /authorize call
// after that. No auth required on this endpoint (that's normal for public
// client registration) — but redirect_uris are still validated at
// /authorize time against exactly what was registered here, so a stolen
// client_id alone can't redirect a code somewhere else.
// -----------------------------------------------------------------------
router.post('/register', async (req, res) => {
  try {
    const { redirect_uris, client_name } = req.body;
    if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
      return res.status(400).json({ error: 'invalid_client_metadata', error_description: 'redirect_uris is required' });
    }

    const clientId = crypto.randomBytes(16).toString('hex');
    await OAuthClient.create({
      clientId,
      clientSecret: null, // public client — PKCE only, matches Claude/ChatGPT's connector model
      clientName: client_name || 'MCP Client',
      redirectUris: redirect_uris
    });

    res.status(201).json({
      client_id: clientId,
      client_name: client_name || 'MCP Client',
      redirect_uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code']
    });
  } catch (err) {
    res.status(500).json({ error: 'server_error', error_description: err.message });
  }
});

// -----------------------------------------------------------------------
// GET /oauth/authorize — renders the actual login+consent page (opens in
// the user's browser, launched by Claude/ChatGPT). Boss's decision: a
// dedicated web page, not the app's own login screen.
// -----------------------------------------------------------------------
router.get('/authorize', async (req, res) => {
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method, response_type } = req.query;

  if (response_type !== 'code') {
    return res.status(400).send('Only response_type=code is supported.');
  }
  if (!client_id || !redirect_uri || !code_challenge) {
    return res.status(400).send('Missing required parameters (client_id, redirect_uri, code_challenge).');
  }

  const client = await OAuthClient.findOne({ clientId: client_id });
  if (!client || !client.redirectUris.includes(redirect_uri)) {
    return res.status(400).send('Unknown client or redirect_uri does not match what was registered.');
  }

  res.set('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Connect TubePilot</title>
  <style>
    body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; background:#f7f5fa; margin:0; padding:0; display:flex; align-items:center; justify-content:center; min-height:100vh; }
    .card { background:#fff; border-radius:20px; padding:32px 28px; width:100%; max-width:380px; box-shadow:0 8px 30px rgba(0,0,0,0.08); }
    h1 { font-size:20px; margin:0 0 4px; }
    p.sub { color:#777; font-size:13.5px; margin:0 0 24px; }
    label { display:block; font-size:12.5px; color:#555; margin-bottom:6px; font-weight:600; }
    input { width:100%; padding:12px 14px; border-radius:12px; border:1px solid #ddd; margin-bottom:16px; font-size:14px; box-sizing:border-box; }
    button { width:100%; padding:13px; border:none; border-radius:12px; background:#4a1d5c; color:#fff; font-weight:700; font-size:14.5px; cursor:pointer; }
    .error { color:#d9354c; font-size:13px; margin-bottom:12px; }
    .consent { font-size:12.5px; color:#888; margin-top:16px; line-height:1.5; text-align:center; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Connect TubePilot 💎</h1>
    <p class="sub">Log in to allow this assistant to generate titles, descriptions, hashtags, and schedule videos on your behalf.</p>
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="client_id" value="${client_id}" />
      <input type="hidden" name="redirect_uri" value="${redirect_uri}" />
      <input type="hidden" name="state" value="${state || ''}" />
      <input type="hidden" name="code_challenge" value="${code_challenge}" />
      <input type="hidden" name="code_challenge_method" value="${code_challenge_method || 'S256'}" />
      <label>Email or Phone</label>
      <input type="text" name="identifier" required autofocus />
      <label>Password</label>
      <input type="password" name="password" required />
      <button type="submit">Log in &amp; Connect</button>
    </form>
    <p class="consent">This lets the assistant use your existing TubePilot plan — free credits and diamond balance apply exactly as in the app.</p>
  </div>
</body>
</html>`);
});

// -----------------------------------------------------------------------
// POST /oauth/authorize — the login form's submit target. Verifies
// credentials the same way the app's normal email/password login does
// (User.comparePassword, from models/User.js), then issues a short-lived
// authorization code and redirects back to Claude/ChatGPT.
// -----------------------------------------------------------------------
router.post('/authorize', express.urlencoded({ extended: true }), async (req, res) => {
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method, identifier, password } = req.body;

  try {
    const client = await OAuthClient.findOne({ clientId: client_id });
    if (!client || !client.redirectUris.includes(redirect_uri)) {
      return res.status(400).send('Unknown client or redirect_uri mismatch.');
    }

    const user = await User.findOne({
      $or: [{ email: (identifier || '').toLowerCase().trim() }, { phone: identifier }]
    }).select('+password');

    if (!user || !user.password || !(await user.comparePassword(password))) {
      return res.status(401).send(`
        <html><body style="font-family:sans-serif;text-align:center;padding-top:80px;">
          <h3>Incorrect email/phone or password</h3>
          <a href="javascript:history.back()">Go back and try again</a>
        </body></html>
      `);
    }
    if (!user.isActive) {
      return res.status(403).send('This account is inactive.');
    }

    const code = generateOpaqueToken();
    await OAuthCode.create({
      code,
      user: user._id,
      clientId: client_id,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      codeChallengeMethod: code_challenge_method || 'S256'
    });

    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set('code', code);
    if (state) redirectUrl.searchParams.set('state', state);

    res.redirect(redirectUrl.toString());
  } catch (err) {
    res.status(500).send(`Server error: ${err.message}`);
  }
});

// -----------------------------------------------------------------------
// POST /oauth/token — exchanges the authorization code (+ PKCE verifier)
// for a real access token. The access token is a standard TubePilot JWT
// (jwt.sign with the SAME process.env.JWT_SECRET used everywhere else),
// so middleware/auth.js's `protect` validates it with zero changes.
//
// Signup-on-first-connect: if this is the very first time this user logs
// in via MCP with an account that somehow doesn't exist yet, this endpoint
// does NOT create one — the login form above only accepts existing
// TubePilot accounts, same as Boss's "user hamare app mein login kare"
// requirement. A brand-new visitor must sign up in the app first, then
// connect via MCP — this keeps the 20-free-credit default exactly as
// defined on the User schema, with no separate MCP-only signup path.
// -----------------------------------------------------------------------
router.post('/token', express.urlencoded({ extended: true }), express.json(), async (req, res) => {
  try {
    const { grant_type, code, redirect_uri, code_verifier, refresh_token, client_id } = req.body;

    if (grant_type === 'authorization_code') {
      if (!code || !code_verifier) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'code and code_verifier are required' });
      }

      const authCode = await OAuthCode.findOne({ code });
      if (!authCode || authCode.used) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code is invalid or already used' });
      }
      if (Date.now() - authCode.createdAt.getTime() > AUTH_CODE_TTL_MS) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code has expired' });
      }
      if (redirect_uri && authCode.redirectUri !== redirect_uri) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      }
      if (!verifyPkce(code_verifier, authCode.codeChallenge, authCode.codeChallengeMethod)) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
      }

      authCode.used = true;
      await authCode.save();

      const user = await User.findById(authCode.user);
      if (!user || !user.isActive) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'User not found or inactive' });
      }

      const accessToken = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRES_IN });
      const refreshTokenValue = generateOpaqueToken();
      user.refreshTokens = [...(user.refreshTokens || []), refreshTokenValue];
      await user.save();

      return res.json({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 60 * 60 * 24 * 30, // 30 days, matches ACCESS_TOKEN_EXPIRES_IN default
        refresh_token: refreshTokenValue,
        scope: 'tubepilot'
      });
    }

    if (grant_type === 'refresh_token') {
      if (!refresh_token) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'refresh_token is required' });
      }
      const user = await User.findOne({ refreshTokens: refresh_token });
      if (!user || !user.isActive) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'Refresh token is invalid or revoked' });
      }

      const accessToken = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRES_IN });
      return res.json({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 60 * 60 * 24 * 30,
        refresh_token, // rotate later if you want stricter security; kept stable for now
        scope: 'tubepilot'
      });
    }

    res.status(400).json({ error: 'unsupported_grant_type' });
  } catch (err) {
    res.status(500).json({ error: 'server_error', error_description: err.message });
  }
});

module.exports = router;
