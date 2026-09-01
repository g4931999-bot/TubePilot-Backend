const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const YouTubeChannelSchema = new mongoose.Schema({
  channelId: String,
  channelTitle: String,
  thumbnail: String,
  subscriberCount: String,
  accessToken: String,
  refreshToken: String,
  tokenExpiryDate: Number,
  connectedAt: { type: Date, default: Date.now }
}, { _id: false });

const ConnectedDriveSchema = new mongoose.Schema({
  email: String,
  displayName: String,
  accessToken: String,
  refreshToken: String,
  tokenExpiryDate: Number,
  folderId: { type: String, default: null },
  folderName: { type: String, default: null },
  dailyUploadTime: { type: String, default: null },
  uploadMode: { type: String, enum: ['scheduled', 'live'], default: 'scheduled' },
  lastAutoUploadDate: { type: String, default: null },
  driveProcessedFileIds: [{ type: String }],
  noNewVideoSinceDate: { type: String, default: null },
  connectedAt: { type: Date, default: Date.now }
}, { _id: false });

const ConnectedFacebookSchema = new mongoose.Schema({
  pageId: String,
  pageName: String,
  pageAccessToken: String,
  connectedAt: { type: Date, default: Date.now }
}, { _id: false });

const ConnectedInstagramSchema = new mongoose.Schema({
  igUserId: String,
  igUsername: String,
  igProfilePicture: String,
  linkedPageId: String,
  connectedAt: { type: Date, default: Date.now }
}, { _id: false });

// Temporary holding area for a user's Facebook Pages when they have more
// than one linked to their account, until they pick which one to connect
// via PATCH /api/meta/select-page. NOTE: this field MUST be declared here —
// Mongoose is strict by default, so calling user.set('metaPendingPages', ...)
// on an undeclared path is silently dropped (never persisted), which used
// to make multi-page selection always fail with "Page not found".
const MetaPendingPageSchema = new mongoose.Schema({
  id: String,
  name: String,
  access_token: String,
  instagram: {
    id: { type: String, default: null },
    username: { type: String, default: null },
    profilePicture: { type: String, default: null }
  }
}, { _id: false });

const UserSchema = new mongoose.Schema({
  userId: { type: String, unique: true, index: true },
  name: { type: String, default: '' },
  username: { type: String, unique: true, sparse: true },
  email: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
  phone: { type: String, unique: true, sparse: true },
  password: { type: String, select: false },
  authProvider: { type: String, enum: ['local', 'google', 'phone'], default: 'local' },
  googleId: { type: String, sparse: true },
  avatar: { type: String, default: '' },
  language: { type: String, default: 'English' },
  referralCode: { type: String, unique: true, sparse: true },
  referredBy: { type: String, default: null },
  diamondBalance: { type: Number, default: 0 },
  autoRefillDiamonds: { type: Boolean, default: false },
  freeUploadsRemaining: { type: Number, default: 20 }, // 20 Free Upload Credits
  freeUploadsResetAt: { type: Date, default: () => new Date(new Date().setMonth(new Date().getMonth() + 1)) },
  storageUsedBytes: { type: Number, default: 0 },
  fcmTokens: [{ type: String }],
  oneSignalPlayerIds: [{ type: String }],
  youtubeChannel: { type: YouTubeChannelSchema, default: null },
  connectedDrive: { type: ConnectedDriveSchema, default: null },
  driveConnectCount: { type: Number, default: 0 },
  connectedFacebook: { type: ConnectedFacebookSchema, default: null },
  connectedInstagram: { type: ConnectedInstagramSchema, default: null },
  metaPendingPages: { type: [MetaPendingPageSchema], default: undefined },
  subscription: {
    isActive: { type: Boolean, default: false },
    plan: { type: String, default: null },
    expiresAt: { type: Date, default: null }
  },
  refreshTokens: [{ type: String }],
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

UserSchema.pre('save', async function (next) {
  if (!this.isModified('password') || !this.password) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

UserSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

UserSchema.methods.toSafeObject = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.refreshTokens;
  if (obj.youtubeChannel) {
    delete obj.youtubeChannel.accessToken;
    delete obj.youtubeChannel.refreshToken;
  }
  if (obj.connectedDrive) {
    delete obj.connectedDrive.accessToken;
    delete obj.connectedDrive.refreshToken;
    delete obj.connectedDrive.driveProcessedFileIds;
  }
  if (obj.connectedFacebook) {
    delete obj.connectedFacebook.pageAccessToken;
  }
  delete obj.metaPendingPages;
  return obj;
};

module.exports = mongoose.model('User', UserSchema);
