const express = require('express');
const jwt = require('jsonwebtoken');
const { protect } = require('../middleware/auth');
const User = require('../models/User');
const {
  getDriveOAuthClient,
  exchangeCodeForDriveTokens,
  getUserDriveAccountInfo,
  listUserDriveFolders,
  listUserDriveVideoFiles
} = require('../utils/googleDrive');

const router = express.Router();
const PRIMARY_FRONTEND_URL = (process.env.FRONTEND_URL || '').split(',')[0].trim();

// Read-only on purpose: the backend only ever needs to LIST and READ the
// user's own video files to auto-upload them — never delete or modify
// anything in their personal Drive. See utils/user.js's account-deletion
// notes for why "disconnect" (not "delete files") is the only destructive
// action ever taken against a user's Drive.
const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
];

const UPLOAD_MODES = ['scheduled', 'live'];

// @route GET /api/drive/oauth/url?platform=mobile|web
// Returns the Google consent URL for connecting the user's OWN Google
// Drive (separate OAuth client/redirect from the YouTube connection —
// see GOOGLE_DRIVE_REDIRECT_URI in utils/googleDrive.js).
router.get('/oauth/url', protect, (req, res) => {
  try {
    const oauth2Client = getDriveOAuthClient();
    const platform = req.query.platform === 'mobile' ? 'mobile' : 'web';
    const state = jwt.sign({ id: req.user._id, platform }, process.env.JWT_SECRET, { expiresIn: '10m' });

    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent', // ensures refresh_token is always returned
      scope: DRIVE_SCOPES,
      state
    });

    res.json({ success: true, url });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to generate Google Drive OAuth URL: ' + err.message });
  }
});

// @route GET /api/drive/oauth/callback
// Google redirects here after the user grants permission.
router.get('/oauth/callback', async (req, res) => {
  let platform = 'web';
  try {
    const { code, state, error, error_description } = req.query;

    if (error) throw new Error(error_description || error);
    if (!code || !state) throw new Error('Missing authorization code or state parameter from Google');

    const decoded = jwt.verify(state, process.env.JWT_SECRET);
    platform = decoded.platform || 'web';

    const user = await User.findById(decoded.id);
    if (!user) throw new Error('User account not found');

    const tokens = await exchangeCodeForDriveTokens(code);
    if (!tokens.refresh_token && !user.connectedDrive?.refreshToken) {
      // Google only returns a refresh_token on the FIRST consent for a given
      // app+account, or when prompt=consent forces re-consent (which we
      // always pass above) — so this should be rare, but fail loudly rather
      // than silently saving a connection that can never auto-refresh.
      throw new Error('Google did not return a refresh token. Please try connecting again.');
    }

    const accountInfo = await getUserDriveAccountInfo(tokens.access_token);

    user.connectedDrive = {
      email: accountInfo?.emailAddress || '',
      displayName: accountInfo?.displayName || '',
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || user.connectedDrive?.refreshToken,
      tokenExpiryDate: tokens.expiry_date,
      folderId: null,
      folderName: null,
      dailyUploadTime: null,
      uploadMode: 'scheduled',
      lastAutoUploadDate: null,
      driveProcessedFileIds: [],
      noNewVideoSinceDate: null,
      connectedAt: new Date()
    };
    user.driveConnectCount = (user.driveConnectCount || 0) + 1;
    await user.save();

    console.log(`✅ [Drive OAuth Callback] Success for user ${user._id} (${accountInfo?.emailAddress || 'unknown email'})`);

    if (platform === 'mobile') {
      return res.redirect('tubepilot://oauth-success?drive_connected=1');
    }
    return res.redirect(`${PRIMARY_FRONTEND_URL}/dashboard.html?drive_connected=1`);
  } catch (err) {
    console.error('❌ [Drive OAuth Callback Failed]:', err.message);
    if (platform === 'mobile') {
      return res.redirect(`tubepilot://oauth-success?drive_connected=0&error=${encodeURIComponent(err.message)}`);
    }
    return res.redirect(`${PRIMARY_FRONTEND_URL}/dashboard.html?drive_connected=0&error=${encodeURIComponent(err.message)}`);
  }
});

