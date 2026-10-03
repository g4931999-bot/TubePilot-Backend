const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const multer = require('multer');
const mongoose = require('mongoose');
const { protect } = require('../middleware/auth');
const {
  pickAvailableImageKitAccount,
  uploadBufferToImageKit,
  recordUsage
} = require('../utils/imagekit');
const {
  startYouTubeLiveSession,
  endYouTubeLiveSession,
  discardYouTubeLiveSession,
  isVideoOwnedByUserChannel,
  describeYouTubeError
} = require('../utils/youtubeLive');

const router = express.Router();

const MAX_VIDEO_SIZE_BYTES = 2 * 1024 * 1024 * 1024; // 2GB — sabhi plans ke liye same
const FREE_TRIAL_SECONDS = 5 * 60; // 5 minute

// ---------------- Live limits (server-side, bypass nahi ho sakta) ----------------
// 1) Ek time par sirf 1 live.
// 2) Pichli live ke START se 1 ghanta ka gap.
// 3) Rolling 24 ghante mein max 3 live (har live ke start time se count).
const LIVE_COOLDOWN_MS = 60 * 60 * 1000;
const LIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
const LIVE_MAX_PER_WINDOW = 3;
// App is special videoUrl se sirf limits poochti hai (start nahi hota).
const CHECK_LIMITS_TOKEN = '__CHECK_LIMITS__';

// EC2 worker ke liye hard deadline. Pehle koi deadline nahi thi, isliye EC2
// unreachable hone par request ~2 minute latakti thi aur app ko
// "Software caused connection abort" milta tha.
const EC2_TIMEOUT_MS = 25000;        // stop / status
const EC2_HEALTH_TIMEOUT_MS = 8000;  // start se pehle quick check — EC2 band ho to turant pata chale
// Worker /start pehle video download karta hai (nayi video par 30-60 sec lag sakte hain),
// isliye iska deadline lamba hai. Download adhoora reh jaye to worker cache nahi maanta.
const EC2_START_TIMEOUT_MS = 90000;
const MAX_TIMER_MS = 2147483647; // setTimeout ki upper limit

const EC2_WORKER_URL = process.env.EC2_WORKER_URL;
const WORKER_SECRET_KEY = process.env.WORKER_SECRET_KEY;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VIDEO_SIZE_BYTES }
});

// ---------------- Live stream log (limits ka source of truth) ----------------
// Server restart hone par bhi 1-ghanta / 24-ghante ka hisaab bana rahe, isliye
// DB mein rakha hai (nayi collection: livestreamlogs — koi migration nahi chahiye).
const liveStreamLogSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  streamId: { type: String, required: true, unique: true },
  startedAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
  endedAt: { type: Date, default: null },
  status: { type: String, enum: ['live', 'ended'], default: 'live' },
  isFreeTrial: { type: Boolean, default: false },
  secondsAllowed: { type: Number, default: 0 },
  broadcastId: { type: String, default: null },
  youtubeStreamId: { type: String, default: null },
  watchUrl: { type: String, default: null },
  title: { type: String, default: '' },
  source: { type: String, enum: ['upload', 'library', 'camera'], default: 'upload' }
});
liveStreamLogSchema.index({ userId: 1, startedAt: -1 });
const LiveStreamLog = mongoose.models.LiveStreamLog || mongoose.model('LiveStreamLog', liveStreamLogSchema);

// In-memory: chal rahi streams + auto-stop timers.
const activeStreams = new Map();
// streamId -> { userId, startedAt, expiresAt, isFreeTrial, broadcastId, timer }

// Ek user ki do /start requests ek saath aayein to double-start na ho.
const startingUsers = new Set();

// ---------------- Limit helpers ----------------
function formatWait(seconds) {
  const totalMinutes = Math.max(1, Math.ceil(seconds / 60));
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h > 0 && m > 0) return `${h} ghante ${m} minute`;
  if (h > 0) return `${h} ghante`;
  return `${m} minute`;
}

const LIMIT_MESSAGES = {
  LIVE_ALREADY_RUNNING: 'Aapki ek live stream pehle se chal rahi hai. Pehle use band karein.',
  LIVE_COOLDOWN: 'Pichli live ke 1 ghante baad hi naya live shuru ho sakta hai.',
  LIVE_DAILY_LIMIT: '24 ghante mein maximum 3 live ho sakte hain.'
};

