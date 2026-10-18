// Competitor Radar — analysis helpers.
//
// Rules this file follows (on purpose):
//  • Total views ("views") and MEASURED growth ("growth") are different things.
//    Growth exists only when a video has two real snapshots ≥ 20h apart.
//  • No history is ever invented or back-filled; no growth → growth is null.
//  • Topics are keyword/phrase COUNTS from titles + tags. They say what
//    competitors talk about, not what will go viral.
const CompetitorVideoSnapshot = require('../models/CompetitorVideoSnapshot');
const Video = require('../models/Video');
const { getYoutubeClient } = require('./youtubePublic');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WINDOW_DAYS = 90;           // videos considered by the dashboard
const MIN_GROWTH_GAP_HOURS = 20;  // two snapshots must be at least this far apart
const MAX_SNAPSHOT_AGE_HOURS = 48; // latest snapshot must be fresh
const round1 = (n) => Math.round(n * 10) / 10;

const median = (arr) => {
  const a = arr.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (a.length === 0) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
};

const viewsPerDay = (video, nowMs) => {
  const views = video.stats?.viewCount || 0;
  const pub = video.publishedAt ? new Date(video.publishedAt).getTime() : null;
  if (!pub) return null;
  return views / Math.max((nowMs - pub) / DAY, 1);
};

// ---------------------------------------------------------------------------
// Measured growth (from snapshots)
// ---------------------------------------------------------------------------
/** snaps: [{viewCount, capturedAt}] oldest → newest. Pure function. */
const growthFromSnapshots = (snaps, nowMs = Date.now()) => {
  if (!snaps || snaps.length < 2) return null;
  const latest = snaps[snaps.length - 1];
  const latestMs = new Date(latest.capturedAt).getTime();
  if (nowMs - latestMs > MAX_SNAPSHOT_AGE_HOURS * HOUR) return null;

  let base = null;
  for (let i = snaps.length - 2; i >= 0; i--) {
    if (latestMs - new Date(snaps[i].capturedAt).getTime() >= MIN_GROWTH_GAP_HOURS * HOUR) { base = snaps[i]; break; }
  }
  if (!base) return null;

  const hours = (latestMs - new Date(base.capturedAt).getTime()) / HOUR;
  const delta = (latest.viewCount || 0) - (base.viewCount || 0);
  if (delta < 0 || hours <= 0) return null; // YouTube view corrections — not a reliable growth number
  return {
    deltaViews: delta,
    hours: round1(hours),
    viewsPerHour: round1(delta / hours),
    // % only when the starting number is big enough to be meaningful
    pct: base.viewCount >= 100 ? round1((delta / base.viewCount) * 100) : null,
    from: base.capturedAt,
    to: latest.capturedAt
  };
};

/** Map(videoId → growth|null) for the given videoIds. */
const computeGrowthMap = async (videoIds, nowMs = Date.now()) => {
  const map = new Map();
  if (!videoIds.length) return map;
  const since = new Date(nowMs - 8 * DAY);
  const snaps = await CompetitorVideoSnapshot.find({ videoId: { $in: videoIds }, capturedAt: { $gte: since } })
    .select('videoId viewCount capturedAt').sort({ capturedAt: 1 }).lean();
  const grouped = new Map();
  snaps.forEach((s) => {
    if (!grouped.has(s.videoId)) grouped.set(s.videoId, []);
    grouped.get(s.videoId).push(s);
  });
  grouped.forEach((list, id) => map.set(id, growthFromSnapshots(list, nowMs)));
  return map;
};

// ---------------------------------------------------------------------------
// "Doing better than this channel's other recent uploads"
// ---------------------------------------------------------------------------
/** Map(videoId → {ratio, medianViewsPerDay}). Needs ≥5 recent videos for a channel. */
const computeOutperforming = (videos, nowMs = Date.now()) => {
  const out = new Map();
  const byChannel = new Map();
  videos.forEach((v) => {
    if (!byChannel.has(v.channelId)) byChannel.set(v.channelId, []);
    byChannel.get(v.channelId).push(v);
  });
  byChannel.forEach((list) => {
    if (list.length < 5) return;
    const rates = list.map((v) => viewsPerDay(v, nowMs));
    const med = median(rates);
    if (!med || med <= 0) return;
    list.forEach((v, i) => {
      const age = v.publishedAt ? nowMs - new Date(v.publishedAt).getTime() : 0;
      if (age < 12 * HOUR || (v.stats?.viewCount || 0) < 100) return;
      const ratio = rates[i] / med;
      if (ratio >= 1.5) out.set(v.videoId, { ratio: round1(ratio), medianViewsPerDay: Math.round(med) });
    });
  });
  return out;
};

