const Video = require('../models/Video');
const Transaction = require('../models/Transaction');
const Notification = require('../models/Notification');
const { deleteManyFromCloudinary } = require('./cloudinary');

/**
 * Fully and permanently deletes a user account and everything tied to it.
 * Shared by:
 *   - routes/admin.js  (admin deleting another user's account)
 *   - routes/auth.js   (a user deleting their own account, for Google Play
 *     account-deletion compliance)
 *
 * Kept in ONE place on purpose — this used to be duplicated logic in
 * admin.js and would have needed to be duplicated again for self-delete.
 * Two copies of destructive cascade-delete logic is exactly the kind of
 * thing that quietly drifts out of sync (e.g. someone fixes a field-name
 * bug in one copy and forgets the other), so from here on both routes call
 * this one function.
 *
 * What gets deleted:
 *   1. Every Cloudinary file the user ever uploaded (across both
 *      cloudinary_1 / cloudinary_2 accounts).
 *   2. Google Drive is DISCONNECTED (connectedDrive cleared) — NOT deleted.
 *      We only ever requested drive.readonly scope (see routes/drive.js),
 *      so we have no permission to delete files from the user's own Drive,
 *      and shouldn't even if we technically could — it's their storage,
 *      not ours.
 *   3. All Video, Transaction, and Notification documents for the user.
 *   4. The User document itself.
 *
 * This is irreversible. There is no soft-delete / recovery path. If the
 * person signs up again later (same email/phone/Google account), they get
 * a completely fresh account — new userId, new referralCode, 0 diamonds,
 * default freeUploadsRemaining — because none of the old data still exists.
 *
 * IMPORTANT — field names this relies on: Video.user (ObjectId ref to
 * User) plus Video.storageFileId and Video.storageProvider
 * ('cloudinary_1' | 'cloudinary_2' | 'google_drive' | 'direct_url'). If the
 * Video schema's field names ever change, update the `Video.find(...)`
 * query and the `.filter()/.map()` below to match — getting this wrong
 * silently deletes 0 Cloudinary files while still deleting the Video docs
 * (or, worse, silently fails to delete the Video docs at all), leaving
 * orphaned data with no easy way to find it again later.
 *
 * @param {import('mongoose').Document} user - a fetched User document (not just an id)
 * @returns {Promise<{ label: string, cloudinaryCleanup: { attempted: number, deleted: number, failed: Array } }>}
 */
const deleteUserAccountCascade = async (user) => {
  const label = user.username || user.email || user.userId;

  // 1. Delete every Cloudinary file this user ever uploaded, BEFORE the
  // Video docs (which hold the storage pointers) are removed. Only videos
  // actually stored on Cloudinary (storageProvider cloudinary_1/cloudinary_2)
  // are relevant here — Drive-stored and direct-url videos have nothing to
  // clean up on Cloudinary.
  const videos = await Video.find({ user: user._id }, 'storageProvider storageFileId');
  const cloudinaryEntries = videos
    .filter((v) => v.storageFileId && ['cloudinary_1', 'cloudinary_2'].includes(v.storageProvider))
    .map((v) => ({ publicId: v.storageFileId, cloudinaryAccount: v.storageProvider }));

  let cloudinaryCleanup = { attempted: 0, deleted: 0, failed: [] };
  if (cloudinaryEntries.length) {
    cloudinaryCleanup = await deleteManyFromCloudinary(cloudinaryEntries);
  }

  // 2. Disconnect Google Drive (does not touch the user's own Drive files).
  user.connectedDrive = null;

  // 3 & 4. Wipe DB records, then the user doc itself.
  await Promise.all([
    Video.deleteMany({ user: user._id }),
    Transaction.deleteMany({ user: user._id }),
    Notification.deleteMany({ user: user._id })
  ]);

  await user.constructor.findByIdAndDelete(user._id);

  return { label, cloudinaryCleanup };
};

module.exports = { deleteUserAccountCascade };
