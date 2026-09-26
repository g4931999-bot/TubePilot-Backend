const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { protect } = require('../middleware/auth');

const router = express.Router();

// -----------------------------------------------------------------------
// Live Streaming Plan Rules
// ₹200 wala pack already "activeTier: 4" hai aapke diamond store mein
// (routes/diamond.js). Jab bhi koi naya pack kharide, activeTier replace
// ho jata hai — isliye seedha activeTier check karna hi sabse simple hai.
//   activeTier === 4        -> ₹200 pack   -> unlimited (24/7) live stream
//   activeTier === 1, 2, 3  -> ₹10/50/100  -> sirf 10 minute trial
//   activeTier === 0        -> koi pack nahi -> live stream locked
// -----------------------------------------------------------------------
function getPlanType(user) {
  const tier = user.activeTier || 0;
  if (tier === 4) return 'unlimited';
  if (tier >= 1 && tier <= 3) return 'trial';
  return 'none';
}

const PLAN_RULES = {
  none: { canStream: false, maxDurationMinutes: 0 },
  unlimited: { canStream: true, maxDurationMinutes: null }, // ₹200 pack (tier 4)
  trial: { canStream: true, maxDurationMinutes: 10 } // tier 1/2/3
};

function getRules(planType) {
  return PLAN_RULES[planType] || PLAN_RULES.none;
}

// In-memory tracking (server restart hone par ye khatam ho jayega —
// abhi testing ke liye theek hai, baad mein DB mein bhi save kar sakte hain)
const activeStreams = new Map();

const EC2_WORKER_URL = process.env.EC2_WORKER_URL; // e.g. http://15.252.108.26:4000
const WORKER_SECRET_KEY = process.env.WORKER_SECRET_KEY;

// -----------------------------------------------------------------------
// POST /api/live-stream/start
// -----------------------------------------------------------------------
router.post('/start', protect, async (req, res) => {
  try {
    const { videoFileName, youtubeStreamKey } = req.body;

    if (!videoFileName || !youtubeStreamKey) {
      return res.status(400).json({
        success: false,
        message: 'videoFileName aur youtubeStreamKey zaroori hain.'
      });
    }

    const planType = getPlanType(req.user);
    const rules = getRules(planType);

    if (!rules.canStream) {
      return res.status(403).json({
        success: false,
        message: 'Live streaming ke liye pehle koi paid plan lein.'
      });
    }

    const streamId = `${req.user._id}_${crypto.randomBytes(4).toString('hex')}`;

    const ec2Response = await axios.post(
      `${EC2_WORKER_URL}/start`,
      { streamId, videoFileName, youtubeStreamKey },
      { headers: { 'x-worker-secret': WORKER_SECRET_KEY } }
    );

    if (!ec2Response.data.success) {
      return res.status(500).json({ success: false, message: ec2Response.data.message });
    }

    activeStreams.set(streamId, {
      userId: req.user._id.toString(),
      planType,
      startedAt: Date.now()
    });

    // Agar unlimited plan nahi hai, to N minute baad auto-stop schedule karo
    if (rules.maxDurationMinutes !== null) {
      setTimeout(async () => {
        if (!activeStreams.has(streamId)) return; // user ne pehle hi stop kar diya

        console.log(`[Auto-Stop] Stream ${streamId} ka ${rules.maxDurationMinutes} minute complete.`);
        await axios
          .post(`${EC2_WORKER_URL}/stop`, { streamId }, { headers: { 'x-worker-secret': WORKER_SECRET_KEY } })
          .catch((err) => console.error('❌ [Auto-Stop] EC2 stop call failed:', err.message));

        activeStreams.delete(streamId);

        // TODO: yahan push notification bhejo — "trial time khatam, ₹200 pack lein unlimited ke liye"
      }, rules.maxDurationMinutes * 60 * 1000);
    }

    return res.json({
      success: true,
      message: 'Live stream shuru ho gaya.',
      streamId,
      unlimited: rules.maxDurationMinutes === null,
      maxDurationMinutes: rules.maxDurationMinutes
    });
  } catch (err) {
    console.error('❌ [liveStream/start]', err.message);
    return res.status(500).json({ success: false, message: 'Stream start karne mein error aayi.' });
  }
});

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

    await axios.post(
      `${EC2_WORKER_URL}/stop`,
      { streamId },
      { headers: { 'x-worker-secret': WORKER_SECRET_KEY } }
    );

    activeStreams.delete(streamId);

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