async function getLimitState(userId, now = Date.now()) {
  const [liveDoc, recent] = await Promise.all([
    LiveStreamLog.findOne({ userId, status: 'live', expiresAt: { $gt: new Date(now) } }).lean(),
    LiveStreamLog.find({ userId, startedAt: { $gt: new Date(now - LIVE_WINDOW_MS) } })
      .sort({ startedAt: 1 })
      .select('startedAt')
      .lean()
  ]);

  const starts = recent.map((r) => r.startedAt.getTime());
  const used = starts.length;

  let nextAt = 0;
  let code = null;

  // 1 ghanta gap — pichli live ke start se
  if (used > 0) {
    const cooldownEnds = starts[used - 1] + LIVE_COOLDOWN_MS;
    if (cooldownEnds > now) {
      nextAt = cooldownEnds;
      code = 'LIVE_COOLDOWN';
    }
  }

  // Rolling 24 ghante mein max 3 — jab teesri-akhri live 24h purani ho jayegi
  // tab ek slot khulega.
  if (used >= LIVE_MAX_PER_WINDOW) {
    const slotFreeAt = starts[used - LIVE_MAX_PER_WINDOW] + LIVE_WINDOW_MS;
    if (slotFreeAt > nextAt) nextAt = slotFreeAt;
    code = 'LIVE_DAILY_LIMIT';
  }

  // Ek time par sirf 1 live
  if (liveDoc) code = 'LIVE_ALREADY_RUNNING';

  const retryAfterSeconds = nextAt > now ? Math.ceil((nextAt - now) / 1000) : 0;

  let message = null;
  if (code) {
    message = LIMIT_MESSAGES[code];
    if (code !== 'LIVE_ALREADY_RUNNING' && retryAfterSeconds > 0) {
      message += ` Agla live ${formatWait(retryAfterSeconds)} baad shuru ho sakta hai.`;
    }
  }

  return {
    canStart: !code,
    code,
    message,
    usedInWindow: used,
    maxPerWindow: LIVE_MAX_PER_WINDOW,
    nextAvailableAt: nextAt > now ? new Date(nextAt).toISOString() : null,
    retryAfterSeconds,
    activeStream: liveDoc
      ? {
          streamId: liveDoc.streamId,
          source: liveDoc.source || 'upload',
          startedAt: liveDoc.startedAt.toISOString(),
          secondsAllowed: liveDoc.secondsAllowed,
          secondsRemaining: Math.max(0, Math.round((liveDoc.expiresAt.getTime() - now) / 1000)),
          isFreeTrial: !!liveDoc.isFreeTrial,
          watchUrl: liveDoc.watchUrl || null
        }
      : null
  };
}

// Response mein jaane wale limit fields (message alag se lagta hai).
function limitFields(state) {
  return {
    canStart: state.canStart,
    code: state.code,
    usedInWindow: state.usedInWindow,
    maxPerWindow: state.maxPerWindow,
    nextAvailableAt: state.nextAvailableAt,
    retryAfterSeconds: state.retryAfterSeconds,
    activeStream: state.activeStream
  };
}

function sendLimitBlocked(res, state) {
  res.set('Retry-After', String(state.retryAfterSeconds || 0));
  return res.status(429).json({ success: false, message: state.message, ...limitFields(state) });
}

// Upload se pehle hi rok deta hai (multer file memory mein lene se PEHLE),
// taaki blocked user 2GB file bhejkar server par bojh na daale.
async function limitGuard(req, res, next) {
  try {
    const state = await getLimitState(req.user._id);
    if (!state.canStart) return sendLimitBlocked(res, state);
    return next();
  } catch (err) {
    console.error('❌ [liveStream/limitGuard]', err.message);
    return res.status(500).json({ success: false, message: 'Limit check karne mein error aayi.' });
  }
}

// ---------------- EC2 worker helper ----------------
const EC2_UNREACHABLE_CODES = [
  'ETIMEDOUT', 'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET',
  'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'EC2_NOT_CONFIGURED'
];

function isEc2Unreachable(err) {
  return EC2_UNREACHABLE_CODES.includes(err.code);
}

