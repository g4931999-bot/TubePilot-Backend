const express = require('express');
const Milestone = require('../models/Milestone');
const { protect } = require('../middleware/auth');

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

module.exports = router;
