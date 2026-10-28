const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const KEY_1 = process.env.GROQ_API_KEY_1 || process.env.GROQ_API_KEY;
const KEY_2 = process.env.GROQ_API_KEY_2;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;

const isFailoverWorthyError = (status, errText) => {
  if (status === 429) return true;
  if (status === 401 || status === 403) return true;
  if (status >= 500) return true;
  if (/insufficient_quota|rate.?limit|invalid.api.?key/i.test(errText || '')) return true;
  return false;
};

// ⚠️ UPDATED: `temperature` is now an option (default 0.7 for creative text).
// SEO scoring passes a low value so the same video gets a stable score.
const callChatCompletionOnce = async (url, apiKey, model, systemPrompt, userPrompt, { json = false, extraHeaders = {}, temperature = 0.7 } = {}) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
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
        temperature,
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

const callGroqOnce = (apiKey, systemPrompt, userPrompt, options = {}) =>
  callChatCompletionOnce(GROQ_URL, apiKey, process.env.GROQ_MODEL || 'openai/gpt-oss-120b', systemPrompt, userPrompt, options);

const callOpenRouterOnce = (apiKey, systemPrompt, userPrompt, options = {}) =>
  callChatCompletionOnce(OPENROUTER_URL, apiKey, process.env.OPENROUTER_MODEL || 'openai/gpt-oss-120b', systemPrompt, userPrompt, options);

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
      console.warn(`Groq primary key failed (${isTimeout ? 'timeout' : err.status}), trying next provider...`);
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
      console.warn(`Groq secondary key failed (${isTimeout ? 'timeout' : err.status}), trying OpenRouter...`);
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

  throw lastErr || new Error('AI request failed and no fallback provider is configured');
};

const callGroq = callGroqWithFailover;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// Models sometimes wrap JSON in ```json fences or add a sentence around it.
const parseJsonLoose = (raw) => {
  const s = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    return JSON.parse(s);
  } catch (_) {
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a !== -1 && b > a) return JSON.parse(s.slice(a, b + 1));
    throw new Error('not json');
  }
};

const clamp100 = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

const cleanStrings = (arr, max) =>
  (Array.isArray(arr) ? arr : [])
    .map((x) => (typeof x === 'string' ? x : x && (x.text || x.title || x.description)) || '')
    .map((x) => String(x).trim())
    .filter(Boolean)
    .slice(0, max);

