const express = require('express');
const { protect } = require('../middleware/auth');
const Video = require('../models/Video');
const Competitor = require('../models/Competitor');
const { refreshAccessToken, isInvalidGrantError } = require('../utils/youtube');
const { fetchCompetitorStats } = require('../utils/youtubePublic');
const { google } = require('googleapis');
const router = express.Router();

// @route GET /api/analytics
// Note: real "Views / Watch Time / CTR / Subscribers" numbers must come from the
// YouTube Analytics API (youtubeAnalytics.reports.query) using the connected channel's
// access token — plug that call in here once the channel has enough data.
router.get('/', protect, async (req, res) => {
  try {
    const userId = req.user._id;
    const fourteenDaysAgo = new Date();
    fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 13);
    fourteenDaysAgo.setHours(0, 0, 0, 0);

    const [uploadCount, scheduledQueue, failedUploads, trendRows, recentActivity] = await Promise.all([
      Video.countDocuments({ user: userId, status: 'uploaded' }),
      Video.countDocuments({ user: userId, status: 'queued' }),
      Video.countDocuments({ user: userId, status: 'failed' }),
      // Daily upload counts for the last 14 days, for the trend chart
      Video.aggregate([
        { $match: { user: userId, status: 'uploaded', createdAt: { $gte: fourteenDaysAgo } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } }
      ]),
      // Most recent 15 videos, for the activity/usage list
      Video.find({ user: userId })
        .sort({ createdAt: -1 })
        .limit(15)
        .select('title status diamondsCharged usedFreeUpload createdAt')
    ]);

    // Build a full 14-day array (including zero-count days) so the chart has consistent x-axis points
    const trendMap = {};
    trendRows.forEach((r) => { trendMap[r._id] = r.count; });
    const uploadTrend = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(fourteenDaysAgo);
      d.setDate(d.getDate() + i);
      const key = d.toISOString().slice(0, 10);
      uploadTrend.push({ date: key, count: trendMap[key] || 0 });
    }

    res.json({
      success: true,
      analytics: {
        uploadCount,
        remainingUploadCredits: req.user.diamondBalance,
        freeUploadsLeft: req.user.freeUploadsRemaining,
        scheduledQueue,
        failedUploads,
        uploadTrend,
        recentActivity
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Competitor Tracking
// ---------------------------------------------------------------------------

// @route GET /api/analytics/competitors/search?q=tube
// Live channel-name search for the "add competitor" autocomplete — used by
// the Competitor Radar screen's search field so the user can type a partial
// name (e.g. "tube") and pick from real matching YouTube channels instead
// of typing an exact @handle or channel ID.
//
// Uses YouTube Data API's public search.list (type=channel) with the same
// YOUTUBE_DATA_API_KEY the app already relies on for public stats (see
// utils/youtubePublic.js) — no separate credential needed.
//
// IMPORTANT: this route must stay registered ABOVE any '/competitors/:id'
// style route, otherwise Express would try to match "search" as an :id.
router.get('/competitors/search', protect, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json({ success: true, results: [] });

    const apiKey = process.env.YOUTUBE_DATA_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ success: false, message: 'YouTube search is unavailable — YOUTUBE_DATA_API_KEY not configured on the server.' });
    }

    const youtube = google.youtube({ version: 'v3', auth: apiKey });
    const searchRes = await youtube.search.list({
      part: 'snippet',
      type: 'channel',
      q,
      maxResults: 8
    });

    const results = (searchRes.data.items || []).map((item) => ({
      channelId: item.snippet.channelId,
      title: item.snippet.title,
      description: item.snippet.description,
      thumbnail: item.snippet.thumbnails?.default?.url || ''
    }));

    res.json({ success: true, results });
  } catch (err) {
    console.error('❌ [Competitor Search] failed:', err.response?.data || err.message);
    res.status(500).json({ success: false, message: 'Search failed. Please try again.' });
  }
});

