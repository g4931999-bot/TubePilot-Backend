// ---------------------------------------------------------------------------
// AI CHAT ASSISTANT (language understanding only - the real work is done by the
// existing endpoints: /videos/upload, /videos/bulk-upload, /analytics/audit,
// /analytics/competitors, live stream screen). Real data only: this file never
// invents numbers, it only (1) understands what the user typed, (2) writes
// title/description/tags from the user's hint, (3) turns "kal shaam 6 baje"
// into a real date-time.
//
// Mount in server.js:   app.use('/api/assistant', require('./routes/assistant'));
// Env: GROQ_API_KEY_1 / GROQ_API_KEY / GROQ_API_KEY_2, GROQ_CHAT_MODEL (default llama-3.3-70b-versatile),
//      AUTO_META_LANGUAGE (default Hinglish)
// ---------------------------------------------------------------------------
const express = require('express');
const axios = require('axios');
const { protect } = require('../middleware/auth');
const { chatModels } = require('../utils/groqModels');

const router = express.Router();
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = () => process.env.GROQ_CHAT_MODEL || 'llama-3.3-70b-versatile';
const LANGUAGE = () => process.env.AUTO_META_LANGUAGE || 'Hinglish';
const keys = () => [process.env.GROQ_API_KEY_1, process.env.GROQ_API_KEY, process.env.GROQ_API_KEY_2].filter(Boolean);
const IST_MS = 5.5 * 60 * 60 * 1000;

// models are tried in this order (first one that works wins); set GROQ_CHAT_MODEL to put yours first
let lastGoodModel = null; // remembered so the next message goes straight to a working model
const models = () => [...new Set([lastGoodModel, process.env.GROQ_CHAT_MODEL, 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-20b'].filter(Boolean))];

const askJson = async (system, user, maxTokens = 700) => {
  const apiKeys = keys();
  if (!apiKeys.length) {
    const e = new Error('AI keys are not set on the server (GROQ_API_KEY_1 / GROQ_API_KEY).');
    e.detail = e.message;
    throw e;
  }
  let lastErr;
  // our default list first; if Groq says a model does not exist, the models this key really has are tried too
  const tried = new Set();
  const order = models();
  for (let m = 0; m < order.length; m += 1) {
    const model = order[m];
    if (tried.has(model)) continue;
    tried.add(model);
    for (const key of apiKeys) {
      try {
        const r = await axios.post(
          GROQ_URL,
          {
            model,
            messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
            temperature: 0.4,
            max_tokens: maxTokens,
            response_format: { type: 'json_object' }
          },
          { headers: { Authorization: `Bearer ${key}` }, timeout: 30000 }
        );
        lastGoodModel = model;
        return JSON.parse(r.data?.choices?.[0]?.message?.content || '{}');
      } catch (e) {
        lastErr = e;
        const st = e.response?.status;
        console.error(`⚠️ [Assistant] Groq ${model} -> ${st || ''} ${e.response?.data?.error?.message || e.message}`);
        lastErr.detail = `${model}: ${st || ''} ${e.response?.data?.error?.message || e.message}`.slice(0, 200);
        if (st === 429) await new Promise((r2) => setTimeout(r2, 1500));
        if (e.response?.data?.error?.code === 'model_not_found' && !order.discovered) {
          order.discovered = true;
          try {
            (await chatModels(key)).forEach((id) => { if (!order.includes(id)) order.push(id); });
          } catch (_) { /* keep going with the list we have */ }
        }
      }
    }
  }
  throw lastErr || new Error('AI failed');
};

// "2026-11-18 20:15 IST, Wednesday" for the prompt
const istNowText = () => {
  const d = new Date(Date.now() + IST_MS);
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} IST, ${days[d.getUTCDay()]}`;
};

const INTENTS = ['upload', 'hint', 'time', 'thumbnail', 'seo', 'competitor', 'live', 'help', 'chat'];

// POST /api/assistant/understand
// body: { message, stage: 'idle'|'ask_hint'|'ask_thumb'|'ask_time', videoCount }
router.post('/understand', protect, async (req, res) => {
  try {
    const message = String(req.body.message || '').trim().slice(0, 1000);
    const stage = String(req.body.stage || 'idle');
    const videoCount = Math.max(0, Number(req.body.videoCount) || 0);
    if (!message) return res.status(400).json({ success: false, message: 'Message is empty' });

    const system =
      `You are the assistant inside TubePilot (a YouTube upload/scheduling/SEO app). The user writes Hindi/Hinglish/English. ` +
      `Current time: ${istNowText()}. Conversation stage: "${stage}". Videos attached in chat: ${videoCount}.\n` +
      `Classify the user's message. Return ONLY JSON: {"intent": one of ${JSON.stringify(INTENTS)}, "reply": "one short friendly Hinglish line (max 25 words)", ` +
      `"auto": boolean, "hint": string|null, "skip": boolean, "now": boolean, "scheduleIso": string|null, "handle": string|null, "bulkAuto": boolean}\n` +
      `Rules:\n` +
      `- "auto": true ONLY if the user says to do it without approval / automatically / on its own ("bina approval ke", "automatic upload karo", "approval ki zarurat nahi"), else false.\n` +
      `- "upload": wants to upload / set up / schedule video(s), or says they will send videos.\n` +
      `- stage "ask_hint": the user is describing what the video is about -> intent "hint", hint = their description (copy their words). If they say they don't know / "tum dekh lo" / "auto" -> intent "hint", skip=true, hint=null.\n` +
      `- stage "ask_thumb": if they say no/skip/auto/baad me -> intent "thumbnail", skip=true. If they only talk about something else classify normally.\n` +
      `- stage "ask_time": a date/time -> intent "time", scheduleIso = ISO 8601 with +05:30 offset computed from the current time (the time MUST be in the future; "kal"=tomorrow, "shaam"=18:00, "subah"=08:00, "raat"=21:00 when no hour given). "abhi"/"now"/"turant" -> now=true. "auto"/"tum decide karo"/"best time" -> intent "time", bulkAuto=true. If you cannot tell the time, intent "chat" and ask them in reply.\n` +
      `- "seo": wants channel SEO / audit / report of their own channel.\n` +
      `- "competitor": wants to analyse a competitor / another channel. handle = the @handle, channel link or channel id they wrote (null if none given; then reply asks for it).\n` +
      `- "live": wants to go live / live stream.\n` +
      `- "help": asks what you can do.\n` +
      `- otherwise "chat" with a short helpful reply. Never invent statistics or facts about their channel.`;

    const out = await askJson(system, message, 400);
    const intent = INTENTS.includes(out.intent) ? out.intent : 'chat';

    let scheduleIso = null;
    if (intent === 'time' && out.scheduleIso) {
      const t = new Date(out.scheduleIso);
      if (!isNaN(t.getTime()) && t.getTime() > Date.now() + 2 * 60 * 1000) scheduleIso = t.toISOString();
    }
    const timeUnclear = intent === 'time' && !scheduleIso && !out.now && !out.bulkAuto;

    res.json({
      success: true,
      intent: timeUnclear ? 'chat' : intent,
      reply: timeUnclear ? 'Time samajh nahi aaya ya wo nikal chuka hai. Dobara batao, jaise "kal shaam 6 baje".' : String(out.reply || '').slice(0, 300),
      hint: out.hint ? String(out.hint).slice(0, 500) : null,
      skip: !!out.skip,
      now: !!out.now,
      bulkAuto: !!out.bulkAuto,
      auto: !!out.auto,
      scheduleIso,
      handle: out.handle ? String(out.handle).trim().slice(0, 200) : null
    });
  } catch (err) {
    console.error('❌ [Assistant] understand:', err.response?.data || err.message);
    res.status(500).json({ success: false, message: 'AI is busy right now. Please try again.', detail: err.detail || err.message });
  }
});

