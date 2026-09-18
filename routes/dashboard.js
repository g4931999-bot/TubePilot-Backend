const express = require('express');
const Video = require('../models/Video');
const { protect } = require('../middleware/auth');

const router = express.Router();

// @route GET /api/dashboard
router.get('/', protect, async (req, res) => {
  try {
    const user = req.user;

    const [totalUploaded, scheduledCount, uploadHistory] = await Promise.all([
      Video.countDocuments({ user: user._id, status: 'uploaded' }),
      Video.countDocuments({ user: user._id, status: 'queued' }),
      Video.find({ user: user._id }).sort({ createdAt: -1 }).limit(10)
    ]);

    res.json({
      success: true,
      data: {
        totalUploadedVideos: totalUploaded,
        scheduledVideos: scheduledCount,
        remainingFreeUploads: user.freeUploadsRemaining,
        diamondBalance: user.diamondBalance,
        subscriptionStatus: user.subscription,
        storageUsedBytes: user.storageUsedBytes,
        connectedYouTubeChannel: user.youtubeChannel
          ? {
              channelTitle: user.youtubeChannel.channelTitle,
              thumbnail: user.youtubeChannel.thumbnail,
              subscriberCount: user.youtubeChannel.subscriberCount
            }
          : null,
        uploadHistory,
        // ⚠️ NEW (Boss request — plan/quota system): exposes the user's
        // current plan entitlements so screens can decide what to unlock
        // WITHOUT a separate API call. Two different screens read
        // seoScoreLevel with two different thresholds:
        //   - Video SEO Optimizer (seo_optimizer_screen.dart) unlocks for
        //     ANY value other than 'none' (even 'basic' / ₹10 pack).
        //   - Channel SEO Score (channel_audit_screen.dart) unlocks ONLY
        //     when this equals 'advance' (₹100+ packs).
        // thumbnailPromptsRemaining and competitorLevel included too since
        // other screens (thumbnail-prompt route, Competitor Radar) need
        // the same "what's my plan" info the same way.
        seoScoreLevel: user.seoScoreLevel,
        competitorLevel: user.competitorLevel,
        thumbnailPromptsRemaining: user.thumbnailPromptsRemaining,
        activeTier: user.activeTier
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
