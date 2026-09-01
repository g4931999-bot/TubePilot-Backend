const mongoose = require('mongoose');

const PlatformTargetSchema = new mongoose.Schema({
  platform: { type: String, enum: ['youtube', 'facebook', 'instagram'], required: true },
  postType: { type: String, enum: ['video', 'reel', 'carousel', 'post'], default: 'video' },
  status: {
    type: String,
    enum: ['pending', 'queued', 'processing', 'uploaded', 'failed'],
    default: 'pending'
  },
  scheduledAt: { type: Date, default: null },

  // Metadata
  title: { type: String, default: '' },
  description: { type: String, default: '' },
  caption: { type: String, default: '' },
  tags: [{ type: String }],
  hashtags: [{ type: String }],
  category: { type: String, default: '22' },
  playlist: { type: String, default: '' },
  audience: { type: String, enum: ['made_for_kids', 'not_for_kids'], default: 'not_for_kids' },
  privacyStatus: { type: String, enum: ['public', 'unlisted', 'private'], default: 'public' },
  targetPrivacyStatus: { type: String, enum: ['public', 'unlisted', 'private'], default: null },
  youtubePrivacyPromoted: { type: Boolean, default: false },
  thumbnailUrl: { type: String, default: '' },

  // Result fields
  platformPostId: { type: String, default: '' },
  platformUrl: { type: String, default: '' },
  failReason: { type: String, default: '' },
  retryCount: { type: Number, default: 0 }
}, { _id: false });

const VideoSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  // Primary Storage
  storageProvider: { type: String, enum: ['cloudinary_1', 'cloudinary_2', 'google_drive', 'youtube', 'direct_url'], default: null },
  storageFileId: { type: String, default: '' },
  storageUrl: { type: String, default: '' },
  
  // Single File or Carousel Media URLs Array
  videoUrl: { type: String, default: '' },
  mediaUrls: [{ type: String }], // Carousel support for Instagram/Facebook
  
  fileSizeBytes: { type: Number, default: 0 },
  storageDeleteAt: { type: Date, default: null },

  sourceProvider: { type: String, enum: ['manual', 'drive_auto'], default: 'manual' },
  sourceDriveFileId: { type: String, default: '' },

  // Root platform status indicator
  platform: { type: String, enum: ['youtube', 'facebook', 'instagram', 'multi'], default: 'youtube' },
  postType: { type: String, enum: ['video', 'reel', 'carousel', 'post'], default: 'video' },
  platformPostId: { type: String, default: '' },
  platformUrl: { type: String, default: '' },

  // Target Platforms List
  platforms: { type: [PlatformTargetSchema], default: [] },

  status: {
    type: String,
    enum: ['draft', 'queued', 'processing', 'uploaded', 'partially_uploaded', 'failed'],
    default: 'draft'
  },

  diamondsCharged: { type: Number, default: 0 },
  usedFreeUpload: { type: Boolean, default: false },
  refundIssued: { type: Boolean, default: false },

  aiGenerated: {
    title: { type: Boolean, default: false },
    description: { type: Boolean, default: false },
    tags: { type: Boolean, default: false },
    caption: { type: Boolean, default: false },
    hashtags: { type: Boolean, default: false }
  }
}, { timestamps: true });

VideoSchema.methods.recomputeStatus = function () {
  const statuses = this.platforms.map((p) => p.status);
  if (statuses.length === 0) { this.status = 'draft'; return; }
  if (statuses.every((s) => s === 'uploaded')) { this.status = 'uploaded'; return; }
  if (statuses.every((s) => s === 'failed')) { this.status = 'failed'; return; }
  if (statuses.some((s) => s === 'processing' || s === 'queued' || s === 'pending')) { this.status = 'queued'; return; }
  this.status = 'partially_uploaded';
};

module.exports = mongoose.model('Video', VideoSchema);