// POST /api/assistant/meta   { hints: ["video 1 about ...", ...] }  (max 30)
// -> { items: [{ title, description, tags }] }   (same order as hints)
router.post('/meta', protect, async (req, res) => {
  try {
    const hints = (Array.isArray(req.body.hints) ? req.body.hints : []).map((h) => String(h || '').trim().slice(0, 500)).slice(0, 30);
    if (!hints.length) return res.status(400).json({ success: false, message: 'hints required' });
    const channel = req.user.youtubeChannel?.title || req.user.youtubeChannel?.channelTitle || '';

    const system =
      `You write YouTube metadata for Indian creators. Language: ${LANGUAGE()} (Hindi in Roman letters mixed with simple English). ` +
      `Use ONLY what the user's hint says; do not invent facts, names or numbers. Channel: ${channel || 'unknown'}.\n` +
      `Return ONLY JSON: {"items":[{"title":"max 70 chars, catchy, no quotes","description":"3-5 short lines + call to action + 3-5 hashtags at the end","tags":["10 to 15 keywords"]}]} ` +
      `with exactly one item per hint, same order.`;
    const out = await askJson(system, hints.map((h, i) => `Video ${i + 1}: ${h}`).join('\n'), 3500);
    const items = (Array.isArray(out.items) ? out.items : []).slice(0, hints.length).map((o) => {
      let tags = Array.isArray(o.tags) ? o.tags : String(o.tags || '').split(',');
      tags = tags.map((t) => String(t).replace(/[#,]/g, '').trim()).filter(Boolean);
      const kept = [];
      let total = 0;
      for (const t of tags) { if (total + t.length + 1 > 450) break; kept.push(t); total += t.length + 1; }
      return {
        title: String(o.title || '').replace(/["\n\r]/g, ' ').trim().slice(0, 95),
        description: String(o.description || '').trim().slice(0, 4500),
        tags: kept
      };
    });
    if (items.length !== hints.length || items.some((i) => !i.title)) {
      return res.status(502).json({ success: false, message: 'AI could not write the title. Please try again.' });
    }
    res.json({ success: true, items });
  } catch (err) {
    console.error('❌ [Assistant] meta:', err.response?.data || err.message);
    res.status(500).json({ success: false, message: 'AI is busy right now. Please try again.', detail: err.detail || err.message });
  }
});

module.exports = router;
