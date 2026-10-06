const express = require('express');
const Milestone = require('../models/Milestone');
const MilestoneTracker = require('../models/MilestoneTracker');
const { protect } = require('../middleware/auth');
const { generateMilestoneForUser, buildEmail, describe } = require('../utils/milestones');
const { sendBrevoEmail } = require('../utils/brevo');

// Test routes only work when MILESTONE_TEST_MODE=1 is set in .env (remove it after testing).
const testOn = () => process.env.MILESTONE_TEST_MODE === '1';

const router = express.Router();

// @route GET /api/milestones/pending
// Latest card the user has not seen yet (or null).
router.get('/pending', protect, async (req, res) => {
  try {
    const milestone = await Milestone.findOne({ user: req.user._id, seen: false }).sort({ createdAt: -1 });
    res.json({
      success: true,
      milestone: milestone
        ? {
            id: milestone._id,
            type: milestone.type,
            value: milestone.value,
            videoTitle: milestone.videoTitle,
            channelTitle: milestone.channelTitle,
            channelThumbnail: milestone.channelThumbnail || '', // NEW
            createdAt: milestone.createdAt
          }
        : null
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route POST /api/milestones/:id/seen
// Marks this card (and any older unseen ones) as seen, so a milestone never pops up twice.
router.post('/:id/seen', protect, async (req, res) => {
  try {
    await Milestone.updateMany({ user: req.user._id, seen: false }, { $set: { seen: true } });
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
      milestone: doc ? { type: doc.type, value: doc.value, channelTitle: doc.channelTitle, channelThumbnail: doc.channelThumbnail } : null,
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
