const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const User = require('../models/User');
const OAuthClient = require('../models/OAuthClient');
const OAuthCode = require('../models/OAuthCode');
const { generateUserId, generateReferralCode } = require('../utils/idGenerator');

const router = express.Router();
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const ACCESS_TOKEN_EXPIRES_IN = process.env.MCP_ACCESS_TOKEN_EXPIRES_IN || '30d';
const AUTH_CODE_TTL_MS = 10 * 60 * 1000;
const MCP_FIRST_CONNECT_DIAMONDS = 20;

const generateOpaqueToken = () => crypto.randomBytes(32).toString('hex');

const base64UrlEncode = (buffer) =>
  buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const verifyPkce = (codeVerifier, codeChallenge, method) => {
  if (method === 'plain') return codeVerifier === codeChallenge;
  const hash = crypto.createHash('sha256').update(codeVerifier).digest();
  return base64UrlEncode(hash) === codeChallenge;
};

const issueAuthCode = async ({ client_id, redirect_uri, state, code_challenge, code_challenge_method, userId }) => {
  const code = generateOpaqueToken();
  await OAuthCode.create({
    code,
    user: userId,
    clientId: client_id,
    redirectUri: redirect_uri,
    codeChallenge: code_challenge,
    codeChallengeMethod: code_challenge_method || 'S256'
  });

  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set('code', code);
  if (state) redirectUrl.searchParams.set('state', state);
  return redirectUrl.toString();
};

// -----------------------------------------------------------------------
// Dynamic Client Registration (RFC 7591)
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
      clientSecret: null,
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
// 🎨 Shared brand styles for the OAuth HTML pages below — pulled from the
// Flutter app's LoginScreen (lib/screens/login_screen.dart) + app_theme
// so this "connect" screen looks like it's part of TubePilot, not a
// generic third-party consent page.
//   - background: #FAF7FC (LoginScreen's Scaffold backgroundColor)
//   - watermark: faint repeated outlined play-icon grid (AppBrandBackground)
//   - logo: rounded outlined play-icon (LoginScreen's splash.png / fallback)
//   - Google button: OUTLINED (OutlinedButton.icon), not filled
//   - inputs: label-above, soft rose border
//   - submit button: solid brand-purple gradient (GradientButton)
// -----------------------------------------------------------------------
const BRAND_PURPLE_DARK = '#3d1440';
const BRAND_PURPLE = '#4a1d5c';
const BRAND_PURPLE_LIGHT = '#7c3aed';
const BRAND_BORDER_ROSE = '#f1d9e6';
const BRAND_TEXT_DIM = '#8a8494';

// Faint repeated play-icon watermark, as an inline SVG data URI tiled via
// background-repeat — approximates AppBrandBackground without needing any
// extra asset file.
const watermarkCss = `
  background-color: ${'#FAF7FC'};
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120' viewBox='0 0 120 120'%3E%3Crect x='30' y='30' width='36' height='36' rx='10' fill='none' stroke='%23e7defc' stroke-width='2.5'/%3E%3Cpath d='M44 42 L58 48 L44 54 Z' fill='none' stroke='%23e7defc' stroke-width='2.5' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: repeat;
`;

