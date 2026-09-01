const express = require('express');
const { protect } = require('../middleware/auth');
const User = require('../models/User');
const Video = require('../models/Video');
const {
  getInstagramAccountId,
  publishInstagramReel,
  publishInstagramCarousel,
  publishFacebookReel
} = require('../utils/meta');
const { toISTDateStr } = require('../utils/dateHelpers');
const { assertScheduleBufferOk, assertDailyLimitOk } = require('./video');

const router = express.Router();

// Helper function to handle user upload credits & diamond deductions
const handlePublishCredits = async (user) => {
  // 1. Check free uploads
  if (user.freeUploadsRemaining > 0) {
    user.freeUploadsRemaining -= 1;
    await user.save();
    return { usedFreeUpload: true, diamondsCharged: 0 };
  }

  // 2. Check diamond balance (1 diamond per post/upload)
  const UPLOAD_COST = 1;
  if (user.diamondBalance < UPLOAD_COST) {
    const err = new Error('Insufficient diamonds. Please buy more diamonds to publish.');
    err.code = 'INSUFFICIENT_DIAMONDS';
    throw err;
  }

  user.diamondBalance -= UPLOAD_COST;
  await user.save();
  return { usedFreeUpload: false, diamondsCharged: UPLOAD_COST };
};

// Business Rules #2 & #4: if the caller passed a scheduledAt, this both
// validates it (1-hour buffer + the plan's daily post cap) and normalizes
// it to a Date, or returns null for an immediate "Post Now" request.
// Throws (with .code set) on validation failure — callers should let that
// propagate to their existing catch block.
const resolveScheduledAt = async (user, scheduledAtRaw) => {
  if (!scheduledAtRaw) return null;
  const scheduledAt = new Date(scheduledAtRaw);
  assertScheduleBufferOk(scheduledAt);
  await assertDailyLimitOk(user, toISTDateStr(scheduledAt));
  return scheduledAt;
};

// ==========================================
// 1. INSTAGRAM CAROUSEL POST (2 - 10 Items)
// Route: POST /api/posts/instagram/carousel
// Body may include an optional `scheduledAt` (ISO date string, must be >= 1
// hour from now) to schedule it instead of publishing immediately — in that
// case the actual Graph API publish is deferred to cron/scheduler.js, same
// as scheduled Facebook/Instagram uploads via /api/videos/upload.
// ==========================================
router.post('/instagram/carousel', protect, async (req, res) => {
  try {
    const { mediaItems, caption, scheduledAt: scheduledAtRaw } = req.body;

    // Validate media items length (Meta API constraint: 2 to 10 items)
    if (!Array.isArray(mediaItems) || mediaItems.length < 2 || mediaItems.length > 10) {
      return res.status(400).json({
        success: false,
        message: 'Instagram Carousel requires between 2 and 10 media items.'
      });
    }

    // Validate each item URL
    for (let i = 0; i < mediaItems.length; i++) {
      if (!mediaItems[i]?.url) {
        return res.status(400).json({
          success: false,
          message: `Item at index ${i} is missing a valid media URL.`
        });
      }
    }

    // Check Meta connection
    const connectedFB = req.user.connectedFacebook;
    if (!connectedFB?.pageId || !connectedFB?.pageAccessToken) {
      return res.status(400).json({
        success: false,
        message: 'Facebook Page is not connected. Please connect Meta via OAuth first.'
      });
    }
    if (!req.user.connectedInstagram) {
      return res.status(400).json({ success: false, message: 'Instagram is not connected.' });
    }

    const scheduledAt = await resolveScheduledAt(req.user, scheduledAtRaw);

    if (scheduledAt) {
      // Charge now (creation is the commitment point for a scheduled post);
      // if it ever permanently fails, cron/scheduler.js's auto-refund engine
      // returns the credit automatically.
      const creditInfo = await handlePublishCredits(req.user);
      const postRecord = await Video.create({
        user: req.user._id,
        status: 'queued',
        platform: 'instagram',
        postType: 'carousel',
        mediaUrls: mediaItems.map((m) => m.url),
        diamondsCharged: creditInfo.diamondsCharged,
        usedFreeUpload: creditInfo.usedFreeUpload,
        platforms: [{
          platform: 'instagram',
          postType: 'carousel',
          status: 'pending',
          scheduledAt,
          caption: caption || ''
        }]
      });

      return res.status(201).json({
        success: true,
        message: `Instagram Carousel scheduled for ${scheduledAt.toISOString()}.`,
        post: postRecord,
        remainingDiamonds: req.user.diamondBalance,
        remainingFreeUploads: req.user.freeUploadsRemaining
      });
    }

    // Fetch linked Instagram Business Account ID
    const igUserId = await getInstagramAccountId(connectedFB.pageId, connectedFB.pageAccessToken);

    // Call Meta helper function
    console.log(`▶️ [Carousel] Publishing ${mediaItems.length} items for User: ${req.user._id}`);
    const publishResult = await publishInstagramCarousel({
      igUserId,
      pageAccessToken: connectedFB.pageAccessToken,
      mediaItems,
      caption: caption || ''
    });

    // Only charge the user once the post has actually published — charging
    // upfront and failing to publish would silently take a diamond/free
    // upload with no record and no way for the user to get it back.
    const creditInfo = await handlePublishCredits(req.user);

    // Save post entry to Database
    const postRecord = await Video.create({
      user: req.user._id,
      title: caption ? caption.substring(0, 50) : 'Instagram Carousel',
      description: caption || '',
      status: 'uploaded',
      platform: 'instagram',
      postType: 'carousel',
      platformPostId: publishResult.platformPostId,
      platformUrl: publishResult.platformUrl,
      mediaUrls: mediaItems.map((m) => m.url),
      diamondsCharged: creditInfo.diamondsCharged,
      usedFreeUpload: creditInfo.usedFreeUpload
    });

    res.status(201).json({
      success: true,
      message: 'Instagram Carousel published successfully!',
      post: postRecord,
      remainingDiamonds: req.user.diamondBalance,
      remainingFreeUploads: req.user.freeUploadsRemaining
    });

  } catch (err) {
    console.error('❌ [Carousel Error]:', err.message);
    const status = err.code === 'INSUFFICIENT_DIAMONDS' ? 402
      : err.code === 'SCHEDULE_TOO_SOON' || err.code === 'INVALID_SCHEDULE_TIME' ? 400
      : err.code === 'DAILY_LIMIT_REACHED' ? 429
      : 500;
    res.status(status).json({ success: false, message: err.message, code: err.code });
  }
});

