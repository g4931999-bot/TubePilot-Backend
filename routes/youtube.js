const express = require('express');
const jwt = require('jsonwebtoken');
const { protect } = require('../middleware/auth');
const {
  getOAuthClient, exchangeCodeForTokens, refreshAccessToken, getChannelInfo,
  listChannelVideos, updateVideoMetadataOnYoutube, isInvalidGrantError
} = require('../utils/youtube');
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

// ⚠️ NEW (Boss request — Option B): if the stored access token is expired
// (or about to expire in the next 60s), refresh it via the stored refresh
// token and persist the new token/expiry on the user doc. Shared by both
// new routes below so a creator's channel access never silently fails
// mid-session just because the token aged out.
const ensureFreshAccessToken = async (user) => {
  const { accessToken, refreshToken, tokenExpiryDate } = user.youtubeChannel;
  const isExpiringSoon = tokenExpiryDate && Date.now() > tokenExpiryDate - 60000;
  if (!isExpiringSoon) return accessToken;

  const creds = await refreshAccessToken(refreshToken);
  user.youtubeChannel.accessToken = creds.access_token;
  user.youtubeChannel.tokenExpiryDate = creds.expiry_date;
  await user.save();
  return creds.access_token;
};

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

// @route GET /api/youtube/my-videos
// ⚠️ NEW (Boss request — Option B): real videos straight from the
// connected YouTube channel — includes already-published videos, unlike
// GET /api/videos?status=queued which only knows about videos uploaded
// through TubePilot itself.
router.get('/my-videos', protect, async (req, res) => {
  try {
    if (!req.user.youtubeChannel) {
      return res.status(404).json({ success: false, message: 'No YouTube channel connected' });
    }
    const accessToken = await ensureFreshAccessToken(req.user);
    const videos = await listChannelVideos(accessToken);
    res.json({ success: true, videos });
  } catch (err) {
    if (isInvalidGrantError(err)) {
      return res.status(401).json({ success: false, code: 'YOUTUBE_RECONNECT_REQUIRED', message: 'Your YouTube connection expired — please reconnect your channel.' });
    }
    res.status(500).json({ success: false, message: err.message || 'Could not load channel videos' });
  }
});

// @route PATCH /api/youtube/my-videos/:videoId
// ⚠️ NEW (Boss request — Option B): writes title/description straight to
// an already-live YouTube video via the YouTube Data API — separate from
// PATCH /api/videos/:id/metadata, which only updates TubePilot's own DB
// record for videos it uploaded itself.
router.patch('/my-videos/:videoId', protect, async (req, res) => {
  try {
    if (!req.user.youtubeChannel) {
      return res.status(404).json({ success: false, message: 'No YouTube channel connected' });
    }
    const { title, description } = req.body;
    if (!title && !description) {
      return res.status(400).json({ success: false, message: 'Provide a title and/or description to update' });
    }
    const accessToken = await ensureFreshAccessToken(req.user);
    const { refreshToken } = req.user.youtubeChannel;
    const updated = await updateVideoMetadataOnYoutube({ accessToken, refreshToken, videoId: req.params.videoId, title, description });
    res.json({ success: true, video: updated });
  } catch (err) {
    if (isInvalidGrantError(err)) {
      return res.status(401).json({ success: false, code: 'YOUTUBE_RECONNECT_REQUIRED', message: 'Your YouTube connection expired — please reconnect your channel.' });
    }
    res.status(err.status || 500).json({ success: false, message: err.message || 'Could not update this video' });
  }
});

module.exports = router;
