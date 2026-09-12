const express = require('express');
const { protect } = require('../middleware/auth');
const upload = require('../middleware/upload');
const Video = require('../models/Video');
const Notification = require('../models/Notification');
const { pickAvailableCloudinaryAccount, uploadBufferToCloudinary } = require('../utils/cloudinary');
const { uploadBufferToDrive } = require('../utils/googleDrive');
const { sendOneSignalToUser } = require('../utils/oneSignalPush');
const {
  refreshAccessToken, isInvalidGrantError, listChannelVideos, deleteVideoFromYoutube
} = require('../utils/youtube');
const {
  getCurrentISTDateStr,
  addDaysToDateStr,
  buildISTInstant,
  toISTDateStr,
  getISTDayRangeUTC
} = require('../utils/dateHelpers');

const router = express.Router();

const DIAMOND_COST_PER_UPLOAD = Number(process.env.DIAMOND_COST_PER_UPLOAD || 10);
const MIN_SCHEDULE_BUFFER_MS = 60 * 60 * 1000;
const FREE_PLAN_DAILY_LIMIT = 1;
const PREMIUM_PLAN_DAILY_LIMIT = 2;

const chargeForUpload = (user) => {
  if (user.freeUploadsRemaining > 0) {
    user.freeUploadsRemaining -= 1;
    return { usedFreeUpload: true, diamondsCharged: 0 };
  }
  if (user.diamondBalance >= DIAMOND_COST_PER_UPLOAD) {
    user.diamondBalance -= DIAMOND_COST_PER_UPLOAD;
    return { usedFreeUpload: false, diamondsCharged: DIAMOND_COST_PER_UPLOAD };
  }
  const err = new Error('Not enough diamonds. Please buy more diamonds to upload.');
  err.code = 'INSUFFICIENT_DIAMONDS';
  throw err;
};

const storeVideoFile = async (buffer, filename, mimetype) => {
  const picked = await pickAvailableCloudinaryAccount(buffer.length);
  if (picked) {
    const result = await uploadBufferToCloudinary(picked.account, buffer, { public_id: filename });
    return { storageProvider: picked.key, storageFileId: result.public_id, storageUrl: result.secure_url };
  }
  const driveFile = await uploadBufferToDrive(buffer, filename, mimetype);
  return { storageProvider: 'google_drive', storageFileId: driveFile.id, storageUrl: driveFile.webViewLink };
};

const parseCommaList = (str) => (str ? str.split(',').map((t) => t.trim()).filter(Boolean) : []);
const parseJson = (str, fallback = {}) => {
  try { return JSON.parse(str); } catch (_) { return fallback; }
};

const assertScheduleBufferOk = (scheduledAt) => {
  if (!scheduledAt) return;
  const target = new Date(scheduledAt);
  if (Number.isNaN(target.getTime())) {
    const err = new Error('Invalid scheduled date/time provided');
    err.code = 'INVALID_SCHEDULE_TIME';
    throw err;
  }
  if (target.getTime() < Date.now() + MIN_SCHEDULE_BUFFER_MS) {
    const err = new Error('Scheduled time must be at least 1 hour from now — this gives upload, processing, and platform rendering enough time to finish before it goes live.');
    err.code = 'SCHEDULE_TOO_SOON';
    throw err;
  }
};

const getUserDailyPostLimit = (user) => {
  const sub = user.subscription;
  const isPremiumActive = !!(sub && sub.isActive && (!sub.expiresAt || new Date(sub.expiresAt) > new Date()));
  return isPremiumActive ? PREMIUM_PLAN_DAILY_LIMIT : FREE_PLAN_DAILY_LIMIT;
};

const countUserVideosOnISTDate = async (userId, dateStr, excludeVideoId = null) => {
  const { start, end } = getISTDayRangeUTC(dateStr);
  const query = {
    user: userId,
    status: { $ne: 'failed' },
    $or: [
      { 'platforms.scheduledAt': { $gte: start, $lt: end } },
      { 'platforms.scheduledAt': null, createdAt: { $gte: start, $lt: end } }
    ]
  };
  if (excludeVideoId) query._id = { $ne: excludeVideoId };
  return Video.countDocuments(query);
};