// AbortController poore request ko (connect phase samet) deadline par kaat deta
// hai. Sirf axios "timeout" connect phase ko cover nahi karta — isi wajah se
// pehle OS ka ~2 minute wala connect-timeout chalta tha.
async function ec2Request(method, path, data, timeoutMs = EC2_TIMEOUT_MS) {
  if (!EC2_WORKER_URL) {
    const e = new Error('EC2_WORKER_URL set nahi hai');
    e.code = 'EC2_NOT_CONFIGURED';
    throw e;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await axios({
      method,
      url: `${EC2_WORKER_URL}${path}`,
      data,
      headers: { 'x-worker-secret': WORKER_SECRET_KEY },
      timeout: timeoutMs,
      signal: controller.signal
    });
  } catch (err) {
    if (axios.isCancel(err) || err.code === 'ERR_CANCELED') {
      const e = new Error(`EC2 worker ne ${timeoutMs}ms mein respond nahi kiya`);
      e.code = 'ETIMEDOUT';
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// -----------------------------------------------------------------------
// POST /api/live-stream/upload-video
// Video ko ImageKit (dual-account) par upload karta hai, URL wapas deta hai.
// limitGuard: live limit poori ho to upload bhi allowed nahi.
// -----------------------------------------------------------------------
router.post('/upload-video', protect, limitGuard, upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Video file zaroori hai (field name: "video").' });
    }

    if (req.file.size > MAX_VIDEO_SIZE_BYTES) {
      return res.status(400).json({ success: false, message: 'Video 2GB se badi nahi ho sakti.' });
    }

    const picked = pickAvailableImageKitAccount(req.file.size);
    if (!picked) {
      return res.status(503).json({
        success: false,
        message: 'Live-streaming storage abhi full hai. Please thodi der baad try karein.'
      });
    }

    const result = await uploadBufferToImageKit(picked.account, req.file.buffer, req.file.originalname);
    recordUsage(picked.accountLabel, req.file.size);

    return res.json({
      success: true,
      videoUrl: result.url,
      fileId: result.fileId,
      sizeBytes: req.file.size
    });
  } catch (err) {
    console.error('❌ [liveStream/upload-video]', err.message);
    return res.status(500).json({ success: false, message: 'Video upload karne mein error aayi.' });
  }
});

// -----------------------------------------------------------------------
// Helper: user ke plan ke hisaab se check karta hai ki stream allowed hai
// ya nahi, aur kitne seconds bache hain.
// -----------------------------------------------------------------------
function evaluateUserPlan(user) {
  const live = user.liveStream || {};

  // Case 1: Koi paid plan nahi hai — sirf free trial available hai
  if (live.planCategory === 'none' || !live.planCategory) {
    if (live.freeTrialUsed) {
      return { allowed: false, reason: 'Free trial already use ho chuka hai. Ek plan kharidein.' };
    }
    return { allowed: true, isFreeTrial: true, secondsRemaining: FREE_TRIAL_SECONDS };
  }

  // Case 2: Day Pass — sirf usi calendar din valid hai (Option B)
  if (live.planCategory === 'day') {
    const purchaseDay = new Date(live.purchaseAt).toDateString();
    const today = new Date().toDateString();
    if (purchaseDay !== today) {
      return { allowed: false, reason: 'Aapka Day Pass expire ho chuka hai (raat 12 baje). Naya pass kharidein.' };
    }
  }

  // Case 3: Month Pass — purchaseAt + 30 din tak valid (Option B)
  if (live.planCategory === 'month') {
    const expiresAt = new Date(live.purchaseAt);
    expiresAt.setDate(expiresAt.getDate() + 30);
    if (Date.now() > expiresAt.getTime()) {
      return { allowed: false, reason: 'Aapka Monthly Pass expire ho chuka hai. Naya pass kharidein.' };
    }
  }

  // Hours check (day aur month, dono ke liye)
  const secondsRemaining = live.hoursAllottedSeconds - live.hoursUsedSeconds;
  if (secondsRemaining <= 0) {
    return { allowed: false, reason: 'Aapke plan ke hours khatam ho chuke hain.' };
  }

  return { allowed: true, isFreeTrial: false, secondsRemaining };
}

