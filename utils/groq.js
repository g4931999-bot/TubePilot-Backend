// Uses Groq's OpenAI-compatible chat completion endpoint, with OpenRouter
// as a further fallback provider.
// Docs: https://console.groq.com/docs/api-reference#chat-create
//       https://openrouter.ai/docs
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// ---------------------------------------------------------------------------
// Triple Provider Automatic Failover: Groq Key 1 -> Groq Key 2 -> OpenRouter
// ---------------------------------------------------------------------------
// GROQ_API_KEY_1 falls back to the legacy GROQ_API_KEY env var so existing
// deployments that only set GROQ_API_KEY keep working unchanged. OPENROUTER_API_KEY
// is a NEW, separate, optional third provider — if it isn't set, behavior is
// unchanged from before (Groq-only, 2-key failover).
const KEY_1 = process.env.GROQ_API_KEY_1 || process.env.GROQ_API_KEY;
const KEY_2 = process.env.GROQ_API_KEY_2;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;

// Errors that mean "this key/provider is exhausted/bad, try the next one" —
// anything else (a malformed prompt, a 400, etc.) is the same on every
// provider so retrying would just waste a call and hide the real error.
const isFailoverWorthyError = (status, errText) => {
  if (status === 429) return true; // rate limit / quota exhausted
  if (status === 401 || status === 403) return true; // invalid/revoked key
  if (status >= 500) return true; // provider-side outage — worth one retry elsewhere
  if (/insufficient_quota|rate.?limit|invalid.api.?key/i.test(errText || '')) return true;
  return false;
};

const callChatCompletionOnce = async (url, apiKey, model, systemPrompt, userPrompt, { json = false, extraHeaders = {} } = {}) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000); // network-timeout guard
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...extraHeaders
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.7,
        ...(json ? { response_format: { type: 'json_object' } } : {})
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      const errText = await res.text();
      const err = new Error(`Chat completion error (${res.status}): ${errText}`);
      err.status = res.status;
      err.body = errText;
      throw err;
    }

    const data = await res.json();
    return data.choices[0].message.content.trim();
  } finally {
    clearTimeout(timeout);
  }
};

// llama-3.3-70b-versatile was deprecated by Groq (announced Jun 17, 2026) and
// fully decommissioned Aug 16, 2026 — requests using it now return 404.
// openai/gpt-oss-120b is Groq's own recommended replacement for this exact
// model (per console.groq.com/docs/deprecations), and supports the same
// JSON-mode response_format used below. Still configurable via GROQ_MODEL
// for future migrations.
const callGroqOnce = (apiKey, systemPrompt, userPrompt, options = {}) =>
  callChatCompletionOnce(GROQ_URL, apiKey, process.env.GROQ_MODEL || 'openai/gpt-oss-120b', systemPrompt, userPrompt, options);

// ⚠️ NEW (Boss request — third provider): OpenRouter as a further fallback
// once BOTH Groq keys have failed. Model defaults to the same
// "openai/gpt-oss-120b" so response shape/behavior stays consistent with
// Groq — configurable separately via OPENROUTER_MODEL if a different model
// is ever preferred on OpenRouter. HTTP-Referer/X-Title headers are
// optional (only affect OpenRouter's own leaderboard attribution), so
// they're omitted rather than hardcoded to a placeholder URL.
const callOpenRouterOnce = (apiKey, systemPrompt, userPrompt, options = {}) =>
  callChatCompletionOnce(OPENROUTER_URL, apiKey, process.env.OPENROUTER_MODEL || 'openai/gpt-oss-120b', systemPrompt, userPrompt, options);

