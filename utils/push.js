const admin = require('firebase-admin');

let initialized = false;

const initFirebase = () => {
  if (initialized) return;
  try {
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64
      ? Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf-8')
      : null;

    if (!serviceAccountJson) {
      console.warn('⚠️  FIREBASE_SERVICE_ACCOUNT_BASE64 not set — push notifications are disabled.');
      return;
    }

    const serviceAccount = JSON.parse(serviceAccountJson);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    initialized = true;
    console.log('✅ Firebase Admin (push notifications) initialized');
  } catch (err) {
    console.error('❌ Firebase Admin init failed:', err.message);
  }
};

initFirebase();

// Sends a push notification to every device token saved on the user.
// Silently no-ops if Firebase isn't configured or the user has no tokens —
// callers never need to check this themselves.
const sendPushToUser = async (user, { title, body, data = {} }) => {
  if (!initialized || !user?.fcmTokens?.length) return;

  const tokens = user.fcmTokens;
  try {
    const response = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      android: { priority: 'high', notification: { channelId: 'tubepilot_default' } }
    });

    // Clean up tokens that are no longer valid (app uninstalled, token rotated, etc.)
    const invalidTokens = [];
    response.responses.forEach((res, i) => {
      if (!res.success && ['messaging/invalid-registration-token', 'messaging/registration-token-not-registered'].includes(res.error?.code)) {
        invalidTokens.push(tokens[i]);
      }
    });
    if (invalidTokens.length) {
      user.fcmTokens = user.fcmTokens.filter((t) => !invalidTokens.includes(t));
      await user.save();
    }
  } catch (err) {
    console.error(`Push notification failed for user ${user._id}:`, err.message);
  }
};

module.exports = { sendPushToUser };