// ==========================================
// 2. INSTAGRAM REEL POST
// Route: POST /api/posts/instagram/reel
// Optional `scheduledAt` — see note on the Carousel route above.
// ==========================================
router.post('/instagram/reel', protect, async (req, res) => {
  try {
    const { videoUrl, caption, scheduledAt: scheduledAtRaw } = req.body;

    if (!videoUrl) {
      return res.status(400).json({ success: false, message: 'videoUrl is required.' });
    }

    const connectedFB = req.user.connectedFacebook;
    if (!connectedFB?.pageId || !connectedFB?.pageAccessToken) {
      return res.status(400).json({
        success: false,
        message: 'Facebook Page is not connected. Please connect Meta via OAuth first.'
      });
    }
    if (!req.user.connectedInstagram) {
      return res.status(400).json({ success: false, message: 'Instagram is not connected.' });
    }

    const scheduledAt = await resolveScheduledAt(req.user, scheduledAtRaw);

    if (scheduledAt) {
      const creditInfo = await handlePublishCredits(req.user);
      const postRecord = await Video.create({
        user: req.user._id,
        status: 'queued',
        platform: 'instagram',
        postType: 'reel',
        videoUrl,
        storageUrl: videoUrl,
        diamondsCharged: creditInfo.diamondsCharged,
        usedFreeUpload: creditInfo.usedFreeUpload,
        platforms: [{
          platform: 'instagram',
          postType: 'reel',
          status: 'pending',
          scheduledAt,
          caption: caption || ''
        }]
      });

      return res.status(201).json({
        success: true,
        message: `Instagram Reel scheduled for ${scheduledAt.toISOString()}.`,
        post: postRecord,
        remainingDiamonds: req.user.diamondBalance,
        remainingFreeUploads: req.user.freeUploadsRemaining
      });
    }

    const igUserId = await getInstagramAccountId(connectedFB.pageId, connectedFB.pageAccessToken);

    console.log(`▶️ [IG Reel] Publishing reel for User: ${req.user._id}`);
    const publishResult = await publishInstagramReel({
      igUserId,
      pageAccessToken: connectedFB.pageAccessToken,
      videoUrl,
      caption: caption || ''
    });

    const creditInfo = await handlePublishCredits(req.user);

    const postRecord = await Video.create({
      user: req.user._id,
      title: caption ? caption.substring(0, 50) : 'Instagram Reel',
      description: caption || '',
      status: 'uploaded',
      platform: 'instagram',
      postType: 'reel',
      videoUrl,
      platformPostId: publishResult.platformPostId,
      platformUrl: publishResult.platformUrl,
      diamondsCharged: creditInfo.diamondsCharged,
      usedFreeUpload: creditInfo.usedFreeUpload
    });

    res.status(201).json({
      success: true,
      message: 'Instagram Reel published successfully!',
      post: postRecord,
      remainingDiamonds: req.user.diamondBalance,
      remainingFreeUploads: req.user.freeUploadsRemaining
    });

  } catch (err) {
    console.error('❌ [IG Reel Error]:', err.message);
    const status = err.code === 'INSUFFICIENT_DIAMONDS' ? 402
      : err.code === 'SCHEDULE_TOO_SOON' || err.code === 'INVALID_SCHEDULE_TIME' ? 400
      : err.code === 'DAILY_LIMIT_REACHED' ? 429
      : 500;
    res.status(status).json({ success: false, message: err.message, code: err.code });
  }
});