// -----------------------------------------------------------------------
// Helper: videoUrl ko asli streaming source mein badalta hai.
//   - "https://..."          -> nayi upload ki hui video (ImageKit URL)
//   - "library://db/<id>"    -> My Videos ki TubePilot-side video
//   - "library://yt/<id>"    -> My Videos ki YouTube-only video
// Video model: owner = user, file = videoUrl/storageUrl (cloudinary/direct), warna YouTube se.
async function resolveVideoSource(user, videoRef) {
  // Sirf http(s) — file:// jaise links se EC2 ki local files na padhi ja sakein.
  if (/^https?:\/\//i.test(videoRef)) {
    return { ok: true, url: videoRef, type: 'file', source: 'upload' };
  }

  const match = /^library:\/\/(db|yt)\/([A-Za-z0-9_-]+)$/.exec(videoRef);
  if (!match) {
    return { ok: false, status: 400, code: 'INVALID_VIDEO_REF', message: 'Video ka link sahi nahi hai.' };
  }

  const kind = match[1];
  const id = match[2];
  let ytVideoId = kind === 'yt' ? id : null;

  if (kind === 'db') {
    let Video = null;
    try {
      Video = require('../models/Video');
    } catch (_) {
      Video = null;
    }
    if (!Video) {
      return { ok: false, status: 501, code: 'VIDEO_MODEL_MISSING', message: 'Purani video live karne ki suvidha abhi taiyar nahi hai.' };
    }

    let video = null;
    try {
      video = await Video.findById(id).lean();
    } catch (_) {
      video = null;
    }
    if (!video) {
      return { ok: false, status: 404, code: 'VIDEO_NOT_FOUND', message: 'Video nahi mili.' };
    }

    // Video model: owner = video.user
    if (String(video.user) !== String(user._id)) {
      return { ok: false, status: 404, code: 'VIDEO_NOT_FOUND', message: 'Video nahi mili.' };
    }

    // Storage ki file tabhi use hogi jab abhi maujood ho (delete date nahi nikli) aur
    // provider seedha downloadable ho (google_drive / youtube link download-able nahi).
    const FILE_PROVIDERS = ['cloudinary_1', 'cloudinary_2', 'direct_url'];
    const storageAlive = !video.storageDeleteAt || new Date(video.storageDeleteAt).getTime() > Date.now();
    const fileUrl = video.videoUrl || video.storageUrl;
    if (storageAlive && FILE_PROVIDERS.includes(video.storageProvider) && typeof fileUrl === 'string' && /^https?:\/\//i.test(fileUrl)) {
      return { ok: true, url: fileUrl, type: 'file', source: 'library' };
    }

    // Storage se file hat chuki hai — YouTube par publish hui ho to wahi se.
    const ytTarget = (video.platforms || []).find(
      (p) => p.platform === 'youtube' && p.status === 'uploaded' && p.platformPostId
    );
    const fallbackYtId = (ytTarget && ytTarget.platformPostId) || (video.platform === 'youtube' ? video.platformPostId : '') || null;
    if (!fallbackYtId || !/^[A-Za-z0-9_-]{6,20}$/.test(String(fallbackYtId))) {
      return { ok: false, status: 422, code: 'VIDEO_FILE_UNAVAILABLE', message: 'Is video ki file live ke liye available nahi hai.' };
    }
    ytVideoId = String(fallbackYtId);
  }

  // YouTube-source: pehle confirm karo ki video isi user ke channel ki hai.
  try {
    const owned = await isVideoOwnedByUserChannel(user, ytVideoId);
    if (!owned) {
      return { ok: false, status: 403, code: 'VIDEO_NOT_OWNED', message: 'Ye video aapke connected YouTube channel ki nahi hai.' };
    }
  } catch (err) {
    const info = describeYouTubeError(err);
    console.error('❌ [liveStream/resolve] YouTube ownership check failed:', err.response?.data || err.message);
    return { ok: false, status: info.status, code: info.code, message: info.message };
  }

  // ⚠️ EC2 worker ko sourceType === 'youtube' par yt-dlp se download/stream karna hoga.
  return { ok: true, url: `https://www.youtube.com/watch?v=${ytVideoId}`, type: 'youtube', source: 'library' };
}

function armAutoStop(streamId, delayMs) {
  const record = activeStreams.get(streamId);
  if (!record) return;
  record.timer = setTimeout(() => autoStopStream(streamId), Math.min(Math.max(0, delayMs), MAX_TIMER_MS));
}