/**
 * callGroqWithFailover(systemPrompt, userPrompt, options?)
 * Tries GROQ_API_KEY_1 first. On a rate-limit / quota / invalid-key /
 * network-timeout style failure, retries GROQ_API_KEY_2 (if configured).
 * If BOTH Groq keys fail in a failover-worthy way, falls over once more to
 * OPENROUTER_API_KEY (if configured) as a last resort before finally
 * throwing. Any non-failover-worthy error (bad request, parsing issue) is
 * NOT retried on any provider — it's thrown as-is since switching keys/
 * providers won't fix it.
 *
 * options.json: true requests JSON mode (used by ideas/seo-score, where
 * the caller needs structured output rather than free text). Supported by
 * Groq and by OpenRouter for OpenAI-compatible models.
 */
const callGroqWithFailover = async (systemPrompt, userPrompt, options = {}) => {
  if (!KEY_1 && !KEY_2 && !OPENROUTER_KEY) {
    throw new Error('No AI provider is configured: set GROQ_API_KEY_1 (or GROQ_API_KEY), and optionally GROQ_API_KEY_2 and/or OPENROUTER_API_KEY');
  }

  let lastErr = null;

  if (KEY_1) {
    try {
      return await callGroqOnce(KEY_1, systemPrompt, userPrompt, options);
    } catch (err) {
      const isTimeout = err.name === 'AbortError';
      const worthFailover = isTimeout || isFailoverWorthyError(err.status, err.body);
      lastErr = isTimeout ? new Error('Groq API request timed out (key 1)') : err;
      if (!worthFailover) throw lastErr;
      console.warn(`⚠️ Groq primary key failed (${isTimeout ? 'timeout' : err.status}), trying next provider...`);
    }
  }

  if (KEY_2) {
    try {
      return await callGroqOnce(KEY_2, systemPrompt, userPrompt, options);
    } catch (err) {
      const isTimeout = err.name === 'AbortError';
      const worthFailover = isTimeout || isFailoverWorthyError(err.status, err.body);
      lastErr = isTimeout ? new Error('Groq API request timed out (key 2)') : err;
      if (!worthFailover) throw lastErr;
      console.warn(`⚠️ Groq secondary key failed (${isTimeout ? 'timeout' : err.status}), trying OpenRouter...`);
    }
  }

  if (OPENROUTER_KEY) {
    try {
      return await callOpenRouterOnce(OPENROUTER_KEY, systemPrompt, userPrompt, options);
    } catch (err) {
      const isTimeout = err.name === 'AbortError';
      lastErr = isTimeout ? new Error('OpenRouter API request timed out') : err;
      throw new Error(`AI request failed on every configured provider — last error: ${lastErr.message}`);
    }
  }

  // No OpenRouter key configured and both Groq keys exhausted/unset.
  throw lastErr || new Error('AI request failed and no fallback provider is configured');
};

// Kept as an internal alias so every existing generate* helper below reads
// unchanged — callGroq now transparently has 3-provider failover.
const callGroq = callGroqWithFailover;

const generateTitle = async (topic) => {
  const raw = await callGroq(
    'You are a YouTube SEO expert. Reply with ONLY one catchy, click-worthy YouTube video title under 90 characters. No quotes, no extra text.',
    `Video topic: ${topic}`
  );
  return raw.replace(/^["']|["']$/g, '');
};

// Multi-option variant for the "Generate & Select" workflow (4-5 title
// options in one call, so the creator can compare and pick rather than
// re-rolling a single result repeatedly).
const generateTitleOptions = async (topic, count = 5) => {
  const n = Math.min(Math.max(Number(count) || 5, 3), 5);
  const raw = await callGroq(
    `You are a YouTube SEO expert. Generate exactly ${n} distinct, catchy, click-worthy YouTube video title options for the given topic — ` +
      'each under 90 characters, genuinely different angles/hooks from each other, not just reworded variants of the same phrase. ' +
      'Reply with ONLY a JSON object: {"titles": [string]}. No markdown, no extra text.',
    `Video topic: ${topic}`,
    { json: true }
  );
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.titles) ? parsed.titles.slice(0, n) : [];
  } catch {
    throw new Error('AI provider returned a non-JSON response for title options');
  }
};