const getPrimaryDateStrForPlatforms = (scheduledDates) => {
  const validDates = scheduledDates.filter(Boolean);
  if (!validDates.length) return getCurrentISTDateStr();
  const earliest = new Date(Math.min(...validDates.map((d) => new Date(d).getTime())));
  return toISTDateStr(earliest);
};

const assertDailyLimitOk = async (user, dateStr, excludeVideoId = null) => {
  const dailyLimit = getUserDailyPostLimit(user);
  const existingCount = await countUserVideosOnISTDate(user._id, dateStr, excludeVideoId);
  if (existingCount >= dailyLimit) {
    const planLabel = dailyLimit === PREMIUM_PLAN_DAILY_LIMIT ? 'Premium' : 'Free';
    const err = new Error(`Your ${planLabel} plan allows only ${dailyLimit} video${dailyLimit > 1 ? 's' : ''} per day. You already have ${existingCount} scheduled for ${dateStr}.`);
    err.code = 'DAILY_LIMIT_REACHED';
    throw err;
  }
};

// Local, read-only token-freshness check — same duplicated pattern used in
// routes/analytics.js (cron/scheduler.js's internal helper isn't exported).
const ensureFreshTokenForVideos = async (user) => {
  const channel = user.youtubeChannel;
  const isExpired = !channel.tokenExpiryDate || Date.now() > channel.tokenExpiryDate - 60000;
  if (!isExpired) return channel.accessToken;
  const credentials = await refreshAccessToken(channel.refreshToken);
  user.youtubeChannel.accessToken = credentials.access_token;
  user.youtubeChannel.tokenExpiryDate = credentials.expiry_date;
  await user.save();
  return credentials.access_token;
};