// -----------------------------------------------------------------------
// POST /api/live-stream/start
// Body: { videoUrl, title, description }
//   videoUrl = "https://..." | "library://db/<id>" | "library://yt/<id>"
//              | "__CHECK_LIMITS__" (sirf limits wapas deta hai, start nahi karta)
// ⚠️ Ab "youtubeStreamKey" bhejne ki zarurat NAHI hai — ye automatically
// user ke connected YouTube channel se generate hoti hai.
// -----------------------------------------------------------------------
router.post('/start', protect, async (req, res) => {
  const userKey = req.user._id.toString();
  let lockTaken = false;

  try {
    const { videoUrl, title, description } = req.body || {};

    if (!videoUrl || typeof videoUrl !== 'string') {
      return res.status(400).json({ success: false, message: 'videoUrl zaroori hai.' });
    }

    // App screen khulte hi limits poochti hai — stream start nahi hoti.
    if (videoUrl === CHECK_LIMITS_TOKEN) {
      const state = await getLimitState(req.user._id);
      return res.json({ success: true, checkOnly: true, ...limitFields(state) });
    }

    if (startingUsers.has(userKey)) {
      return res.status(429).json({
        success: false,
        code: 'LIVE_START_IN_PROGRESS',
        message: 'Aapki pichli request abhi process ho rahi hai. Thoda ruk kar dekhein.'
      });
    }
    startingUsers.add(userKey);
    lockTaken = true;

    // Limits: 1 at a time, 1 ghanta gap, 24 ghante mein max 3
    const limitState = await getLimitState(req.user._id);
    if (!limitState.canStart) {
      return sendLimitBlocked(res, limitState);
    }

    const planCheck = evaluateUserPlan(req.user);
    if (!planCheck.allowed) {
      return res.status(403).json({ success: false, message: planCheck.reason });
    }

    const source = await resolveVideoSource(req.user, videoUrl);
    if (!source.ok) {
      return res.status(source.status).json({ success: false, code: source.code, message: source.message });
    }

    if (!EC2_WORKER_URL) {
      console.error('❌ [liveStream/start] EC2_WORKER_URL env set nahi hai.');
      return res.status(503).json({
        success: false,
        code: 'STREAMING_SERVER_UNAVAILABLE',
        message: 'Streaming server abhi available nahi hai. Thodi der baad try karein.'
      });
    }

    const cleanTitle = typeof title === 'string' ? title.trim().slice(0, 100) : '';

    // Step 0: EC2 zinda hai? (YouTube session banane se PEHLE — warna EC2 band hone par
    // har try mein YouTube API quota aur 5-6 sec bekaar jate hain)
    try {
      await ec2Request('get', '/health', undefined, EC2_HEALTH_TIMEOUT_MS);
    } catch (healthErr) {
      console.error('❌ [liveStream/start] EC2 health check failed:', healthErr.code || healthErr.message);
      return res.status(503).json({
        success: false,
        code: 'STREAMING_SERVER_UNAVAILABLE',
        message: 'Streaming server abhi available nahi hai. Thodi der baad try karein.'
      });
    }

    // Step 1: YouTube par broadcast + stream banao, stream key nikalo
    let youtubeSession;
    try {
      youtubeSession = await startYouTubeLiveSession(req.user, { title: cleanTitle, description });
    } catch (err) {
      const info = describeYouTubeError(err);
      if (info.status === 500) {
        console.error('❌ [liveStream/start] YouTube session banane mein error:', err.response?.data || err.message);
      }
      return res.status(info.status).json({ success: false, code: info.code, message: info.message });
    }

    const streamId = `${req.user._id}_${crypto.randomBytes(4).toString('hex')}`;

    // Step 2: EC2 worker ko bolo FFmpeg start kare, isi generated stream key se
    let ec2Response;
    try {
      ec2Response = await ec2Request('post', '/start', {
        streamId,
        videoUrl: source.url,
        sourceType: source.type,
        youtubeStreamKey: youtubeSession.streamKey
      }, EC2_START_TIMEOUT_MS);
    } catch (ec2Err) {
      // Worker abhi download kar raha ho sakta hai — usse cancel karo, warna wo
      // delete ho chuke broadcast par stream shuru kar dega.
      try { await ec2Request('post', '/stop', { streamId }); } catch (_) { /* ignore */ }
      // EC2 tak pahunch hi nahi paye (timeout/refused) ya worker ne error diya —
      // dono case mein YouTube par bana hua unused broadcast + stream delete karo.
      await discardYouTubeLiveSession(req.user, youtubeSession.broadcastId, youtubeSession.youtubeStreamId);
      console.error('❌ [liveStream/start] EC2 worker call failed:', ec2Err.code || ec2Err.message);

      if (isEc2Unreachable(ec2Err)) {
        return res.status(503).json({
          success: false,
          code: 'STREAMING_SERVER_UNAVAILABLE',
          message: 'Streaming server abhi available nahi hai. Thodi der baad try karein.'
        });
      }
      return res.status(502).json({
        success: false,
        message: ec2Err.response?.data?.message || 'Streaming server se connect nahi ho paya. Thodi der baad try karein.'
      });
    }

    if (!ec2Response.data.success) {
      // EC2 fail ho gaya to YouTube broadcast bhi turant hata do (orphan na chhode)
      await discardYouTubeLiveSession(req.user, youtubeSession.broadcastId, youtubeSession.youtubeStreamId);
      return res.status(500).json({ success: false, message: ec2Response.data.message });
    }

    // Stream asal mein start ho chuki — ab se 1 ghante / 24 ghante ka count chalu.
    const startedAtMs = Date.now();
    const expiresAtMs = startedAtMs + planCheck.secondsRemaining * 1000;

    try {
      await LiveStreamLog.create({
        userId: req.user._id,
        streamId,
        startedAt: new Date(startedAtMs),
        expiresAt: new Date(expiresAtMs),
        status: 'live',
        isFreeTrial: !!planCheck.isFreeTrial,
        secondsAllowed: planCheck.secondsRemaining,
        broadcastId: youtubeSession.broadcastId,
        youtubeStreamId: youtubeSession.youtubeStreamId,
        watchUrl: youtubeSession.watchUrl,
        title: cleanTitle,
        source: source.source
      });
    } catch (dbErr) {
      // Log save nahi hua to stream ko untracked chalne nahi denge.
      console.error('❌ [liveStream/start] Log save failed, stream rok rahe hain:', dbErr.message);
      try { await ec2Request('post', '/stop', { streamId }); } catch (_) { /* ignore */ }
      await endYouTubeLiveSession(req.user, youtubeSession.broadcastId);
      return res.status(500).json({ success: false, message: 'Stream start karne mein error aayi.' });
    }

    activeStreams.set(streamId, {
      userId: userKey,
      startedAt: startedAtMs,
      expiresAt: expiresAtMs,
      isFreeTrial: !!planCheck.isFreeTrial,
      broadcastId: youtubeSession.broadcastId,
      youtubeStreamId: youtubeSession.youtubeStreamId,
      kind: 'ec2',
      timer: null
    });

    // Auto-stop timer — jitne seconds bache hain, utni der baad band karo
    armAutoStop(streamId, planCheck.secondsRemaining * 1000);

    let after = null;
    try {
      after = await getLimitState(req.user._id);
    } catch (_) {
      after = null;
    }

    return res.json({
      success: true,
      message: planCheck.isFreeTrial ? 'Free trial live stream shuru ho gaya (5 minute).' : 'Live stream shuru ho gaya.',
      streamId,
      isFreeTrial: !!planCheck.isFreeTrial,
      secondsAllowed: planCheck.secondsRemaining,
      watchUrl: youtubeSession.watchUrl,
      startedAt: new Date(startedAtMs).toISOString(),
      ...(after ? limitFields(after) : {})
    });
  } catch (err) {
    console.error('❌ [liveStream/start]', err.message);
    return res.status(500).json({ success: false, message: 'Stream start karne mein error aayi.' });
  } finally {
    if (lockTaken) startingUsers.delete(userKey);
  }
});

