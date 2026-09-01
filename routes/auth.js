const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const User = require('../models/User');
const { generateAccessToken, generateRefreshToken } = require('../utils/generateTokens');
const { generateUserId, generateReferralCode } = require('../utils/idGenerator');
const { protect } = require('../middleware/auth');
const { deleteUserAccountCascade } = require('../utils/user');

const router = express.Router();
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const issueTokens = async (res, user) => {
  const accessToken = generateAccessToken(user._id);
  const refreshToken = generateRefreshToken(user._id);

  user.refreshTokens = [...(user.refreshTokens || []).slice(-4), refreshToken];
  await user.save();

  res.cookie('refreshToken', refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 30 * 24 * 60 * 60 * 1000
  });

  return { accessToken, refreshToken };
};

// @route POST /api/auth/signup
router.post('/signup', async (req, res) => {
  try {
    const { name, email, password, referredBy } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required' });
    }

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({ success: false, message: 'Email already registered' });
    }

    const userId = await generateUserId();
    const referralCode = await generateReferralCode(userId);

    const user = await User.create({
      userId,
      name: name || '',
      email: email.toLowerCase(),
      password,
      authProvider: 'local',
      referralCode,
      referredBy: referredBy || null,
      freeUploadsRemaining: Number(process.env.FREE_UPLOADS_PER_MONTH || 20)
    });

    const { accessToken, refreshToken } = await issueTokens(res, user);
    res.status(201).json({ success: true, accessToken, refreshToken, user: user.toSafeObject() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email: (email || '').toLowerCase() }).select('+password');
    if (!user || !user.password) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }
    const match = await user.comparePassword(password);
    if (!match) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    const { accessToken, refreshToken } = await issueTokens(res, user);
    res.json({ success: true, accessToken, refreshToken, user: user.toSafeObject() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route POST /api/auth/google
router.post('/google', async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ success: false, message: 'idToken is required' });

    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID
    });
    const payload = ticket.getPayload();

    let user = await User.findOne({ googleId: payload.sub });
    if (!user) {
      user = await User.findOne({ email: payload.email });
    }

    if (!user) {
      const userId = await generateUserId();
      const referralCode = await generateReferralCode(userId);
      user = await User.create({
        userId,
        name: payload.name,
        email: payload.email,
        avatar: payload.picture,
        googleId: payload.sub,
        authProvider: 'google',
        referralCode,
        freeUploadsRemaining: Number(process.env.FREE_UPLOADS_PER_MONTH || 20)
      });
    } else if (!user.googleId) {
      user.googleId = payload.sub;
      user.authProvider = 'google';
      await user.save();
    }

    const { accessToken, refreshToken } = await issueTokens(res, user);
    res.json({ success: true, accessToken, refreshToken, user: user.toSafeObject(), isNewUser: !user.username });
  } catch (err) {
    res.status(401).json({ success: false, message: 'Google authentication failed', error: err.message });
  }
});

// @route POST /api/auth/refresh
router.post('/refresh', async (req, res) => {
  try {
    const token = req.cookies.refreshToken || req.body.refreshToken;
    if (!token) return res.status(401).json({ success: false, message: 'No refresh token provided' });

    const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    const user = await User.findById(decoded.id);
    if (!user || !user.refreshTokens.includes(token)) {
      return res.status(401).json({ success: false, message: 'Invalid refresh token' });
    }

    const accessToken = generateAccessToken(user._id);
    res.json({ success: true, accessToken });
  } catch (err) {
    res.status(401).json({ success: false, message: 'Refresh token expired or invalid' });
  }
});

// @route POST /api/auth/logout
router.post('/logout', protect, async (req, res) => {
  try {
    const token = req.cookies.refreshToken;
    req.user.refreshTokens = (req.user.refreshTokens || []).filter((t) => t !== token);
    await req.user.save();
    res.clearCookie('refreshToken');
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route GET /api/auth/me
router.get('/me', protect, async (req, res) => {
  res.json({ success: true, user: req.user.toSafeObject() });
});

// @route POST /api/auth/setup-username
router.post('/setup-username', protect, async (req, res) => {
  try {
    const { username, language, avatar } = req.body;
    if (!username || username.length < 3) {
      return res.status(400).json({ success: false, message: 'Username must be at least 3 characters' });
    }
    const taken = await User.findOne({ username, _id: { $ne: req.user._id } });
    if (taken) return res.status(409).json({ success: false, message: 'Username already taken' });

    req.user.username = username;
    if (language) req.user.language = language;
    if (avatar) req.user.avatar = avatar;
    await req.user.save();

    res.json({ success: true, user: req.user.toSafeObject() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

const REFERRAL_SIGNUP_BONUS_DIAMONDS = 10;
const REFERRER_BONUS_DIAMONDS = 5;

router.post('/apply-referral', protect, async (req, res) => {
  try {
    const { referralCode } = req.body;
    if (!referralCode) return res.status(400).json({ success: false, message: 'referralCode is required' });

    if (req.user.referredBy) {
      return res.status(400).json({ success: false, message: 'You have already used a referral code' });
    }

    const referrer = await User.findOne({ referralCode: referralCode.trim().toUpperCase() });
    if (!referrer) {
      return res.status(404).json({ success: false, message: 'Invalid referral code' });
    }
    if (referrer._id.equals(req.user._id)) {
      return res.status(400).json({ success: false, message: "You can't use your own referral code" });
    }

    req.user.referredBy = referrer.userId;
    req.user.diamondBalance += REFERRAL_SIGNUP_BONUS_DIAMONDS;
    await req.user.save();

    referrer.diamondBalance += REFERRER_BONUS_DIAMONDS;
    await referrer.save();

    res.json({
      success: true,
      message: `Referral applied! You received ${REFERRAL_SIGNUP_BONUS_DIAMONDS} bonus diamonds, and your referrer received ${REFERRER_BONUS_DIAMONDS}.`,
      diamondBalance: req.user.diamondBalance
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/delete-account', protect, async (req, res) => {
  try {
    if (req.user.role === 'admin') {
      return res.status(400).json({
        success: false,
        message: 'Admin accounts cannot be deleted from the app. Contact support or use direct database access.'
      });
    }

    const { cloudinaryCleanup } = await deleteUserAccountCascade(req.user);

    res.clearCookie('refreshToken');

    const storageNote = cloudinaryCleanup.failed.length
      ? ` (${cloudinaryCleanup.failed.length} file(s) had cleanup issues)`
      : '';

    res.json({
      success: true,
      message: `Your account has been permanently deleted${storageNote}`
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