// ---------------------------------------------------------------------------
// Topics (keyword + tag counting)
// ---------------------------------------------------------------------------
const STOP = new Set((
  // English
  'the a an and or but of to in on at for with from by is are was were be been it its this that these those you your yours i me my we our they their he she his her ' +
  'as if so not no yes do does did done have has had will would can could should may might just than then there here what when where which who whom why how all any each ' +
  'more most other some such only own same too very into out up down over under again about after before between during through above below off ' +
  // YouTube filler
  'video videos new latest official full part episode ep hd 4k live shorts short vs ft feat channel subscribe watch like comment share ' +
  // Generic words that say nothing about a topic
  'big last power must best top most one two three first second get got make made makes see seen say says said know going gone want need back way ways thing things now today why because every really still even also many much never always ever ' +
  // Roman Hindi / Hinglish filler
  'ka ki ke ko se me mein par pe hai hain tha thi the ho hota hoti hote kya kaise kyun kyu ye yeh wo woh aur ya bhi to toh ek is us in un ne se liye lie wala wali wale ' +
  'apna apni apne mera meri mere tera teri tere hum tum aap aapka aapki main mai nahi nahin ab abhi bas sab sabse kuch bahut ' +
  // Devanagari filler
  'का की के को से में पर है हैं था थी थे हो और या भी तो एक यह वह ये वो ने क्या कैसे क्यों लिए वाला वाली वाले अपना मेरा तेरा हम तुम आप नहीं अब सब कुछ बहुत'
).split(/\s+/));

const TOKEN_RE = /[\p{L}\p{M}\p{N}]+/gu;

const tokenize = (text) => {
  const raw = (text || '').toLowerCase().match(TOKEN_RE) || [];
  return raw.map((t) => ({ t, ok: !STOP.has(t) && !/^\d+$/.test(t) && (/^[a-z]+$/.test(t) ? t.length >= 3 : t.length >= 2) }));
};

/** Set of topic strings (unigrams, bigrams from the title; whole tags) for ONE video. */
const topicsOfVideo = (video) => {
  const topics = new Set();
  const toks = tokenize(video.title);
  toks.forEach((x, i) => {
    if (x.ok) topics.add(x.t);
    if (x.ok && toks[i + 1] && toks[i + 1].ok) topics.add(`${x.t} ${toks[i + 1].t}`);
  });
  (video.tags || []).forEach((tag) => {
    const words = tokenize(tag);
    if (words.length === 0 || words.length > 4) return;
    if (words.every((w) => !w.ok)) return;
    topics.add(words.map((w) => w.t).join(' '));
  });
  return topics;
};

/**
 * videos: CompetitorVideo-like objects. Returns topics ranked by how many
 * different channels use them, then by total views.
 * opts.minVideos (default 2), opts.limit (default 10)
 */