// -----------------------------------------------------------------------
// POST /api/live-stream/start-camera
// Phone ka camera seedha YouTube ko RTMP bhejta hai (EC2 beech mein NAHI aata).
// Wahi rules lagte hain: 1 at a time, 1 ghanta gap, 24 ghante mein max 3, plan hours.
// Response mein rtmpUrl + streamKey hai — app inhi se camera stream bhejti hai.
// Body: { title, description }
// -----------------------------------------------------------------------
router.post('/start-camera', protect, async (req, res) => {
  const userKey = req.user._id.toString();
  let lockTaken = false;

  try {
    const { title, description } = req.body || {};

    if (startingUsers.has(userKey)) {
      return res.status(429).json({
        success: false,
        code: 'LIVE_START_IN_PROGRESS',
        message: 'Aapki pichli request abhi process ho rahi hai. Thoda ruk kar dekhein.'
      });
    }
    startingUsers.add(userKey);
    lockTaken = true;

    const limitState = await getLimitState(req.user._id);
    if (!limitState.canStart) {
      return sendLimitBlocked(res, limitState);
    }

    const planCheck = evaluateUserPlan(req.user);
    if (!planCheck.allowed) {
      return res.status(403).json({ success: false, message: planCheck.reason });
    }

    const cleanTitle = typeof title === 'string' ? title.trim().slice(0, 100) : '';

    let youtubeSession;
    try {
      youtubeSession = await startYouTubeLiveSession(req.user, { title: cleanTitle, description });
    } catch (err) {
      const info = describeYouTubeError(err);
      if (info.status === 500) {
        console.error('❌ [liveStream/start-camera] YouTube session banane mein error:', err.response?.data || err.message);
      }
      return res.status(info.status).json({ success: false, code: info.code, message: info.message });
    }

    const streamId = `${req.user._id}_${crypto.randomBytes(4).toString('hex')}`;
    const startedAtMs = Date.now();
    const expiresAtMs = startedAtMs + planCheck.secondsRemaining * 1000;

    try {
      await LiveStreamLog.create({
        userId: req.user._id,
        streamId,
        startedAt: new Date(startedAtMs),
        expiresAt: new Date(expiresAtMs),
        status: 'live',
        isFreeTrial: !!planCheck.isFreeTrial,
        secondsAllowed: planCheck.secondsRemaining,
        broadcastId: youtubeSession.broadcastId,
        youtubeStreamId: youtubeSession.youtubeStreamId,
        watchUrl: youtubeSession.watchUrl,
        title: cleanTitle,
        source: 'camera'
      });
    } catch (dbErr) {
      console.error('❌ [liveStream/start-camera] Log save failed:', dbErr.message);
      await discardYouTubeLiveSession(req.user, youtubeSession.broadcastId, youtubeSession.youtubeStreamId);
      return res.status(500).json({ success: false, message: 'Camera live start karne mein error aayi.' });
    }

    activeStreams.set(streamId, {
      userId: userKey,
      startedAt: startedAtMs,
      expiresAt: expiresAtMs,
      isFreeTrial: !!planCheck.isFreeTrial,
      broadcastId: youtubeSession.broadcastId,
      youtubeStreamId: youtubeSession.youtubeStreamId,
      kind: 'camera',
      timer: null
    });
    armAutoStop(streamId, planCheck.secondsRemaining * 1000);

    let after = null;
    try {
      after = await getLimitState(req.user._id);
    } catch (_) {
      after = null;
    }

    return res.json({
      success: true,
      message: planCheck.isFreeTrial ? 'Free trial camera live ready (5 minute).' : 'Camera live ready.',
      streamId,
      isFreeTrial: !!planCheck.isFreeTrial,
      secondsAllowed: planCheck.secondsRemaining,
      watchUrl: youtubeSession.watchUrl,
      rtmpUrl: youtubeSession.ingestionAddress,
      streamKey: youtubeSession.streamKey,
      startedAt: new Date(startedAtMs).toISOString(),
      ...(after ? limitFields(after) : {})
    });
  } catch (err) {
    console.error('❌ [liveStream/start-camera]', err.message);
    return res.status(500).json({ success: false, message: 'Camera live start karne mein error aayi.' });
  } finally {
    if (lockTaken) startingUsers.delete(userKey);
  }
});

