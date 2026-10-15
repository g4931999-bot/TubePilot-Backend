// Competitor Radar — data collection (YouTube Data API, API-key only, public data).
//
// Quota cost (units): channels.list = 1 per 50 channels, playlistItems.list
// = 1 per channel, videos.list = 1 per 50 videos. So ~1.7 units per tracked
// channel per day, and a channel tracked by many users is fetched ONCE.
// (search.list — the typeahead — costs 100, that is why its results are
// cached in routes/analytics.js.)
const Competitor = require('../models/Competitor');
const CompetitorVideo = require('../models/CompetitorVideo');
const CompetitorVideoSnapshot = require('../models/CompetitorVideoSnapshot');
const CompetitorChannelSnapshot = require('../models/CompetitorChannelSnapshot');
const { getYoutubeClient } = require('./youtubePublic');

const HOUR = 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * HOUR;

// 'YYYY-MM-DD' in IST — one snapshot per video per IST day.
const istDayKey = (d = new Date()) => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

const isChannelId = (id) => typeof id === 'string' && /^UC[\w-]{22}$/.test(id);

// A channel's uploads playlist ID is its channel ID with "UC" → "UU" (no API call needed).
const uploadsPlaylistFor = (channelId) => 'UU' + channelId.slice(2);

const parseDurationSeconds = (iso) => {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  if (!m) return null;
  return (Number(m[1]) || 0) * 86400 + (Number(m[2]) || 0) * 3600 + (Number(m[3]) || 0) * 60 + (Number(m[4]) || 0);
};

const numOrNull = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

// Best channel ID we know for a Competitor doc (works for lean or hydrated docs).
const competitorChannelId = (c) => {
  const resolved = c.lastStats?.resolvedChannelId;
  if (isChannelId(resolved)) return resolved;
  if (isChannelId(c.channelId)) return c.channelId;
  return null;
};

const ignoreDuplicateKey = (err) => {
  // A parallel run may insert the same (video, day) row first — harmless.
  const dup = err && (err.code === 11000 || (err.writeErrors || []).every((e) => e.code === 11000));
  if (!dup) throw err;
};

/**
 * Fetch + store channel stats, latest videos and today's snapshots for the
 * given channel IDs. Never throws for a single bad channel — failures are
 * collected in `errors`.
 */
const ingestChannels = async (channelIds, { maxVideos = 30 } = {}) => {
  const ids = [...new Set((channelIds || []).filter(isChannelId))];
  const result = { channels: 0, videos: 0, errors: [] };
  if (ids.length === 0) return result;

  const youtube = getYoutubeClient();
  const now = new Date();
  const day = istDayKey(now);

  // 1) Channel-level numbers (batched, 50 channels per call).
  for (const batch of chunk(ids, 50)) {
    try {
      const res = await youtube.channels.list({ part: 'statistics', id: batch.join(','), maxResults: 50 });
      const ops = (res.data.items || []).map((ch) => ({
        updateOne: {
          filter: { channelId: ch.id, day },
          update: {
            $setOnInsert: {
              subscriberCount: ch.statistics?.hiddenSubscriberCount ? null : numOrNull(ch.statistics?.subscriberCount),
              viewCount: Number(ch.statistics?.viewCount || 0),
              videoCount: Number(ch.statistics?.videoCount || 0),
              capturedAt: now
            }
          },
          upsert: true
        }
      }));
      if (ops.length) {
        await CompetitorChannelSnapshot.bulkWrite(ops, { ordered: false }).catch(ignoreDuplicateKey);
        result.channels += ops.length;
      }
    } catch (err) {
      result.errors.push(`channels.list: ${err.message}`);
    }
  }

  // 2) Latest upload IDs per channel (small concurrency to stay polite).
  const allVideoIds = [];
  for (const group of chunk(ids, 5)) {
    await Promise.all(group.map(async (channelId) => {
      try {
        const res = await youtube.playlistItems.list({
          part: 'contentDetails',
          playlistId: uploadsPlaylistFor(channelId),
          maxResults: Math.min(maxVideos, 50)
        });
        (res.data.items || []).forEach((i) => {
          if (i.contentDetails?.videoId) allVideoIds.push(i.contentDetails.videoId);
        });
      } catch (err) {
        result.errors.push(`${channelId}: ${err.message}`);
      }
    }));
  }

  // 3) Video details + statistics (batched, 50 videos per call).
  for (const batch of chunk([...new Set(allVideoIds)], 50)) {
    try {
      const res = await youtube.videos.list({ part: 'snippet,statistics,contentDetails', id: batch.join(','), maxResults: 50 });
      const videoOps = [];
      const snapOps = [];
      (res.data.items || []).forEach((v) => {
        const channelId = v.snippet?.channelId;
        if (!channelId) return;
        const stats = {
          viewCount: Number(v.statistics?.viewCount || 0),
          likeCount: numOrNull(v.statistics?.likeCount),
          commentCount: numOrNull(v.statistics?.commentCount)
        };
        videoOps.push({
          updateOne: {
            filter: { videoId: v.id },
            update: {
              $set: {
                channelId,
                title: v.snippet?.title || '',
                thumbnail: v.snippet?.thumbnails?.medium?.url || v.snippet?.thumbnails?.default?.url || '',
                publishedAt: v.snippet?.publishedAt ? new Date(v.snippet.publishedAt) : null,
                durationSec: parseDurationSeconds(v.contentDetails?.duration),
                tags: (v.snippet?.tags || []).slice(0, 30),
                stats,
                statsAt: now
              },
              $setOnInsert: { firstSeenAt: now }
            },
            upsert: true
          }
        });
        // $setOnInsert: the first capture of the IST day wins, so a lazy
        // refresh and the daily cron never fight over the same row.
        snapOps.push({
          updateOne: {
            filter: { videoId: v.id, day },
            update: { $setOnInsert: { channelId, viewCount: stats.viewCount, likeCount: stats.likeCount, commentCount: stats.commentCount, capturedAt: now } },
            upsert: true
          }
        });
      });
      if (videoOps.length) {
        await CompetitorVideo.bulkWrite(videoOps, { ordered: false }).catch(ignoreDuplicateKey);
        await CompetitorVideoSnapshot.bulkWrite(snapOps, { ordered: false }).catch(ignoreDuplicateKey);
        result.videos += videoOps.length;
      }
    } catch (err) {
      result.errors.push(`videos.list: ${err.message}`);
    }
  }

  return result;
};

