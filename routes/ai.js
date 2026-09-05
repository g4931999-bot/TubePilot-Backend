const express = require('express');
const { protect } = require('../middleware/auth');
const { generateTitle, generateTitleOptions, generateDescription, generateDescriptionOptions, generateTags, generateCaption, generateHashtags, generateAiScript, analyzeSeoScore } = require('../utils/groq');

const router = express.Router();

// AI features cost diamonds (premium feature) - adjust cost as needed
// NOTE: `ideas` is now FREE (see /ideas route below) — kept here only so
// the cost map stays a single source of truth if it's ever referenced
// elsewhere; the /ideas route no longer charges it.
const AI_FEATURE_COST = { title: 2, description: 2, tags: 2, caption: 2, hashtags: 2, ideas: 3, seoScore: 1, titleOptions: 3, descriptionOptions: 3 };

const chargeDiamonds = async (user, cost) => {
  if (user.diamondBalance < cost) {
    const err = new Error('Not enough diamonds for this AI feature');
    err.code = 'INSUFFICIENT_DIAMONDS';
    throw err;
  }
  user.diamondBalance -= cost;
  await user.save();
};

// @route POST /api/ai/title  { topic }
router.post('/title', protect, async (req, res) => {
  try {
    const { topic } = req.body;
    if (!topic) return res.status(400).json({ success: false, message: 'topic is required' });

    await chargeDiamonds(req.user, AI_FEATURE_COST.title);
    const title = await generateTitle(topic);
    res.json({ success: true, title, diamondsCharged: AI_FEATURE_COST.title, remainingDiamonds: req.user.diamondBalance });
  } catch (err) {
    const status = err.code === 'INSUFFICIENT_DIAMONDS' ? 402 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

// @route POST /api/ai/title-options  { topic, count? }
// Multi-option variant for the "Generate & Select" workflow — returns
// 3-5 distinct titles instead of one, for the option-cards UI.
router.post('/title-options', protect, async (req, res) => {
  try {
    const { topic, count } = req.body;
    if (!topic) return res.status(400).json({ success: false, message: 'topic is required' });

    await chargeDiamonds(req.user, AI_FEATURE_COST.titleOptions);
    const titles = await generateTitleOptions(topic, count);
    res.json({ success: true, titles, diamondsCharged: AI_FEATURE_COST.titleOptions, remainingDiamonds: req.user.diamondBalance });
  } catch (err) {
    const status = err.code === 'INSUFFICIENT_DIAMONDS' ? 402 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

// @route POST /api/ai/description  { topic }
router.post('/description', protect, async (req, res) => {
  try {
    const { topic } = req.body;
    if (!topic) return res.status(400).json({ success: false, message: 'topic is required' });

    await chargeDiamonds(req.user, AI_FEATURE_COST.description);
    const description = await generateDescription(topic);
    res.json({ success: true, description, diamondsCharged: AI_FEATURE_COST.description, remainingDiamonds: req.user.diamondBalance });
  } catch (err) {
    const status = err.code === 'INSUFFICIENT_DIAMONDS' ? 402 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

// @route POST /api/ai/description-options  { topic, count? }
router.post('/description-options', protect, async (req, res) => {
  try {
    const { topic, count } = req.body;
    if (!topic) return res.status(400).json({ success: false, message: 'topic is required' });

    await chargeDiamonds(req.user, AI_FEATURE_COST.descriptionOptions);
    const descriptions = await generateDescriptionOptions(topic, count);
    res.json({ success: true, descriptions, diamondsCharged: AI_FEATURE_COST.descriptionOptions, remainingDiamonds: req.user.diamondBalance });
  } catch (err) {
    const status = err.code === 'INSUFFICIENT_DIAMONDS' ? 402 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

// @route POST /api/ai/tags  { topic }
router.post('/tags', protect, async (req, res) => {
  try {
    const { topic } = req.body;
    if (!topic) return res.status(400).json({ success: false, message: 'topic is required' });

    await chargeDiamonds(req.user, AI_FEATURE_COST.tags);
    const tags = await generateTags(topic);
    res.json({ success: true, tags, diamondsCharged: AI_FEATURE_COST.tags, remainingDiamonds: req.user.diamondBalance });
  } catch (err) {
    const status = err.code === 'INSUFFICIENT_DIAMONDS' ? 402 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

// @route POST /api/ai/caption  { topic, platform }
// platform: 'instagram' | 'facebook' — each gets its own tone/length via
// generateCaption's platform-aware prompt (see utils/groq.js). Never reuses
// the YouTube title as the caption.
router.post('/caption', protect, async (req, res) => {
  try {
    const { topic, platform } = req.body;
    if (!topic) return res.status(400).json({ success: false, message: 'topic is required' });
    if (!['instagram', 'facebook'].includes(platform)) {
      return res.status(400).json({ success: false, message: 'platform must be instagram or facebook' });
    }

    await chargeDiamonds(req.user, AI_FEATURE_COST.caption);
    const caption = await generateCaption(topic, platform);
    res.json({ success: true, caption, diamondsCharged: AI_FEATURE_COST.caption, remainingDiamonds: req.user.diamondBalance });
  } catch (err) {
    const status = err.code === 'INSUFFICIENT_DIAMONDS' ? 402 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

// @route POST /api/ai/hashtags  { topic, platform }
router.post('/hashtags', protect, async (req, res) => {
  try {
    const { topic, platform } = req.body;
    if (!topic) return res.status(400).json({ success: false, message: 'topic is required' });
    if (!['instagram', 'facebook'].includes(platform)) {
      return res.status(400).json({ success: false, message: 'platform must be instagram or facebook' });
    }

    await chargeDiamonds(req.user, AI_FEATURE_COST.hashtags);
    const hashtags = await generateHashtags(topic, platform);
    res.json({ success: true, hashtags, diamondsCharged: AI_FEATURE_COST.hashtags, remainingDiamonds: req.user.diamondBalance });
  } catch (err) {
    const status = err.code === 'INSUFFICIENT_DIAMONDS' ? 402 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

// @route POST /api/ai/ideas  { niche, platform?, count? }
// VidIQ-style "Daily Ideas" generator — 3-5 viral video/reel ideas with a
// title, hook line, and short description each.
//
// ⚠️ FREE FEATURE (boss request): unlike every other /ai/* route above,
// this one does NOT charge diamonds. It only fails on a genuine upstream
// error (Groq down/misconfigured), never with an "insufficient diamonds"
// message — there is no diamond check here at all.
router.post('/ideas', protect, async (req, res) => {
  try {
    const { niche, platform = 'youtube', count = 5 } = req.body;
    if (!niche) return res.status(400).json({ success: false, message: 'niche is required' });

    const ideas = await generateAiScript({ niche, platform, count });
    res.json({ success: true, ideas, diamondsCharged: 0, remainingDiamonds: req.user.diamondBalance });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route POST /api/ai/seo-score  { title, description?, tags?, platform? }
// VidIQ-style SEO score: keyword density, CTR potential, length compliance,
// tag relevance, plus a recommended-tags list.
router.post('/seo-score', protect, async (req, res) => {
  try {
    const { title, description, tags, platform = 'youtube' } = req.body;
    if (!title) return res.status(400).json({ success: false, message: 'title is required' });

    await chargeDiamonds(req.user, AI_FEATURE_COST.seoScore);
    const result = await analyzeSeoScore({ title, description, tags, platform });
    res.json({ success: true, ...result, diamondsCharged: AI_FEATURE_COST.seoScore, remainingDiamonds: req.user.diamondBalance });
  } catch (err) {
    const status = err.code === 'INSUFFICIENT_DIAMONDS' ? 402 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

module.exports = router;
