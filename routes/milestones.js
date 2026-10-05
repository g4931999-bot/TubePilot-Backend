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

const buildEmail = (m) => {
  const v = fmt(m.value);
  const { body } = describe(m);
  const line = m.type === 'subscribers' ? `You reached ${v} subscribers` : `Your latest video hit ${v} views`;
  return `<div style="background:#f7f0f5;padding:24px;font-family:Arial,Helvetica,sans-serif">
  <div style="max-width:420px;margin:auto;background-color:#4B1D3F;background-image:linear-gradient(135deg,#2A0F22,#4B1D3F);border-radius:24px;padding:32px 24px;text-align:center;color:#ffffff">
    <div style="font-size:20px;font-weight:800;letter-spacing:.5px">TubePilot</div>
    <div style="margin:24px auto;width:140px;height:140px;border-radius:70px;border:6px solid #D4A017;line-height:128px;font-size:44px;font-weight:800">${esc(v)}</div>
    <div style="font-size:22px;font-weight:700">Congratulations!</div>
    <div style="font-size:16px;margin-top:8px">${esc(line)}</div>
    ${m.type === 'views' && m.videoTitle ? `<div style="font-size:13px;color:#e3cbda;margin-top:8px">${esc(m.videoTitle)}</div>` : ''}
    <div style="font-size:13px;color:#e3cbda;margin-top:16px">${esc(m.channelTitle)}</div>
  </div>
  <p style="text-align:center;color:#7A3A67;font-size:12px;margin-top:16px">${esc(body)}<br>Open the TubePilot app to download and share your achievement card.</p>
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
    channelTitle: stats.channelTitle
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