const extractTopics = (videos, { minVideos = 2, minChannels = 1, limit = 10 } = {}) => {
  const overallMedian = videos.length >= 5 ? median(videos.map((v) => v.stats?.viewCount || 0)) : null;
  const map = new Map();
  videos.forEach((v) => {
    topicsOfVideo(v).forEach((topic) => {
      let e = map.get(topic);
      if (!e) { e = { topic, videos: [], channels: new Set() }; map.set(topic, e); }
      e.videos.push(v);
      e.channels.add(v.channelId);
    });
  });

  const rows = [];
  map.forEach((e) => {
    if (e.videos.length < minVideos || e.channels.size < minChannels) return;
    const views = e.videos.map((v) => v.stats?.viewCount || 0);
    const total = views.reduce((a, b) => a + b, 0);
    const avg = total / views.length;
    const best = e.videos.slice().sort((a, b) => (b.stats?.viewCount || 0) - (a.stats?.viewCount || 0))[0];
    rows.push({
      topic: e.topic,
      videos: e.videos.length,
      channels: e.channels.size,
      totalViews: total,
      avgViews: Math.round(avg),
      // >1 means videos on this topic get more views than the typical video in this set
      strength: overallMedian && overallMedian > 0 ? round1(avg / overallMedian) : null,
      exampleVideo: { videoId: best.videoId, title: best.title, views: best.stats?.viewCount || 0, channelId: best.channelId },
      // The videos that make this topic "trend" (top 3 by total views) - so the app can show WHO is winning.
      topVideos: e.videos
        .slice()
        .sort((a, b) => (b.stats?.viewCount || 0) - (a.stats?.viewCount || 0))
        .slice(0, 3)
        .map((v) => ({
          videoId: v.videoId,
          title: v.title,
          thumbnail: v.thumbnail,
          views: v.stats?.viewCount || 0,
          publishedAt: v.publishedAt,
          channelId: v.channelId
        }))
    });
  });

  // Prefer phrases over their own single words when both show up for the same videos.
  const dedup = rows.filter((r) => {
    if (r.topic.includes(' ')) return true;
    return !rows.some((o) => o !== r && o.topic.includes(' ') && o.topic.split(' ').includes(r.topic) && o.videos >= r.videos);
  });

  return dedup
    .sort((a, b) => b.channels - a.channels || b.totalViews - a.totalViews)
    .slice(0, limit);
};

/** Topics competitors cover with comparatively strong views that the user's own titles don't. */
const buildOpportunities = (videos, ownTitles, trackedChannels, { limit = 8 } = {}) => {
  const ownTokenSets = (ownTitles || []).map((t) => new Set(tokenize(t).filter((x) => x.ok).map((x) => x.t)));
  const covered = (topic) => {
    const parts = topic.split(' ');
    return ownTokenSets.some((set) => parts.every((p) => set.has(p)));
  };
  const multi = trackedChannels >= 2;
  const topics = extractTopics(videos, { minVideos: multi ? 2 : 3, minChannels: multi ? 2 : 1, limit: 60 });
  return topics
    .filter((t) => t.strength !== null && t.strength >= 1 && !covered(t.topic))
    .sort((a, b) => b.strength - a.strength || b.videos - a.videos)
    .slice(0, limit);
};

// ---------------------------------------------------------------------------
// The user's own recent titles (to tell which topics they already cover)
// ---------------------------------------------------------------------------
const ownTitlesCache = new Map(); // userId -> { at, titles }
const OWN_TITLES_TTL = 6 * HOUR;

const getOwnTitles = async (user) => {
  const key = String(user._id);
  const hit = ownTitlesCache.get(key);
  if (hit && Date.now() - hit.at < OWN_TITLES_TTL) return hit.titles;

  const titles = new Set();
  try {
    const rows = await Video.find({ user: user._id }).select('title').sort({ createdAt: -1 }).limit(200).lean();
    rows.forEach((r) => r.title && titles.add(r.title));
  } catch (_) { /* ignore */ }

  // Their public channel (API key, 1 quota unit) — covers videos not uploaded through TubePilot.
  const channelId = user.youtubeChannel?.channelId;
  if (channelId && /^UC[\w-]{22}$/.test(channelId)) {
    try {
      const yt = getYoutubeClient();
      const res = await yt.playlistItems.list({ part: 'snippet', playlistId: 'UU' + channelId.slice(2), maxResults: 50 });
      (res.data.items || []).forEach((i) => i.snippet?.title && titles.add(i.snippet.title));
    } catch (_) { /* ignore */ }
  }

  const list = [...titles];
  ownTitlesCache.set(key, { at: Date.now(), titles: list });
  return list;
};

module.exports = {
  WINDOW_DAYS,
  median,
  viewsPerDay,
  growthFromSnapshots,
  computeGrowthMap,
  computeOutperforming,
  tokenize,
  topicsOfVideo,
  extractTopics,
  buildOpportunities,
  getOwnTitles
};
