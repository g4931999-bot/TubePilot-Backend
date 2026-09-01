const axios = require('axios');

const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_API_KEY = process.env.ONESIGNAL_API_KEY;
const ONESIGNAL_URL = 'https://onesignal.com/api/v1/notifications';

const isConfigured = !!(ONESIGNAL_APP_ID && ONESIGNAL_API_KEY);
if (!isConfigured) {
  console.warn('⚠️  ONESIGNAL_APP_ID / ONESIGNAL_API_KEY not set — OneSignal alerts are disabled.');
}

// Sends a OneSignal push to every player id saved on the user. Silently
// no-ops if OneSignal isn't configured or the user has no player ids —
// callers never need to check this themselves. This is used ONLY for the
// "your free uploads + diamonds are exhausted" alert; every other push
// notification in the app still goes through utils/push.js (Firebase).
const sendOneSignalToUser = async (user, { title, body, data = {} }) => {
  if (!isConfigured || !user?.oneSignalPlayerIds?.length) return;
  try {
    await axios.post(
      ONESIGNAL_URL,
      {
        app_id: ONESIGNAL_APP_ID,
        include_player_ids: user.oneSignalPlayerIds,
        headings: { en: title },
        contents: { en: body },
        data
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${ONESIGNAL_API_KEY}`
        }
      }
    );
  } catch (err) {
    console.error(`OneSignal notification failed for user ${user._id}:`, err.response?.data || err.message);
  }
};

module.exports = { sendOneSignalToUser };
