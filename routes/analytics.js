const express = require('express');
const { protect } = require('../middleware/auth');
const Video = require('../models/Video');
const Competitor = require('../models/Competitor');
const { refreshAccessToken, isInvalidGrantError } = require('../utils/youtube');
const { fetchCompetitorStats, getYoutubeClient } = require('../utils/youtubePublic');
const mongoose = require('mongoose');
const CompetitorVideo = require('../models/CompetitorVideo');
const CompetitorVideoSnapshot = require('../models/CompetitorVideoSnapshot');
const CompetitorChannelSnapshot = require('../models/CompetitorChannelSnapshot');
const { normalizeLevel, getCompetitorLimit, hasAdvancedInsights, limitReachedBody } = require('../utils/competitorLimits');
const { competitorChannelId, ensureChannelsFresh, ingestInBackground } = require('../utils/competitorIngest');
const insights = require('../utils/competitorInsights');
const { google } = require('googleapis');
const { buildAuditReport } = require('../utils/channelAudit');
const router = express.Router();

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
      Video.aggregate([
        { $match: { user: userId, status: 'uploaded', createdAt: { $gte: fourteenDaysAgo } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } }
      ]),
      Video.find({ user: userId })
        .sort({ createdAt: -1 })
        .limit(15)
        .select('title status diamondsCharged usedFreeUpload createdAt')
    ]);

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
// ⚠️ UPGRADED (Competitor Radar): per-plan competitor limits (enforced HERE,
// not only in the app), shared daily snapshots, and the dashboard / detail /
// video-list endpoints. Plan limits: none(free)=2, basic=5, advance=15 —
// see utils/competitorLimits.js. Existing competitors are NEVER deleted when
// a limit is applied; an over-limit user keeps and can view all of them but
// cannot add new ones until they are below the limit.

const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_STATS_MS = 6 * 60 * 60 * 1000;

const compLabel = (c) => c.label || c.handle || c.channelId || '';

const buildMeta = (user, count) => {
  const level = normalizeLevel(user.competitorLevel);
  const limit = getCompetitorLimit(level);
  return { level, limit, count, canAdd: count < limit, advanced: hasAdvancedInsights(level) };
};

// VPH is the deeper (advance-only) metric — never leak it to lower plans,
// even if an older cache from a previous higher plan still holds it.
const shapeCompetitor = (c, advanced) => {
  const obj = c.toObject ? c.toObject() : { ...c };
  if (!advanced && obj.lastStats) obj.lastStats.vph = null;
  return obj;
};

// Search typeahead: search.list costs 100 YouTube quota units per call, so
// identical queries are served from a short in-memory cache.
const searchCache = new Map();
const SEARCH_TTL_MS = 10 * 60 * 1000;
const SEARCH_CACHE_MAX = 500;

// @route GET /api/analytics/competitors/search?q=tube
router.get('/competitors/search', protect, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json({ success: true, results: [] });

    const apiKey = process.env.YOUTUBE_DATA_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ success: false, message: 'YouTube search is unavailable — YOUTUBE_DATA_API_KEY not configured on the server.' });
    }

    const cacheKey = q.toLowerCase();
    const hit = searchCache.get(cacheKey);
    if (hit && Date.now() - hit.at < SEARCH_TTL_MS) {
      return res.json({ success: true, results: hit.results, cached: true });
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

    if (searchCache.size >= SEARCH_CACHE_MAX) searchCache.delete(searchCache.keys().next().value);
    searchCache.set(cacheKey, { at: Date.now(), results });

    res.json({ success: true, results });
  } catch (err) {
    console.error('❌ [Competitor Search] failed:', err.response?.data || err.message);
    res.status(500).json({ success: false, message: 'Search failed. Please try again.' });
  }
});

// Loads the user's competitors and refreshes any whose cached channel stats are > 6h old.
const loadCompetitorsFresh = async (user) => {
  const competitors = await Competitor.find({ user: user._id }).sort({ createdAt: -1 });
  await Promise.all(
    competitors.map(async (c) => {
      const isStale = !c.lastStats?.fetchedAt || Date.now() - new Date(c.lastStats.fetchedAt).getTime() > STALE_STATS_MS;
      if (!isStale) return;
      try {
        c.lastStats = await fetchCompetitorStats({ channelId: c.channelId, handle: c.handle, mode: normalizeLevel(user.competitorLevel) });
        await c.save();
      } catch (err) {
        c.lastStats = { ...(c.lastStats?.toObject ? c.lastStats.toObject() : c.lastStats), error: err.message, fetchedAt: c.lastStats?.fetchedAt || null };
        await c.save();
      }
    })
  );
  return competitors;
};

