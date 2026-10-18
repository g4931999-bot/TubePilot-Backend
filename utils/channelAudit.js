// Channel Audit report builder. PURE function: takes data already fetched from
// the YouTube Data API and returns the numbers behind the audit cards.
// Nothing here is estimated or invented: if there is not enough real data for
// a card, that card is null and the app shows an "not enough data" note.
const DAY = 24 * 60 * 60 * 1000;
const IST = 5.5 * 60 * 60 * 1000;

const dayKey = (ms) => new Date(ms + IST).toISOString().slice(0, 10);
const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const sum = (a) => a.reduce((s, x) => s + x, 0);
const median = (a) => {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const POWER = new Set((
  'secret secrets best top how why ultimate free easy fast new proven mistakes truth shocking hidden guide tips tricks trick vs review ' +
  'kaise kyun kyu sach raaz asli sabse tarika tarike free ' +
  'कैसे क्यों सच राज सबसे असली तरीका फ्री'
).split(/\s+/));


const MIN_GROUP = 3; // a comparison is only shown when BOTH groups have at least this many videos

/** Plain yes/no facts about a title. No scoring - these only split videos into groups. */
const titleFacts = (title) => {
  const t = (title || '').trim();
  const words = t.toLowerCase().match(/[\p{L}\p{M}]+/gu) || [];
  const len = [...t].length;
  return {
    number: /\d/.test(t),
    question: /[?؟]/.test(t),
    power: words.some((w) => POWER.has(w)),
    length: len < 40 ? 'short' : len <= 70 ? 'medium' : 'long'
  };
};

/**
 * channel: { subscriberCount, viewCount, videoCount, description, hasBanner, hasHandle }
 * videos : [{ videoId, title, thumbnail, publishedAt(ms), durationSec, views, likes, comments }]
 */
const buildAuditReport = ({ channel, videos, now = Date.now() }) => {
  const vids = (videos || []).filter((v) => v.publishedAt).sort((a, b) => b.publishedAt - a.publishedAt);
  const since28 = now - 28 * DAY;
  const since56 = now - 56 * DAY;
  const last28 = vids.filter((v) => v.publishedAt >= since28);
  const prev28 = vids.filter((v) => v.publishedAt < since28 && v.publishedAt >= since56);

  // ---------- Content performance (views on videos PUBLISHED in the window) ----------
  const dayKeys = [];
  for (let i = 27; i >= 0; i--) dayKeys.push(dayKey(now - i * DAY));
  const viewsByDay = new Map(dayKeys.map((k) => [k, 0]));
  last28.forEach((v) => {
    const k = dayKey(v.publishedAt);
    if (viewsByDay.has(k)) viewsByDay.set(k, viewsByDay.get(k) + v.views);
  });
  const views28 = sum(last28.map((v) => v.views));
  const viewsPrev28 = sum(prev28.map((v) => v.views));
  const performance = {
    videos: last28.length,
    prevVideos: prev28.length,
    views: views28,
    prevViews: viewsPrev28,
    // Per-video averages of CURRENT views. NOTE: newer videos are still collecting views, so the latest
    // window naturally looks lower - the app shows this with a caveat and never as a "growth %".
    avgViews: last28.length ? Math.round(views28 / last28.length) : null,
    prevAvgViews: prev28.length ? Math.round(viewsPrev28 / prev28.length) : null,
    daily: dayKeys.map((k) => ({ day: k, views: viewsByDay.get(k) }))
  };

  // ---------- Engagement ----------
  const rate = (v) => (v.views > 0 ? ((v.likes || 0) + (v.comments || 0)) / v.views : null);
  const avgRate = (list) => {
    const r = list.map(rate).filter((x) => x !== null);
    return r.length ? sum(r) / r.length : null;
  };
  const eng28 = avgRate(last28.length ? last28 : vids.slice(0, 10));
  const engPrev = avgRate(prev28);
  const engDaily = dayKeys.map((k) => {
    const list = last28.filter((v) => dayKey(v.publishedAt) === k);
    const r = avgRate(list);
    return { day: k, pct: r === null ? null : round2(r * 100) };
  });
  const engagement = {
    pct: eng28 === null ? null : round2(eng28 * 100),
    prevPct: engPrev === null ? null : round2(engPrev * 100),
    deltaPoints: eng28 !== null && engPrev !== null ? round2((eng28 - engPrev) * 100) : null,
    basedOnRecent: last28.length === 0, // true = no uploads in 28d, used latest 10 videos instead
    daily: engDaily
  };

  // ---------- Titles (REAL views per day of YOUR videos, grouped by a title trait) ----------
  // Needs >= 6 videos older than 2 days. Compares median views/day; never scores or guesses.
  const titleVids = vids
    .filter((v) => now - v.publishedAt >= 2 * DAY)
    .slice(0, 50)
    .map((v) => ({ v, vpd: v.views / ((now - v.publishedAt) / DAY), f: titleFacts(v.title) }));
  let titles = null;
  if (titleVids.length >= 6) {
    const medianOf = (list) => (list.length ? Math.round(median(list.map((x) => x.vpd))) : null);
    const pack = (x) => ({ videoId: x.v.videoId, title: x.v.title, thumbnail: x.v.thumbnail, views: x.v.views, viewsPerDay: Math.round(x.vpd) });
    const sorted = titleVids.slice().sort((a, b) => b.vpd - a.vpd);
    const patterns = ['number', 'question', 'power'].map((code) => {
      const withG = titleVids.filter((x) => x.f[code]);
      const withoutG = titleVids.filter((x) => !x.f[code]);
      const ready = withG.length >= MIN_GROUP && withoutG.length >= MIN_GROUP;
      const wm = medianOf(withG);
      const om = medianOf(withoutG);
      return {
        code,
        ready,
        withCount: withG.length,
        withoutCount: withoutG.length,
        withMedian: wm,
        withoutMedian: om,
        // % difference of median views/day, only when both groups are big enough
        diffPct: ready && om > 0 ? Math.round(((wm - om) / om) * 100) : null
      };
    });
    const lengths = ['short', 'medium', 'long'].map((bucket) => {
      const g = titleVids.filter((x) => x.f.length === bucket);
      return { bucket, count: g.length, ready: g.length >= MIN_GROUP, median: g.length >= MIN_GROUP ? medianOf(g) : null };
    });
    const readyLens = lengths.filter((l) => l.ready);
    titles = {
      sampled: titleVids.length,
      minGroup: MIN_GROUP,
      best: sorted.slice(0, 3).map(pack),
      worst: sorted.slice(-3).reverse().map(pack),
      patterns,
      lengths,
      bestLength: readyLens.length >= 2 ? readyLens.slice().sort((a, b) => b.median - a.median)[0].bucket : null
    };
  }

  // ---------- Thumbnails (real views per day, NOT an A/B test) ----------
  const eligible = vids
    .filter((v) => now - v.publishedAt >= 2 * DAY)
    .map((v) => ({ v, vpd: v.views / ((now - v.publishedAt) / DAY) }));
  let thumbnails = null;
  if (eligible.length >= 5) {
    const med = median(eligible.map((e) => e.vpd));
    const sorted = eligible.slice().sort((a, b) => b.vpd - a.vpd);
    const pack = (e) => ({
      videoId: e.v.videoId,
      title: e.v.title,
      thumbnail: e.v.thumbnail,
      views: e.v.views,
      viewsPerDay: Math.round(e.vpd),
      vsMedian: med > 0 ? round1(e.vpd / med) : null
    });
    thumbnails = {
      sampled: eligible.length,
      medianViewsPerDay: Math.round(med),
      best: sorted.slice(0, 3).map(pack),
      worst: sorted.slice(-3).reverse().map(pack)
    };
  }

  // ---------- Consistency ----------
  const week = [];
  for (let i = 6; i >= 0; i--) {
    const k = dayKey(now - i * DAY);
    week.push({
      day: k,
      weekday: new Date(`${k}T00:00:00Z`).getUTCDay(), // 0=Sun..6=Sat
      uploads: vids.filter((v) => dayKey(v.publishedAt) === k).length
    });
  }
  const gaps = [];
  for (let i = 0; i < Math.min(vids.length, 20) - 1; i++) gaps.push((vids[i].publishedAt - vids[i + 1].publishedAt) / DAY);
  const daysSinceLast = vids.length ? Math.floor((now - vids[0].publishedAt) / DAY) : null;
  const consistency = {
    week,
    uploadsLast28: last28.length,
    perWeek: round1(last28.length / 4),
    avgGapDays: gaps.length ? round1(sum(gaps) / gaps.length) : null,
    longestGapDays: gaps.length ? Math.round(Math.max(...gaps)) : null,
    daysSinceLast,
    weekendUploads: last28.filter((v) => [0, 6].includes(new Date(v.publishedAt + IST).getUTCDay())).length
  };

  // ---------- Profile ----------
  const profile = {
    descriptionOk: ((channel.description || '').trim().length >= 50),
    hasBanner: !!channel.hasBanner,
    hasHandle: !!channel.hasHandle
  };

  // ---------- Health score (only parts with real data count) ----------
  const parts = [];
  if (vids.length) {
    const recency = daysSinceLast === null ? 0 : clamp(1 - Math.max(0, daysSinceLast - 7) / 21, 0, 1);
    parts.push({ key: 'consistency', weight: 40, value: clamp(consistency.perWeek / 2, 0, 1) * 0.7 + recency * 0.3 });
    if (engagement.pct !== null) parts.push({ key: 'engagement', weight: 35, value: clamp(engagement.pct / 4, 0, 1) });
  }
  parts.push({ key: 'profile', weight: 25, value: (Number(profile.descriptionOk) + Number(profile.hasBanner) + Number(profile.hasHandle)) / 3 });
  const totalW = sum(parts.map((p) => p.weight));
  const score = Math.round((sum(parts.map((p) => p.weight * p.value)) / totalW) * 100);
  const health = {
    score,
    level: score >= 80 ? 'healthy' : score >= 60 ? 'attention' : 'work',
    parts: parts.map((p) => ({ key: p.key, score: Math.round(p.value * 100) })),
    complete: parts.length === 3 // false = some cards lacked data and were left out of the score
  };

  return { health, performance, engagement, titles, thumbnails, consistency, profile, videosAnalysed: vids.length };
};

module.exports = { buildAuditReport, titleFacts, dayKey };
