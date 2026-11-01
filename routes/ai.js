const express = require('express');
const { protect } = require('../middleware/auth');
const User = require('../models/User');
const { generateTitle, generateTitleOptions, generateDescription, generateDescriptionOptions, generateTags, generateCaption, generateHashtags, generateAiScript, analyzeSeoScore } = require('../utils/groq');
const { AI_DIAMOND_COST } = require('../utils/aiCost');

const router = express.Router();

// ---------------------------------------------------------------------------
// ⚠️ UPDATED: EVERY AI feature now costs the same flat AI_DIAMOND_COST (= 1 diamond, utils/aiCost.js)
// — title, description, tags, caption, hashtags, title/description options, SEO analysis.
// Change the number in ONE place (env AI_DIAMOND_COST) and every route follows.
//
// /ideas stays FREE by default because the dashboard "AI Idea" popup calls it automatically once a day
// (charging it would silently eat diamonds). Set env AI_CHARGE_IDEAS=true to charge it too.
// /thumbnail-prompt stays quota-based (each pack gives a fixed number of thumbnail prompts).
// ---------------------------------------------------------------------------
const CHARGE_IDEAS = String(process.env.AI_CHARGE_IDEAS || '') === 'true';

// Atomic: balance check + deduction in ONE database operation, so two quick taps can never
// spend the same diamond twice or push the balance below zero.
const chargeDiamonds = async (user, cost) => {
  if (cost <= 0) return;
  const updated = await User.findOneAndUpdate(
    { _id: user._id, diamondBalance: { $gte: cost } },
    { $inc: { diamondBalance: -cost } },
    { new: true }
  );
  if (!updated) {
    const err = new Error('Not enough diamonds for this AI feature');
    err.code = 'INSUFFICIENT_DIAMONDS';
    throw err;
  }
  user.diamondBalance = updated.diamondBalance;
};

// If the AI provider fails AFTER we charged, the user gets the diamond back.
const refundDiamonds = async (user, cost) => {
  if (cost <= 0) return;
  const updated = await User.findByIdAndUpdate(user._id, { $inc: { diamondBalance: cost } }, { new: true });
  if (updated) user.diamondBalance = updated.diamondBalance;
};

const logAiError = (routeName, err) => {
  console.error(`❌ [AI:${routeName}] ${err.message}`);
  if (err.stack) console.error(err.stack);
};

// Video SEO Optimizer features unlock for ANY paid pack (seoScoreLevel !== 'none'). Same rule as /seo-score.
const hasSeoPlan = (user) => user.seoScoreLevel && user.seoScoreLevel !== 'none';

const planUpgradeBody = {
  success: false,
  message: 'Video SEO Optimizer is not included in your current plan. Please upgrade from the Diamond Store.',
  code: 'PLAN_UPGRADE_REQUIRED'
};

// One shared handler for every diamond-charged AI route.
//   validate(body) -> error message string | null
//   run(body, user) -> object merged into the JSON response
const aiRoute = (routeName, { cost = AI_DIAMOND_COST, requirePlan = false, validate, run }) => async (req, res) => {
  let charged = false;
  try {
    if (requirePlan && !hasSeoPlan(req.user)) return res.status(402).json(planUpgradeBody);

    const problem = validate ? validate(req.body || {}) : null;
    if (problem) return res.status(400).json({ success: false, message: problem });

    await chargeDiamonds(req.user, cost);
    charged = true;

    const payload = await run(req.body || {}, req.user);
    res.json({ success: true, ...payload, diamondsCharged: cost, remainingDiamonds: req.user.diamondBalance });
  } catch (err) {
    logAiError(routeName, err);
    if (charged) await refundDiamonds(req.user, cost).catch(() => {});
    const status = err.code === 'INSUFFICIENT_DIAMONDS' ? 402 : 500;
    res.status(status).json({ success: false, message: err.message, ...(err.code ? { code: err.code } : {}) });
  }
};

const needTopic = (b) => (!b.topic ? 'topic is required' : null);

