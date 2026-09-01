const { google } = require('googleapis');
const stream = require('stream');

// ---------------- System-wide storage Drive account ----------------
const getDriveClient = () => {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_DRIVE_REFRESH_TOKEN });
  return google.drive({ version: 'v3', auth: oauth2Client });
};

const uploadBufferToDrive = async (buffer, filename, mimeType) => {
  const drive = getDriveClient();
  const bufferStream = new stream.PassThrough();
  bufferStream.end(buffer);
  const res = await drive.files.create({
    requestBody: { name: filename, parents: [process.env.GOOGLE_DRIVE_FOLDER_ID] },
    media: { mimeType, body: bufferStream },
    fields: 'id, webViewLink, webContentLink'
  });
  await drive.permissions.create({
    fileId: res.data.id,
    requestBody: { role: 'reader', type: 'anyone' }
  });
  return res.data;
};

const getDriveFileStream = async (fileId) => {
  const drive = getDriveClient();
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
  return res.data;
};

const deleteDriveFile = async (fileId) => {
  const drive = getDriveClient();
  return drive.files.delete({ fileId });
};

// ---------------- User's own connected Drive ----------------
const getDriveOAuthClient = () => {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_DRIVE_REDIRECT_URI
  );
};

const exchangeCodeForDriveTokens = async (code) => {
  const oauth2Client = getDriveOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);
  return tokens;
};

const getUserDriveClient = (user) => {
  if (!user.connectedDrive || !user.connectedDrive.refreshToken) {
    throw new Error('User has no connected Google Drive');
  }
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_DRIVE_REDIRECT_URI
  );
  oauth2Client.setCredentials({ refresh_token: user.connectedDrive.refreshToken });
  return google.drive({ version: 'v3', auth: oauth2Client });
};

const getUserDriveAccountInfo = async (accessToken) => {
  const oauth2Client = getDriveOAuthClient();
  oauth2Client.setCredentials({ access_token: accessToken });
  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  const res = await drive.about.get({ fields: 'user' });
  return res.data.user;
};

const listUserDriveVideoFiles = async (user, pageSize = 50) => {
  const drive = getUserDriveClient(user);
  const folderId = user.connectedDrive.folderId;
  let q = "mimeType contains 'video/' and trashed = false";
  if (folderId) q += ` and '${folderId}' in parents`;
  const res = await drive.files.list({
    q,
    pageSize,
    fields: 'files(id, name, mimeType, size, createdTime)',
    orderBy: 'createdTime'
  });
  return res.data.files || [];
};

const downloadUserDriveFileBuffer = async (user, fileId) => {
  const drive = getUserDriveClient(user);
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  return Buffer.from(res.data);
};

// Lists sub-folders under `parentId` (or the Drive root if parentId is
// omitted) so the app can show a folder picker. Used by the "select/change
// folder" feature — the picked folder's id is then saved as
// connectedDrive.folderId and listUserDriveVideoFiles() above scopes to it.
const listUserDriveFolders = async (user, parentId) => {
  const drive = getUserDriveClient(user);
  let q = "mimeType = 'application/vnd.google-apps.folder' and trashed = false";
  q += parentId ? ` and '${parentId}' in parents` : " and 'root' in parents";
  const res = await drive.files.list({
    q,
    pageSize: 100,
    fields: 'files(id, name)',
    orderBy: 'name'
  });
  return res.data.files || [];
};

// NOTE on "delete account" storage cleanup: there is deliberately NO
// deleteUserDriveFiles()-style function here. The Drive files a user
// connected live in THEIR OWN Google Drive, not ours — we only ever had
// read-only access (see DRIVE_SCOPES = ['...drive.readonly'] in
// routes/drive.js). We have no permission to delete files from a user's
// personal Drive, and shouldn't try to even if the scope allowed it: that
// storage isn't ours to touch. Account deletion should only DISCONNECT
// (clear user.connectedDrive, same as the existing DELETE /api/drive/disconnect
// route already does) — never attempt to delete the user's own Drive files.

module.exports = {
  uploadBufferToDrive,
  getDriveFileStream,
  deleteDriveFile,
  getDriveOAuthClient,
  exchangeCodeForDriveTokens,
  getUserDriveClient,
  getUserDriveAccountInfo,
  listUserDriveVideoFiles,
  downloadUserDriveFileBuffer,
  listUserDriveFolders
};
