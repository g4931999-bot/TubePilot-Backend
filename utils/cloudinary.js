const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');

const account1 = {
  cloud_name: process.env.CLOUDINARY_1_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_1_API_KEY,
  api_secret: process.env.CLOUDINARY_1_API_SECRET,
  maxBytes: Number(process.env.CLOUDINARY_1_MAX_GB || 25) * 1024 * 1024 * 1024
};
const account2 = {
  cloud_name: process.env.CLOUDINARY_2_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_2_API_KEY,
  api_secret: process.env.CLOUDINARY_2_API_SECRET,
  maxBytes: Number(process.env.CLOUDINARY_2_MAX_GB || 25) * 1024 * 1024 * 1024
};

const getAccountUsage = async (account) => {
  cloudinary.config(account);
  const usage = await cloudinary.api.usage();
  return usage.storage ? usage.storage.usage : 0;
};

const pickAvailableCloudinaryAccount = async (incomingFileBytes) => {
  try {
    const used1 = await getAccountUsage(account1);
    if (used1 + incomingFileBytes < account1.maxBytes) {
      return { key: 'cloudinary_1', account: account1 };
    }
  } catch (err) {
    console.error('Cloudinary account 1 usage check failed:', err.message);
  }
  try {
    const used2 = await getAccountUsage(account2);
    if (used2 + incomingFileBytes < account2.maxBytes) {
      return { key: 'cloudinary_2', account: account2 };
    }
  } catch (err) {
    console.error('Cloudinary account 2 usage check failed:', err.message);
  }
  return null;
};

const uploadBufferToCloudinary = (account, buffer, options = {}) => {
  cloudinary.config(account);
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: 'video', folder: 'tubepilot', ...options },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );
    streamifier.createReadStream(buffer).pipe(stream);
  });
};

const deleteFromCloudinary = async (account, publicId) => {
  cloudinary.config(account);
  return cloudinary.uploader.destroy(publicId, { resource_type: 'video' });
};

// Resolves the { key: 'cloudinary_1' | 'cloudinary_2' } string stored on a
// Video doc back to the actual account credentials object. Add more keys
// here if a 3rd account is ever introduced — everything that deletes by
// key (like deleteManyFromCloudinary below) stays correct automatically.
const resolveAccountByKey = (key) => {
  if (key === 'cloudinary_1') return account1;
  if (key === 'cloudinary_2') return account2;
  return null;
};

// Bulk-deletes a list of { publicId, cloudinaryAccount } entries — used by
// the admin "Delete Account" flow to wipe every video a user ever uploaded
// across both Cloudinary accounts before their Video docs are removed from
// Mongo. Runs deletes in parallel per account but never throws: a single
// failed/already-gone file must not block the rest of the cleanup or the
// account deletion itself. Returns a summary so the caller can log/report
// partial failures instead of silently losing track of orphaned files.
const deleteManyFromCloudinary = async (entries = []) => {
  const results = await Promise.allSettled(
    entries
      .filter((e) => e && e.publicId)
      .map(async (e) => {
        const account = resolveAccountByKey(e.cloudinaryAccount) || account1;
        return deleteFromCloudinary(account, e.publicId);
      })
  );

  const failed = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      failed.push({ publicId: entries[i]?.publicId, reason: r.reason?.message || String(r.reason) });
    }
  });

  if (failed.length) {
    console.error(`⚠️  Cloudinary bulk delete: ${failed.length}/${entries.length} file(s) failed to delete:`, failed);
  }

  return { attempted: entries.length, deleted: entries.length - failed.length, failed };
};

module.exports = {
  pickAvailableCloudinaryAccount,
  uploadBufferToCloudinary,
  deleteFromCloudinary,
  deleteManyFromCloudinary,
  account1,
  account2
};
