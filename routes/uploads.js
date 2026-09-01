const express = require('express');
const multer = require('multer');
const { protect } = require('../middleware/auth');
const { pickAvailableCloudinaryAccount, uploadBufferToCloudinary } = require('../utils/cloudinary');

const router = express.Router();

// ---------------------------------------------------------------------------
// Dedicated multer instance for this route only — separate from
// middleware/upload.js (which is tuned for video/thumbnail uploads) so
// changing image limits/validation here can never affect the video upload
// flow. Memory storage, same as the video uploader, since files are
// streamed straight to Cloudinary and never touch disk.
// ---------------------------------------------------------------------------
const ALLOWED_IMAGE_MIMES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB per image
const MAX_IMAGES_PER_REQUEST = 10; // Instagram carousel supports 2-10 items

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: MAX_IMAGES_PER_REQUEST },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_IMAGE_MIMES.includes(file.mimetype)) {
      return cb(new Error('Only JPEG, PNG, or WEBP images are allowed'));
    }
    cb(null, true);
  }
});

// Accepts EITHER a single file under field name "image" OR up to 10 files
// under field name "images" in the same request — callers doing a single
// cover-image upload don't need to know about the array field, and the
// carousel picker doesn't need a separate single-file code path.
const IMAGE_FIELDS = [
  { name: 'image', maxCount: 1 },
  { name: 'images', maxCount: MAX_IMAGES_PER_REQUEST }
];

// Wraps multer so its errors (bad mimetype, file too large, too many files)
// come back as the same { success:false, message } JSON shape as the rest
// of the API instead of multer's default plain-text/HTML error.
const handleImageUpload = (req, res, next) => {
  imageUpload.fields(IMAGE_FIELDS)(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      const message =
        err.code === 'LIMIT_FILE_SIZE'
          ? `Each image must be under ${MAX_IMAGE_BYTES / (1024 * 1024)}MB`
          : err.code === 'LIMIT_FILE_COUNT'
          ? `You can upload at most ${MAX_IMAGES_PER_REQUEST} images per request`
          : err.message;
      return res.status(400).json({ success: false, message });
    }
    if (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
    next();
  });
};

/**
 * POST /api/uploads/image
 * Multipart form-data — send ONE file under field name "image", or 1-10
 * files under field name "images" (the Flutter carousel picker uses
 * "images"). Uploads each file to whichever Cloudinary account currently
 * has room (same load-balancing helper the video upload flow uses), and
 * returns the hosted URLs so the client can pass them straight into
 * POST /api/posts/instagram/carousel as `mediaItems: urls.map(url => ({url}))`.
 */
router.post('/image', protect, handleImageUpload, async (req, res) => {
  try {
    const files = [...(req.files?.image || []), ...(req.files?.images || [])];
    if (files.length === 0) {
      return res.status(400).json({ success: false, message: 'No image files received (use field name "image" or "images")' });
    }

    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    const picked = await pickAvailableCloudinaryAccount(totalBytes);
    if (!picked) {
      return res.status(503).json({
        success: false,
        message: 'Image storage is temporarily full. Please try again later or contact support.'
      });
    }

    const uploads = await Promise.allSettled(
      files.map((file) =>
        uploadBufferToCloudinary(picked.account, file.buffer, {
          resource_type: 'image',
          folder: 'tubepilot/carousel'
        })
      )
    );

    const urls = [];
    const failed = [];
    uploads.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        urls.push(result.value.secure_url);
      } else {
        failed.push({ file: files[i].originalname, reason: result.reason?.message || String(result.reason) });
      }
    });

    if (urls.length === 0) {
      return res.status(502).json({ success: false, message: 'All image uploads failed', failed });
    }

    return res.status(failed.length ? 207 : 200).json({
      success: true,
      urls,
      // Convenience shape — ready to drop straight into
      // POST /api/posts/instagram/carousel's `mediaItems` field.
      mediaItems: urls.map((url) => ({ url })),
      ...(failed.length ? { failed } : {})
    });
  } catch (err) {
    console.error('Image upload error:', err);
    return res.status(500).json({ success: false, message: 'Image upload failed', error: err.message });
  }
});

module.exports = router;
