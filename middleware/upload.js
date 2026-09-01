const multer = require('multer');

const storage = multer.memoryStorage();

const videoFilter = (req, file, cb) => {
  const allowed = ['video/mp4', 'video/quicktime', 'video/x-matroska', 'video/webm', 'video/x-msvideo'];
  if (['video', 'videos'].includes(file.fieldname) && !allowed.includes(file.mimetype)) {
    return cb(new Error('Only video files (mp4, mov, mkv, webm, avi) are allowed'));
  }
  if (file.fieldname === 'thumbnail' && !file.mimetype.startsWith('image/')) {
    return cb(new Error('Thumbnail must be an image file'));
  }
  if (file.fieldname === 'screenshot' && !file.mimetype.startsWith('image/')) {
    return cb(new Error('Screenshot must be an image file'));
  }
  cb(null, true);
};

const upload = multer({
  storage,
  fileFilter: videoFilter,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2GB max per video
});

module.exports = upload;
