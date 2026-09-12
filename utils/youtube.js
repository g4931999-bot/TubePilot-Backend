const { google } = require('googleapis');

const getOAuthClient = () => {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
};

const exchangeCodeForTokens = async (code) => {
  const oauth2Client = getOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);
  return tokens;
};

const refreshAccessToken = async (refreshToken) => {
  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  const { credentials } = await oauth2Client.refreshAccessToken();
  return credentials;
};

const getChannelInfo = async (accessToken) => {
  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({ access_token: accessToken });
  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
  const res = await youtube.channels.list({ part: 'snippet,statistics', mine: true });
  return res.data.items && res.data.items[0];
};

const uploadVideoToYouTube = async ({ accessToken, refreshToken, fileStream, title, description, tags, categoryId, privacyStatus, publishAt, madeForKids }) => {
  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
  const status = { privacyStatus: privacyStatus || 'private', selfDeclaredMadeForKids: !!madeForKids };
  if (publishAt) {
    status.privacyStatus = 'private';
    status.publishAt = new Date(publishAt).toISOString();
  }
  const res = await youtube.videos.insert({
    part: 'snippet,status',
    requestBody: {
      snippet: { title, description, tags, categoryId: categoryId || '22' },
      status
    },
    media: { body: fileStream }
  });
  return res.data;
};

const setThumbnail = async ({ accessToken, refreshToken, videoId, thumbnailStream }) => {
  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
  return youtube.thumbnails.set({ videoId, media: { body: thumbnailStream } });
};

const updateVideoPrivacy = async ({ accessToken, refreshToken, videoId, privacyStatus }) => {
  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
  const res = await youtube.videos.update({
    part: 'status',
    requestBody: { id: videoId, status: { privacyStatus } }
  });
  return res.data;
};

// ⚠️ UPDATED (Boss request — "My Videos" screen needs tags too, for
// editing): playlistItems.list's snippet does NOT include tags, only
// videos.list's snippet does — so this now makes a second batched call
// (one videos.list for up to `maxResults` ids) to pull tags/description
// alongside title/thumbnail. Still just 2 API calls total per screen
// load (channels.list + playlistItems.list + videos.list = 3, but all
// cheap/quota-light list calls).
const listChannelVideos = async (accessToken, { maxResults = 25 } = {}) => {
  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({ access_token: accessToken });
  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

  const channelRes = await youtube.channels.list({ part: 'contentDetails', mine: true });
  const uploadsPlaylistId = channelRes.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylistId) return [];

  const itemsRes = await youtube.playlistItems.list({
    part: 'snippet',
    playlistId: uploadsPlaylistId,
    maxResults
  });

  const videoIds = (itemsRes.data.items || []).map((i) => i.snippet.resourceId.videoId).filter(Boolean);
  if (!videoIds.length) return [];

  const videosRes = await youtube.videos.list({ part: 'snippet', id: videoIds.join(',') });
  const detailsById = {};
  (videosRes.data.items || []).forEach((v) => { detailsById[v.id] = v.snippet; });

  return videoIds.map((videoId) => {
    const snippet = detailsById[videoId] || {};
    return {
      videoId,
      title: snippet.title || '',
      description: snippet.description || '',
      tags: snippet.tags || [],
      thumbnail: snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || '',
      publishedAt: snippet.publishedAt || null
    };
  });
};

// ⚠️ UPDATED (Boss request — My Videos edit sheet needs to save tags
// too): now merges `tags` into the snippet alongside title/description,
// same "fetch current snippet, merge only what changed" pattern as before.
const updateVideoMetadataOnYoutube = async ({ accessToken, refreshToken, videoId, title, description, tags }) => {
  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

  const existingRes = await youtube.videos.list({ part: 'snippet', id: videoId });
  const existing = existingRes.data.items?.[0];
  if (!existing) {
    const err = new Error('Video not found on this YouTube channel');
    err.status = 404;
    throw err;
  }

  const mergedSnippet = {
    ...existing.snippet,
    ...(title !== undefined && title !== null ? { title } : {}),
    ...(description !== undefined && description !== null ? { description } : {}),
    ...(tags !== undefined && tags !== null ? { tags } : {})
  };

  const res = await youtube.videos.update({
    part: 'snippet',
    requestBody: { id: videoId, snippet: mergedSnippet }
  });
  return res.data;
};

// ⚠️ NEW (Boss request — "My Videos" delete must remove the REAL YouTube
// video, not just TubePilot's own record): permanently deletes a video
// from the connected channel via the YouTube Data API. This is
// irreversible on YouTube's side — the calling route is responsible for
// any confirmation UX before reaching this.
const deleteVideoFromYoutube = async ({ accessToken, refreshToken, videoId }) => {
  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
  await youtube.videos.delete({ id: videoId });
};

const isInvalidGrantError = (err) => {
  const code = err?.response?.data?.error;
  const description = err?.response?.data?.error_description || err?.message || '';
  return code === 'invalid_grant' || /invalid_grant/i.test(description);
};

module.exports = {
  getOAuthClient, exchangeCodeForTokens, refreshAccessToken,
  getChannelInfo, uploadVideoToYouTube, setThumbnail, updateVideoPrivacy,
  listChannelVideos, updateVideoMetadataOnYoutube, deleteVideoFromYoutube,
  isInvalidGrantError
};