// ---------------------------------------------------------------------------
// Lazy refresh — used when a user opens the Radar and a competitor has no (or
// day-old) data, e.g. just added, or tracked before this feature existed.
// Runs in the background; guarded so it never stampedes the API quota.
// ---------------------------------------------------------------------------
const inFlight = new Set();
const lastAttempt = new Map(); // channelId -> ms
const RETRY_AFTER_MS = 3 * HOUR;

const ingestInBackground = (channelIds) => {
  const nowMs = Date.now();
  const todo = [...new Set(channelIds)].filter((id) => {
    if (!isChannelId(id) || inFlight.has(id)) return false;
    return !(lastAttempt.get(id) && nowMs - lastAttempt.get(id) < RETRY_AFTER_MS);
  });
  if (todo.length === 0) return false;
  todo.forEach((id) => { inFlight.add(id); lastAttempt.set(id, nowMs); });
  ingestChannels(todo)
    .then((r) => { if (r.errors.length) console.warn('⚠️ [Competitor ingest]', r.errors.slice(0, 3).join(' | ')); })
    .catch((err) => console.error('❌ [Competitor ingest]', err.message))
    .finally(() => todo.forEach((id) => inFlight.delete(id)));
  return true;
};

/** Returns { refreshing } — true when a background refresh was started or is running. */
const ensureChannelsFresh = async (channelIds, maxAgeHours = 24) => {
  const ids = [...new Set((channelIds || []).filter(isChannelId))];
  if (ids.length === 0) return { refreshing: false };

  const rows = await CompetitorVideo.aggregate([
    { $match: { channelId: { $in: ids } } },
    { $group: { _id: '$channelId', last: { $max: '$statsAt' } } }
  ]);
  const lastMap = new Map(rows.map((r) => [r._id, r.last ? new Date(r.last).getTime() : 0]));
  const cutoff = Date.now() - maxAgeHours * HOUR;
  const stale = ids.filter((id) => (lastMap.get(id) || 0) < cutoff);

  const started = ingestInBackground(stale);
  const running = stale.some((id) => inFlight.has(id));
  return { refreshing: started || running };
};

// ---------------------------------------------------------------------------
// Daily job body (see cron/competitorScheduler.js)
// ---------------------------------------------------------------------------
const runDailyCompetitorSnapshot = async () => {
  const docs = await Competitor.find({}).select('channelId lastStats.resolvedChannelId').lean();
  const ids = [...new Set(docs.map(competitorChannelId).filter(Boolean))];
  const total = { channels: 0, videos: 0, errors: [] };

  for (const group of chunk(ids, 100)) {
    const r = await ingestChannels(group);
    total.channels += r.channels;
    total.videos += r.videos;
    total.errors.push(...r.errors);
  }
  return { distinctChannels: ids.length, ...total };
};

module.exports = {
  istDayKey,
  isChannelId,
  competitorChannelId,
  ingestChannels,
  ingestInBackground,
  ensureChannelsFresh,
  runDailyCompetitorSnapshot
};
