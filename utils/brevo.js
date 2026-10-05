const axios = require('axios');

// Two Brevo accounts: key 1 is tried first; if it fails (quota, auth, network),
// key 2 is tried automatically.
const getKeys = () => [process.env.BREVO_API_KEY_1, process.env.BREVO_API_KEY_2].filter(Boolean);

const sendBrevoEmail = async ({ to, toName, subject, html }) => {
  const keys = getKeys();
  if (!keys.length) throw new Error('No Brevo API key configured');

  let lastErr;
  for (let i = 0; i < keys.length; i++) {
    try {
      await axios.post(
        'https://api.brevo.com/v3/smtp/email',
        {
          sender: {
            name: process.env.BREVO_SENDER_NAME || 'TubePilot',
            email: process.env.BREVO_SENDER_EMAIL
          },
          to: [{ email: to, ...(toName ? { name: toName } : {}) }],
          subject,
          htmlContent: html
        },
        { headers: { 'api-key': keys[i], 'content-type': 'application/json' }, timeout: 15000 }
      );
      return true;
    } catch (err) {
      lastErr = err;
      console.error(`⚠️ [Brevo] account ${i + 1} failed:`, err.response?.data ? JSON.stringify(err.response.data) : err.message);
    }
  }
  throw lastErr;
};

module.exports = { sendBrevoEmail };