// ==========================================
// 3. FACEBOOK REEL POST
// Route: POST /api/posts/facebook/reel
// Optional `scheduledAt` — see note on the Carousel route above.
// ==========================================
router.post('/facebook/reel', protect, async (req, res) => {
  try {
    const { videoUrl, caption, scheduledAt: scheduledAtRaw } = req.body;

    if (!videoUrl) {
      return res.status(400).json({ success: false, message: 'videoUrl is required.' });
    }

    const connectedFB = req.user.connectedFacebook;
    if (!connectedFB?.pageId || !connectedFB?.pageAccessToken) {
      return res.status(400).json({
        success: false,
        message: 'Facebook Page is not connected. Please connect Meta via OAuth first.'
      });
    }

    const scheduledAt = await resolveScheduledAt(req.user, scheduledAtRaw);

    if (scheduledAt) {
      const creditInfo = await handlePublishCredits(req.user);
      const postRecord = await Video.create({
        user: req.user._id,
        status: 'queued',
        platform: 'facebook',
        postType: 'reel',
        videoUrl,
        storageUrl: videoUrl,
        diamondsCharged: creditInfo.diamondsCharged,
        usedFreeUpload: creditInfo.usedFreeUpload,
        platforms: [{
          platform: 'facebook',
          postType: 'reel',
          status: 'pending',
          scheduledAt,
          caption: caption || ''
        }]
      });

      return res.status(201).json({
        success: true,
        message: `Facebook Reel scheduled for ${scheduledAt.toISOString()}.`,
        post: postRecord,
        remainingDiamonds: req.user.diamondBalance,
        remainingFreeUploads: req.user.freeUploadsRemaining
      });
    }

    console.log(`▶️ [FB Reel] Publishing reel for User: ${req.user._id}`);
    const publishResult = await publishFacebookReel({
      pageId: connectedFB.pageId,
      pageAccessToken: connectedFB.pageAccessToken,
      videoUrl,
      caption: caption || ''
    });

    const creditInfo = await handlePublishCredits(req.user);

    const postRecord = await Video.create({
      user: req.user._id,
      title: caption ? caption.substring(0, 50) : 'Facebook Reel',
      description: caption || '',
      status: 'uploaded',
      platform: 'facebook',
      postType: 'reel',
      videoUrl,
      platformPostId: publishResult.platformPostId,
      platformUrl: publishResult.platformUrl,
      diamondsCharged: creditInfo.diamondsCharged,
      usedFreeUpload: creditInfo.usedFreeUpload
    });

    res.status(201).json({
      success: true,
      message: 'Facebook Reel published successfully!',
      post: postRecord,
      remainingDiamonds: req.user.diamondBalance,
      remainingFreeUploads: req.user.freeUploadsRemaining
    });

  } catch (err) {
    console.error('❌ [FB Reel Error]:', err.message);
    const status = err.code === 'INSUFFICIENT_DIAMONDS' ? 402
      : err.code === 'SCHEDULE_TOO_SOON' || err.code === 'INVALID_SCHEDULE_TIME' ? 400
      : err.code === 'DAILY_LIMIT_REACHED' ? 429
      : 500;
    res.status(status).json({ success: false, message: err.message, code: err.code });
  }
});

module.exports = router;
