const express = require('express');
const jwt = require('jsonwebtoken');
const { protect } = require('../middleware/auth');
const upload = require('../middleware/upload');
const { Readable } = require('stream');
const {
  getOAuthClient, exchangeCodeForTokens, refreshAccessToken, getChannelInfo,
  listChannelVideos, updateVideoMetadataOnYoutube, deleteVideoFromYoutube,
  setThumbnail, isInvalidGrantError
} = require('../utils/youtube');
const User = require('../models/User');
const { onChannelConnected } = require('../utils/milestones');

const router = express.Router();

const PRIMARY_FRONTEND_URL = (process.env.FRONTEND_URL || '').split(',')[0].trim();
console.log(`ℹ️  YouTube OAuth callback will redirect back to: ${PRIMARY_FRONTEND_URL || '⚠️ EMPTY — check FRONTEND_URL in .env'}`);

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube'
];

const pickChannelThumbnail = (snippet) =>
  snippet?.thumbnails?.high?.url ||
  snippet?.thumbnails?.medium?.url ||
  snippet?.thumbnails?.default?.url ||
  '';

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

// ⚠️ NEW: extra channel info for GET /channel (niche for AI ideas + live subscriber count).
// Cached per user+channel for 6 hours so the home/profile screens stay fast.
const channelExtraCache = new Map(); // key: userId:channelId -> { category, subscriberCount, at }
const CHANNEL_EXTRA_TTL = 6 * 60 * 60 * 1000;

// "Niche" for AI ideas, taken from YouTube's own topic data, else channel keywords.
const deriveNiche = (info) => {
  const topics = (info?.topicDetails?.topicCategories || [])
    .map((u) => {
      try { return decodeURIComponent(String(u).split('/').pop()).replace(/_/g, ' '); } catch (_) { return ''; }
    })
    .filter(Boolean);
  if (topics.length) return [...new Set(topics)].slice(0, 3).join(', ');

  const kw = info?.brandingSettings?.channel?.keywords;
  if (kw) return String(kw).replace(/"/g, '').split(/\s+/).filter(Boolean).slice(0, 5).join(' ');
  return '';
};

router.get('/oauth/url', protect, (req, res) => {
  const oauth2Client = getOAuthClient();
  const platform = req.query.platform === 'mobile' ? 'mobile' : 'web';
  const state = jwt.sign({ id: req.user._id, platform }, process.env.JWT_SECRET, { expiresIn: '10m' });

  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state
  });

  res.json({ success: true, url });
});

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

    // ⚠️ NEW: brand-new channel -> milestone card can show now; channel already in our DB -> card after 15 days
    onChannelConnected(user).catch((e) => console.error('Milestone on connect failed:', e.message));

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

router.delete('/disconnect', protect, async (req, res) => {
  req.user.youtubeChannel = null;
  await req.user.save();
  res.json({ success: true, message: 'YouTube channel disconnected' });
});

// ⚠️ UPDATED: now also returns `category` (niche for AI ideas) and a live subscriberCount.
router.get('/channel', protect, async (req, res) => {
  if (!req.user.youtubeChannel) {
    return res.status(404).json({ success: false, message: 'No YouTube channel connected' });
  }
  const { channelId, channelTitle, thumbnail, subscriberCount, connectedAt } = req.user.youtubeChannel;

  let category = '';
  let liveSubs = subscriberCount;
  const key = `${req.user._id}:${channelId}`;
  const hit = channelExtraCache.get(key);

  if (hit && Date.now() - hit.at < CHANNEL_EXTRA_TTL) {
    category = hit.category;
    liveSubs = hit.subscriberCount ?? subscriberCount;
  } else {
    try {
      const accessToken = await ensureFreshAccessToken(req.user);
      const info = await getChannelInfo(accessToken);
      category = deriveNiche(info);
      if (info?.statistics?.subscriberCount != null) liveSubs = info.statistics.subscriberCount;
      channelExtraCache.set(key, { category, subscriberCount: liveSubs, at: Date.now() });
    } catch (e) {
      // Never break the profile/home screen because of this extra info.
      console.error('⚠️ [YouTube] channel extra info failed:', e.message);
    }
  }

  res.json({
    success: true,
    channel: { channelId, channelTitle, thumbnail, subscriberCount: liveSubs, connectedAt, category }
  });
});

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

