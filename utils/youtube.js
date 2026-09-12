const { google } = require('googleapis');

const getOAuthClient = () => {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
};

// Exchanges the authorization code (from frontend Google consent screen) for tokens
const exchangeCodeForTokens = async (code) => {
  const oauth2Client = getOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);
  return tokens; // { access_token, refresh_token, expiry_date, ... }
};

// Refreshes access token using stored refresh token
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

// Uploads a readable stream to the connected YouTube channel
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
  return res.data; // includes id
};

const setThumbnail = async ({ accessToken, refreshToken, videoId, thumbnailStream }) => {
  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
  return youtube.thumbnails.set({ videoId, media: { body: thumbnailStream } });
};

// Switches an already-uploaded video's privacy status (e.g. unlisted -> public)
// without re-uploading the file. Used by cron/scheduler.js to publish a video
// that was uploaded unlisted and scheduled to go public later.
const updateVideoPrivacy = async ({ accessToken, refreshToken, videoId, privacyStatus }) => {
  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
  const res = await youtube.videos.update({
    part: 'status',
    requestBody: {
      id: videoId,
      status: { privacyStatus }
    }
  });
  return res.data;
};

// ⚠️ NEW (Boss request — Option B, "Apply to Video" should also cover
// already-published channel videos, not just TubePilot's own queued
// uploads): fetches the connected channel's real videos straight from
// YouTube — same data the creator sees in YouTube Studio.
//
// Two-step approach because playlistItems.list (the "uploads" playlist)
// is the cheapest way to enumerate a channel's videos, but doesn't
// reliably include privacyStatus — so this only pulls what's needed for
// a picker list (id/title/description/thumbnail/publishedAt). If a
// caller later needs privacyStatus too, add a videos.list(part:'status')
// pass over the returned ids — not done here to keep this to one API
// round-trip pair (channels.list + playlistItems.list) per call.
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

  return (itemsRes.data.items || []).map((item) => ({
    videoId: item.snippet.resourceId.videoId,
    title: item.snippet.title,
    description: item.snippet.description,
    thumbnail: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || '',
    publishedAt: item.snippet.publishedAt
  }));
};

// ⚠️ NEW (Boss request — Option B): updates title/description directly on
// an already-published/live YouTube video (NOT TubePilot's own DB record —
// this is a real YouTube API write). videos.update requires the FULL
// snippet object (categoryId is mandatory), so this fetches the video's
// current snippet first and merges in only the fields that changed,
// leaving tags/categoryId/everything else exactly as they were.
const updateVideoMetadataOnYoutube = async ({ accessToken, refreshToken, videoId, title, description }) => {
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
    ...(description !== undefined && description !== null ? { description } : {})
  };

  const res = await youtube.videos.update({
    part: 'snippet',
    requestBody: { id: videoId, snippet: mergedSnippet }
  });
  return res.data;
};

// Detects Google's "invalid_grant" response, which means the refresh token
// itself is dead (user revoked access in their Google Account, token expired
// from 6 months of inactivity, or the OAuth consent was reset). This is NOT
// a transient network/API error — retrying won't help, the user must
// reconnect their YouTube account. Used by cron/scheduler.js's
// ensureFreshYouTubeToken() to decide between "stop retrying, ask user to
// reconnect" vs "transient error, retry as normal". Also now used by the
// new /my-videos and /my-videos/:id routes for the same reason.
const isInvalidGrantError = (err) => {
  const code = err?.response?.data?.error;
  const description = err?.response?.data?.error_description || err?.message || '';
  return code === 'invalid_grant' || /invalid_grant/i.test(description);
};

module.exports = {
  getOAuthClient, exchangeCodeForTokens, refreshAccessToken,
  getChannelInfo, uploadVideoToYouTube, setThumbnail, updateVideoPrivacy,
  listChannelVideos, updateVideoMetadataOnYoutube,
  isInvalidGrantError
};