// @route GET /api/analytics/competitors
// Lists this user's tracked competitors. Any competitor whose cached stats
// are missing or older than 6 hours gets refreshed inline before returning
// (best-effort — a refresh failure for one competitor never blocks the rest
// of the list, it just carries its previous cache + an `error` note).
router.get('/competitors', protect, async (req, res) => {
  try {
    const competitors = await Competitor.find({ user: req.user._id }).sort({ createdAt: -1 });
    const STALE_MS = 6 * 60 * 60 * 1000;

    await Promise.all(
      competitors.map(async (c) => {
        const isStale = !c.lastStats?.fetchedAt || Date.now() - new Date(c.lastStats.fetchedAt).getTime() > STALE_MS;
        if (!isStale) return;
        try {
          c.lastStats = await fetchCompetitorStats({ channelId: c.channelId, handle: c.handle });
          await c.save();
        } catch (err) {
          c.lastStats = { ...(c.lastStats?.toObject ? c.lastStats.toObject() : c.lastStats), error: err.message, fetchedAt: c.lastStats?.fetchedAt || null };
          await c.save();
        }
      })
    );

    res.json({ success: true, competitors });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route POST /api/analytics/competitors  { channelId?, handle?, label? }
router.post('/competitors', protect, async (req, res) => {
  try {
    const { channelId, handle, label } = req.body;
    if (!channelId && !handle) {
      return res.status(400).json({ success: false, message: 'Provide either channelId or handle' });
    }

    const existing = await Competitor.findOne({
      user: req.user._id,
      $or: [{ channelId: channelId || null }, { handle: handle || null }]
    });
    if (existing) {
      return res.status(409).json({ success: false, message: 'This competitor is already being tracked', competitor: existing });
    }

    const competitor = await Competitor.create({
      user: req.user._id,
      channelId: channelId || null,
      handle: handle || null,
      label: label || handle || channelId
    });

    // Best-effort first fetch so the UI has stats immediately instead of
    // showing "pending" until the next GET refresh cycle.
    try {
      competitor.lastStats = await fetchCompetitorStats({ channelId, handle });
      if (!competitor.label && competitor.lastStats.resolvedChannelId) competitor.label = handle || channelId;
      await competitor.save();
    } catch (err) {
      competitor.lastStats = { error: err.message, fetchedAt: null };
      await competitor.save();
    }

    res.status(201).json({ success: true, competitor });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route DELETE /api/analytics/competitors/:id
router.delete('/competitors/:id', protect, async (req, res) => {
  try {
    const competitor = await Competitor.findOneAndDelete({ _id: req.params.id, user: req.user._id });
    if (!competitor) return res.status(404).json({ success: false, message: 'Competitor not found' });
    res.json({ success: true, message: 'Competitor removed' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Channel Audit
// ---------------------------------------------------------------------------

// Local, read-only token-freshness check — deliberately NOT reusing
// cron/scheduler.js's ensureFreshYouTubeToken (unexported, and scheduling
// logic must stay untouched) — this duplicates ~8 lines instead of
// widening the scheduler's surface area for a read-only analytics call.
const ensureFreshTokenForAudit = async (user) => {
  const channel = user.youtubeChannel;
  const isExpired = !channel.tokenExpiryDate || Date.now() > channel.tokenExpiryDate - 60000;
  if (!isExpired) return channel.accessToken;
  try {
    const credentials = await refreshAccessToken(channel.refreshToken);
    user.youtubeChannel.accessToken = credentials.access_token;
    user.youtubeChannel.tokenExpiryDate = credentials.expiry_date;
    await user.save();
    return credentials.access_token;
  } catch (err) {
    if (isInvalidGrantError(err)) {
      const reauthErr = new Error('Your YouTube authorization has expired or was revoked. Please reconnect your YouTube account.');
      reauthErr.code = 'YOUTUBE_REAUTH_REQUIRED';
      throw reauthErr;
    }
    throw err;
  }
};

// ⚠️ NEW (Boss request — real, actionable channel-profile gaps): builds a
// short, ready-to-use AI prompt for each detected gap. These are plain
// rule-based templates (not an extra AI/LLM call) — fast, free to compute,
// and don't depend on any AI provider being up. The frontend shows only a
// blurred/truncated preview of this text + a Copy button and a "Gemini"
// button — both gated behind Diamond Store, per Boss's monetization model
// (₹10/month plan) — so the prompt text itself is real and useful, just
// not usable for free.
const buildDescriptionPrompt = (channelTitle) =>
  `Write a compelling, SEO-friendly YouTube channel description for a channel named "${channelTitle}". Explain what viewers can expect, how often new videos are posted, and end with a clear call-to-action to subscribe. Keep it under 1000 characters and make it sound natural, not like a list of keywords.`;

const buildBannerPrompt = (channelTitle) =>
  `Create a professional, eye-catching YouTube channel banner for a channel named "${channelTitle}". Canvas size 2560x1440px, keep all important text and logo inside the safe area (1546x423px, centered). Use bold, readable typography, a color palette that matches the channel's tone, and leave clean negative space so it doesn't look cluttered on mobile.`;

const buildNamePrompt = (channelTitle) =>
  `Suggest 5 short, brandable, easy-to-remember YouTube channel name ideas as alternatives to "${channelTitle}", along with a matching @handle for each. Keep names under 20 characters, avoid random numbers, and make sure they hint at the channel's niche.`;

// @route GET /api/analytics/audit
// Channel health: engagement %, weekly Short-to-Long video ratio (Shorts =
// duration <= 60s), and a few actionable, rule-based recommendations. Pulls
// the connected channel's most recent uploads via the authorized YouTube
// Data API (statistics + contentDetails are public fields, but calling as
// the authenticated owner avoids a second API-key dependency for the
// user's own channel).
//
// ⚠️ UPDATED (Boss request): now also pulls `snippet` + `brandingSettings`
// so real channel-profile gaps (missing/short description, missing banner,
// no custom handle/name set) can be detected — not just activity metrics.
// `recommendations` is now an array of OBJECTS ({ type, message, prompt })
// instead of plain strings, so the frontend can render an actionable
// prompt-preview + Copy/Gemini buttons for the gaps that have one.
router.get('/audit', protect, async (req, res) => {
  try {
    if (!req.user.youtubeChannel) {
      return res.status(400).json({ success: false, message: 'Connect your YouTube channel first' });
    }

    const accessToken = await ensureFreshTokenForAudit(req.user);
    const oauth2Client = new google.auth.OAuth2();
    oauth2Client.setCredentials({ access_token: accessToken });
    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

    const channelRes = await youtube.channels.list({ part: 'snippet,statistics,contentDetails,brandingSettings', mine: true });
    const channel = channelRes.data.items && channelRes.data.items[0];
    if (!channel) return res.status(404).json({ success: false, message: 'YouTube channel not found' });

    const uploadsPlaylistId = channel.contentDetails?.relatedPlaylists?.uploads;
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    let engagementPct = null;
    let shortToLongRatio = null;
    let recentVideoCount = 0;

    if (uploadsPlaylistId) {
      const playlistRes = await youtube.playlistItems.list({ part: 'contentDetails', playlistId: uploadsPlaylistId, maxResults: 20 });
      const videoIds = (playlistRes.data.items || []).map((i) => i.contentDetails.videoId).filter(Boolean);

      if (videoIds.length) {
        const videosRes = await youtube.videos.list({ part: 'statistics,contentDetails,snippet', id: videoIds.join(',') });
        const videos = videosRes.data.items || [];

        // Engagement % = (likes + comments) / views, averaged across all
        // fetched videos (VidIQ-style "engagement rate").
        const engagementRates = videos
          .map((v) => {
            const views = Number(v.statistics?.viewCount || 0);
            if (views === 0) return null;
            const likes = Number(v.statistics?.likeCount || 0);
            const comments = Number(v.statistics?.commentCount || 0);
            return (likes + comments) / views;
          })
          .filter((r) => r !== null);
        if (engagementRates.length) {
          engagementPct = Math.round((engagementRates.reduce((s, r) => s + r, 0) / engagementRates.length) * 10000) / 100;
        }

        // Weekly Short-to-Long ratio: Shorts = ISO-8601 duration <= 60s.
        const parseDurationSeconds = (iso) => {
          const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
          if (!m) return 0;
          return (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
        };
        const recentVideos = videos.filter((v) => new Date(v.snippet?.publishedAt).getTime() >= sevenDaysAgo);
        recentVideoCount = recentVideos.length;
        const shorts = recentVideos.filter((v) => parseDurationSeconds(v.contentDetails?.duration) <= 60).length;
        const longForm = recentVideos.length - shorts;
        shortToLongRatio = longForm === 0 ? (shorts > 0 ? shorts : 0) : Math.round((shorts / longForm) * 100) / 100;
      }
    }

    const channelTitle = channel.snippet?.title || 'your channel';
    const recommendations = [];

    // ---- Activity/engagement gaps (unchanged logic, now object-shaped) ----
    if (engagementPct !== null && engagementPct < 2) {
      recommendations.push({
        type: 'engagement',
        message: 'Engagement is under 2% — try asking a direct question in your first comment or video hook to prompt replies.',
        prompt: null
      });
    }
    if (recentVideoCount === 0) {
      recommendations.push({
        type: 'uploads',
        message: 'No uploads in the last 7 days — consistency is one of the biggest ranking signals on YouTube.',
        prompt: null
      });
    }
    if (shortToLongRatio !== null && shortToLongRatio === 0 && recentVideoCount > 0) {
      recommendations.push({
        type: 'shorts',
        message: 'You posted zero Shorts this week — Shorts are currently the fastest way to reach new subscribers.',
        prompt: null
      });
    }

    // ---- NEW: real channel-profile gaps (description / banner / name) ----
    const description = channel.snippet?.description || '';
    if (description.trim().length < 50) {
      recommendations.push({
        type: 'description',
        message: 'Your channel description is missing or too short — a clear description helps YouTube understand your channel and improves search ranking.',
        prompt: buildDescriptionPrompt(channelTitle)
      });
    }

    const hasBanner = !!channel.brandingSettings?.image?.bannerExternalUrl;
    if (!hasBanner) {
      recommendations.push({
        type: 'banner',
        message: 'Your channel has no banner image — a banner is the first visual impression for new visitors landing on your channel.',
        prompt: buildBannerPrompt(channelTitle)
      });
    }

    // customUrl (the @handle) is only set once a channel has claimed a
    // proper handle — its absence is a reliable, real signal that the
    // channel name/branding hasn't been optimized yet.
    if (!channel.snippet?.customUrl) {
      recommendations.push({
        type: 'title',
        message: 'Your channel doesn\'t have a custom handle set yet — a clear, brandable name and handle make you easier to find and remember.',
        prompt: buildNamePrompt(channelTitle)
      });
    }

    if (recommendations.length === 0) {
      recommendations.push({
        type: 'healthy',
        message: 'Your channel activity looks healthy — keep up the current posting cadence.',
        prompt: null
      });
    }

    res.json({
      success: true,
      audit: {
        subscriberCount: Number(channel.statistics?.subscriberCount || 0),
        totalViews: Number(channel.statistics?.viewCount || 0),
        totalVideos: Number(channel.statistics?.videoCount || 0),
        engagementPct,
        weeklyShortToLongRatio: shortToLongRatio,
        recentUploadsLast7Days: recentVideoCount,
        recommendations
      }
    });
  } catch (err) {
    const status = err.code === 'YOUTUBE_REAUTH_REQUIRED' ? 401 : 500;
    res.status(status).json({ success: false, message: err.message, code: err.code });
  }
});

module.exports = router;