// @route POST /api/videos/upload
router.post('/upload', protect, upload.fields([{ name: 'video', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }]), async (req, res) => {
  try {
    const user = req.user;
    if (!req.files || !req.files.video) {
      return res.status(400).json({ success: false, message: 'Video file is required' });
    }

    const platformsRequested = parseJson(req.body.platforms, []);
    if (!Array.isArray(platformsRequested) || platformsRequested.length === 0) {
      return res.status(400).json({ success: false, message: 'Select at least one platform' });
    }

    for (const p of platformsRequested) {
      if (p === 'youtube' && !user.youtubeChannel) {
        return res.status(400).json({ success: false, message: 'Connect your YouTube channel first', code: 'YOUTUBE_NOT_CONNECTED' });
      }
      if (p === 'facebook' && !user.connectedFacebook) {
        return res.status(400).json({ success: false, message: 'Connect Facebook first', code: 'FACEBOOK_NOT_CONNECTED' });
      }
      if (p === 'instagram' && !user.connectedInstagram) {
        return res.status(400).json({ success: false, message: 'Connect Instagram first', code: 'INSTAGRAM_NOT_CONNECTED' });
      }
    }

    const postTypeRequested = req.body.postType || 'video';
    const perPlatformMeta = {};
    const scheduledDates = [];

    for (const p of platformsRequested) {
      if (p === 'youtube') {
        const yt = parseJson(req.body.youtube, {});
        const scheduledAt = yt.scheduledAt ? new Date(yt.scheduledAt) : null;
        assertScheduleBufferOk(scheduledAt);
        perPlatformMeta.youtube = { raw: yt, scheduledAt };
        scheduledDates.push(scheduledAt);
      } else if (p === 'facebook') {
        const fb = parseJson(req.body.facebook, {});
        const scheduledAt = fb.scheduledAt ? new Date(fb.scheduledAt) : null;
        assertScheduleBufferOk(scheduledAt);
        perPlatformMeta.facebook = { raw: fb, scheduledAt };
        scheduledDates.push(scheduledAt);
      } else if (p === 'instagram') {
        const ig = parseJson(req.body.instagram, {});
        const scheduledAt = ig.scheduledAt ? new Date(ig.scheduledAt) : null;
        assertScheduleBufferOk(scheduledAt);
        perPlatformMeta.instagram = { raw: ig, scheduledAt };
        scheduledDates.push(scheduledAt);
      }
    }

    const primaryDateStr = getPrimaryDateStrForPlatforms(scheduledDates);
    await assertDailyLimitOk(user, primaryDateStr);

    const charge = chargeForUpload(user);

    const videoFile = req.files.video[0];
    const stored = await storeVideoFile(videoFile.buffer, `${user.userId}_${Date.now()}`, videoFile.mimetype);

    let thumbnailUrl = '';
    if (req.files.thumbnail) {
      const thumbFile = req.files.thumbnail[0];
      const thumbUpload = await uploadBufferToCloudinary(
        require('../utils/cloudinary').account1,
        thumbFile.buffer,
        { resource_type: 'image', public_id: `${user.userId}_thumb_${Date.now()}` }
      ).catch(() => null);
      thumbnailUrl = thumbUpload ? thumbUpload.secure_url : '';
    }

    const mediaUrlsRequested = parseJson(req.body.mediaUrls, [stored.storageUrl]);

    const platforms = [];
    for (const p of platformsRequested) {
      if (p === 'youtube') {
        const { raw: yt, scheduledAt } = perPlatformMeta.youtube;
        const requestedPrivacy = ['public', 'unlisted', 'private'].includes(yt.privacyStatus) ? yt.privacyStatus : 'public';
        platforms.push({
          platform: 'youtube',
          postType: 'video',
          status: 'queued',
          scheduledAt,
          title: yt.title || '',
          description: yt.description || '',
          tags: parseCommaList(yt.tags),
          category: yt.category || '22',
          playlist: yt.playlist || '',
          audience: yt.audience || 'not_for_kids',
          privacyStatus: requestedPrivacy,
          targetPrivacyStatus: requestedPrivacy,
          youtubePrivacyPromoted: false,
          thumbnailUrl
        });
      } else if (p === 'facebook') {
        const { raw: fb, scheduledAt } = perPlatformMeta.facebook;
        platforms.push({
          platform: 'facebook',
          postType: postTypeRequested,
          status: scheduledAt && scheduledAt > new Date() ? 'pending' : 'queued',
          scheduledAt,
          caption: fb.caption || '',
          hashtags: parseCommaList(fb.hashtags)
        });
      } else if (p === 'instagram') {
        const { raw: ig, scheduledAt } = perPlatformMeta.instagram;
        platforms.push({
          platform: 'instagram',
          postType: postTypeRequested,
          status: scheduledAt && scheduledAt > new Date() ? 'pending' : 'queued',
          scheduledAt,
          caption: ig.caption || '',
          hashtags: parseCommaList(ig.hashtags)
        });
      }
    }

    if (!platforms.length) {
      return res.status(400).json({ success: false, message: 'No valid platforms selected' });
    }

    const video = await Video.create({
      user: user._id,
      storageProvider: stored.storageProvider,
      storageFileId: stored.storageFileId,
      storageUrl: stored.storageUrl,
      videoUrl: stored.storageUrl,
      mediaUrls: mediaUrlsRequested,
      fileSizeBytes: videoFile.size,
      platforms,
      postType: postTypeRequested,
      platform: platformsRequested.length > 1 ? 'multi' : platformsRequested[0],
      status: 'queued',
      diamondsCharged: charge.diamondsCharged,
      usedFreeUpload: charge.usedFreeUpload
    });

    user.storageUsedBytes += videoFile.size;
    await user.save();

    res.status(201).json({ success: true, video });
  } catch (err) {
    if (err.code === 'INSUFFICIENT_DIAMONDS') {
      sendOneSignalToUser(req.user, {
        title: 'Your credits are over 💎',
        body: 'Your free uploads and diamonds are used up. Please buy diamonds to upload.',
        data: { type: 'insufficient_diamonds' }
      }).catch(() => {});
      return res.status(402).json({ success: false, message: err.message, code: err.code });
    }
    if (err.code === 'SCHEDULE_TOO_SOON' || err.code === 'INVALID_SCHEDULE_TIME') {
      return res.status(400).json({ success: false, message: err.message, code: err.code });
    }
    if (err.code === 'DAILY_LIMIT_REACHED') {
      return res.status(429).json({ success: false, message: err.message, code: err.code });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route POST /api/videos/bulk-upload
router.post('/bulk-upload', protect, upload.array('videos', 30), async (req, res) => {
  try {
    const user = req.user;
    const files = req.files;
    if (!files || !files.length) {
      return res.status(400).json({ success: false, message: 'At least one video file is required (field name: videos)' });
    }

    const platformsRequested = parseJson(req.body.platforms, []);
    if (!Array.isArray(platformsRequested) || platformsRequested.length === 0) {
      return res.status(400).json({ success: false, message: 'Select at least one platform' });
    }
    for (const p of platformsRequested) {
      if (p === 'youtube' && !user.youtubeChannel) {
        return res.status(400).json({ success: false, message: 'Connect your YouTube channel first', code: 'YOUTUBE_NOT_CONNECTED' });
      }
      if (p === 'facebook' && !user.connectedFacebook) {
        return res.status(400).json({ success: false, message: 'Connect Facebook first', code: 'FACEBOOK_NOT_CONNECTED' });
      }
      if (p === 'instagram' && !user.connectedInstagram) {
        return res.status(400).json({ success: false, message: 'Connect Instagram first', code: 'INSTAGRAM_NOT_CONNECTED' });
      }
    }

    const items = parseJson(req.body.items, []);
    const postTypeRequested = req.body.postType || 'video';
    const preferredTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(req.body.preferredTime || '') ? req.body.preferredTime : '10:00';

    const availableCredits = user.freeUploadsRemaining + Math.floor(user.diamondBalance / DIAMOND_COST_PER_UPLOAD);
    if (availableCredits < files.length) {
      return res.status(402).json({
        success: false,
        code: 'INSUFFICIENT_DIAMONDS',
        message: `You have credits for ${availableCredits} upload(s), but ${files.length} video(s) were submitted. Please buy more diamonds or reduce the batch size.`
      });
    }

    const dailyLimit = getUserDailyPostLimit(user);
    let cursorDateStr = addDaysToDateStr(getCurrentISTDateStr(), 1);
    const slotDateStrs = [];
    const assignedCountByDate = {};
    let safetyCounter = 0;
    while (slotDateStrs.length < files.length) {
      safetyCounter += 1;
      if (safetyCounter > files.length + 400) {
        return res.status(500).json({ success: false, message: 'Could not compute bulk schedule slots — please try a smaller batch.' });
      }
      const alreadyOnThisDay = await countUserVideosOnISTDate(user._id, cursorDateStr);
      const takenThisRun = assignedCountByDate[cursorDateStr] || 0;
      const capacityLeft = dailyLimit - alreadyOnThisDay - takenThisRun;
      if (capacityLeft > 0) {
        slotDateStrs.push(cursorDateStr);
        assignedCountByDate[cursorDateStr] = takenThisRun + 1;
      } else {
        cursorDateStr = addDaysToDateStr(cursorDateStr, 1);
      }
    }

    const results = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const dateStr = slotDateStrs[i];
      const scheduledAt = buildISTInstant(dateStr, preferredTime);
      const meta = items[i] || {};

      try {
        assertScheduleBufferOk(scheduledAt);

        const charge = chargeForUpload(user);
        const stored = await storeVideoFile(file.buffer, `${user.userId}_bulk_${Date.now()}_${i}`, file.mimetype);

        const platforms = platformsRequested.map((p) => {
          if (p === 'youtube') {
            const requestedPrivacy = ['public', 'unlisted', 'private'].includes(meta.privacyStatus) ? meta.privacyStatus : 'public';
            return {
              platform: 'youtube',
              postType: 'video',
              status: 'queued',
              scheduledAt,
              title: meta.title || file.originalname || `Video ${i + 1}`,
              description: meta.description || '',
              tags: parseCommaList(meta.tags),
              category: meta.category || '22',
              playlist: meta.playlist || '',
              audience: meta.audience || 'not_for_kids',
              privacyStatus: requestedPrivacy,
              targetPrivacyStatus: requestedPrivacy,
              youtubePrivacyPromoted: false
            };
          }
          return {
            platform: p,
            postType: postTypeRequested,
            status: scheduledAt && scheduledAt > new Date() ? 'pending' : 'queued',
            scheduledAt,
            caption: meta.caption || '',
            hashtags: parseCommaList(meta.hashtags)
          };
        });

        const video = await Video.create({
          user: user._id,
          storageProvider: stored.storageProvider,
          storageFileId: stored.storageFileId,
          storageUrl: stored.storageUrl,
          videoUrl: stored.storageUrl,
          fileSizeBytes: file.size,
          platforms,
          postType: postTypeRequested,
          platform: platformsRequested.length > 1 ? 'multi' : platformsRequested[0],
          status: 'queued',
          diamondsCharged: charge.diamondsCharged,
          usedFreeUpload: charge.usedFreeUpload
        });

        user.storageUsedBytes += file.size;
        await user.save();

        results.push({
          success: true,
          fileName: file.originalname,
          videoId: video._id,
          scheduledDate: dateStr,
          scheduledAt
        });
      } catch (itemErr) {
        console.error(`❌ [Bulk Upload] Item ${i} (${file.originalname}) failed:`, itemErr.message);
        results.push({ success: false, fileName: file.originalname, error: itemErr.message, code: itemErr.code });
      }
    }

    const successCount = results.filter((r) => r.success).length;

    res.status(201).json({
      success: successCount > 0,
      message: `${successCount}/${files.length} video(s) scheduled successfully, starting ${slotDateStrs[0]} (today skipped, ${dailyLimit}/day plan limit applied).`,
      results
    });
  } catch (err) {
    if (err.code === 'INSUFFICIENT_DIAMONDS') {
      return res.status(402).json({ success: false, message: err.message, code: err.code });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

// ⚠️ NEW (Boss request — "My Videos" screen): a single combined list of
// EVERY video the creator has — TubePilot's own queued/uploaded DB
// records AND real videos live on the connected YouTube channel — with
// duplicates merged (a DB video that's already live on YouTube is shown
// once, using the live YouTube copy's title/description/tags/thumbnail as
// the source of truth, since that's what's actually public).
//
// IMPORTANT: this route must stay registered ABOVE '/:id' so Express
// doesn't try to match "library" as an :id.
router.get('/library', protect, async (req, res) => {
  try {
    const dbVideos = await Video.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(100);

    let ytVideos = [];
    if (req.user.youtubeChannel) {
      try {
        const accessToken = await ensureFreshTokenForVideos(req.user);
        ytVideos = await listChannelVideos(accessToken);
      } catch (err) {
        console.error('⚠️ [Library] Could not fetch YouTube channel videos:', err.message);
      }
    }

    const ytByVideoId = {};
    ytVideos.forEach((v) => { ytByVideoId[v.videoId] = v; });
    const usedYtIds = new Set();

    const items = [];

    dbVideos.forEach((video) => {
      const ytTarget = video.platforms.find((p) => p.platform === 'youtube');
      const ytVideoId = ytTarget?.platformPostId || null;
      const liveMatch = ytVideoId ? ytByVideoId[ytVideoId] : null;
      if (liveMatch) usedYtIds.add(ytVideoId);

      items.push({
        source: liveMatch ? 'both' : 'db',
        dbId: video._id,
        ytVideoId,
        title: liveMatch?.title || ytTarget?.title || '',
        description: liveMatch?.description || ytTarget?.description || '',
        tags: liveMatch?.tags || ytTarget?.tags || [],
        thumbnail: liveMatch?.thumbnail || ytTarget?.thumbnailUrl || '',
        status: video.status,
        createdAt: video.createdAt
      });
    });

    ytVideos.forEach((v) => {
      if (usedYtIds.has(v.videoId)) return;
      items.push({
        source: 'youtube',
        dbId: null,
        ytVideoId: v.videoId,
        title: v.title,
        description: v.description,
        tags: v.tags,
        thumbnail: v.thumbnail,
        status: 'uploaded',
        createdAt: v.publishedAt
      });
    });

    items.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    res.json({ success: true, videos: items });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/', protect, async (req, res) => {
  try {
    const filter = { user: req.user._id };
    if (req.query.status) filter.status = req.query.status;
    const videos = await Video.find(filter).sort({ createdAt: -1 }).limit(Number(req.query.limit) || 50);
    res.json({ success: true, videos });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/:id', protect, async (req, res) => {
  try {
    const video = await Video.findOne({ _id: req.params.id, user: req.user._id });
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });
    res.json({ success: true, video });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ⚠️ UPDATED (Boss request — My Videos edit sheet needs to save tags too)
router.patch('/:id/metadata', protect, async (req, res) => {
  try {
    const { platform, title, description, caption, hashtags, tags } = req.body;
    if (!platform) return res.status(400).json({ success: false, message: 'platform is required' });

    const video = await Video.findOne({ _id: req.params.id, user: req.user._id });
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });

    const target = video.platforms.find((p) => p.platform === platform);
    if (!target) return res.status(404).json({ success: false, message: `This video has no ${platform} target` });

    if (!['pending', 'queued'].includes(target.status)) {
      return res.status(400).json({
        success: false,
        message: `Can't edit metadata — this video's ${platform} upload is already ${target.status}.`
      });
    }

    if (title !== undefined) {
      target.title = title;
      video.aiGenerated.title = true;
    }
    if (description !== undefined) {
      target.description = description;
      video.aiGenerated.description = true;
    }
    if (caption !== undefined) {
      target.caption = caption;
      video.aiGenerated.caption = true;
    }
    if (hashtags !== undefined) {
      target.hashtags = Array.isArray(hashtags) ? hashtags : String(hashtags).split(',').map((h) => h.trim()).filter(Boolean);
      video.aiGenerated.hashtags = true;
    }
    if (tags !== undefined) {
      target.tags = Array.isArray(tags) ? tags : String(tags).split(',').map((t) => t.trim()).filter(Boolean);
      video.aiGenerated.tags = true;
    }

    await video.save();
    res.json({ success: true, message: 'Video updated', video });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ⚠️ NEW (Boss request — "My Videos" thumbnail change, for a video still
// in TubePilot's own queue/draft). If it's already live on YouTube, the
// new thumbnail goes straight to YouTube instead of just our own DB copy.
router.patch('/:id/thumbnail', protect, upload.single('thumbnail'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'thumbnail file is required' });

    const video = await Video.findOne({ _id: req.params.id, user: req.user._id });
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });

    const target = video.platforms.find((p) => p.platform === 'youtube');
    if (!target) return res.status(404).json({ success: false, message: 'This video has no YouTube target' });

    if (target.platformPostId && req.user.youtubeChannel) {
      const { setThumbnail } = require('../utils/youtube');
      const { Readable } = require('stream');
      const accessToken = await ensureFreshTokenForVideos(req.user);
      await setThumbnail({
        accessToken,
        refreshToken: req.user.youtubeChannel.refreshToken,
        videoId: target.platformPostId,
        thumbnailStream: Readable.from(req.file.buffer)
      });
    } else {
      const thumbUpload = await uploadBufferToCloudinary(
        require('../utils/cloudinary').account1,
        req.file.buffer,
        { resource_type: 'image', public_id: `${req.user.userId}_thumb_${Date.now()}` }
      );
      target.thumbnailUrl = thumbUpload.secure_url;
      await video.save();
    }

    res.json({ success: true, message: 'Thumbnail updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.patch('/:id/schedule/:platform', protect, async (req, res) => {
  try {
    const { scheduledAt } = req.body;
    if (!scheduledAt) return res.status(400).json({ success: false, message: 'scheduledAt is required' });

    try {
      assertScheduleBufferOk(scheduledAt);
    } catch (bufferErr) {
      return res.status(400).json({ success: false, message: bufferErr.message, code: bufferErr.code });
    }

    const video = await Video.findOne({ _id: req.params.id, user: req.user._id });
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });

    const target = video.platforms.find((p) => p.platform === req.params.platform);
    if (!target) return res.status(404).json({ success: false, message: 'Platform target not found on this video' });

    try {
      await assertDailyLimitOk(req.user, toISTDateStr(scheduledAt), video._id);
    } catch (limitErr) {
      return res.status(429).json({ success: false, message: limitErr.message, code: limitErr.code });
    }

    if (target.platform === 'youtube') {
      if (target.status === 'uploaded' && target.youtubePrivacyPromoted) {
        return res.status(400).json({ success: false, message: 'This video is already public on YouTube' });
      }
      target.scheduledAt = new Date(scheduledAt);
      if (target.status !== 'uploaded') {
        target.status = 'queued';
      }
    } else {
      if (target.status === 'uploaded') return res.status(400).json({ success: false, message: 'Already published to this platform' });
      target.scheduledAt = new Date(scheduledAt);
      target.status = target.scheduledAt > new Date() ? 'pending' : 'queued';
    }

    video.recomputeStatus();
    await video.save();

    res.json({ success: true, video });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ⚠️ UPDATED (Boss request — "My Videos" delete must remove BOTH the
// TubePilot record AND the real YouTube video): previously blocked
// deleting an already fully-uploaded video entirely. That restriction is
// now removed — if this video has a live YouTube target, it's deleted
// from YouTube first, then the TubePilot record is removed. A YouTube
// delete failure (already gone, dead token) never blocks cleaning up the
// local record — the user's "Delete" action should always finish.
router.delete('/:id', protect, async (req, res) => {
  try {
    const video = await Video.findOne({ _id: req.params.id, user: req.user._id });
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });

    const ytTarget = video.platforms.find((p) => p.platform === 'youtube' && p.platformPostId);
    if (ytTarget && req.user.youtubeChannel) {
      try {
        const accessToken = await ensureFreshTokenForVideos(req.user);
        await deleteVideoFromYoutube({
          accessToken,
          refreshToken: req.user.youtubeChannel.refreshToken,
          videoId: ytTarget.platformPostId
        });
      } catch (err) {
        console.error('⚠️ [Video Delete] YouTube delete failed, continuing with local delete:', err.message);
      }
    }

    // Only refund credits for a video that never actually finished
    // publishing — an already-live video's credit was legitimately spent.
    if (!video.refundIssued && video.status !== 'uploaded') {
      if (video.usedFreeUpload) {
        req.user.freeUploadsRemaining += 1;
      } else if (video.diamondsCharged > 0) {
        req.user.diamondBalance += video.diamondsCharged;
      }
      await req.user.save();
    }
    await video.deleteOne();

    await Notification.create({
      user: req.user._id,
      type: 'upload_failed',
      title: 'Video Deleted',
      message: 'Your video was deleted from TubePilot and YouTube.'
    });

    res.json({ success: true, message: 'Video deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
module.exports.chargeForUpload = chargeForUpload;
module.exports.storeVideoFile = storeVideoFile;
module.exports.getUserDailyPostLimit = getUserDailyPostLimit;
module.exports.countUserVideosOnISTDate = countUserVideosOnISTDate;
module.exports.assertScheduleBufferOk = assertScheduleBufferOk;
module.exports.assertDailyLimitOk = assertDailyLimitOk;