// -----------------------------------------------------------------------
// Internal: stream ko band karta hai aur (agar free trial nahi tha) User
// ke hoursUsedSeconds mein actual elapsed time add karta hai.
// -----------------------------------------------------------------------
async function autoStopStream(streamId) {
  const record = activeStreams.get(streamId);
  if (!record) return; // pehle hi user ne khud stop kar diya

  await stopStreamInternal(streamId, record);
}

async function stopStreamInternal(streamId, record) {
  const User = require('../models/User'); // lazy require — circular import se bachne ke liye

  // Double-stop (user stop + auto-stop ek saath) se bachne ke liye pehle hi hata do.
  activeStreams.delete(streamId);
  if (record.timer) clearTimeout(record.timer);

  // Camera live mein FFmpeg/EC2 hota hi nahi — phone seedha YouTube ko bhejta hai.
  if (record.kind !== 'camera') {
    try {
      await ec2Request('post', '/stop', { streamId });
    } catch (err) {
      console.error(`❌ [Stop] EC2 stop call failed for ${streamId}:`, err.code || err.message);
    }
  }

  // YouTube ki taraf se broadcast band karo. Agar wo kabhi live hi nahi hua
  // (jaise camera connect nahi hua) to delete hota hai aur neverLive=true aata hai.
  let neverLive = false;
  if (record.broadcastId) {
    try {
      const user = await User.findById(record.userId);
      if (user) {
        const result = await endYouTubeLiveSession(user, record.broadcastId, record.youtubeStreamId);
        neverLive = Boolean(result && result.neverLive);
      }
    } catch (err) {
      console.error(`❌ [Stop] YouTube broadcast end karne mein error:`, err.message);
    }
  }

  // Allotted time se zyada kabhi count nahi hoga (server restart ke baad late stop par bhi).
  const endMs = Math.min(Date.now(), record.expiresAt || Date.now());
  const elapsedSeconds = neverLive ? 0 : Math.max(0, Math.floor((endMs - record.startedAt) / 1000));

  try {
    if (neverLive) {
      // Stream hui hi nahi — free trial / plan hours kharch nahi honge.
    } else if (record.isFreeTrial) {
      await User.findByIdAndUpdate(record.userId, { $set: { 'liveStream.freeTrialUsed': true } });
    } else {
      await User.findByIdAndUpdate(record.userId, { $inc: { 'liveStream.hoursUsedSeconds': elapsedSeconds } });
    }
  } catch (err) {
    console.error(`❌ [Stop] User hours update failed for ${streamId}:`, err.message);
  }

  // Log: live hui to "ended" (startedAt wahi rehta hai, 1h / 24h count nahi badalta).
  // Kabhi live nahi hui to log hata do — us try ka slot wapas mil jata hai.
  try {
    if (neverLive) {
      await LiveStreamLog.deleteOne({ streamId });
      console.log(`[Stream Cancelled] ${streamId} — kabhi live nahi hui, slot wapas.`);
    } else {
      await LiveStreamLog.updateOne({ streamId }, { $set: { status: 'ended', endedAt: new Date() } });
    }
  } catch (err) {
    console.error(`❌ [Stop] Log update failed for ${streamId}:`, err.message);
  }

  console.log(`[Stream Stopped] ${streamId} — ${elapsedSeconds}s used`);
}

