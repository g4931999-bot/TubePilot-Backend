const express = require('express');
const Milestone = require('../models/Milestone');
const MilestoneTracker = require('../models/MilestoneTracker');
const { protect } = require('../middleware/auth');
const { generateMilestoneForUser, buildEmail, describe, CYCLE_DAYS } = require('../utils/milestones');
const { sendBrevoEmail } = require('../utils/brevo');

// Test routes only work when MILESTONE_TEST_MODE=1 is set in .env (remove it after testing).
const testOn = () => process.env.MILESTONE_TEST_MODE === '1';

const router = express.Router();

// UPDATE25: handle saved on the milestone; for older cards (created before handles were saved)
// fall back to whatever the user's saved channel already holds. Empty string if none - never invented.
const handleFor = (milestone, user) => {
  const c = (user && user.youtubeChannel) || {};
  const raw = [milestone.channelHandle, c.channelHandle, c.handle, c.customUrl]
    .find((h) => typeof h === 'string' && h.trim()) || '';
  const h = raw.trim();
  return h ? (h.startsWith('@') ? h : `@${h}`) : '';
};

// A card stays "active" for 15 days after it was created (= the milestone cycle). The app shows it on
// login / app open, at most once per day, until it expires.
const ACTIVE_DAYS = CYCLE_DAYS > 0 ? CYCLE_DAYS : 15;
const DAY_MS = 24 * 60 * 60 * 1000;
// Today's date in IST (YYYY-MM-DD) - the "once per day" rule uses it.
const todayIST = () => new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);

// @route GET /api/milestones/pending
// Latest card created in the last 15 days that was NOT already shown today (or null).
router.get('/pending', protect, async (req, res) => {
  try {
    const since = new Date(Date.now() - ACTIVE_DAYS * DAY_MS);
    const milestone = await Milestone.findOne({ user: req.user._id, createdAt: { $gte: since }, lastShownOn: { $ne: todayIST() } }).sort({ createdAt: -1 });
    res.json({
      success: true,
      milestone: milestone
        ? {
            id: milestone._id,
            type: milestone.type,
            value: milestone.value,
            videoTitle: milestone.videoTitle,
            channelTitle: milestone.channelTitle,
            channelHandle: handleFor(milestone, req.user), // UPDATE25
            channelThumbnail: milestone.channelThumbnail || '', // NEW
            createdAt: milestone.createdAt,
            expiresAt: new Date(new Date(milestone.createdAt).getTime() + ACTIVE_DAYS * DAY_MS)
          }
        : null
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route POST /api/milestones/:id/seen
// Called when the card is shown: remembers "shown today", so it comes back tomorrow (until it expires).
router.post('/:id/seen', protect, async (req, res) => {
  try {
    await Milestone.updateOne({ _id: req.params.id, user: req.user._id }, { $set: { seen: true, lastShownOn: todayIST() } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// TEST ONLY (needs MILESTONE_TEST_MODE=1)
// POST /api/milestones/test-reset
// Zeroes this user's milestone history + tracker, then immediately generates a
// fresh card (popup + push + email), exactly like a first connect.
// ---------------------------------------------------------------------------
router.post('/test-reset', protect, async (req, res) => {
  if (!testOn()) return res.status(404).json({ success: false, message: 'Not found' });
  try {
    await Milestone.deleteMany({ user: req.user._id });
    await MilestoneTracker.deleteMany({ user: req.user._id });
    const doc = await generateMilestoneForUser(req.user, { respectDue: false });
    res.json({
      success: true,
      created: !!doc,
      emailSent: doc ? doc.emailSent : false,
      milestone: doc ? { type: doc.type, value: doc.value, channelTitle: doc.channelTitle, channelHandle: doc.channelHandle, channelThumbnail: doc.channelThumbnail } : null,
      hint: doc ? 'Open the app home screen to see the popup.' : 'No milestone reached yet, or YouTube stats failed. Check server logs.'
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/milestones/test-email
// Sends the milestone email to the logged-in user and returns the REAL error if it fails.
router.post('/test-email', protect, async (req, res) => {
  if (!testOn()) return res.status(404).json({ success: false, message: 'Not found' });
  try {
    if (!req.user.email) return res.status(400).json({ success: false, message: 'User has no email' });
    const fake = {
      type: 'subscribers',
      value: 100,
      channelTitle: req.user.youtubeChannel?.channelTitle || 'Test Channel',
      channelThumbnail: req.user.youtubeChannel?.thumbnail || '',
      videoTitle: ''
    };
    await sendBrevoEmail({ to: req.user.email, toName: req.user.name, subject: describe(fake).title, html: buildEmail(fake) });
    res.json({ success: true, message: `Email sent to ${req.user.email}` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, details: err.response?.data || null });
  }
});

module.exports = router;
