// utils/imagekit.js
//
// Live-streaming section ke liye video upload — ImageKit ke 2 accounts
// use karte hain (jaise cloudinary.js mein 2 accounts hain video/image
// upload ke liye). Jab Account 1 ka free-tier limit (bandwidth/storage)
// khatam ho jaye, Account 2 automatically use hone lagega.
//
// ⚠️ .env mein ye 6 variables chahiye:
//   IMAGEKIT_1_PUBLIC_KEY, IMAGEKIT_1_PRIVATE_KEY, IMAGEKIT_1_URL_ENDPOINT
//   IMAGEKIT_2_PUBLIC_KEY, IMAGEKIT_2_PRIVATE_KEY, IMAGEKIT_2_URL_ENDPOINT

const ImageKit = require('imagekit');

const account1 = new ImageKit({
  publicKey: process.env.IMAGEKIT_1_PUBLIC_KEY,
  privateKey: process.env.IMAGEKIT_1_PRIVATE_KEY,
  urlEndpoint: process.env.IMAGEKIT_1_URL_ENDPOINT
});

const account2 = new ImageKit({
  publicKey: process.env.IMAGEKIT_2_PUBLIC_KEY,
  privateKey: process.env.IMAGEKIT_2_PRIVATE_KEY,
  urlEndpoint: process.env.IMAGEKIT_2_URL_ENDPOINT
});

// ImageKit Forever-Free tier: 20GB bandwidth/month, 3GB storage (fixed).
// Hum sirf STORAGE track karte hain apne DB mein (per-account running
// total) — bandwidth ImageKit khud track karta hai unki side par, hum
// usse seedha nahi padh sakte real-time mein, isliye storage hi hamara
// "kaunsa account use karein" ka decision factor hai.
const ACCOUNT_STORAGE_LIMIT_BYTES = 3 * 1024 * 1024 * 1024; // 3GB free tier

// In-memory running totals — server restart hone par reset ho jayenge.
// Production mein isse DB field mein persist karna better hoga
// (jaise: SystemSettings.imagekitAccount1UsedBytes), abhi ke liye simple.
let account1UsedBytes = 0;
let account2UsedBytes = 0;

/**
 * Konsa account use karna hai decide karta hai — jisme jagah bachi ho.
 * @param {number} fileSizeBytes
 * @returns {{ account: ImageKit, accountLabel: 'imagekit_1' | 'imagekit_2' } | null}
 */
function pickAvailableImageKitAccount(fileSizeBytes) {
  if (account1UsedBytes + fileSizeBytes <= ACCOUNT_STORAGE_LIMIT_BYTES) {
    return { account: account1, accountLabel: 'imagekit_1' };
  }
  if (account2UsedBytes + fileSizeBytes <= ACCOUNT_STORAGE_LIMIT_BYTES) {
    return { account: account2, accountLabel: 'imagekit_2' };
  }
  return null; // Dono accounts full — naya 3rd account banane ka time aa gaya
}

/**
 * Buffer ko ImageKit par upload karta hai.
 * @param {ImageKit} account
 * @param {Buffer} buffer
 * @param {string} fileName
 * @returns {Promise<{url: string, fileId: string}>}
 */
async function uploadBufferToImageKit(account, buffer, fileName) {
  const result = await account.upload({
    file: buffer,
    fileName,
    folder: '/tubepilot-live-videos',
    useUniqueFileName: true
  });

  // Running total update — accountLabel ke hisaab se bahar (caller) update karega
  return { url: result.url, fileId: result.fileId };
}

function recordUsage(accountLabel, bytes) {
  if (accountLabel === 'imagekit_1') account1UsedBytes += bytes;
  else if (accountLabel === 'imagekit_2') account2UsedBytes += bytes;
}

async function deleteFromImageKit(account, fileId) {
  try {
    await account.deleteFile(fileId);
  } catch (err) {
    console.error('❌ [ImageKit] Delete failed:', err.message);
  }
}

module.exports = {
  account1,
  account2,
  pickAvailableImageKitAccount,
  uploadBufferToImageKit,
  recordUsage,
  deleteFromImageKit
};
