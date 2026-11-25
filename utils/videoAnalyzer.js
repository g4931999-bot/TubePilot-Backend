// ---------------------------------------------------------------------------
// AUTO TITLE / DESCRIPTION / TAGS from the video itself.
//
//  1. Cloudinary gives 3 small frames of the video (second 0, 1, 2) as jpg URLs - no ffmpeg, no extra server.
//  2. The frames + the channel name + the channel's last titles go to a Groq VISION model.
//  3. The model answers (Hinglish) with { title, description, tags }.
//
// Env:  GROQ_API_KEY_1 / GROQ_API_KEY / GROQ_API_KEY_2   (same keys the other AI tools use)
//       GROQ_VISION_MODEL   default meta-llama/llama-4-scout-17b-16e-instruct  (change here if Groq renames it)
//       AUTO_META_LANGUAGE  default "Hinglish"
// Never throws: returns null when anything fails, so an upload is never broken by this.
// ---------------------------------------------------------------------------
const axios = require('axios');
const { visionModels } = require('./groqModels');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = () => process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';
const LANGUAGE = () => process.env.AUTO_META_LANGUAGE || 'Hinglish';
const FRAME_SECONDS = [0, 1, 2];
const MAX_PARALLEL = 2; // Groq free limits: never hit it with many videos at once

const keys = () => [process.env.GROQ_API_KEY_1, process.env.GROQ_API_KEY, process.env.GROQ_API_KEY_2].filter(Boolean);

// ---- tiny queue so a 30-video bulk upload does not fire 30 requests together
let running = 0;
const waiting = [];
const runQueued = (fn) =>
  new Promise((resolve) => {
    const start = async () => {
      running += 1;
      try { resolve(await fn()); } catch (_) { resolve(null); } finally {
        running -= 1;
        const next = waiting.shift();
        if (next) next();
      }
    };
    if (running < MAX_PARALLEL) start(); else waiting.push(start);
  });

const frameUrl = (storageUrl, sec) => {
  const u = String(storageUrl || '');
  if (!u.includes('/video/upload/')) return '';
  return u
    .replace('/video/upload/', `/video/upload/so_${sec},w_512,c_limit,q_70,f_jpg/`)
    .replace(/\.[a-z0-9]+(\?.*)?$/i, '.jpg');
};

const fetchFrame = async (url) => {
  try {
    const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000, maxContentLength: 3 * 1024 * 1024 });
    return `data:image/jpeg;base64,${Buffer.from(r.data).toString('base64')}`;
  } catch (_) {
    return null;
  }
};

const clean = (obj) => {
  if (!obj || typeof obj !== 'object') return null;
  const title = String(obj.title || '').replace(/["\n\r]/g, ' ').trim().slice(0, 95);
  const description = String(obj.description || '').trim().slice(0, 4500);
  let tags = Array.isArray(obj.tags) ? obj.tags : String(obj.tags || '').split(',');
  tags = tags.map((t) => String(t).replace(/[#,]/g, '').trim()).filter(Boolean);
  const out = [];
  let total = 0;
  for (const t of tags) {
    if (total + t.length + 1 > 450) break;
    out.push(t);
    total += t.length + 1;
  }
  if (!title) return null;
  return { title, description, tags: out };
};

let discoveredVision = null; // a vision model this key really has (used after a "model_not_found")
const callGroq = async (messages, key) => {
  const r = await axios.post(
    GROQ_URL,
    { model: discoveredVision || MODEL(), messages, temperature: 0.6, max_tokens: 900, response_format: { type: 'json_object' } },
    { headers: { Authorization: `Bearer ${key}` }, timeout: 30000 }
  );
  return r.data?.choices?.[0]?.message?.content || '';
};

/**
 * @param {{storageUrl:string, fileName?:string, channelName?:string, recentTitles?:string[]}} p
 * @returns {Promise<{title:string, description:string, tags:string[]}|null>}
 */
const analyzeVideo = (p) =>
  runQueued(async () => {
    const apiKeys = keys();
    if (!apiKeys.length) return null;

    const frames = (await Promise.all(FRAME_SECONDS.map((s) => fetchFrame(frameUrl(p.storageUrl, s))))).filter(Boolean);
    if (!frames.length) return null; // not a Cloudinary video (Drive fallback) or frames not ready

    const recent = (p.recentTitles || []).filter(Boolean).slice(0, 5);
    const prompt =
      `You write YouTube metadata. These images are the first seconds of one video.\n` +
      `Channel: ${p.channelName || 'unknown'}\n` +
      (recent.length ? `The channel's recent video titles (keep the same niche and style): ${recent.join(' | ')}\n` : '') +
      (p.fileName ? `File name (a weak hint only): ${p.fileName}\n` : '') +
      `Write in ${LANGUAGE()} (Hindi words in Roman letters mixed with simple English, the way Indian creators write).\n` +
      `Describe only what you can really see; do not invent facts, names or numbers.\n` +
      `Return ONLY JSON: {"title": "max 70 characters, catchy, no quotes", ` +
      `"description": "3-5 short lines about the video + a call to action + 3-5 hashtags at the end", ` +
      `"tags": ["10 to 15 relevant search keywords"]}`;

    const content = [{ type: 'text', text: prompt }, ...frames.map((f) => ({ type: 'image_url', image_url: { url: f } }))];
    const messages = [{ role: 'user', content }];

    for (let attempt = 0; attempt < 2; attempt += 1) {
      for (const key of apiKeys) {
        try {
          const text = await callGroq(messages, key);
          const parsed = clean(JSON.parse(text));
          if (parsed) return parsed;
        } catch (e) {
          const status = e.response?.status;
          console.error(`⚠️ [VideoAnalyzer] Groq ${status || ''} ${e.response?.data?.error?.message || e.message}`);
          if (e.response?.data?.error?.code === 'model_not_found') {
            try { discoveredVision = (await visionModels(key))[0] || null; } catch (_) { /* ignore */ }
          }
          if (status === 429) await new Promise((r) => setTimeout(r, 3000)); // rate limit: next key / retry
        }
      }
    }
    return null;
  });

module.exports = { analyzeVideo, frameUrl };
