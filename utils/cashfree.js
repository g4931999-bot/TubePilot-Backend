const axios = require('axios');

// UPDATE18: CASHFREE_ENV is normalised to exactly 'PRODUCTION' or 'SANDBOX'
// (accepts PROD / PRODUCTION / SANDBOX / TEST, any case). The SAME normalised
// value is what the Flutter SDK is told to use, so the order (server) and the
// checkout (app) can never end up in different environments - that mismatch
// makes the checkout open and close instantly.
const RAW_ENV = (process.env.CASHFREE_ENV || 'PRODUCTION').trim().toUpperCase();
const IS_PROD = RAW_ENV === 'PRODUCTION' || RAW_ENV === 'PROD';
const CASHFREE_ENV = IS_PROD ? 'PRODUCTION' : 'SANDBOX';
const CASHFREE_APP_ID = (process.env.CASHFREE_APP_ID || '').trim();
const CASHFREE_SECRET_KEY = (process.env.CASHFREE_SECRET_KEY || '').trim();
const CASHFREE_API_VERSION = '2023-08-01';

const BASE_URL = IS_PROD ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';

const isConfigured = !!(CASHFREE_APP_ID && CASHFREE_SECRET_KEY);

// UPDATE18: return_url must be a real https URL of YOUR backend. It now falls back
// to PUBLIC_BACKEND_URL (already used in server.js) before giving up.
const APP_BASE_URL = (process.env.APP_BASE_URL || process.env.PUBLIC_BACKEND_URL || '').trim().replace(/\/+$/, '');

console.log(`ℹ️  [Cashfree] environment=${CASHFREE_ENV}, base=${BASE_URL}, configured=${isConfigured}, return_url base=${APP_BASE_URL || '(NOT SET)'}`);
if (!APP_BASE_URL) {
  console.warn('⚠️ [Cashfree] APP_BASE_URL (or PUBLIC_BACKEND_URL) is not set. Set it to your real https backend URL, e.g. APP_BASE_URL=https://your-backend.onrender.com');
}
if (IS_PROD && CASHFREE_APP_ID.toUpperCase().startsWith('TEST')) {
  console.warn('⚠️ [Cashfree] CASHFREE_ENV is PRODUCTION but the App ID looks like a TEST (sandbox) key - checkout will fail.');
}
if (!IS_PROD && CASHFREE_SECRET_KEY && !CASHFREE_SECRET_KEY.toLowerCase().includes('test')) {
  console.warn('⚠️ [Cashfree] CASHFREE_ENV is SANDBOX but the secret key does not look like a TEST key - checkout will fail.');
}

const cashfreeHeaders = () => ({
  'x-client-id': CASHFREE_APP_ID,
  'x-client-secret': CASHFREE_SECRET_KEY,
  'x-api-version': CASHFREE_API_VERSION,
  'Content-Type': 'application/json'
});

const formatPhoneNumber = (phoneStr) => {
  if (!phoneStr) return '9999999999';
  const cleaned = String(phoneStr).replace(/\D/g, '');
  if (cleaned.length >= 10) return cleaned.slice(-10);
  return '9999999999';
};

// Cashfree customer_id may only contain letters, numbers, _ and -.
const safeCustomerId = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 50) || 'user';

const createCashfreeOrder = async ({ orderId, amount, customerId, customerPhone, customerEmail, customerName, returnUrl }) => {
  if (!isConfigured) {
    const err = new Error('Cashfree credentials (CASHFREE_APP_ID / CASHFREE_SECRET_KEY) are missing in environment variables.');
    err.code = 'CASHFREE_NOT_CONFIGURED';
    throw err;
  }

  const body = {
    order_id: orderId,
    order_amount: Number(amount),
    order_currency: 'INR',
    customer_details: {
      customer_id: safeCustomerId(customerId),
      customer_phone: formatPhoneNumber(customerPhone),
      customer_email: (customerEmail && customerEmail.includes('@')) ? customerEmail : `user_${safeCustomerId(customerId)}@tubepilot.app`,
      customer_name: customerName || 'TubePilot User'
    }
  };
  // Only send a return_url when we really have our own https URL (an invalid
  // placeholder is worse than none for the native SDK flow).
  const appReturnUrl = returnUrl || (APP_BASE_URL.startsWith('https://') ? `${APP_BASE_URL}/api/payment/verify?order_id={order_id}` : '');
  if (appReturnUrl) body.order_meta = { return_url: appReturnUrl };

  const res = await axios.post(`${BASE_URL}/orders`, body, { headers: cashfreeHeaders() });

  if (!res.data || !res.data.payment_session_id) {
    throw new Error('Cashfree did not return a payment_session_id');
  }
  return {
    orderId: res.data.order_id,
    paymentSessionId: String(res.data.payment_session_id).trim(),
    cfOrderId: res.data.cf_order_id
  };
};

const getCashfreeOrderStatus = async (orderId) => {
  if (!isConfigured) {
    throw new Error('Cashfree credentials are missing in environment variables.');
  }
  const res = await axios.get(`${BASE_URL}/orders/${orderId}`, { headers: cashfreeHeaders() });
  return res.data;
};

module.exports = { createCashfreeOrder, getCashfreeOrderStatus, isConfigured, CASHFREE_ENV };