const uniqueCI = (arr) => {
  const seen = new Set();
  return arr.filter((x) => {
    const k = x.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

const SAME_LANGUAGE_RULE =
  'Write in the SAME language and script as the given topic (Hindi stays Hindi, Hinglish/Roman Hindi stays Hinglish, English stays English). ';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const generateTitle = async (topic) => {
  const raw = await callGroq(
    'You are a YouTube SEO expert. ' + SAME_LANGUAGE_RULE + 'Reply with ONLY one catchy, click-worthy YouTube video title under 90 characters. No quotes, no extra text.',
    `Video topic: ${topic}`
  );
  return raw.replace(/^["']|["']$/g, '');
};

const generateTitleOptions = async (topic, count = 5) => {
  const n = Math.min(Math.max(Number(count) || 5, 3), 5);
  const raw = await callGroq(
    `You are a YouTube SEO expert. Generate exactly ${n} distinct, catchy, click-worthy YouTube video title options for the given topic — ` +
      'each under 90 characters, genuinely different angles/hooks from each other, not just reworded variants of the same phrase. ' +
      SAME_LANGUAGE_RULE +
      'Reply with ONLY a JSON object: {"titles": [string]}. No markdown, no extra text.',
    `Video topic: ${topic}`,
    { json: true }
  );
  try {
    const parsed = parseJsonLoose(raw);
    const titles = uniqueCI(cleanStrings(parsed.titles, 8).map((t) => t.replace(/^["']|["']$/g, '')).filter((t) => t.length <= 100));
    return titles.slice(0, n);
  } catch {
    throw new Error('AI provider returned a non-JSON response for title options');
  }
};

const generateDescription = async (topic) => {
  return callGroq(
    'You are a YouTube SEO expert. ' + SAME_LANGUAGE_RULE + 'Write a compelling, SEO-optimized YouTube video description (150-300 words) with a hook in the first two lines. Reply with ONLY the description text.',
    `Video topic: ${topic}`
  );
};

const generateDescriptionOptions = async (topic, count = 4) => {
  const n = Math.min(Math.max(Number(count) || 4, 3), 5);
  const raw = await callGroq(
    `You are a YouTube SEO expert. Generate exactly ${n} distinct SEO-optimized YouTube video description options (100-200 words each) for the ` +
      'given topic, each with a different opening hook/angle from the others. ' +
      SAME_LANGUAGE_RULE +
      'Reply with ONLY a JSON object: {"descriptions": [string]}. No markdown, no extra text.',
    `Video topic: ${topic}`,
    { json: true }
  );
  try {
    const parsed = parseJsonLoose(raw);
    return cleanStrings(parsed.descriptions, n);
  } catch {
    throw new Error('AI provider returned a non-JSON response for description options');
  }
};

const generateTags = async (topic) => {
  const raw = await callGroq(
    'You are a YouTube SEO expert. ' + SAME_LANGUAGE_RULE + 'Reply with ONLY a comma-separated list of 15 relevant YouTube tags/hashtags for the given topic. No numbering, no extra text.',
    `Video topic: ${topic}`
  );
  return raw.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean);
};

const CAPTION_PROMPTS = {
  instagram: 'You are a social media copywriter specializing in Instagram Reels. Write a short, punchy, engaging caption (1-3 sentences, conversational tone, can include 1-2 emojis) that hooks viewers in the first line. Reply with ONLY the caption text, no hashtags.',
  facebook: 'You are a social media copywriter specializing in Facebook video posts. Write a friendly, slightly longer caption (2-4 sentences) that encourages comments and shares. Reply with ONLY the caption text, no hashtags.'
};

const generateCaption = async (topic, platform) => {
  const systemPrompt = CAPTION_PROMPTS[platform] || CAPTION_PROMPTS.instagram;
  return callGroq(systemPrompt, `Video/Reel topic: ${topic}`);
};

// YouTube hashtag prompt added so the AI Title/Description/Hashtags
// generator screen can call this with platform: 'youtube'. Instagram and
// Facebook prompts unchanged.
const HASHTAG_PROMPTS = {
  youtube: 'You are a YouTube SEO expert. Reply with ONLY a comma-separated list of 12 relevant YouTube hashtags for the given video topic (mix of broad and niche tags, usable in the description). No numbering, no extra text, no # symbol.',
  instagram: 'You are a social media growth expert specializing in Instagram Reels. Reply with ONLY a comma-separated list of 20 relevant, trending Instagram hashtags for the given topic (mix of broad and niche tags). No numbering, no extra text, no # symbol.',
  facebook: 'You are a social media growth expert specializing in Facebook video posts. Reply with ONLY a comma-separated list of 8 relevant Facebook hashtags for the given topic. No numbering, no extra text, no # symbol.'
};

const generateHashtags = async (topic, platform) => {
  const systemPrompt = HASHTAG_PROMPTS[platform] || HASHTAG_PROMPTS.youtube;
  const raw = await callGroq(systemPrompt, `Video/Reel topic: ${topic}`);
  return raw.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean);
};

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
    const parsed = parseJsonLoose(raw);
    return Array.isArray(parsed.ideas)
      ? parsed.ideas.map((i) => ({
          title: i.title || '',
          hook: i.hook || '',
          description: i.description || '',
          script: i.script || '',
          viralScore: clamp100(i.viralScore)
        }))
      : [];
  } catch {
    throw new Error('AI provider returned a non-JSON response for ideas generation');
  }
};

// ---------------------------------------------------------------------------
// Video SEO Optimizer scoring
// ---------------------------------------------------------------------------

// Real, countable facts about the video's text. The server counts these itself
// (LLMs miscount characters) and hands them to the model, so "issues" quote
// exact numbers and the hard caps below are based on facts, not guesses.
const computeSeoFacts = ({ title, description, tags }) => {
  const t = String(title || '').trim();
  const d = String(description || '').trim();
  const tg = (Array.isArray(tags) ? tags : []).map((x) => String(x).trim()).filter(Boolean);
  return {
    titleChars: [...t].length,
    titleWords: t ? t.split(/\s+/).length : 0,
    titleHasNumber: /\d/.test(t),
    descChars: [...d].length,
    descWords: d ? d.split(/\s+/).length : 0,
    descHasLink: /https?:\/\//i.test(d),
    descHashtags: (d.match(/#\w+/g) || []).length,
    tagCount: tg.length,
    tagChars: tg.join(',').length
  };
};

// Overall = fixed weighted formula (never the model's own number), so the big
// ring always agrees with the three sub-scores shown under it.
const SEO_WEIGHTS = { title: 0.4, desc: 0.3, tags: 0.3 };

// Accepts `mode` ('basic' | 'advance'). Real prompt-depth difference, not
// just a gate on top of the same output. Both modes return per-area issues
// (title / description / tags) — Video SEO Optimizer unlocks for ANY paid
// pack. Only the deeper fields (recommendedTags / notes / competitorGapNotes)
// stay advance-only; for basic they are returned EMPTY by the server, so a
// basic user can never see them even by tampering with the app.
const analyzeSeoScore = async ({ title, description, tags = [], platform = 'youtube', mode = 'advance' }) => {
  const facts = computeSeoFacts({ title, description, tags });

  const shared =
    'titleScore weighs length (40-70 chars ideal), keyword placement, and CTR/click-worthiness. descScore weighs length (150-300 words ideal for YouTube), keyword density, and hook strength in the first 2 lines. ' +
    'tagScore weighs relevance and coverage breadth (8-15 relevant tags ideal). ' +
    '"issuesByArea" lists SPECIFIC problems with THIS exact title/description/tags — 1-3 per area, quoting the real numbers from the FACTS line (never generic tips, never recount the numbers yourself). ' +
    'Use an empty array for an area that has no real problem. Write the issues in the same language as the title. No markdown, no extra text.';

  const basicSystemPrompt =
    `You are an SEO analyst for ${platform} video content. Score the given title, description, and tags at a high level, and list concrete problems with them. ` +
    'Reply with ONLY a JSON object: {"breakdown": {"titleScore": number 0-100, "descScore": number 0-100, "tagScore": number 0-100}, "issuesByArea": {"title": [string], "description": [string], "tags": [string]}}. ' +
    shared;

  const advanceSystemPrompt =
    `You are an SEO analyst for ${platform} video content. Score the given title, description, and tags in depth, and list concrete problems with them. ` +
    'Reply with ONLY a JSON object: {"breakdown": {"titleScore": number 0-100, "descScore": number 0-100, "tagScore": number 0-100}, "issuesByArea": {"title": [string], "description": [string], "tags": [string]}, "recommendedTags": [string], "notes": string, "competitorGapNotes": string}. ' +
    shared +
    ' recommendedTags is 5-10 additional tags the creator is missing (no # symbol, not already in the existing tags). ' +
    'notes is 1-2 sentences of the single most valuable improvement. ' +
    'competitorGapNotes is 1-2 sentences on what a top-ranking video in this niche likely does better than this one (packaging, pacing, hook strength, etc).';

  const raw = await callGroq(
    mode === 'basic' ? basicSystemPrompt : advanceSystemPrompt,
    `Title: ${title}\nDescription: ${description || '(none provided)'}\nExisting tags: ${(tags || []).join(', ') || '(none provided)'}\nFACTS (counted by the server, trust these): ${JSON.stringify(facts)}`,
    { json: true, temperature: 0.2 }
  );

  try {
    const parsed = parseJsonLoose(raw);

    let titleScore = clamp100(parsed.breakdown?.titleScore);
    let descScore = clamp100(parsed.breakdown?.descScore);
    let tagScore = clamp100(parsed.breakdown?.tagScore);

    // Hard caps from real facts: nothing to score = near-zero, no matter what the model says.
    if (facts.descChars === 0) descScore = Math.min(descScore, 10);
    if (facts.tagCount === 0) tagScore = Math.min(tagScore, 10);

    const seoScore = clamp100(titleScore * SEO_WEIGHTS.title + descScore * SEO_WEIGHTS.desc + tagScore * SEO_WEIGHTS.tags);

    const byArea = {
      title: cleanStrings(parsed.issuesByArea?.title, 3),
      description: cleanStrings(parsed.issuesByArea?.description, 3),
      tags: cleanStrings(parsed.issuesByArea?.tags, 3)
    };
    // Flat list kept for older app versions (same shape as before).
    const issues = [...byArea.title, ...byArea.description, ...byArea.tags].slice(0, 6);

    const result = {
      seoScore,
      breakdown: { titleScore, descScore, tagScore },
      issues,
      issuesByArea: byArea
    };

    if (mode === 'basic') {
      // Explicitly empty rather than omitted, so the frontend can always
      // read the same shape and show these as locked/blurred for basic.
      result.recommendedTags = [];
      result.notes = '';
      result.competitorGapNotes = '';
    } else {
      const have = new Set((tags || []).map((x) => String(x).trim().toLowerCase()));
      result.recommendedTags = uniqueCI(cleanStrings(parsed.recommendedTags, 15).map((x) => x.replace(/^#/, '')))
        .filter((x) => !have.has(x.toLowerCase()))
        .slice(0, 10);
      result.notes = String(parsed.notes || '').trim();
      result.competitorGapNotes = String(parsed.competitorGapNotes || '').trim();
    }

    return result;
  } catch {
    throw new Error('AI provider returned a non-JSON response for SEO scoring');
  }
};

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
