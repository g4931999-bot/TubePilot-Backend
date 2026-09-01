const express = require('express');
const jwt = require('jsonwebtoken');
const { protect } = require('../middleware/auth');
const { getOAuthClient, exchangeCodeForTokens, getChannelInfo } = require('../utils/youtube');
const User = require('../models/User');

const router = express.Router();

// FRONTEND_URL may be a comma-separated list — use the first one to redirect back after OAuth
const PRIMARY_FRONTEND_URL = (process.env.FRONTEND_URL || '').split(',')[0].trim();
console.log(`ℹ️  YouTube OAuth callback will redirect back to: ${PRIMARY_FRONTEND_URL || '⚠️ EMPTY — check FRONTEND_URL in .env'}`);

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube'
];

// ⚠️ ADD: pick the best available thumbnail resolution instead of always
// using `default` (which is a tiny 88x88 image — fine for a list icon but
// noticeably soft/blurry anywhere it's shown larger, e.g. the Profile
// screen's subscriber card). YouTube's API returns thumbnails.default
// always, .medium/.high only when the channel has them — fall through in
// quality order so we always get the best one actually available.
const pickChannelThumbnail = (snippet) =>
  snippet?.thumbnails?.high?.url ||
  snippet?.thumbnails?.medium?.url ||
  snippet?.thumbnails?.default?.url ||
  '';

// @route GET /api/youtube/oauth/url?platform=mobile|web
// Returns the Google consent URL. We encode the user's id + platform in `state` (signed) so the
// callback (which Google redirects to, no auth header available) knows who connected and where to send them back.
router.get('/oauth/url', protect, (req, res) => {
  const oauth2Client = getOAuthClient();
  const platform = req.query.platform === 'mobile' ? 'mobile' : 'web';
  const state = jwt.sign({ id: req.user._id, platform }, process.env.JWT_SECRET, { expiresIn: '10m' });

  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // ensures refresh_token is always returned
    scope: SCOPES,
    state
  });

  res.json({ success: true, url });
});

// @route GET /api/youtube/oauth/callback
// Google redirects here after user grants permission.
router.get('/oauth/callback', async (req, res) => {
  let platform = 'web';
  try {
    const { code, state } = req.query;
    const decoded = jwt.verify(state, process.env.JWT_SECRET);
    platform = decoded.platform || 'web';
    const user = await User.findById(decoded.id);
    if (!user) throw new Error('User not found');

    const tokens = await exchangeCodeForTokens(code);
    const channel = await getChannelInfo(tokens.access_token);

    user.youtubeChannel = {
      channelId: channel.id,
      channelTitle: channel.snippet.title,
      thumbnail: pickChannelThumbnail(channel.snippet),
      subscriberCount: channel.statistics?.subscriberCount || '0',
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || user.youtubeChannel?.refreshToken,
      tokenExpiryDate: tokens.expiry_date,
      connectedAt: new Date()
    };
    await user.save();

    // Mobile (Flutter app, opened via external browser) -> bounce back into the app via a custom deep link
    // Web (Live Server / deployed site) -> redirect to the existing dashboard.html page
    if (platform === 'mobile') {
      res.redirect('tubepilot://oauth-success?youtube_connected=1');
    } else {
      res.redirect(`${PRIMARY_FRONTEND_URL}/dashboard.html?youtube_connected=1`);
    }
  } catch (err) {
    if (platform === 'mobile') {
      res.redirect(`tubepilot://oauth-success?youtube_connected=0&error=${encodeURIComponent(err.message)}`);
    } else {
      res.redirect(`${PRIMARY_FRONTEND_URL}/dashboard.html?youtube_connected=0&error=${encodeURIComponent(err.message)}`);
    }
  }
});

// @route DELETE /api/youtube/disconnect
router.delete('/disconnect', protect, async (req, res) => {
  req.user.youtubeChannel = null;
  await req.user.save();
  res.json({ success: true, message: 'YouTube channel disconnected' });
});

// @route GET /api/youtube/channel
router.get('/channel', protect, async (req, res) => {
  if (!req.user.youtubeChannel) {
    return res.status(404).json({ success: false, message: 'No YouTube channel connected' });
  }
  const { channelId, channelTitle, thumbnail, subscriberCount, connectedAt } = req.user.youtubeChannel;
  res.json({ success: true, channel: { channelId, channelTitle, thumbnail, subscriberCount, connectedAt } });
});

module.exports = router;
