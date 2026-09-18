const express = require('express');
const { protect } = require('../middleware/auth');
const { generateTitle, generateTitleOptions, generateDescription, generateDescriptionOptions, generateTags, generateCaption, generateHashtags, generateAiScript, analyzeSeoScore } = require('../utils/groq');

const router = express.Router();

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

const logAiError = (routeName, err) => {
  console.error(`❌ [AI:${routeName}] ${err.message}`);
  if (err.stack) console.error(err.stack);
};

router.get('/debug-env', protect, (req, res) => {
  res.json({
    success: true,
    hasGroqKey1: !!(process.env.GROQ_API_KEY_1 || process.env.GROQ_API_KEY),
    hasGroqKey2: !!process.env.GROQ_API_KEY_2,
    hasOpenRouterKey: !!process.env.OPENROUTER_API_KEY,
    groqModel: process.env.GROQ_MODEL || 'openai/gpt-oss-120b (default)',
    openRouterModel: process.env.OPENROUTER_MODEL || 'openai/gpt-oss-120b (default)',
    nodeEnv: process.env.NODE_ENV || '(not set)'
  });
});

router.post('/title', protect, async (req, res) => {
  try {
    const { topic } = req.body;
    if (!topic) return res.status(400).json({ success: false, message: 'topic is required' });

    await chargeDiamonds(req.user, AI_FEATURE_COST.title);
    const title = await generateTitle(topic);
    res.json({ success: true, title, diamondsCharged: AI_FEATURE_COST.title, remainingDiamonds: req.user.diamondBalance });
  } catch (err) {
    logAiError('title', err);
    const status = err.code === 'INSUFFICIENT_DIAMONDS' ? 402 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

router.post('/title-options', protect, async (req, res) => {
  try {
    const { topic, count } = req.body;
    if (!topic) return res.status(400).json({ success: false, message: 'topic is required' });

    await chargeDiamonds(req.user, AI_FEATURE_COST.titleOptions);
    const titles = await generateTitleOptions(topic, count);
    res.json({ success: true, titles, diamondsCharged: AI_FEATURE_COST.titleOptions, remainingDiamonds: req.user.diamondBalance });
  } catch (err) {
    logAiError('title-options', err);
    const status = err.code === 'INSUFFICIENT_DIAMONDS' ? 402 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

router.post('/description', protect, async (req, res) => {
  try {
    const { topic } = req.body;
    if (!topic) return res.status(400).json({ success: false, message: 'topic is required' });

    await chargeDiamonds(req.user, AI_FEATURE_COST.description);
    const description = await generateDescription(topic);
    res.json({ success: true, description, diamondsCharged: AI_FEATURE_COST.description, remainingDiamonds: req.user.diamondBalance });
  } catch (err) {
    logAiError('description', err);
    const status = err.code === 'INSUFFICIENT_DIAMONDS' ? 402 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

router.post('/description-options', protect, async (req, res) => {
  try {
    const { topic, count } = req.body;
    if (!topic) return res.status(400).json({ success: false, message: 'topic is required' });

    await chargeDiamonds(req.user, AI_FEATURE_COST.descriptionOptions);
    const descriptions = await generateDescriptionOptions(topic, count);
    res.json({ success: true, descriptions, diamondsCharged: AI_FEATURE_COST.descriptionOptions, remainingDiamonds: req.user.diamondBalance });
  } catch (err) {
    logAiError('description-options', err);
    const status = err.code === 'INSUFFICIENT_DIAMONDS' ? 402 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

router.post('/tags', protect, async (req, res) => {
  try {
    const { topic } = req.body;
    if (!topic) return res.status(400).json({ success: false, message: 'topic is required' });

    await chargeDiamonds(req.user, AI_FEATURE_COST.tags);
    const tags = await generateTags(topic);
    res.json({ success: true, tags, diamondsCharged: AI_FEATURE_COST.tags, remainingDiamonds: req.user.diamondBalance });
  } catch (err) {
    logAiError('tags', err);
    const status = err.code === 'INSUFFICIENT_DIAMONDS' ? 402 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

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
    logAiError('caption', err);
    const status = err.code === 'INSUFFICIENT_DIAMONDS' ? 402 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

// 'youtube' added to the allowed platform list, so the AI Title/
// Description/Hashtags generator screen can call this with
// platform: 'youtube'. instagram/facebook unchanged.
router.post('/hashtags', protect, async (req, res) => {
  try {
    const { topic, platform } = req.body;
    if (!topic) return res.status(400).json({ success: false, message: 'topic is required' });
    if (!['youtube', 'instagram', 'facebook'].includes(platform)) {
      return res.status(400).json({ success: false, message: 'platform must be youtube, instagram, or facebook' });
    }

    await chargeDiamonds(req.user, AI_FEATURE_COST.hashtags);
    const hashtags = await generateHashtags(topic, platform);
    res.json({ success: true, hashtags, diamondsCharged: AI_FEATURE_COST.hashtags, remainingDiamonds: req.user.diamondBalance });
  } catch (err) {
    logAiError('hashtags', err);
    const status = err.code === 'INSUFFICIENT_DIAMONDS' ? 402 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

router.post('/ideas', protect, async (req, res) => {
  try {
    const { niche, platform = 'youtube', count = 5 } = req.body;
    if (!niche) return res.status(400).json({ success: false, message: 'niche is required' });

    const ideas = await generateAiScript({ niche, platform, count });
    res.json({ success: true, ideas, diamondsCharged: 0, remainingDiamonds: req.user.diamondBalance });
  } catch (err) {
    logAiError('ideas', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route POST /api/ai/seo-score  { title, description?, tags?, platform? }
// Video SEO Optimizer gate: unlocks for ANY paid pack
// (seoScoreLevel !== 'none'). tier1 (₹10) sets seoScoreLevel: 'basic' in
// diamond.js, so ₹10 buyers already get full issues + score here. This is
// a DIFFERENT (looser) threshold than the Channel SEO Score gate in
// analytics.js's /audit route, which requires 'advance' (₹100+) — two
// separate screens, two separate thresholds, both reading the same
// seoScoreLevel field.
router.post('/seo-score', protect, async (req, res) => {
  try {
    if (req.user.seoScoreLevel === 'none') {
      return res.status(402).json({ success: false, message: 'Video SEO Optimizer is not included in your current plan. Please upgrade from the Diamond Store.', code: 'PLAN_UPGRADE_REQUIRED' });
    }

    const { title, description, tags, platform = 'youtube' } = req.body;
    if (!title) return res.status(400).json({ success: false, message: 'title is required' });

    await chargeDiamonds(req.user, AI_FEATURE_COST.seoScore);
    const result = await analyzeSeoScore({ title, description, tags, platform, mode: req.user.seoScoreLevel });
    res.json({ success: true, ...result, seoScoreLevel: req.user.seoScoreLevel, diamondsCharged: AI_FEATURE_COST.seoScore, remainingDiamonds: req.user.diamondBalance });
  } catch (err) {
    logAiError('seo-score', err);
    const status = err.code === 'INSUFFICIENT_DIAMONDS' ? 402 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

// @route POST /api/ai/thumbnail-prompt  { topic }
// Quota-based, NOT diamond-charged — each purchase sets a fixed count
// (thumbnailPromptsRemaining) and every call here decrements it by 1 until
// it hits 0, then the user must buy a new package to reset the quota.
router.post('/thumbnail-prompt', protect, async (req, res) => {
  try {
    if (req.user.thumbnailPromptsRemaining <= 0) {
      return res.status(402).json({ success: false, message: 'Thumbnail prompt limit reached for your current plan. Please upgrade from the Diamond Store.', code: 'PLAN_UPGRADE_REQUIRED' });
    }

    const { topic } = req.body;
    if (!topic) return res.status(400).json({ success: false, message: 'topic is required' });

    const prompt = `Create a bold, high-CTR YouTube thumbnail concept for a video about "${topic}". Describe the main subject/expression, background style, and 2-4 word text overlay. Keep it visually simple enough to read at a small size.`;

    req.user.thumbnailPromptsRemaining -= 1;
    await req.user.save();

    res.json({ success: true, prompt, thumbnailPromptsRemaining: req.user.thumbnailPromptsRemaining });
  } catch (err) {
    logAiError('thumbnail-prompt', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