router.get('/debug-env', protect, (req, res) => {
  res.json({
    success: true,
    hasGroqKey1: !!(process.env.GROQ_API_KEY_1 || process.env.GROQ_API_KEY),
    hasGroqKey2: !!process.env.GROQ_API_KEY_2,
    hasOpenRouterKey: !!process.env.OPENROUTER_API_KEY,
    groqModel: process.env.GROQ_MODEL || 'openai/gpt-oss-120b (default)',
    openRouterModel: process.env.OPENROUTER_MODEL || 'openai/gpt-oss-120b (default)',
    aiDiamondCost: AI_DIAMOND_COST,
    nodeEnv: process.env.NODE_ENV || '(not set)'
  });
});

router.post('/title', protect, aiRoute('title', {
  validate: needTopic,
  run: async (b) => ({ title: await generateTitle(b.topic) })
}));

// Generic routes (AI Title Generator screen, open to anyone with diamonds) and the SEO routes
// (Video SEO Optimizer, paid packs only) run the same logic — SEO ones check the plan first.
const titleOptions = (name, requirePlan) => aiRoute(name, {
  requirePlan,
  validate: needTopic,
  run: async (b) => ({ titles: await generateTitleOptions(b.topic, b.count) })
});
const descriptionOptions = (name, requirePlan) => aiRoute(name, {
  requirePlan,
  validate: needTopic,
  run: async (b) => ({ descriptions: await generateDescriptionOptions(b.topic, b.count) })
});

router.post('/title-options', protect, titleOptions('title-options', false));
router.post('/description-options', protect, descriptionOptions('description-options', false));
router.post('/seo-title-options', protect, titleOptions('seo-title-options', true));
router.post('/seo-description-options', protect, descriptionOptions('seo-description-options', true));

router.post('/description', protect, aiRoute('description', {
  validate: needTopic,
  run: async (b) => ({ description: await generateDescription(b.topic) })
}));

router.post('/tags', protect, aiRoute('tags', {
  validate: needTopic,
  run: async (b) => ({ tags: await generateTags(b.topic) })
}));

router.post('/caption', protect, aiRoute('caption', {
  validate: (b) => {
    if (!b.topic) return 'topic is required';
    if (!['instagram', 'facebook'].includes(b.platform)) return 'platform must be instagram or facebook';
    return null;
  },
  run: async (b) => ({ caption: await generateCaption(b.topic, b.platform) })
}));

router.post('/hashtags', protect, aiRoute('hashtags', {
  validate: (b) => {
    if (!b.topic) return 'topic is required';
    if (!['youtube', 'instagram', 'facebook'].includes(b.platform)) return 'platform must be youtube, instagram, or facebook';
    return null;
  },
  run: async (b) => ({ hashtags: await generateHashtags(b.topic, b.platform) })
}));

router.post('/ideas', protect, aiRoute('ideas', {
  cost: CHARGE_IDEAS ? AI_DIAMOND_COST : 0,
  validate: (b) => (!b.niche ? 'niche is required' : null),
  run: async (b) => ({ ideas: await generateAiScript({ niche: b.niche, platform: b.platform || 'youtube', count: b.count || 5 }) })
}));

// @route POST /api/ai/seo-score  { title, description?, tags?, platform? }
// Video SEO Optimizer gate: ANY paid pack (seoScoreLevel !== 'none'). Channel SEO Score in
// analytics.js's /audit is a DIFFERENT, stricter gate ('advance').
router.post('/seo-score', protect, aiRoute('seo-score', {
  requirePlan: true,
  validate: (b) => (!b.title ? 'title is required' : null),
  run: async (b, user) => {
    const result = await analyzeSeoScore({
      title: b.title,
      description: b.description,
      tags: b.tags,
      platform: b.platform || 'youtube',
      mode: user.seoScoreLevel
    });
    return { ...result, seoScoreLevel: user.seoScoreLevel };
  }
}));

// @route POST /api/ai/thumbnail-prompt  { topic }
// Quota-based, NOT diamond-charged — each purchase sets a fixed count (thumbnailPromptsRemaining)
// and every call decrements it by 1 until 0, then the user must buy a new package.
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
module.exports.AI_DIAMOND_COST = AI_DIAMOND_COST;