const generateDescription = async (topic) => {
  return callGroq(
    'You are a YouTube SEO expert. Write a compelling, SEO-optimized YouTube video description (150-300 words) with a hook in the first two lines. Reply with ONLY the description text.',
    `Video topic: ${topic}`
  );
};

// Multi-option variant, same rationale as generateTitleOptions above.
const generateDescriptionOptions = async (topic, count = 4) => {
  const n = Math.min(Math.max(Number(count) || 4, 3), 5);
  const raw = await callGroq(
    `You are a YouTube SEO expert. Generate exactly ${n} distinct SEO-optimized YouTube video description options (100-200 words each) for the ` +
      'given topic, each with a different opening hook/angle from the others. Reply with ONLY a JSON object: {"descriptions": [string]}. No markdown, no extra text.',
    `Video topic: ${topic}`,
    { json: true }
  );
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.descriptions) ? parsed.descriptions.slice(0, n) : [];
  } catch {
    throw new Error('AI provider returned a non-JSON response for description options');
  }
};

const generateTags = async (topic) => {
  const raw = await callGroq(
    'You are a YouTube SEO expert. Reply with ONLY a comma-separated list of 15 relevant YouTube tags/hashtags for the given topic. No numbering, no extra text.',
    `Video topic: ${topic}`
  );
  return raw.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean);
};

// Platform-aware caption generator. Instagram and Facebook have different
// tone/length conventions, so the system prompt is branched per platform
// rather than reusing the YouTube description generator — this is what
// keeps captions from ever being a copy of the YouTube title/description.
const CAPTION_PROMPTS = {
  instagram: 'You are a social media copywriter specializing in Instagram Reels. Write a short, punchy, engaging caption (1-3 sentences, conversational tone, can include 1-2 emojis) that hooks viewers in the first line. Reply with ONLY the caption text, no hashtags.',
  facebook: 'You are a social media copywriter specializing in Facebook video posts. Write a friendly, slightly longer caption (2-4 sentences) that encourages comments and shares. Reply with ONLY the caption text, no hashtags.'
};

const generateCaption = async (topic, platform) => {
  const systemPrompt = CAPTION_PROMPTS[platform] || CAPTION_PROMPTS.instagram;
  return callGroq(systemPrompt, `Video/Reel topic: ${topic}`);
};

// Platform-aware hashtag generator. Instagram favors more hashtags than
// Facebook, per each platform's own best-practice conventions.
const HASHTAG_PROMPTS = {
  instagram: 'You are a social media growth expert specializing in Instagram Reels. Reply with ONLY a comma-separated list of 20 relevant, trending Instagram hashtags for the given topic (mix of broad and niche tags). No numbering, no extra text, no # symbol.',
  facebook: 'You are a social media growth expert specializing in Facebook video posts. Reply with ONLY a comma-separated list of 8 relevant Facebook hashtags for the given topic. No numbering, no extra text, no # symbol.'
};

const generateHashtags = async (topic, platform) => {
  const systemPrompt = HASHTAG_PROMPTS[platform] || HASHTAG_PROMPTS.instagram;
  const raw = await callGroq(systemPrompt, `Video/Reel topic: ${topic}`);
  return raw.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean);
};

// Used by routes/ratings.js's GET /suggest route to draft an app-store
// review for the user to edit/submit, based on the star rating they picked.
const generateReviewText = async (stars) => {
  const tone = stars >= 4
    ? 'positive and enthusiastic'
    : stars === 3
      ? 'balanced, mentioning both good points and room for improvement'
      : 'constructive but polite, focused on what could be improved';

  return callGroq(
    `You are helping a user draft a short app store review for "TubePilot", a YouTube/Instagram/Facebook auto-upload and scheduling app. Write a ${tone} review, 1-3 sentences, in the first person, sounding like a real user wrote it (not marketing copy). Reply with ONLY the review text.`,
    `The user gave a ${stars}-star rating.`
  );
};

// ---------------------------------------------------------------------------
// VidIQ-style Creator OS additions
// ---------------------------------------------------------------------------