// -----------------------------------------------------------------------
// Server restart ke baad: jo streams DB mein "live" hain unhe wapas track
// karo (timer dobara lagao) ya agar time nikal chuka ho to band karo.
// Isse restart ke baad koi stream hamesha ke liye chalti nahi reh jayegi.
// -----------------------------------------------------------------------
async function recoverOrphanStreams() {
  try {
    const liveLogs = await LiveStreamLog.find({ status: 'live' });
    for (const log of liveLogs) {
      const record = {
        userId: log.userId.toString(),
        startedAt: log.startedAt.getTime(),
        expiresAt: log.expiresAt.getTime(),
        isFreeTrial: !!log.isFreeTrial,
        broadcastId: log.broadcastId,
        youtubeStreamId: log.youtubeStreamId,
        kind: log.source === 'camera' ? 'camera' : 'ec2',
        timer: null
      };
      const remainingMs = record.expiresAt - Date.now();

      if (remainingMs <= 0) {
        await stopStreamInternal(log.streamId, record);
      } else {
        activeStreams.set(log.streamId, record);
        armAutoStop(log.streamId, remainingMs);
      }
    }
    if (liveLogs.length) console.log(`[LiveStream] ${liveLogs.length} stream(s) recover ki gayi.`);
  } catch (err) {
    console.error('❌ [LiveStream] Recovery failed:', err.message);
  }
}

if (mongoose.connection.readyState === 1) {
  recoverOrphanStreams();
} else {
  mongoose.connection.once('open', recoverOrphanStreams);
}

// -----------------------------------------------------------------------
// POST /api/live-stream/stop
// -----------------------------------------------------------------------
router.post('/stop', protect, async (req, res) => {
  try {
    const { streamId } = req.body;
    const record = activeStreams.get(streamId);

    if (!record || record.userId !== req.user._id.toString()) {
      return res.status(404).json({ success: false, message: 'Stream nahi mili.' });
    }

    await stopStreamInternal(streamId, record);
    return res.json({ success: true, message: 'Stream band ho gaya.' });
  } catch (err) {
    console.error('❌ [liveStream/stop]', err.message);
    return res.status(500).json({ success: false, message: 'Stream stop karne mein error aayi.' });
  }
});

// -----------------------------------------------------------------------
// GET /api/live-stream/status/:streamId
// -----------------------------------------------------------------------
router.get('/status/:streamId', protect, async (req, res) => {
  try {
    const { streamId } = req.params;
    const record = activeStreams.get(streamId);

    if (!record || record.userId !== req.user._id.toString()) {
      return res.status(404).json({ success: false, message: 'Stream nahi mili.' });
    }

    const ec2Response = await ec2Request('get', `/status/${streamId}`);

    return res.json({ success: true, ...ec2Response.data });
  } catch (err) {
    console.error('❌ [liveStream/status]', err.message);
    return res.status(500).json({ success: false, message: 'Status check karne mein error aayi.' });
  }
});

module.exports = router;
