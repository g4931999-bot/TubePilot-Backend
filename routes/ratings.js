const express = require('express');
const { protect } = require('../middleware/auth');
const Rating = require('../models/Rating');
const { generateReviewText } = require('../utils/groq');

const router = express.Router();
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

router.get('/status', protect, async (req, res) => {
  try {
    const last = await Rating.findOne({ user: req.user._id }).sort({ createdAt: -1 });
    const shouldShow = !last || (Date.now() - last.createdAt.getTime()) >= SEVEN_DAYS_MS;
    res.json({ success: true, shouldShow });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/suggest', protect, async (req, res) => {
  try {
    const stars = Number(req.query.stars);
    if (!stars || stars < 1 || stars > 5) {
      return res.status(400).json({ success: false, message: 'stars must be between 1 and 5' });
    }
    const reviewText = await generateReviewText(stars);
    res.json({ success: true, reviewText });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/', protect, async (req, res) => {
  try {
    const { stars, reviewText, email } = req.body;
    if (!stars || stars < 1 || stars > 5) {
      return res.status(400).json({ success: false, message: 'stars must be between 1 and 5' });
    }
    const rating = await Rating.create({
      user: req.user._id,
      email: email || req.user.email || '',
      stars,
      reviewText: reviewText || '',
      skipped: false
    });
    res.status(201).json({ success: true, rating });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/dismiss', protect, async (req, res) => {
  try {
    await Rating.create({ user: req.user._id, email: req.user.email || '', stars: null, reviewText: '', skipped: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/mine', protect, async (req, res) => {
  try {
    const rating = await Rating.findOne({ user: req.user._id, skipped: false }).sort({ createdAt: -1 });
    res.json({ success: true, rating: rating || null });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