const brandPageStyles = `
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: -apple-system, Segoe UI, Roboto, sans-serif;
      ${watermarkCss}
      margin: 0;
      padding: 20px 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .card {
      background: #fff;
      border-radius: 22px;
      padding: 34px 26px 26px;
      width: 100%;
      max-width: 400px;
      box-shadow: 0 10px 34px rgba(61,20,64,0.10);
      text-align: center;
    }
    .logo-badge {
      width: 64px;
      height: 64px;
      margin: 0 auto 18px;
      border-radius: 18px;
      border: 2px solid ${BRAND_PURPLE};
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .logo-badge svg { width: 26px; height: 26px; }
    h2 {
      font-size: 22px;
      font-weight: 800;
      margin: 0 0 4px;
      color: #1a1224;
    }
    p.sub {
      color: ${BRAND_TEXT_DIM};
      font-size: 13.5px;
      margin: 0 0 22px;
      line-height: 1.5;
    }
    .benefit-banner {
      background: linear-gradient(135deg, #f3e8ff, #ede9fe);
      border: 1px solid #ddd6fe;
      border-radius: 12px;
      padding: 12px 14px;
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      gap: 10px;
      text-align: left;
    }
    .benefit-banner .gem { font-size: 22px; }
    .benefit-banner .text { font-size: 12.5px; color: ${BRAND_PURPLE}; line-height: 1.45; }
    .benefit-banner .text strong { display: block; font-weight: 700; }
    #google-signin-btn {
      display: flex;
      justify-content: center;
      margin-bottom: 18px;
      min-height: 44px;
    }
    .google-btn-fallback {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding: 12px 14px;
      border-radius: 12px;
      border: 1.5px solid ${BRAND_PURPLE};
      background: #fff;
      color: #1a1224;
      font-weight: 600;
      font-size: 14.5px;
    }
    .divider {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 0 0 18px;
      color: #ccc;
      font-size: 12px;
    }
    .divider::before, .divider::after {
      content: '';
      flex: 1;
      height: 1px;
      background: #eee;
    }
    label {
      display: block;
      font-size: 12.5px;
      color: ${BRAND_TEXT_DIM};
      margin-bottom: 5px;
      font-weight: 600;
      text-align: left;
    }
    input[type=text], input[type=password] {
      width: 100%;
      padding: 12px 14px;
      border-radius: 12px;
      border: 1.5px solid ${BRAND_BORDER_ROSE};
      margin-bottom: 14px;
      font-size: 14px;
      outline: none;
      transition: border-color 0.15s;
    }
    input:focus { border-color: ${BRAND_PURPLE_LIGHT}; }
    .forgot-row {
      text-align: right;
      margin-top: -10px;
      margin-bottom: 14px;
    }
    .forgot-row a {
      font-size: 12px;
      color: ${BRAND_PURPLE_LIGHT};
      text-decoration: none;
    }
    button[type=submit] {
      width: 100%;
      padding: 14px;
      border: none;
      border-radius: 12px;
      background: linear-gradient(135deg, ${BRAND_PURPLE_DARK}, ${BRAND_PURPLE});
      color: #fff;
      font-weight: 700;
      font-size: 15px;
      cursor: pointer;
      transition: opacity 0.15s;
    }
    button[type=submit]:hover { opacity: 0.92; }
    .error-box {
      background: #fff1f2;
      border: 1px solid #fecdd3;
      border-radius: 10px;
      color: #be123c;
      font-size: 13px;
      padding: 10px 14px;
      margin-bottom: 14px;
      text-align: left;
    }
    .signup-cta {
      text-align: center;
      font-size: 13px;
      color: ${BRAND_TEXT_DIM};
      margin-top: 16px;
    }
    .signup-cta a {
      color: ${BRAND_PURPLE_LIGHT};
      font-weight: 700;
      text-decoration: none;
    }
    .consent {
      font-size: 11.5px;
      color: #b7b0c0;
      margin-top: 18px;
      line-height: 1.5;
      text-align: center;
    }
    #google-error { display: none; }
`;

const logoBadgeSvg = `
  <div class="logo-badge">
    <svg viewBox="0 0 24 24" fill="none" stroke="${BRAND_PURPLE}" stroke-width="2">
      <rect x="3" y="3" width="18" height="18" rx="6" />
      <path d="M10 8.5 L16 12 L10 15.5 Z" fill="${BRAND_PURPLE}" stroke="none" />
    </svg>
  </div>
`;