// @route GET /api/analytics/competitors
router.get('/competitors', protect, async (req, res) => {
  try {
    const competitors = await loadCompetitorsFresh(req.user);
    const meta = buildMeta(req.user, competitors.length);
    res.json({
      success: true,
      competitors: competitors.map((c) => shapeCompetitor(c, meta.advanced)),
      competitorLevel: meta.level,
      limit: meta.limit,
      count: meta.count,
      canAdd: meta.canAdd
    });
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

    const level = normalizeLevel(req.user.competitorLevel);
    const limit = getCompetitorLimit(level);

    // ---- plan limit (enforced on the server) ----
    const current = await Competitor.countDocuments({ user: req.user._id });
    if (current >= limit) {
      return res.status(403).json(limitReachedBody({ level, current }));
    }

    // ---- duplicate check ----
    // ⚠️ FIX: the old query was `$or: [{channelId: x || null}, {handle: y || null}]`.
    // When only a channelId was sent, `{handle: null}` matched EVERY competitor
    // that had been added by channelId (their handle is null) — so a second
    // competitor was always rejected as "already tracked". Only the fields
    // that were actually provided are compared now.
    const or = [];
    if (channelId) or.push({ channelId }, { 'lastStats.resolvedChannelId': channelId });
    if (handle) or.push({ handle });
    const existing = await Competitor.findOne({ user: req.user._id, $or: or });
    if (existing) {
      return res.status(409).json({ success: false, message: 'This competitor is already being tracked', competitor: existing });
    }

    const competitor = await Competitor.create({
      user: req.user._id,
      channelId: channelId || null,
      handle: handle || null,
      label: label || handle || channelId
    });

    // ---- race guard: two parallel adds can both pass the count check above.
    // Only the first `limit` documents (by creation order) are kept. ----
    const keep = await Competitor.find({ user: req.user._id }).sort({ _id: 1 }).limit(limit).select('_id').lean();
    if (!keep.some((k) => String(k._id) === String(competitor._id))) {
      await Competitor.deleteOne({ _id: competitor._id });
      return res.status(403).json(limitReachedBody({ level, current: limit }));
    }

    try {
      competitor.lastStats = await fetchCompetitorStats({ channelId, handle, mode: level });
      if (!competitor.label && competitor.lastStats.resolvedChannelId) competitor.label = handle || channelId;
      await competitor.save();
    } catch (err) {
      // A channel that does not exist must not eat one of the user's slots.
      if (/^Channel not found/i.test(err.message)) {
        await Competitor.deleteOne({ _id: competitor._id });
        return res.status(404).json({ success: false, message: err.message });
      }
      competitor.lastStats = { error: err.message, fetchedAt: null };
      await competitor.save();
    }

    // Same channel added twice under different forms (e.g. @handle then ID).
    const resolvedId = competitor.lastStats?.resolvedChannelId;
    if (resolvedId) {
      const dup = await Competitor.findOne({
        user: req.user._id,
        _id: { $ne: competitor._id },
        $or: [{ channelId: resolvedId }, { 'lastStats.resolvedChannelId': resolvedId }]
      });
      if (dup) {
        await Competitor.deleteOne({ _id: competitor._id });
        return res.status(409).json({ success: false, message: 'This competitor is already being tracked', competitor: dup });
      }
      // Collect the first video snapshot right away (background, never blocks the response).
      ingestInBackground([resolvedId]);
    }

    res.status(201).json({
      success: true,
      competitor: shapeCompetitor(competitor, hasAdvancedInsights(level)),
      limit,
      count: await Competitor.countDocuments({ user: req.user._id })
    });
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
// Competitor Radar — dashboard / details / video lists
// ---------------------------------------------------------------------------

const toVideoItem = (v, comp, growthMap, outMap, nowMs) => {
  const vpd = insights.viewsPerDay(v, nowMs);
  return {
    videoId: v.videoId,
    url: `https://www.youtube.com/watch?v=${v.videoId}`,
    channelId: v.channelId,
    competitorId: comp ? String(comp._id) : null,
    channelLabel: comp ? compLabel(comp) : '',
    channelThumbnail: comp?.lastStats?.thumbnail || '',
    title: v.title,
    thumbnail: v.thumbnail,
    publishedAt: v.publishedAt,
    durationSec: v.durationSec,
    views: v.stats?.viewCount ?? 0,           // TOTAL views (not growth)
    likes: v.stats?.likeCount ?? null,
    comments: v.stats?.commentCount ?? null,
    viewsPerDay: vpd === null ? null : Math.round(vpd),
    growth: growthMap.get(v.videoId) || null, // MEASURED growth between two real snapshots, else null
    outperform: outMap.get(v.videoId) || null
  };
};

const sortItems = (items, sort) => {
  const list = items.slice();
  switch (sort) {
    case 'recent':
      return list.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
    case 'fastest':
      return list.filter((i) => i.growth).sort((a, b) => b.growth.viewsPerHour - a.growth.viewsPerHour);
    case 'outperforming':
      return list.filter((i) => i.outperform).sort((a, b) => b.outperform.ratio - a.outperform.ratio);
    case 'most_viewed':
    default:
      return list.sort((a, b) => b.views - a.views);
  }
};

// Gathers everything the dashboard / detail / list endpoints need for a set of competitors.
const loadRadarContext = async (user, comps, totalCount = comps.length) => {
  const meta = buildMeta(user, totalCount);
  const chToComp = new Map();
  comps.forEach((c) => {
    const id = competitorChannelId(c);
    if (id) chToComp.set(id, c);
  });
  const channelIds = [...chToComp.keys()];
  const { refreshing } = await ensureChannelsFresh(channelIds);

  const since = new Date(Date.now() - insights.WINDOW_DAYS * DAY_MS);
  const videos = channelIds.length
    ? await CompetitorVideo.find({ channelId: { $in: channelIds }, publishedAt: { $gte: since } }).lean()
    : [];

  const nowMs = Date.now();
  const growthMap = meta.advanced ? await insights.computeGrowthMap(videos.map((v) => v.videoId), nowMs) : new Map();
  const outMap = insights.computeOutperforming(videos, nowMs);
  const items = videos.map((v) => toVideoItem(v, chToComp.get(v.channelId), growthMap, outMap, nowMs));

  let firstSnapshotAt = null;
  if (channelIds.length) {
    const first = await CompetitorVideoSnapshot.findOne({ channelId: { $in: channelIds } }).sort({ capturedAt: 1 }).select('capturedAt').lean();
    firstSnapshotAt = first ? first.capturedAt : null;
  }

  return { meta, chToComp, channelIds, refreshing, videos, items, firstSnapshotAt };
};

const withChannelLabel = (topics, chToComp) =>
  topics.map((t) => ({
    ...t,
    exampleVideo: { ...t.exampleVideo, channelLabel: chToComp.get(t.exampleVideo.channelId) ? compLabel(chToComp.get(t.exampleVideo.channelId)) : '' },
    topVideos: (t.topVideos || []).map((v) => {
      const comp = chToComp.get(v.channelId);
      return {
        ...v,
        url: `https://www.youtube.com/watch?v=${v.videoId}`,
        views: v.views,
        competitorId: comp ? String(comp._id) : null,
        channelLabel: comp ? compLabel(comp) : '',
        channelThumbnail: comp?.lastStats?.thumbnail || ''
      };
    })
  }));

const growthInfo = (ctx) => ({
  // `ready` = at least one video has a measured growth number.
  ready: ctx.meta.advanced && ctx.items.some((i) => i.growth),
  measuredVideos: ctx.items.filter((i) => i.growth).length,
  firstSnapshotAt: ctx.firstSnapshotAt
});

// @route GET /api/analytics/competitors/dashboard
router.get('/competitors/dashboard', protect, async (req, res) => {
  try {
    const comps = await loadCompetitorsFresh(req.user);
    const ctx = await loadRadarContext(req.user, comps);
    const adv = ctx.meta.advanced;

    let fastestGrowing = null;
    let topics = null;
    let opportunities = null;
    if (adv) {
      fastestGrowing = sortItems(ctx.items, 'fastest').slice(0, 8);
      topics = withChannelLabel(
        insights.extractTopics(ctx.videos, { minVideos: 2, minChannels: ctx.channelIds.length >= 2 ? 2 : 1, limit: 10 }),
        ctx.chToComp
      );
      const own = await insights.getOwnTitles(req.user);
      opportunities = withChannelLabel(insights.buildOpportunities(ctx.videos, own, ctx.channelIds.length), ctx.chToComp);
    }

    res.json({
      success: true,
      meta: ctx.meta,
      refreshing: ctx.refreshing,
      windowDays: insights.WINDOW_DAYS,
      summary: { tracked: comps.length, videosAnalysed: ctx.items.length },
      competitors: comps.map((c) => shapeCompetitor(c, adv)),
      topVideos: sortItems(ctx.items, 'most_viewed').slice(0, 5),
      recentVideos: sortItems(ctx.items, 'recent').slice(0, 8),
      outperforming: sortItems(ctx.items, 'outperforming').slice(0, 5),
      fastestGrowing,           // null = locked on this plan
      topics,                   // null = locked on this plan
      opportunities,            // null = locked on this plan
      growth: growthInfo(ctx),
      locked: { growth: !adv, topics: !adv, opportunities: !adv }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

const MAX_LIST = 50;

const sendVideoList = async (req, res, comps, totalCount = comps.length) => {
  const sort = ['most_viewed', 'recent', 'fastest', 'outperforming'].includes(req.query.sort) ? req.query.sort : 'most_viewed';
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), MAX_LIST);
  const meta = buildMeta(req.user, totalCount);
  if (sort === 'fastest' && !meta.advanced) {
    return res.status(403).json({ success: false, code: 'FEATURE_LOCKED', message: 'Fastest Growing videos are available on the Advanced plan.' });
  }
  const ctx = await loadRadarContext(req.user, comps, totalCount);
  res.json({
    success: true,
    sort,
    meta: ctx.meta,
    refreshing: ctx.refreshing,
    windowDays: insights.WINDOW_DAYS,
    growth: growthInfo(ctx),
    videos: sortItems(ctx.items, sort).slice(0, limit)
  });
};

// @route GET /api/analytics/competitors/videos?sort=most_viewed|recent|fastest|outperforming&limit=30
// (all of the user's tracked competitors together)
router.get('/competitors/videos', protect, async (req, res) => {
  try {
    const comps = await Competitor.find({ user: req.user._id }).sort({ createdAt: -1 }).lean();
    await sendVideoList(req, res, comps);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

const findOwnedCompetitor = async (req) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return null;
  return Competitor.findOne({ _id: req.params.id, user: req.user._id }).lean();
};

// @route GET /api/analytics/competitors/:id/videos?sort=...&limit=...
// @route GET /api/analytics/competitors/video/:videoId
// Full public details of ONE competitor video (description, tags, best thumbnail)
// so the app can let the user copy them. Only videos of channels the user tracks.
router.get('/competitors/video/:videoId', protect, async (req, res) => {
  try {
    const videoId = String(req.params.videoId || '');
    if (!/^[\w-]{11}$/.test(videoId)) return res.status(400).json({ success: false, message: 'Invalid video id' });

    const stored = await CompetitorVideo.findOne({ videoId }).lean();
    if (!stored) return res.status(404).json({ success: false, message: 'Video not found' });

    const comps = await Competitor.find({ user: req.user._id });
    const owned = comps.some((c) => competitorChannelId(c) === stored.channelId);
    if (!owned) return res.status(404).json({ success: false, message: 'Video not found' });

    let description = null;
    let tags = stored.tags || [];
    let title = stored.title;
    try {
      const yt = getYoutubeClient();
      const r = await yt.videos.list({ part: 'snippet', id: videoId });
      const item = r.data.items && r.data.items[0];
      if (item) {
        description = item.snippet?.description || '';
        tags = item.snippet?.tags || tags;
        title = item.snippet?.title || title;
      }
    } catch (_) { /* keep stored data; description stays null */ }

    res.json({
      success: true,
      video: {
        videoId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        title,
        description,          // null = could not be fetched right now
        tags,
        thumbnailMax: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
        thumbnailHigh: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/competitors/:id/videos', protect, async (req, res) => {
  try {
    const comp = await findOwnedCompetitor(req);
    if (!comp) return res.status(404).json({ success: false, message: 'Competitor not found' });
    // plan flags/count are based on ALL the user's competitors; the list is just this one channel
    const all = await Competitor.countDocuments({ user: req.user._id });
    await sendVideoList(req, res, [comp], all);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route GET /api/analytics/competitors/:id   (detail screen)
router.get('/competitors/:id', protect, async (req, res) => {
  try {
    const comp = await findOwnedCompetitor(req);
    if (!comp) return res.status(404).json({ success: false, message: 'Competitor not found' });

    const all = await Competitor.countDocuments({ user: req.user._id });
    const ctx = await loadRadarContext(req.user, [comp], all);
    const adv = ctx.meta.advanced;
    const channelId = competitorChannelId(comp);
    const stats = comp.lastStats || {};

    let fastestGrowing = null;
    let topics = null;
    let series = null;
    if (adv) {
      fastestGrowing = sortItems(ctx.items, 'fastest').slice(0, 5);
      topics = withChannelLabel(insights.extractTopics(ctx.videos, { minVideos: 2, minChannels: 1, limit: 10 }), ctx.chToComp);
      if (channelId) {
        const rows = await CompetitorChannelSnapshot.find({ channelId, capturedAt: { $gte: new Date(Date.now() - 30 * DAY_MS) } })
          .sort({ day: 1 }).select('day subscriberCount viewCount videoCount').lean();
        series = rows.map((r) => ({ day: r.day, subscribers: r.subscriberCount, views: r.viewCount, videos: r.videoCount }));
      }
    }

    res.json({
      success: true,
      meta: ctx.meta,
      refreshing: ctx.refreshing,
      windowDays: insights.WINDOW_DAYS,
      channel: {
        id: String(comp._id),
        channelId,
        label: compLabel(comp),
        handle: comp.handle,
        thumbnail: stats.thumbnail || '',
        subscriberCount: stats.subscriberCount ?? null,
        viewCount: stats.viewCount ?? null,
        videoCount: stats.videoCount ?? null,
        vph: adv ? (stats.vph ?? null) : null,
        url: channelId ? `https://www.youtube.com/channel/${channelId}` : null,
        error: stats.error || null
      },
      mostViewed: sortItems(ctx.items, 'most_viewed').slice(0, 5),
      recent: sortItems(ctx.items, 'recent').slice(0, 8),
      outperforming: sortItems(ctx.items, 'outperforming').slice(0, 5),
      fastestGrowing,   // null = locked on this plan
      topics,           // null = locked on this plan
      series,           // channel trend (daily snapshots); null = locked on this plan
      growth: growthInfo(ctx),
      locked: { growth: !adv, topics: !adv, trend: !adv }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Channel Audit / Channel SEO Score
// ---------------------------------------------------------------------------

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

const buildDescriptionPrompt = (channelTitle) =>
  `Write a compelling, SEO-friendly YouTube channel description for a channel named "${channelTitle}". Explain what viewers can expect, how often new videos are posted, and end with a clear call-to-action to subscribe. Keep it under 1000 characters and make it sound natural, not like a list of keywords.`;

const buildBannerPrompt = (channelTitle) =>
  `Create a professional, eye-catching YouTube channel banner for a channel named "${channelTitle}". Canvas size 2560x1440px, keep all important text and logo inside the safe area (1546x423px, centered). Use bold, readable typography, a color palette that matches the channel's tone, and leave clean negative space so it doesn't look cluttered on mobile.`;

const buildNamePrompt = (channelTitle) =>
  `Suggest 5 short, brandable, easy-to-remember YouTube channel name ideas as alternatives to "${channelTitle}", along with a matching @handle for each. Keep names under 20 characters, avoid random numbers, and make sure they hint at the channel's niche.`;

// @route GET /api/analytics/audit
// Channel SEO Score (renamed from "Channel Audit"). Score/stats are ALWAYS
// computed and returned regardless of plan. `recommendations` (the
// suggestion list) is gated behind req.user.seoScoreLevel === 'advance'
// (₹100+ packs) — a STRICTER threshold than Video SEO Optimizer's gate in
// routes/ai.js (which unlocks from ANY paid pack). Below that threshold,
// `recommendations` is returned as an empty array + `channelSeoUnlocked:
// false` — no blurred preview, no partial suggestion, the frontend shows a
// single upgrade banner instead.
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
    let auditVideos = [];

    if (uploadsPlaylistId) {
      const playlistRes = await youtube.playlistItems.list({ part: 'contentDetails', playlistId: uploadsPlaylistId, maxResults: 50 });
      const videoIds = (playlistRes.data.items || []).map((i) => i.contentDetails.videoId).filter(Boolean);

      if (videoIds.length) {
        const videosRes = await youtube.videos.list({ part: 'statistics,contentDetails,snippet', id: videoIds.join(',') });
        const videos = videosRes.data.items || [];
        auditVideos = videos;

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

    if (engagementPct !== null && engagementPct < 2) {
      recommendations.push({ type: 'engagement', message: 'Engagement is under 2% — try asking a direct question in your first comment or video hook to prompt replies.', prompt: null });
    }
    if (recentVideoCount === 0) {
      recommendations.push({ type: 'uploads', message: 'No uploads in the last 7 days — consistency is one of the biggest ranking signals on YouTube.', prompt: null });
    }
    if (shortToLongRatio !== null && shortToLongRatio === 0 && recentVideoCount > 0) {
      recommendations.push({ type: 'shorts', message: 'You posted zero Shorts this week — Shorts are currently the fastest way to reach new subscribers.', prompt: null });
    }

    const description = channel.snippet?.description || '';
    if (description.trim().length < 50) {
      recommendations.push({ type: 'description', message: 'Your channel description is missing or too short — a clear description helps YouTube understand your channel and improves search ranking.', prompt: buildDescriptionPrompt(channelTitle) });
    }

    const hasBanner = !!channel.brandingSettings?.image?.bannerExternalUrl;
    if (!hasBanner) {
      recommendations.push({ type: 'banner', message: 'Your channel has no banner image — a banner is the first visual impression for new visitors landing on your channel.', prompt: buildBannerPrompt(channelTitle) });
    }

    if (!channel.snippet?.customUrl) {
      recommendations.push({ type: 'title', message: 'Your channel doesn\'t have a custom handle set yet — a clear, brandable name and handle make you easier to find and remember.', prompt: buildNamePrompt(channelTitle) });
    }

    if (recommendations.length === 0) {
      recommendations.push({ type: 'healthy', message: 'Your channel activity looks healthy — keep up the current posting cadence.', prompt: null });
    }

    // Gate applied HERE, after computing everything — score/stats above
    // are always full; only `recommendations` is stripped for non-'advance'
    // users. Channel SEO Score requires 'advance' specifically (₹100+),
    // NOT just any non-'none' value — this is what makes it stricter than
    // Video SEO Optimizer's gate in routes/ai.js.
    const channelSeoUnlocked = req.user.seoScoreLevel === 'advance';

    // Full audit report (health score + the 5 cards). Built from real API data only.
    const parseIso = (iso) => {
      const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
      return m ? (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0) : 0;
    };
    let report = null;
    try {
      report = buildAuditReport({
        channel: {
          description,
          hasBanner,
          hasHandle: !!channel.snippet?.customUrl
        },
        videos: auditVideos.map((v) => ({
          videoId: v.id,
          title: v.snippet?.title || '',
          thumbnail: v.snippet?.thumbnails?.medium?.url || v.snippet?.thumbnails?.default?.url || '',
          publishedAt: v.snippet?.publishedAt ? new Date(v.snippet.publishedAt).getTime() : null,
          durationSec: parseIso(v.contentDetails?.duration),
          views: Number(v.statistics?.viewCount || 0),
          likes: v.statistics?.likeCount !== undefined ? Number(v.statistics.likeCount) : null,
          comments: v.statistics?.commentCount !== undefined ? Number(v.statistics.commentCount) : null
        }))
      });
    } catch (_) { report = null; }

    res.json({
      success: true,
      report,
      audit: {
        subscriberCount: Number(channel.statistics?.subscriberCount || 0),
        totalViews: Number(channel.statistics?.viewCount || 0),
        totalVideos: Number(channel.statistics?.videoCount || 0),
        engagementPct,
        weeklyShortToLongRatio: shortToLongRatio,
        recentUploadsLast7Days: recentVideoCount,
        channelSeoUnlocked,
        recommendations: channelSeoUnlocked ? recommendations : []
      }
    });
  } catch (err) {
    const status = err.code === 'YOUTUBE_REAUTH_REQUIRED' ? 401 : 500;
    res.status(status).json({ success: false, message: err.message, code: err.code });
  }
});

module.exports = router;
