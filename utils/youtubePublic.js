// Public YouTube Data API v3 lookups — used for COMPETITOR channels, which
// the app has no OAuth grant for. Unlike utils/youtube.js (which always
// authenticates as the connected user), everything here runs with a plain
// API key, since channel stats and public video stats are readable without
// OAuth for any channel that hasn't opted out.
//
// Requires YOUTUBE_DATA_API_KEY to be set (a separate credential from the
// GOOGLE_CLIENT_ID/SECRET OAuth app — create one in Google Cloud Console
// under "API key", scoped to the YouTube Data API v3). Every function here
// throws a clearly-labelled error if it's missing, rather than silently
// returning fake numbers.
const { google } = require('googleapis');

const getYoutubeClient = () => {
  const apiKey = process.env.YOUTUBE_DATA_API_KEY;
  if (!apiKey) {
    const err = new Error('YOUTUBE_DATA_API_KEY is not configured — competitor stats are unavailable until it is set.');
    err.code = 'YOUTUBE_DATA_API_KEY_MISSING';
    throw err;
  }
  return google.youtube({ version: 'v3', auth: apiKey });
};

// Resolves a channelId OR an @handle to the channel's snippet + statistics.
const resolvePublicChannel = async ({ channelId, handle }) => {
  const youtube = getYoutubeClient();
  const params = { part: 'snippet,statistics,contentDetails' };
  if (channelId) params.id = channelId;
  else if (handle) params.forHandle = handle.replace(/^@/, '');
  else throw new Error('resolvePublicChannel requires a channelId or handle');

  const res = await youtube.channels.list(params);
  const channel = res.data.items && res.data.items[0];
  if (!channel) throw new Error('Channel not found — check the channel ID or @handle');
  return channel;
};

// Views Per Hour: pulls the channel's most recent uploads (via its uploads
// playlist) and averages (viewCount / hoursSincePublished) across them —
// the standard "is this channel trending" signal.
const computeChannelVph = async (channel, maxVideos = 10) => {
  const youtube = getYoutubeClient();
  const uploadsPlaylistId = channel.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylistId) return null;

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
};

// Full refresh for one Competitor doc — resolves the channel, pulls
// stats + VPH, and returns the shape that matches Competitor.lastStats.
const fetchCompetitorStats = async ({ channelId, handle }) => {
  const channel = await resolvePublicChannel({ channelId, handle });
  const vph = await computeChannelVph(channel).catch(() => null); // VPH is a bonus signal — a failure here shouldn't fail the whole refresh
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

module.exports = { resolvePublicChannel, computeChannelVph, fetchCompetitorStats };
