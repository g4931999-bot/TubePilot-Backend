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

// ⚠️ UPDATED (Boss request — plan/quota system): now accepts `mode`
// ('basic' | 'advance'). This is a REAL feature difference, not just a
// gate — VPH (Views Per Hour, the "is this channel trending" signal) is
// the expensive/deeper metric, computed via extra playlistItems.list +
// videos.list calls. 'basic' users skip it entirely (faster response,
// fewer API quota units spent); only 'advance' users get it computed.
// Default stays 'advance' when mode isn't passed, so any existing caller
// that doesn't pass mode keeps its current (full) behavior.
const fetchCompetitorStats = async ({ channelId, handle, mode = 'advance' }) => {
  const channel = await resolvePublicChannel({ channelId, handle });
  const vph = mode === 'advance'
    ? await computeChannelVph(channel).catch(() => null)
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

module.exports = { resolvePublicChannel, computeChannelVph, fetchCompetitorStats };
