const express = require('express');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const { protect } = require('../middleware/auth');
const User = require('../models/User');

// Safely require utility functions
let metaUtils = {};
try {
  metaUtils = require('../utils/meta');
} catch (e) {
  console.warn('⚠️ [Meta Routes] utils/meta.js import warning:', e.message);
}

const router = express.Router();
const PRIMARY_FRONTEND_URL = (process.env.FRONTEND_URL || '').split(',')[0].trim();

// Local Production Fallbacks for 100% Reliability
const safeExchangeCode = async (code) => {
  if (typeof metaUtils.exchangeCodeForToken === 'function') {
    return await metaUtils.exchangeCodeForToken(code);
  }
  const appId = process.env.META_APP_ID || process.env.FACEBOOK_APP_ID;
  const appSecret = process.env.META_APP_SECRET || process.env.FACEBOOK_APP_SECRET;
  const redirectUri = process.env.META_REDIRECT_URI || `${process.env.BACKEND_URL || 'https://api.tubepilot.shop'}/api/meta/oauth/callback`;

  const res = await axios.get('https://graph.facebook.com/v18.0/oauth/access_token', {
    params: { client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code },
    timeout: 10000
  });
  return res.data.access_token;
};

const safeGetLongLivedToken = async (token) => {
  if (typeof metaUtils.getLongLivedUserToken === 'function') {
    return await metaUtils.getLongLivedUserToken(token);
  }
  const appId = process.env.META_APP_ID || process.env.FACEBOOK_APP_ID;
  const appSecret = process.env.META_APP_SECRET || process.env.FACEBOOK_APP_SECRET;

  const res = await axios.get('https://graph.facebook.com/v18.0/oauth/access_token', {
    params: { grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: token },
    timeout: 10000
  });
  return res.data.access_token;
};

const safeFetchUserPages = async (token) => {
  if (typeof metaUtils.getUserPages === 'function') {
    return await metaUtils.getUserPages(token);
  }
  const res = await axios.get('https://graph.facebook.com/v18.0/me/accounts', {
    params: { fields: 'id,name,access_token', access_token: token },
    timeout: 10000
  });
  return res.data.data || [];
};

/**
 * Controller: Generate OAuth URL
 */
const handleGetOAuthUrl = async (req, res) => {
  try {
    const platform = req.query.platform === 'web' ? 'web' : 'mobile';
    const state = jwt.sign({ id: req.user._id, platform }, process.env.JWT_SECRET, { expiresIn: '15m' });
    
    let url;
    if (typeof metaUtils.getFacebookOAuthUrl === 'function') {
      url = metaUtils.getFacebookOAuthUrl(state);
    } else {
      const appId = process.env.META_APP_ID || process.env.FACEBOOK_APP_ID;
      const redirectUri = process.env.META_REDIRECT_URI || `${process.env.BACKEND_URL || 'https://api.tubepilot.shop'}/api/meta/oauth/callback`;
      const scopes = 'public_profile,email,pages_show_list,pages_read_engagement,pages_manage_posts,instagram_basic,instagram_content_publish';
      url = `https://www.facebook.com/v18.0/dialog/oauth?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopes)}&state=${state}&response_type=code`;
    }

    console.log(`▶️ [Meta OAuth URL] user=${req.user._id} platform=${platform}`);
    return res.json({ success: true, url, authUrl: url, oauthUrl: url });
  } catch (err) {
    console.error(`❌ [Meta OAuth URL Error]:`, err.message);
    return res.status(500).json({ success: false, message: 'Failed to generate Meta OAuth URL: ' + err.message });
  }
};

/**
 * Controller: OAuth Callback Process
 */
const handleOAuthCallback = async (req, res) => {
  let platform = 'mobile';
  try {
    const { code, state, error, error_reason, error_description } = req.query;

    if (error) {
      console.error(`❌ [Meta OAuth Callback] Facebook Error: ${error_description || error_reason || error}`);
      throw new Error(error_description || error_reason || error);
    }

    if (!code || !state) {
      throw new Error('Missing authorization code or state parameter from Facebook');
    }

    let decoded;
    try {
      decoded = jwt.verify(state, process.env.JWT_SECRET);
    } catch (jwtErr) {
      throw new Error(`Invalid or expired state verification token`);
    }

    platform = decoded.platform || 'mobile';
    console.log(`▶️ [Meta OAuth Callback] Processing for user ${decoded.id}, platform=${platform}`);

    const user = await User.findById(decoded.id);
    if (!user) throw new Error('User account not found');

    // 1. Exchange short-lived token
    const shortLivedToken = await safeExchangeCode(code);
    
    // 2. Exchange long-lived token
    const longLivedToken = await safeGetLongLivedToken(shortLivedToken);

    // 3. Get Pages
    const pages = await safeFetchUserPages(longLivedToken);

    if (!pages || !pages.length) {
      throw new Error('No Facebook Pages found on this account. A Facebook Page is required to connect.');
    }

    if (pages.length === 1) {
      user.connectedFacebook = {
        pageId: pages[0].id,
        pageName: pages[0].name,
        pageAccessToken: pages[0].access_token,
        connectedAt: new Date()
      };
      user.connectedInstagram = pages[0].instagram
        ? {
            igUserId: pages[0].instagram.id,
            igUsername: pages[0].instagram.username,
            igProfilePicture: pages[0].instagram.profilePicture,
            linkedPageId: pages[0].id,
            connectedAt: new Date()
          }
        : null;
      user.set('metaPendingPages', undefined);
      await user.save();
    } else {
      // Keep each page's linked Instagram info attached so select-page can
      // save connectedInstagram too once the user picks a page — dropping it
      // here (as before) meant Instagram could never be connected for anyone
      // with more than one Facebook Page.
      user.set('metaPendingPages', pages.map((p) => ({
        id: p.id,
        name: p.name,
        access_token: p.access_token,
        instagram: p.instagram
          ? { id: p.instagram.id, username: p.instagram.username, profilePicture: p.instagram.profilePicture }
          : { id: null, username: null, profilePicture: null }
      })));
      await user.save();
    }

    console.log(`✅ [Meta OAuth Callback] Success for user ${user._id}`);

    if (platform === 'mobile') {
      return res.redirect(`tubepilot://oauth-success?meta_connected=1&multiple_pages=${pages.length > 1 ? '1' : '0'}`);
    } else {
      return res.redirect(`${PRIMARY_FRONTEND_URL}/dashboard.html?meta_connected=1`);
    }
  } catch (err) {
    console.error(`❌ [Meta OAuth Callback Failed]:`, err.message);
    if (platform === 'mobile') {
      return res.redirect(`tubepilot://oauth-success?meta_connected=0&error=${encodeURIComponent(err.message)}`);
    } else {
      return res.redirect(`${PRIMARY_FRONTEND_URL}/dashboard.html?meta_connected=0&error=${encodeURIComponent(err.message)}`);
    }
  }
};

