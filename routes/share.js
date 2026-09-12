const express = require('express');
const router = express.Router();

// ⚠️ NEW (Boss request — Share button should open the app if installed,
// else Play Store). This is the classic "smart-link" pattern: the shared
// link points here (a normal https:// page anyone can open), which tries
// the app's custom URL scheme immediately, and falls back to the Play
// Store after a short timeout if the app didn't intercept it. This does
// NOT require Android App Links / assetlinks.json verification — but it
// also means some strict in-app browsers (e.g. certain WhatsApp/Instagram
// webviews) may block the custom-scheme redirect. A verified Android App
// Link is more reliable but needs the real package name + a signing-key
// SHA256 fingerprint hosted at /.well-known/assetlinks.json — ask Boss if
// that level of reliability is wanted later.
const ANDROID_PACKAGE = process.env.ANDROID_PACKAGE_NAME || 'com.tubepilot.app';
const APP_SCHEME = process.env.APP_URL_SCHEME || 'tubepilot';

router.get('/v/:videoId', (req, res) => {
  const { videoId } = req.params;
  const deepLink = `${APP_SCHEME}://video/${videoId}`;
  const storeLink = `https://play.google.com/store/apps/details?id=${ANDROID_PACKAGE}`;

  res.set('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Opening TubePilot…</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body style="font-family: sans-serif; text-align: center; padding-top: 60px;">
  <p>Opening in TubePilot…</p>
  <p>If nothing happens, <a href="${storeLink}">tap here to get the app</a>.</p>
  <script>
    window.location = "${deepLink}";
    setTimeout(function () { window.location = "${storeLink}"; }, 1500);
  </script>
</body>
</html>`);
});

module.exports = router;