// -----------------------------------------------------------------------
// GET /oauth/authorize — renders the login+consent page, now styled to
// match the TubePilot app's own LoginScreen (see brandPageStyles above).
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

  const appStoreUrl = process.env.PUBLIC_APP_STORE_URL || 'https://play.google.com/store/search?q=tubepilot';
  const forgotPasswordUrl = process.env.PUBLIC_FORGOT_PASSWORD_URL || `${process.env.PUBLIC_FRONTEND_URL || 'https://tubepilot.app'}/forgot-password`;

  res.set('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Connect TubePilot</title>
  <script src="https://accounts.google.com/gsi/client" async defer></script>
  <style>${brandPageStyles}</style>
</head>
<body>
  <div class="card">
    ${logoBadgeSvg}

    <h2>Welcome back</h2>
    <p class="sub">Log in to allow this assistant to generate titles, descriptions, hashtags, and schedule videos on your behalf.</p>

    <div class="benefit-banner">
      <div class="gem">💎</div>
      <div class="text">
        <strong>20 free diamonds on first connect!</strong>
        Log in to your TubePilot account and get 20 diamonds added automatically — use them for AI titles, descriptions, or uploads.
      </div>
    </div>

    <div id="google-error" class="error-box"></div>

    <div id="google-signin-btn"></div>

    <div class="divider">or continue with email</div>

    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="client_id" value="${client_id}" />
      <input type="hidden" name="redirect_uri" value="${redirect_uri}" />
      <input type="hidden" name="state" value="${state || ''}" />
      <input type="hidden" name="code_challenge" value="${code_challenge}" />
      <input type="hidden" name="code_challenge_method" value="${code_challenge_method || 'S256'}" />

      <label>Email or Phone</label>
      <input type="text" name="identifier" required autofocus autocomplete="username" />

      <label>Password</label>
      <input type="password" name="password" required autocomplete="current-password" />

      <div class="forgot-row">
        <a href="${forgotPasswordUrl}" target="_blank" rel="noopener">Forgot password?</a>
      </div>

      <button type="submit">Log in &amp; Connect</button>
    </form>

    <div class="signup-cta">
      Don't have an account?
      <a href="${appStoreUrl}" target="_blank" rel="noopener">Download TubePilot &amp; Sign up →</a>
    </div>

    <p class="consent">
      By connecting, you allow this assistant to use your existing TubePilot plan —
      free credits and diamond balance apply exactly as in the app.
    </p>
  </div>

  <script>
    function handleGoogleCredential(response) {
      var form = document.querySelector('form');
      var errorBox = document.getElementById('google-error');
      errorBox.style.display = 'none';

      fetch('/oauth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idToken: response.credential,
          client_id: form.client_id.value,
          redirect_uri: form.redirect_uri.value,
          state: form.state.value,
          code_challenge: form.code_challenge.value,
          code_challenge_method: form.code_challenge_method.value
        })
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.redirect) {
            window.location.href = data.redirect;
          } else {
            errorBox.textContent = data.error_description || 'Google sign-in failed. Please try again.';
            errorBox.style.display = 'block';
          }
        })
        .catch(function () {
          errorBox.textContent = 'Google sign-in failed. Please try again.';
          errorBox.style.display = 'block';
        });
    }

    window.onload = function () {
      if (!window.google || !window.google.accounts) return;
      google.accounts.id.initialize({
        client_id: '${process.env.GOOGLE_CLIENT_ID}',
        callback: handleGoogleCredential
      });
      google.accounts.id.renderButton(
        document.getElementById('google-signin-btn'),
        { theme: 'outline', size: 'large', shape: 'pill', width: 336, text: 'continue_with', logo_alignment: 'left' }
      );
    };
  </script>