/**
 * Controller: Page Selection
 */
const handleSelectPage = async (req, res) => {
  try {
    const pending = req.user.get('metaPendingPages') || [];
    const chosen = pending.find((p) => p.id === req.body.pageId);
    
    if (!chosen) {
      return res.status(400).json({ success: false, message: 'Page not found in pending list' });
    }

    req.user.connectedFacebook = {
      pageId: chosen.id,
      pageName: chosen.name,
      pageAccessToken: chosen.access_token,
      connectedAt: new Date()
    };
    req.user.connectedInstagram = chosen.instagram?.id
      ? {
          igUserId: chosen.instagram.id,
          igUsername: chosen.instagram.username,
          igProfilePicture: chosen.instagram.profilePicture,
          linkedPageId: chosen.id,
          connectedAt: new Date()
        }
      : null;
    req.user.set('metaPendingPages', undefined);
    await req.user.save();

    return res.json({
      success: true,
      facebook: { pageId: req.user.connectedFacebook.pageId, pageName: req.user.connectedFacebook.pageName },
      instagram: req.user.connectedInstagram
        ? { igUserId: req.user.connectedInstagram.igUserId, igUsername: req.user.connectedInstagram.igUsername }
        : null
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Controller: Disconnect Facebook
 */
const handleDisconnect = async (req, res) => {
  try {
    const existing = req.user.connectedFacebook;
    if (existing?.pageId && existing?.pageAccessToken && typeof metaUtils.revokeFacebookAccess === 'function') {
      await metaUtils.revokeFacebookAccess(existing.pageId, existing.pageAccessToken);
    }

    req.user.connectedFacebook = null;
    req.user.connectedInstagram = null;
    req.user.set('metaPendingPages', undefined);
    await req.user.save();

    return res.json({ success: true, message: 'Facebook and Instagram disconnected successfully' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// -----------------------------------------------------------------------
// Route Registrations & Exhaustive Path Mappings
// -----------------------------------------------------------------------

// OAuth URL
router.get('/oauth/url', protect, handleGetOAuthUrl);
router.get('/facebook/url', protect, handleGetOAuthUrl);
router.get('/facebook-auth-url', protect, handleGetOAuthUrl);
router.get('/oauth-url', protect, handleGetOAuthUrl);
router.get('/auth-url', protect, handleGetOAuthUrl);
router.get('/connect', protect, handleGetOAuthUrl);
router.get('/facebook/connect', protect, handleGetOAuthUrl);

// OAuth Callbacks
router.get('/oauth/callback', handleOAuthCallback);
router.get('/facebook/callback', handleOAuthCallback);
router.get('/callback', handleOAuthCallback);

// Page Management
router.get('/pages', protect, async (req, res) => {
  const pending = req.user.get('metaPendingPages') || [];
  res.json({
    success: true,
    pages: pending.map((p) => ({ id: p.id, name: p.name, hasInstagram: !!p.instagram?.id }))
  });
});
router.patch('/select-page', protect, handleSelectPage);

// Disconnect
router.delete('/facebook/disconnect', protect, handleDisconnect);
router.delete('/disconnect', protect, handleDisconnect);

// Status
router.get('/status', protect, async (req, res) => {
  res.json({
    success: true,
    facebook: req.user.connectedFacebook
      ? { pageId: req.user.connectedFacebook.pageId, pageName: req.user.connectedFacebook.pageName, connectedAt: req.user.connectedFacebook.connectedAt }
      : null,
    instagram: req.user.connectedInstagram
      ? { igUserId: req.user.connectedInstagram.igUserId, igUsername: req.user.connectedInstagram.igUsername, connectedAt: req.user.connectedInstagram.connectedAt }
      : null
  });
});

module.exports = router;