// @route GET /api/drive/status
router.get('/status', protect, (req, res) => {
  const drive = req.user.connectedDrive;
  if (!drive) return res.json({ success: true, connected: false, drive: null });

  res.json({
    success: true,
    connected: true,
    drive: {
      email: drive.email,
      displayName: drive.displayName,
      folderId: drive.folderId,
      folderName: drive.folderName,
      dailyUploadTime: drive.dailyUploadTime,
      uploadMode: drive.uploadMode,
      lastAutoUploadDate: drive.lastAutoUploadDate,
      connectedAt: drive.connectedAt
    }
  });
});

// @route GET /api/drive/folders?parentId=xyz
// Lists sub-folders for the folder picker UI. Omit parentId for Drive root.
router.get('/folders', protect, async (req, res) => {
  try {
    if (!req.user.connectedDrive) {
      return res.status(400).json({ success: false, message: 'Google Drive is not connected', code: 'DRIVE_NOT_CONNECTED' });
    }
    const folders = await listUserDriveFolders(req.user, req.query.parentId || null);
    res.json({ success: true, folders });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to list Drive folders: ' + err.message });
  }
});

// @route GET /api/drive/files
// Lists the video files currently visible in the connected scope (whole
// Drive, or the selected folder) — used for a "here's what we'll pick up
// next" preview in the app.
router.get('/files', protect, async (req, res) => {
  try {
    if (!req.user.connectedDrive) {
      return res.status(400).json({ success: false, message: 'Google Drive is not connected', code: 'DRIVE_NOT_CONNECTED' });
    }
    const files = await listUserDriveVideoFiles(req.user);
    res.json({ success: true, files });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to list Drive video files: ' + err.message });
  }
});

// @route PATCH /api/drive/settings  { folderId, folderName, dailyUploadTime, uploadMode }
// Configures the Drive Auto-Upload Engine (see cron/scheduler.js). All
// fields optional/partial — only provided fields are updated.
router.patch('/settings', protect, async (req, res) => {
  try {
    if (!req.user.connectedDrive) {
      return res.status(400).json({ success: false, message: 'Google Drive is not connected', code: 'DRIVE_NOT_CONNECTED' });
    }

    const { folderId, folderName, dailyUploadTime, uploadMode } = req.body;

    if (uploadMode !== undefined) {
      if (!UPLOAD_MODES.includes(uploadMode)) {
        return res.status(400).json({ success: false, message: `uploadMode must be one of: ${UPLOAD_MODES.join(', ')}` });
      }
      req.user.connectedDrive.uploadMode = uploadMode;
    }

    if (dailyUploadTime !== undefined) {
      if (dailyUploadTime !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(dailyUploadTime)) {
        return res.status(400).json({ success: false, message: 'dailyUploadTime must be in HH:MM 24-hour format (IST), or null to clear it' });
      }
      req.user.connectedDrive.dailyUploadTime = dailyUploadTime;
    }

    if (folderId !== undefined) {
      req.user.connectedDrive.folderId = folderId || null;
      req.user.connectedDrive.folderName = folderName || null;
      // Changing scope means previously-seen file ids from the old scope
      // shouldn't block new files in the new scope from being picked up.
      req.user.connectedDrive.driveProcessedFileIds = [];
      req.user.connectedDrive.noNewVideoSinceDate = null;
    }

    await req.user.save();

    res.json({
      success: true,
      message: 'Drive auto-upload settings updated',
      drive: {
        folderId: req.user.connectedDrive.folderId,
        folderName: req.user.connectedDrive.folderName,
        dailyUploadTime: req.user.connectedDrive.dailyUploadTime,
        uploadMode: req.user.connectedDrive.uploadMode
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route DELETE /api/drive/disconnect
// Only clears the stored connection — never touches the user's actual
// Drive files (we only ever hold drive.readonly access; see utils/user.js).
router.delete('/disconnect', protect, async (req, res) => {
  try {
    req.user.connectedDrive = null;
    await req.user.save();
    res.json({ success: true, message: 'Google Drive disconnected successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
