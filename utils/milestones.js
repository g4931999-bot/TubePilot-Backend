const MilestoneTracker = require('../models/MilestoneTracker');
const Milestone = require('../models/Milestone');
const Notification = require('../models/Notification');
const { sendPushToUser } = require('./push');
const { sendOneSignalToUser } = require('./oneSignalPush');
const { refreshAccessToken, getMilestoneStats, isInvalidGrantError } = require('./youtube');
const { sendBrevoEmail } = require('./brevo');

const MILESTONES = {
  subscribers: [100, 500, 1000, 2000, 3000, 5000, 9000, 15000, 25000, 50000, 100000, 250000, 500000, 1000000],
  views: [500, 1000, 2000, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000]
};

// Days between two cards. Set MILESTONE_CYCLE_DAYS=0 in .env to test quickly.
const CYCLE_DAYS = process.env.MILESTONE_CYCLE_DAYS !== undefined ? Number(process.env.MILESTONE_CYCLE_DAYS) : 15;
const DAY_MS = 24 * 60 * 60 * 1000;

const fmt = (n) => {
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}K`;
  return String(n);
};

const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Highest milestone crossed that has not been shown yet (the "show only the top one" rule).
const highest = (list, current, last) => {
  const hit = list.filter((m) => m <= current && m > last);
  return hit.length ? hit[hit.length - 1] : null;
};

// NEW: best-effort channel photo URL. Tries stats first, then the saved channel on the user.
// If your field has another name, add it to the candidates list below.
const pickThumbnail = (user, stats) => {
  const c = (user && user.youtubeChannel) || {};
  const candidates = [
    stats && stats.channelThumbnail,
    stats && stats.thumbnail,
    c.thumbnail,
    c.thumbnailUrl,
    c.thumbnails && c.thumbnails.default && c.thumbnails.default.url,
    c.avatar,
    c.profileImage,
    c.picture
  ];
  const url = candidates.find((u) => typeof u === 'string' && /^https?:\/\//.test(u));
  return url || '';
};

const getFreshToken = async (user) => {
  const ch = user.youtubeChannel;
  const expired = !ch.tokenExpiryDate || Date.now() > ch.tokenExpiryDate - 60000;
  if (!expired) return ch.accessToken;
  const creds = await refreshAccessToken(ch.refreshToken);
  user.youtubeChannel.accessToken = creds.access_token;
  user.youtubeChannel.tokenExpiryDate = creds.expiry_date;
  await user.save();
  return creds.access_token;
};

const describe = (m) => {
  const v = fmt(m.value);
  return m.type === 'subscribers'
    ? { title: `🎉 ${v} Subscribers!`, body: `Congratulations! ${m.channelTitle || 'Your channel'} just crossed ${v} subscribers.` }
    : { title: `🔥 ${v} Views!`, body: `Congratulations! Your latest video just crossed ${v} views.` };
};

// Black + gold achievement email (matches the in-app card).
// Email-safe: tables + inline styles, solid bgcolor fallbacks (no reliance on gradients).
const buildEmail = (m) => {
  const v = fmt(m.value);
  const isSubs = m.type === 'subscribers';
  const { body } = describe(m);
  const channel = m.channelTitle || 'Your channel';
  const heading = isSubs ? 'Subscriber Milestone' : 'Views Milestone';
  const lead = isSubs ? 'You reached ' : 'Your latest video hit ';
  const tail = isSubs ? ' subscribers' : ' views';
  const sub = isSubs ? 'Congratulations! Your community is growing.' : 'Congratulations on this milestone!';
  const hasThumb = /^https?:\/\//.test(m.channelThumbnail || '');
  const avatar = hasThumb
    ? `<img src="${esc(m.channelThumbnail)}" width="22" height="22" alt="" style="width:22px;height:22px;border-radius:11px;vertical-align:middle;margin-right:8px;border:1px solid #F2B531">`
    : '';
  const ytIcon = `<span style="display:inline-block;width:22px;height:16px;line-height:16px;border-radius:4px;background:#FF0000;color:#ffffff;font-size:9px;text-align:center;vertical-align:middle;margin-right:8px">&#9654;</span>`;

  return `<div style="background:#000000;padding:24px 12px;font-family:Arial,Helvetica,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:420px;margin:auto">
    <tr><td align="center" bgcolor="#0C0C10" style="background-color:#0C0C10;border-radius:28px;padding:26px 18px;border:1px solid #26262E">

      <div style="font-size:19px;font-weight:700;color:#ffffff;letter-spacing:.2px">&#127942; ${esc(heading)} &#127942;</div>
      <div style="font-size:12.5px;color:#B4B0C4;margin-top:10px">${avatar}<span style="vertical-align:middle">${esc(channel)}</span></div>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:18px">
        <tr><td align="center" bgcolor="#0F0F14" style="background-color:#0F0F14;border-radius:24px;padding:22px 16px;border:1px solid #26262E">

          <div style="font-size:22px;font-weight:800;letter-spacing:.3px"><span style="color:#ffffff">Tube</span><span style="color:#F2B531">Pilot</span></div>

          <div style="margin:22px auto 20px;width:140px;height:140px;border-radius:70px;border:6px solid #F2B531;background:#17121F;text-align:center;line-height:128px;font-size:44px;font-weight:800;color:#ffffff;box-shadow:0 0 28px rgba(242,181,49,.35)">${esc(v)}</div>

          <div style="font-size:22px;font-weight:800;color:#ffffff;line-height:1.25">${lead}<span style="color:#F2B531;font-style:italic">${esc(v)}</span>${tail}</div>
          <div style="font-size:14px;color:#B4B0C4;margin-top:8px">${esc(sub)}</div>
          ${!isSubs && m.videoTitle ? `<div style="font-size:12px;color:#7E7A92;margin-top:6px">${esc(m.videoTitle)}</div>` : ''}

          <div style="margin-top:18px">
            <span style="display:inline-block;background:#1B1B22;border:1px solid #2C2C35;border-radius:999px;padding:8px 16px;font-size:13.5px;font-weight:600;color:#ffffff">${ytIcon}<span style="vertical-align:middle">${esc(channel)}</span></span>
          </div>

        </td></tr>
      </table>

    </td></tr>
  </table>
  <p style="text-align:center;color:#8A869C;font-size:12px;margin:16px auto 0;max-width:420px;line-height:1.5">${esc(body)}<br>Open the TubePilot app to download and share your achievement card.</p>
</div>`;
};

