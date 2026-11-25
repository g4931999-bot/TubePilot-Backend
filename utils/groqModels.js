// Asks Groq which models this API key can really use (cached 6 h), so a renamed / retired
// model never breaks the chat or the auto-title again.
const axios = require('axios');

const URL = 'https://api.groq.com/openai/v1/models';
let cache = { at: 0, ids: [] };
const TTL = 6 * 60 * 60 * 1000;
const NOT_CHAT = /whisper|guard|tts|playai|orpheus|embed|prompt-guard|safeguard/i;

const listModels = async (key) => {
  if (cache.ids.length && Date.now() - cache.at < TTL) return cache.ids;
  try {
    const r = await axios.get(URL, { headers: { Authorization: `Bearer ${key}` }, timeout: 15000 });
    const ids = (r.data?.data || []).map((m) => m.id).filter((id) => id && !NOT_CHAT.test(id));
    if (ids.length) cache = { at: Date.now(), ids };
    return ids;
  } catch (e) {
    console.error('⚠️ [Groq models] list failed:', e.response?.status || '', e.response?.data?.error?.message || e.message);
    return cache.ids;
  }
};

const rank = (ids, prefs) => {
  const out = [];
  for (const re of prefs) ids.filter((id) => re.test(id) && !out.includes(id)).forEach((id) => out.push(id));
  return out;
};

/** best text models first */
const chatModels = async (key) =>
  rank(await listModels(key), [/llama-3\.3-70b/i, /llama-3\.1-8b/i, /gpt-oss-120b/i, /gpt-oss-20b/i, /llama-4/i, /qwen/i, /kimi/i, /llama/i, /./]);

/** models that can read images */
const visionModels = async (key) =>
  rank(await listModels(key), [/llama-4-scout/i, /llama-4-maverick/i, /llama-4/i, /vision/i]);

module.exports = { listModels, chatModels, visionModels };