// ⚠️ UPDATED (Boss request — My Videos edit sheet needs to save tags too)
router.patch('/my-videos/:videoId', protect, async (req, res) => {
  try {
    if (!req.user.youtubeChannel) {
      return res.status(404).json({ success: false, message: 'No YouTube channel connected' });
    }
    const { title, description, tags } = req.body;
    if (!title && !description && !tags) {
      return res.status(400).json({ success: false, message: 'Provide a title, description, and/or tags to update' });
    }
    const accessToken = await ensureFreshAccessToken(req.user);
    const { refreshToken } = req.user.youtubeChannel;
    const parsedTags = Array.isArray(tags) ? tags : (tags !== undefined ? String(tags).split(',').map((t) => t.trim()).filter(Boolean) : undefined);
    const updated = await updateVideoMetadataOnYoutube({ accessToken, refreshToken, videoId: req.params.videoId, title, description, tags: parsedTags });
    res.json({ success: true, video: updated });
  } catch (err) {
    if (isInvalidGrantError(err)) {
      return res.status(401).json({ success: false, code: 'YOUTUBE_RECONNECT_REQUIRED', message: 'Your YouTube connection expired — please reconnect your channel.' });
    }
    res.status(err.status || 500).json({ success: false, message: err.message || 'Could not update this video' });
  }
});

// ⚠️ NEW (Boss request — "My Videos" screen thumbnail change, for a video
// that ONLY exists on YouTube, no matching TubePilot DB record).
router.patch('/my-videos/:videoId/thumbnail', protect, upload.single('thumbnail'), async (req, res) => {
  try {
    if (!req.user.youtubeChannel) {
      return res.status(404).json({ success: false, message: 'No YouTube channel connected' });
    }
    if (!req.file) return res.status(400).json({ success: false, message: 'thumbnail file is required' });

    const accessToken = await ensureFreshAccessToken(req.user);
    const { refreshToken } = req.user.youtubeChannel;
    await setThumbnail({
      accessToken,
      refreshToken,
      videoId: req.params.videoId,
      thumbnailStream: Readable.from(req.file.buffer)
    });
    res.json({ success: true, message: 'Thumbnail updated' });
  } catch (err) {
    if (isInvalidGrantError(err)) {
      return res.status(401).json({ success: false, code: 'YOUTUBE_RECONNECT_REQUIRED', message: 'Your YouTube connection expired — please reconnect your channel.' });
    }
    res.status(err.status || 500).json({ success: false, message: err.message || 'Could not update thumbnail' });
  }
});

// ⚠️ NEW (Boss request — My Videos delete, for a video that ONLY exists
// on YouTube, no matching TubePilot DB record so there's nothing to clean
// up on our own database side).
router.delete('/my-videos/:videoId', protect, async (req, res) => {
  try {
    if (!req.user.youtubeChannel) {
      return res.status(404).json({ success: false, message: 'No YouTube channel connected' });
    }
    const accessToken = await ensureFreshAccessToken(req.user);
    const { refreshToken } = req.user.youtubeChannel;
    await deleteVideoFromYoutube({ accessToken, refreshToken, videoId: req.params.videoId });
    res.json({ success: true, message: 'Video deleted from YouTube' });
  } catch (err) {
    if (isInvalidGrantError(err)) {
      return res.status(401).json({ success: false, code: 'YOUTUBE_RECONNECT_REQUIRED', message: 'Your YouTube connection expired — please reconnect your channel.' });
    }
    res.status(err.status || 500).json({ success: false, message: err.message || 'Could not delete this video' });
  }
});

module.exports = router;