// POST /api/ai/ideas — 3-5 daily viral video/reel script ideas.
// Reply is parsed as JSON ({ ideas: [...] }) via JSON mode so the route
// doesn't have to regex-parse free text.
const generateAiScript = async ({ niche, platform = 'youtube', count = 5 }) => {
  const n = Math.min(Math.max(Number(count) || 5, 3), 5);
  const raw = await callGroq(
    `You are a viral content strategist for ${platform}. Generate exactly ${n} original short-form video/reel ideas for the given niche. ` +
      'Reply with ONLY a JSON object: {"ideas": [{"title": string, "hook": string, "description": string, "script": string, "viralScore": number}]}. ' +
      '"hook" is the first spoken line (under 15 words) designed to stop someone scrolling. "description" is 1-2 sentences on how the video plays out. ' +
      '"script" is a full 30-60 second spoken script (4-8 short lines/beats, newline-separated) the creator can read straight off. ' +
      '"viralScore" is your own 0-100 estimate of how likely this specific idea is to outperform the niche average, based on hook strength, trend timing, and rewatchability — vary it realistically across the ideas, don\'t give them all the same score. No markdown, no extra text.',
    `Niche: ${niche}`,
    { json: true }
  );
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.ideas)
      ? parsed.ideas.map((i) => ({
          title: i.title || '',
          hook: i.hook || '',
          description: i.description || '',
          script: i.script || '',
          viralScore: Math.max(0, Math.min(100, Math.round(Number(i.viralScore) || 0)))
        }))
      : [];
  } catch {
    throw new Error('AI provider returned a non-JSON response for ideas generation');
  }
};

// POST /api/ai/seo-score — keyword density / CTR potential / length
// compliance / tag relevance analysis of a title+description+tags set.
const analyzeSeoScore = async ({ title, description, tags = [], platform = 'youtube' }) => {
  const raw = await callGroq(
    `You are an SEO analyst for ${platform} video content. Score the given title, description, and tags. ` +
      'Reply with ONLY a JSON object: {"seoScore": number 0-100, "breakdown": {"titleScore": number 0-100, "descScore": number 0-100, "tagScore": number 0-100}, "recommendedTags": [string], "notes": string}. ' +
      'titleScore weighs length (40-70 chars ideal), keyword placement, and CTR/click-worthiness. descScore weighs length (150-300 words ideal for YouTube), keyword density, and hook strength in the first 2 lines. ' +
      'tagScore weighs relevance and coverage breadth. recommendedTags is 5-10 additional tags the creator is missing. No markdown, no extra text.',
    `Title: ${title}\nDescription: ${description || '(none provided)'}\nExisting tags: ${(tags || []).join(', ') || '(none provided)'}`,
    { json: true }
  );
  try {
    const parsed = JSON.parse(raw);
    return {
      seoScore: Math.round(Number(parsed.seoScore) || 0),
      breakdown: {
        titleScore: Math.round(Number(parsed.breakdown?.titleScore) || 0),
        descScore: Math.round(Number(parsed.breakdown?.descScore) || 0),
        tagScore: Math.round(Number(parsed.breakdown?.tagScore) || 0)
      },
      recommendedTags: Array.isArray(parsed.recommendedTags) ? parsed.recommendedTags : [],
      notes: parsed.notes || ''
    };
  } catch {
    throw new Error('AI provider returned a non-JSON response for SEO scoring');
  }
};

// Generic tag suggester — thin wrapper around generateTags kept as its own
// export per spec, in case a caller wants a platform-neutral name instead
// of the YouTube-specific generateTags.
const suggestTags = (topic) => generateTags(topic);

module.exports = {
  callGroqWithFailover,
  generateTitle,
  generateTitleOptions,
  generateDescription,
  generateDescriptionOptions,
  generateTags,
  generateCaption,
  generateHashtags,
  generateReviewText,
  generateAiScript,
  analyzeSeoScore,
  suggestTags
};
