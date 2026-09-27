const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const multer = require('multer');
const { protect } = require('../middleware/auth');
const {
  pickAvailableImageKitAccount,
  uploadBufferToImageKit,
  recordUsage
} = require('../utils/imagekit');
const { startYouTubeLiveSession, endYouTubeLiveSession } = require('../utils/youtubeLive');

const router = express.Router();

const MAX_VIDEO_SIZE_BYTES = 2 * 1024 * 1024 * 1024; // 2GB — sabhi plans ke liye same
const FREE_TRIAL_SECONDS = 5 * 60; // 5 minute

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VIDEO_SIZE_BYTES }
});

const EC2_WORKER_URL = process.env.EC2_WORKER_URL;
const WORKER_SECRET_KEY = process.env.WORKER_SECRET_KEY;

// In-memory tracking of currently-running streams (server restart hone par
// khatam ho jayega — testing ke liye theek hai abhi).
const activeStreams = new Map();
// streamId -> { userId, startedAt, isFreeTrial }

// -----------------------------------------------------------------------
// POST /api/live-stream/upload-video
// Video ko ImageKit (dual-account) par upload karta hai, URL wapas deta hai.
// -----------------------------------------------------------------------
router.post('/upload-video', protect, upload.single('video'), async (req, res) => {
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
// POST /api/live-stream/start
// Body: { videoUrl, title, description }
// ⚠️ Ab "youtubeStreamKey" bhejne ki zarurat NAHI hai — ye automatically
// user ke connected YouTube channel se generate hoti hai.
// -----------------------------------------------------------------------
router.post('/start', protect, async (req, res) => {
  try {
    const { videoUrl, title, description } = req.body;

    if (!videoUrl) {
      return res.status(400).json({ success: false, message: 'videoUrl zaroori hai.' });
    }

    const planCheck = evaluateUserPlan(req.user);
    if (!planCheck.allowed) {
      return res.status(403).json({ success: false, message: planCheck.reason });
    }

    // Step 1: YouTube par broadcast + stream banao, stream key nikalo
    let youtubeSession;
    try {
      youtubeSession = await startYouTubeLiveSession(req.user, { title, description });
    } catch (err) {
      if (err.code === 'YOUTUBE_NOT_CONNECTED' || err.code === 'YOUTUBE_REAUTH_REQUIRED') {
        return res.status(400).json({ success: false, message: err.message, code: err.code });
      }
      console.error('❌ [liveStream/start] YouTube session banane mein error:', err.response?.data || err.message);
      return res.status(500).json({ success: false, message: 'YouTube live session banane mein error aayi.' });
    }

    const streamId = `${req.user._id}_${crypto.randomBytes(4).toString('hex')}`;

    // Step 2: EC2 worker ko bolo FFmpeg start kare, isi generated stream key se
    const ec2Response = await axios.post(
      `${EC2_WORKER_URL}/start`,
      { streamId, videoUrl, youtubeStreamKey: youtubeSession.streamKey },
      { headers: { 'x-worker-secret': WORKER_SECRET_KEY } }
    );

    if (!ec2Response.data.success) {
      // EC2 fail ho gaya to YouTube broadcast bhi turant band kar do (orphan na chhode)
      await endYouTubeLiveSession(req.user, youtubeSession.broadcastId);
      return res.status(500).json({ success: false, message: ec2Response.data.message });
    }

    activeStreams.set(streamId, {
      userId: req.user._id.toString(),
      startedAt: Date.now(),
      isFreeTrial: planCheck.isFreeTrial,
      broadcastId: youtubeSession.broadcastId
    });

    // Auto-stop timer — jitne seconds bache hain, utni der baad band karo
    const stopAfterMs = planCheck.secondsRemaining * 1000;
    setTimeout(() => autoStopStream(streamId), stopAfterMs);

    return res.json({
      success: true,
      message: planCheck.isFreeTrial ? 'Free trial live stream shuru ho gaya (5 minute).' : 'Live stream shuru ho gaya.',
      streamId,
      isFreeTrial: planCheck.isFreeTrial,
      secondsAllowed: planCheck.secondsRemaining,
      watchUrl: youtubeSession.watchUrl
    });
  } catch (err) {
    console.error('❌ [liveStream/start]', err.message);
    return res.status(500).json({ success: false, message: 'Stream start karne mein error aayi.' });
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

  try {
    await axios.post(
      `${EC2_WORKER_URL}/stop`,
      { streamId },
      { headers: { 'x-worker-secret': WORKER_SECRET_KEY } }
    );
  } catch (err) {
    console.error(`❌ [Stop] EC2 stop call failed for ${streamId}:`, err.message);
  }

  // YouTube ki taraf se bhi broadcast properly "complete" karo (sirf FFmpeg
  // band karna kaafi nahi, warna YouTube pe "stuck live" dikh sakta hai)
  if (record.broadcastId) {
    try {
      const user = await User.findById(record.userId);
      if (user) await endYouTubeLiveSession(user, record.broadcastId);
    } catch (err) {
      console.error(`❌ [Stop] YouTube broadcast end karne mein error:`, err.message);
    }
  }

  const elapsedSeconds = Math.floor((Date.now() - record.startedAt) / 1000);

  try {
    if (record.isFreeTrial) {
      await User.findByIdAndUpdate(record.userId, { $set: { 'liveStream.freeTrialUsed': true } });
    } else {
      await User.findByIdAndUpdate(record.userId, { $inc: { 'liveStream.hoursUsedSeconds': elapsedSeconds } });
    }
  } catch (err) {
    console.error(`❌ [Stop] User hours update failed for ${streamId}:`, err.message);
  }

  activeStreams.delete(streamId);
  console.log(`[Stream Stopped] ${streamId} — ${elapsedSeconds}s used`);
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

    const ec2Response = await axios.get(`${EC2_WORKER_URL}/status/${streamId}`, {
      headers: { 'x-worker-secret': WORKER_SECRET_KEY }
    });

    return res.json({ success: true, ...ec2Response.data });
  } catch (err) {
    console.error('❌ [liveStream/status]', err.message);
    return res.status(500).json({ success: false, message: 'Status check karne mein error aayi.' });
  }
});

module.exports = router;
