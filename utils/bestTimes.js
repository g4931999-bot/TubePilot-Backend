// UPDATE16 - Auto-Slotting engine. REAL data only.
//
// Reads the user's own published videos from the YouTube Data API
// (views + publish time), groups them by IST weekday x 3-hour slot, and ranks
// the slots by MEDIAN views-per-day. (YouTube does not expose "when is my
// audience online", so the user's own results are the real signal.)
// Videos younger than 2 days are ignored (views still growing). At least
// MIN_VIDEOS usable videos are needed, otherwise there is NO profile (null)
// and callers must fall back to the user's manual time - nothing is guessed.
const { listChannelVideos, refreshAccessToken } = require('./youtube');
const { getCurrentISTDateStr, addDaysToDateStr, buildISTInstant } = require('./dateHelpers');

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MIN_VIDEOS = 5;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MIN_BUFFER_MS = 60 * 60 * 1000 + 5 * 60 * 1000; // server rule is 1h; +5 min safety
const cache = new Map(); // userId -> { at, profile }

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const hhmm = (mins) => {
  const r = Math.round(mins / 5) * 5; // nearest 5 minutes
  const m = Math.min(r, 23 * 60 + 55);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
const weekdayOfDateStr = (dateStr) => (new Date(`${dateStr}T00:00:00Z`).getUTCDay() + 6) % 7; // Mon=0

const freshToken = async (user) => {
  const ch = user.youtubeChannel;
  if (ch.tokenExpiryDate && Date.now() < ch.tokenExpiryDate - 60000) return ch.accessToken;
  const creds = await refreshAccessToken(ch.refreshToken);
  user.youtubeChannel.accessToken = creds.access_token;
  user.youtubeChannel.tokenExpiryDate = creds.expiry_date;
  await user.save();
  return creds.access_token;
};

/** Returns { slots:[{weekday,slot,rate,n,time}], videosUsed } or null when there is not enough real data. */
const getBestTimeProfile = async (user) => {
  if (!user.youtubeChannel) return null;
  const key = String(user._id);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.profile;

  let profile = null;
  try {
    const videos = await listChannelVideos(await freshToken(user), { maxResults: 100 });
    const cells = {};
    let used = 0;
    const now = Date.now();
    for (const v of videos) {
      if (v.viewCount == null || !v.publishedAt) continue;
      const pub = new Date(v.publishedAt).getTime();
      const ageDays = (now - pub) / 86400000;
      if (!(ageDays >= 2)) continue;
      const ist = new Date(pub + IST_OFFSET_MS);
      const weekday = (ist.getUTCDay() + 6) % 7;
      const hour = ist.getUTCHours();
      const slot = Math.floor(((hour - 6 + 24) % 24) / 3);
      const k = `${weekday}-${slot}`;
      (cells[k] = cells[k] || { weekday, slot, rates: [], minutes: [] });
      cells[k].rates.push(v.viewCount / ageDays);
      cells[k].minutes.push(hour * 60 + ist.getUTCMinutes());
      used += 1;
    }
    if (used >= MIN_VIDEOS) {
      const slots = Object.values(cells)
        .map((c) => ({ weekday: c.weekday, slot: c.slot, rate: median(c.rates), n: c.rates.length, time: hhmm(median(c.minutes)) }))
        .sort((a, b) => b.rate - a.rate);
      profile = { slots, videosUsed: used };
    }
  } catch (err) {
    console.error(`⚠️ [AutoSlotting] could not build profile for user ${key}: ${err.message}`);
    return null; // not cached, retry next time
  }
  cache.set(key, { at: Date.now(), profile });
  return profile;
};

// Ranked unique IST times (HH:MM) for one weekday: that weekday's own best slots
// first, then the overall best slots as fallback for weekdays without data.
const timesForWeekday = (profile, weekday) => {
  const out = [];
  const add = (s) => { if (!out.includes(s.time)) out.push(s.time); };
  profile.slots.filter((s) => s.weekday === weekday).forEach(add);
  profile.slots.forEach(add);
  return out.slice(0, 6);
};

/**
 * Picks `count` publish instants (Date[]) at the user's best times, on the next
 * days that still have room under the plan's daily limit.
 * deps = { dailyLimit, countOnDate(dateStr) } - injected by routes/video.js so
 * the exact same limit rules (and IST math) apply.
 */
const pickAutoSlots = async (profile, count, { startOffsetDays = 0, dailyLimit, countOnDate }) => {
  const results = [];
  const base = getCurrentISTDateStr();
  for (let off = startOffsetDays; off <= startOffsetDays + 90 && results.length < count; off++) {
    const dateStr = addDaysToDateStr(base, off);
    let cap = dailyLimit - (await countOnDate(dateStr));
    if (cap <= 0) continue;
    for (const time of timesForWeekday(profile, weekdayOfDateStr(dateStr))) {
      if (cap <= 0 || results.length >= count) break;
      const at = buildISTInstant(dateStr, time);
      if (at.getTime() < Date.now() + MIN_BUFFER_MS) continue;
      results.push(at);
      cap -= 1;
    }
  }
  return results.length === count ? results : null;
};

module.exports = { getBestTimeProfile, pickAutoSlots, timesForWeekday, weekdayOfDateStr };
