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

// Detects Google's "invalid_grant" response, which means the refresh token
// itself is dead (user revoked access in their Google Account, token expired
// from 6 months of inactivity, or the OAuth consent was reset). This is NOT
// a transient network/API error — retrying won't help, the user must
// reconnect their YouTube account. Used by cron/scheduler.js's
// ensureFreshYouTubeToken() to decide between "stop retrying, ask user to
// reconnect" vs "transient error, retry as normal".
const isInvalidGrantError = (err) => {
  const code = err?.response?.data?.error;
  const description = err?.response?.data?.error_description || err?.message || '';
  return code === 'invalid_grant' || /invalid_grant/i.test(description);
};

module.exports = {
  getOAuthClient, exchangeCodeForTokens, refreshAccessToken,
  getChannelInfo, uploadVideoToYouTube, setThumbnail, updateVideoPrivacy,
  isInvalidGrantError
};