</body>
</html>`);
});

// -----------------------------------------------------------------------
// POST /oauth/authorize — email/password submit target.
// -----------------------------------------------------------------------
router.post('/authorize', express.urlencoded({ extended: true }), async (req, res) => {
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method, identifier, password } = req.body;

  const appStoreUrl = process.env.PUBLIC_APP_STORE_URL || 'https://play.google.com/store/search?q=tubepilot';

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
        <!DOCTYPE html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Login Failed — TubePilot</title>
          <style>${brandPageStyles}
            .card { text-align: center; }
            h3 { color:#be123c; margin:0 0 8px; font-size:17px; }
            p.msg { color:${BRAND_TEXT_DIM}; font-size:13.5px; line-height:1.5; margin:0 0 20px; }
            a.btn { display:inline-block; padding:12px 26px; border-radius:12px; background:linear-gradient(135deg, ${BRAND_PURPLE_DARK}, ${BRAND_PURPLE}); color:#fff; font-weight:700; text-decoration:none; font-size:14px; }
          </style>
        </head>
        <body>
          <div class="card">
            ${logoBadgeSvg}
            <h3>❌ Incorrect email/phone or password</h3>
            <p class="msg">Please check your credentials and try again. Make sure you're using the same email/phone you registered with in the TubePilot app.</p>
            <a class="btn" href="javascript:history.back()">Try again</a>
            <div class="signup-cta">
              New to TubePilot?
              <a href="${appStoreUrl}" target="_blank" rel="noopener">Download the app &amp; sign up →</a>
            </div>
          </div>
        </body>
        </html>
      `);
    }

    if (!user.isActive) {
      return res.status(403).send('This account is inactive. Please contact TubePilot support.');
    }

    const redirectUrl = await issueAuthCode({ client_id, redirect_uri, state, code_challenge, code_challenge_method, userId: user._id });
    res.redirect(redirectUrl);
  } catch (err) {
    res.status(500).send(`Server error: ${err.message}`);
  }
});

// -----------------------------------------------------------------------
// POST /oauth/google
// -----------------------------------------------------------------------
router.post('/google', express.json(), async (req, res) => {
  try {
    const { idToken, client_id, redirect_uri, state, code_challenge, code_challenge_method } = req.body;

    if (!idToken) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'idToken is required' });
    }
    if (!client_id || !redirect_uri || !code_challenge) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'Missing OAuth parameters' });
    }

    const client = await OAuthClient.findOne({ clientId: client_id });
    if (!client || !client.redirectUris.includes(redirect_uri)) {
      return res.status(400).json({ error: 'invalid_client', error_description: 'Unknown client or redirect_uri mismatch' });
    }

    const ticket = await googleClient.verifyIdToken({ idToken, audience: process.env.GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();

    let user = await User.findOne({ googleId: payload.sub });
    if (!user) {
      user = await User.findOne({ email: payload.email });
    }

    if (!user) {
      const userId = await generateUserId();
      const referralCode = await generateReferralCode(userId);
      user = await User.create({
        userId,
        name: payload.name,
        email: payload.email,
        avatar: payload.picture,
        googleId: payload.sub,
        authProvider: 'google',
        referralCode,
        freeUploadsRemaining: Number(process.env.FREE_UPLOADS_PER_MONTH || 20)
      });
    } else if (!user.googleId) {
      user.googleId = payload.sub;
      user.authProvider = 'google';
      await user.save();
    }

    if (!user.isActive) {
      return res.status(403).json({ error: 'access_denied', error_description: 'This account is inactive. Please contact TubePilot support.' });
    }

    const redirectUrl = await issueAuthCode({ client_id, redirect_uri, state, code_challenge, code_challenge_method, userId: user._id });
    res.json({ redirect: redirectUrl });
  } catch (err) {
    console.error('❌ [OAuth Google] failed:', err.stack || err.message);
    res.status(401).json({ error: 'access_denied', error_description: 'Google authentication failed: ' + err.message });
  }
});

// -----------------------------------------------------------------------
// POST /oauth/token
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

      if (!user.mcpConnectedAt) {
        user.mcpConnectedAt = new Date();
        user.diamondBalance = (user.diamondBalance || 0) + MCP_FIRST_CONNECT_DIAMONDS;
        console.log(`💎 [MCP] First connect for user ${user._id} — awarded ${MCP_FIRST_CONNECT_DIAMONDS} diamonds (balance now ${user.diamondBalance})`);
      }

      const accessToken = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRES_IN });
      const refreshTokenValue = generateOpaqueToken();
      user.refreshTokens = [...(user.refreshTokens || []), refreshTokenValue];
      await user.save();

      return res.json({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 60 * 60 * 24 * 30,
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
        refresh_token,
        scope: 'tubepilot'
      });
    }

    res.status(400).json({ error: 'unsupported_grant_type' });
  } catch (err) {
    res.status(500).json({ error: 'server_error', error_description: err.message });
  }
});

module.exports = router;