const notifyUser = async (user, m) => {
  const { title, body } = describe(m);
  try {
    await Notification.create({ user: user._id, type: 'milestone', title, message: body });
  } catch (e) { console.error('⚠️ [Milestone] notification create failed:', e.message); }

  try {
    await sendPushToUser(user, { title, body, data: { type: 'milestone', milestoneId: m._id.toString() } });
  } catch (e) { console.error('⚠️ [Milestone] push failed:', e.message); }
  sendOneSignalToUser(user, { title, body, data: { type: 'milestone' } }).catch(() => {});

  if (user.email) {
    try {
      await sendBrevoEmail({ to: user.email, toName: user.name, subject: title, html: buildEmail(m) });
      m.emailSent = true;
      await m.save();
    } catch (e) { console.error('⚠️ [Milestone] email failed:', e.message); }
  }
};

// Creates at most ONE milestone card for the user (views OR subscribers), alternating.
// Returns the Milestone doc, or null if nothing new / not due yet.
const generateMilestoneForUser = async (user, { respectDue = true } = {}) => {
  if (!user.youtubeChannel?.refreshToken) return null;

  let tracker = await MilestoneTracker.findOne({ user: user._id });
  if (!tracker) tracker = await MilestoneTracker.create({ user: user._id });
  if (respectDue && tracker.nextDueAt > new Date()) return null;

  let stats;
  try {
    const token = await getFreshToken(user);
    stats = await getMilestoneStats(token);
  } catch (err) {
    console.error(`⚠️ [Milestone] user ${user._id}: ${isInvalidGrantError(err) ? 'YouTube reauth needed' : err.message}`);
    return null;
  }
  if (!stats) return null;

  // Different channel connected than last time -> start fresh.
  if (tracker.channelId !== user.youtubeChannel.channelId) {
    tracker.channelId = user.youtubeChannel.channelId;
    tracker.lastSubMilestone = 0;
    tracker.videoMilestones = new Map();
    tracker.lastType = '';
    tracker.initialCheckDone = false;
  }
  const isFirstCheck = !tracker.initialCheckDone;

  const subValue = stats.subscribers != null ? highest(MILESTONES.subscribers, stats.subscribers, tracker.lastSubMilestone) : null;
  const lv = stats.latestVideo;
  const viewValue = lv ? highest(MILESTONES.views, lv.views, tracker.videoMilestones.get(lv.videoId) || 0) : null;

  // Alternate: views first, then subscribers, then views...
  const order = tracker.lastType === 'views' ? ['subscribers', 'views'] : ['views', 'subscribers'];
  const pick = order.find((t) => (t === 'subscribers' ? subValue : viewValue));
  tracker.initialCheckDone = true;

  if (!pick) {
    // First connect with no milestone yet (e.g. only 10-20 subscribers): no popup now,
    // and the 15-day cycle starts from today. On later checks, nothing new stays "due"
    // and is re-checked daily until a milestone is actually reached.
    if (isFirstCheck) tracker.nextDueAt = new Date(Date.now() + CYCLE_DAYS * DAY_MS);
    await tracker.save();
    return null;
  }

  const doc = await Milestone.create({
    user: user._id,
    type: pick,
    value: pick === 'subscribers' ? subValue : viewValue,
    videoId: pick === 'views' ? lv.videoId : '',
    videoTitle: pick === 'views' ? lv.title : '',
    channelTitle: stats.channelTitle,
    channelThumbnail: pickThumbnail(user, stats) // NEW
  });

  tracker.lastType = pick;
  if (pick === 'subscribers') tracker.lastSubMilestone = subValue;
  else tracker.videoMilestones.set(lv.videoId, viewValue);
  tracker.nextDueAt = new Date(Date.now() + CYCLE_DAYS * DAY_MS);
  await tracker.save();

  console.log(`🏆 [Milestone] user ${user._id}: ${pick} ${doc.value}`);
  await notifyUser(user, doc);
  return doc;
};

module.exports = { generateMilestoneForUser, MILESTONES };
