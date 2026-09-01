// Uses Groq's OpenAI-compatible chat completion endpoint.
// Docs: https://console.groq.com/docs/api-reference#chat-create
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// ---------------------------------------------------------------------------
// Dual API Key Automatic Failover
// ---------------------------------------------------------------------------
// GROQ_API_KEY_1 falls back to the legacy GROQ_API_KEY env var so existing
// deployments that only set GROQ_API_KEY keep working unchanged — they just
// won't have a second key to fail over to until GROQ_API_KEY_2 is set too.
const KEY_1 = process.env.GROQ_API_KEY_1 || process.env.GROQ_API_KEY;
const KEY_2 = process.env.GROQ_API_KEY_2;

// Errors that mean "this key is exhausted/bad, try the other one" —
// anything else (a malformed prompt, a 400, etc.) is the same on both keys
// so retrying with key 2 would just waste a call and hide the real error.
const isFailoverWorthyError = (status, errText) => {
  if (status === 429) return true; // rate limit / quota exhausted
  if (status === 401 || status === 403) return true; // invalid/revoked key
  if (status >= 500) return true; // Groq-side outage — worth one retry on the other key
  if (/insufficient_quota|rate.?limit|invalid.api.?key/i.test(errText || '')) return true;
  return false;
};

const callGroqOnce = async (apiKey, systemPrompt, userPrompt, { json = false } = {}) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000); // network-timeout guard
  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
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
      const err = new Error(`Groq API error (${res.status}): ${errText}`);
      err.status = res.status;
      err.groqBody = errText;
      throw err;
    }

    const data = await res.json();
    return data.choices[0].message.content.trim();
  } finally {
    clearTimeout(timeout);
  }
};

/**
 * callGroqWithFailover(systemPrompt, userPrompt, options?)
 * Tries GROQ_API_KEY_1 first. On a rate-limit / quota / invalid-key /
 * network-timeout style failure, silently retries once on GROQ_API_KEY_2
 * (if configured) instead of surfacing the error to the caller. Any other
 * kind of error (bad request, parsing issue) is NOT retried — it's thrown
 * as-is since a second key won't fix it.
 *
 * options.json: true requests Groq's JSON mode (used by ideas/seo-score,
 * where the caller needs structured output rather than free text).
 */
const callGroqWithFailover = async (systemPrompt, userPrompt, options = {}) => {
  if (!KEY_1 && !KEY_2) {
    throw new Error('Groq is not configured: set GROQ_API_KEY_1 (or GROQ_API_KEY) and optionally GROQ_API_KEY_2');
  }

  if (KEY_1) {
    try {
      return await callGroqOnce(KEY_1, systemPrompt, userPrompt, options);
    } catch (err) {
      const isTimeout = err.name === 'AbortError';
      const worthFailover = isTimeout || isFailoverWorthyError(err.status, err.groqBody);
      if (!worthFailover || !KEY_2) {
        if (isTimeout) throw new Error('Groq API request timed out');
        throw err;
      }
      console.warn(`⚠️ Groq primary key failed (${isTimeout ? 'timeout' : err.status}), failing over to GROQ_API_KEY_2...`);
    }
  }

  // Either key 1 wasn't configured, or it just failed in a failover-worthy way.
  if (!KEY_2) throw new Error('Groq primary key failed and no GROQ_API_KEY_2 fallback is configured');
  try {
    return await callGroqOnce(KEY_2, systemPrompt, userPrompt, options);
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Groq API request timed out on fallback key');
    throw new Error(`Groq API failed on both keys — last error: ${err.message}`);
  }
};

// Kept as an internal alias so every existing generate* helper below reads
// unchanged — callGroq now transparently has dual-key failover.
const callGroq = callGroqWithFailover;

const generateTitle = async (topic) => {
  const raw = await callGroq(
    'You are a YouTube SEO expert. Reply with ONLY one catchy, click-worthy YouTube video title under 90 characters. No quotes, no extra text.',
    `Video topic: ${topic}`
  );
  return raw.replace(/^["']|["']$/g, '');
};

const generateDescription = async (topic) => {
  return callGroq(
    'You are a YouTube SEO expert. Write a compelling, SEO-optimized YouTube video description (150-300 words) with a hook in the first two lines. Reply with ONLY the description text.',
    `Video topic: ${topic}`
  );
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
// Reply is parsed as JSON ({ ideas: [...] }) via Groq's JSON mode so the
// route doesn't have to regex-parse free text.
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
    throw new Error('Groq returned a non-JSON response for ideas generation');
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
    throw new Error('Groq returned a non-JSON response for SEO scoring');
  }
};

// Generic tag suggester — thin wrapper around generateTags kept as its own
// export per spec, in case a caller wants a platform-neutral name instead
// of the YouTube-specific generateTags.
const suggestTags = (topic) => generateTags(topic);

module.exports = {
  callGroqWithFailover,
  generateTitle,
  generateDescription,
  generateTags,
  generateCaption,
  generateHashtags,
  generateReviewText,
  generateAiScript,
  analyzeSeoScore,
  suggestTags
};
