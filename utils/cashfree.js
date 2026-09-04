const axios = require('axios');

// Default set to PRODUCTION (fallback to process.env if provided)
const CASHFREE_ENV = (process.env.CASHFREE_ENV || 'PRODUCTION').toUpperCase();
const IS_PROD = CASHFREE_ENV === 'PRODUCTION' || CASHFREE_ENV === 'PROD';
const CASHFREE_APP_ID = process.env.CASHFREE_APP_ID;
const CASHFREE_SECRET_KEY = process.env.CASHFREE_SECRET_KEY;
const CASHFREE_API_VERSION = '2023-08-01';

// Production PG URL vs Sandbox PG URL
const BASE_URL = IS_PROD
  ? 'https://api.cashfree.com/pg'
  : 'https://sandbox.cashfree.com/pg';

const isConfigured = !!(CASHFREE_APP_ID && CASHFREE_SECRET_KEY);

// ⚠️ FIX: return_url below falls back to a placeholder domain
// ('https://tubepilot.app') if APP_BASE_URL isn't set. That placeholder is
// almost certainly NOT your real deployed backend, so Cashfree's checkout
// would redirect to a domain that doesn't even serve your new GET
// /api/payment/verify route (see routes/diamond.js) — same "checkout
// closes immediately" symptom, just from a different cause. This warns
// loudly at startup instead of failing silently in production.
if (!process.env.APP_BASE_URL) {
  console.warn(
    '⚠️ [Cashfree] APP_BASE_URL is not set in your .env file — payment ' +
    'return_url will fall back to a placeholder domain that is NOT your ' +
    'real backend. Set APP_BASE_URL=https://<your-actual-backend-domain> ' +
    'in .env or the Cashfree checkout may close/error unexpectedly for ' +
    'redirect-based payment methods (UPI collect, netbanking, card 3DS).'
  );
}

const cashfreeHeaders = () => ({
  'x-client-id': CASHFREE_APP_ID,
  'x-client-secret': CASHFREE_SECRET_KEY,
  'x-api-version': CASHFREE_API_VERSION,
  'Content-Type': 'application/json'
});

const formatPhoneNumber = (phoneStr) => {
  if (!phoneStr) return '9999999999';
  const cleaned = phoneStr.replace(/\D/g, '');
  if (cleaned.length >= 10) return cleaned.slice(-10);
  return '9999999999';
};

/**
 * Creates a Cashfree Order for Production
 * @param {Object} params 
 * @param {string} params.orderId
 * @param {number} params.amount
 * @param {string} params.customerId
 * @param {string} [params.customerPhone]
 * @param {string} [params.customerEmail]
 * @param {string} [params.customerName]
 * @param {string} [params.returnUrl] - Production Return URL where customer redirects after payment
 */
const createCashfreeOrder = async ({
  orderId,
  amount,
  customerId,
  customerPhone,
  customerEmail,
  customerName,
  returnUrl
}) => {
  if (!isConfigured) {
    throw new Error('Cashfree production credentials (APP_ID / SECRET_KEY) are missing in environment variables.');
  }

  // Production app redirect URL fallback
  const appReturnUrl = returnUrl || `${process.env.APP_BASE_URL || 'https://tubepilot.app'}/api/payment/verify?order_id={order_id}`;

  const res = await axios.post(
    `${BASE_URL}/orders`,
    {
      order_id: orderId,
      order_amount: amount,
      order_currency: 'INR',
      customer_details: {
        customer_id: customerId,
        customer_phone: formatPhoneNumber(customerPhone),
        customer_email: (customerEmail && customerEmail.includes('@')) ? customerEmail : `user_${customerId}@tubepilot.app`,
        customer_name: customerName || 'TubePilot User'
      },
      order_meta: {
        return_url: appReturnUrl
      }
    },
    { headers: cashfreeHeaders() }
  );

  return {
    orderId: res.data.order_id,
    paymentSessionId: res.data.payment_session_id,
    cfOrderId: res.data.cf_order_id
  };
};

const getCashfreeOrderStatus = async (orderId) => {
  if (!isConfigured) {
    throw new Error('Cashfree production credentials are missing in environment variables.');
  }
  const res = await axios.get(`${BASE_URL}/orders/${orderId}`, { headers: cashfreeHeaders() });
  return res.data;
};

module.exports = { 
  createCashfreeOrder, 
  getCashfreeOrderStatus, 
  isConfigured, 
  CASHFREE_ENV 
};
