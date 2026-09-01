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
        uploadHistory
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
