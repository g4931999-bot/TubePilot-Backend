const { google } = require('googleapis');

// ---------------------------------------------------------------------------
// QUOTA PROTECTION (YouTube Data API: 10,000 units/day per Google project, resets at midnight Pacific time
// = about 1:30 PM IST).
//  * When Google answers "quota exceeded" we remember it until the next reset and answer instantly with a
//    friendly message - no more calls are made (so nothing keeps hammering the API / retrying in a loop).
//  * Every caller that uses getYoutubeClient() is protected: it throws the friendly error while blocked.
//  * Channel details are cached for 6 hours (same channel asked again = 0 units).
// ---------------------------------------------------------------------------
let quotaBlockedUntil = 0;

const msUntilPacificMidnight = () => {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(new Date());
    const get = (t) => Number(parts.find((p) => p.type === t).value);
    const secondsToday = get('hour') * 3600 + get('minute') * 60 + get('second');
    return Math.max((86400 - secondsToday) * 1000, 60 * 1000);
  } catch (_) {
    return 60 * 60 * 1000;
  }
};

const isQuotaError = (err) => {
  const reasons = [
    ...(err?.errors || []).map((e) => e.reason),
    ...(err?.response?.data?.error?.errors || []).map((e) => e.reason)
  ];
  if (reasons.some((r) => r === 'quotaExceeded' || r === 'dailyLimitExceeded' || r === 'rateLimitExceeded')) return true;
  return /exceeded your|quota/i.test(String(err?.message || ''));
};

const quotaError = () => {
  const err = new Error('YouTube daily limit reached. It resets around 1:30 PM IST - please try again then.');
  err.code = 'YOUTUBE_QUOTA_EXCEEDED';
  return err;
};

/** Call this in a catch block: if the error is a quota error it starts the block and returns the friendly error. */
const markQuotaIfExceeded = (err) => {
  if (!isQuotaError(err)) return err;
  quotaBlockedUntil = Date.now() + msUntilPacificMidnight();
  console.error('⛔ [YouTube] daily quota exhausted - blocked until', new Date(quotaBlockedUntil).toISOString());
  return quotaError();
};

const getYoutubeClient = () => {
  const apiKey = process.env.YOUTUBE_DATA_API_KEY;
  if (!apiKey) {
    const err = new Error('YOUTUBE_DATA_API_KEY is not configured — competitor stats are unavailable until it is set.');
    err.code = 'YOUTUBE_DATA_API_KEY_MISSING';
    throw err;
  }
  if (Date.now() < quotaBlockedUntil) throw quotaError();
  return google.youtube({ version: 'v3', auth: apiKey });
};

// ---- small cache: same channel again within 6h costs nothing
const CHANNEL_TTL = 6 * 60 * 60 * 1000;
const channelCache = new Map(); // key -> { at, channel }

const resolvePublicChannel = async ({ channelId, handle }) => {
  const key = channelId ? `id:${channelId}` : handle ? `h:${String(handle).replace(/^@/, '').toLowerCase()}` : '';
  if (!key) throw new Error('resolvePublicChannel requires a channelId or handle');
  const hit = channelCache.get(key);
  if (hit && Date.now() - hit.at < CHANNEL_TTL) return hit.channel;

  const youtube = getYoutubeClient();
  const params = { part: 'snippet,statistics,contentDetails' };
  if (channelId) params.id = channelId;
  else params.forHandle = handle.replace(/^@/, '');

  let res;
  try {
    res = await youtube.channels.list(params);
  } catch (e) {
    throw markQuotaIfExceeded(e);
  }
  const channel = res.data.items && res.data.items[0];
  if (!channel) throw new Error('Channel not found — check the channel ID or @handle');
  channelCache.set(key, { at: Date.now(), channel });
  return channel;
};

const computeChannelVph = async (channel, maxVideos = 10) => {
  const youtube = getYoutubeClient();
  const uploadsPlaylistId = channel.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylistId) return null;

  try {
    const playlistRes = await youtube.playlistItems.list({
      part: 'contentDetails',
      playlistId: uploadsPlaylistId,
      maxResults: maxVideos
    });
    const videoIds = (playlistRes.data.items || []).map((i) => i.contentDetails.videoId).filter(Boolean);
    if (videoIds.length === 0) return null;

    const videosRes = await youtube.videos.list({ part: 'statistics,snippet', id: videoIds.join(',') });
    const now = Date.now();
    const rates = (videosRes.data.items || [])
      .map((v) => {
        const views = Number(v.statistics?.viewCount || 0);
        const publishedAt = new Date(v.snippet?.publishedAt).getTime();
        const hoursSince = Math.max((now - publishedAt) / (1000 * 60 * 60), 1);
        return views / hoursSince;
      })
      .filter((rate) => Number.isFinite(rate));

    if (rates.length === 0) return null;
    return Math.round((rates.reduce((sum, r) => sum + r, 0) / rates.length) * 100) / 100;
  } catch (e) {
    throw markQuotaIfExceeded(e);
  }
};

// 'basic' skips VPH (fewer quota units); only 'advance' computes it. Default stays 'advance'.
const fetchCompetitorStats = async ({ channelId, handle, mode = 'advance' }) => {
  const channel = await resolvePublicChannel({ channelId, handle });
  const vph = mode === 'advance'
    ? await computeChannelVph(channel).catch((e) => {
        if (e && e.code === 'YOUTUBE_QUOTA_EXCEEDED') throw e; // keep the friendly quota message
        return null;
      })
    : null;

  return {
    subscriberCount: channel.statistics?.hiddenSubscriberCount ? null : Number(channel.statistics?.subscriberCount || 0),
    viewCount: Number(channel.statistics?.viewCount || 0),
    videoCount: Number(channel.statistics?.videoCount || 0),
    thumbnail: channel.snippet?.thumbnails?.default?.url || '',
    resolvedChannelId: channel.id,
    vph,
    fetchedAt: new Date(),
    error: null
  };
};

// getYoutubeClient is exported so utils/competitorIngest.js can reuse the same API-key client.
// markQuotaIfExceeded: other files can wrap their own YouTube calls with it in a catch block.
module.exports = { getYoutubeClient, resolvePublicChannel, computeChannelVph, fetchCompetitorStats, markQuotaIfExceeded, isQuotaError };
