const axios = require('axios');

// ENV setup - default PRODUCTION
const CASHFREE_ENV = (process.env.CASHFREE_ENV || 'PRODUCTION').toUpperCase();
const IS_PROD = CASHFREE_ENV === 'PRODUCTION' || CASHFREE_ENV === 'PROD';
const CASHFREE_APP_ID = process.env.CASHFREE_APP_ID;
const CASHFREE_SECRET_KEY = process.env.CASHFREE_SECRET_KEY;
const CASHFREE_API_VERSION = process.env.CASHFREE_API_VERSION || '2023-08-01';
const APP_BASE_URL = (process.env.APP_BASE_URL || 'https://api.tubepilot.shop').replace(/\/$/, '');

const BASE_URL = IS_PROD
  ? 'https://api.cashfree.com/pg'
  : 'https://sandbox.cashfree.com/pg';

const isConfigured = !!(CASHFREE_APP_ID && CASHFREE_SECRET_KEY);

if (!CASHFREE_APP_ID || !CASHFREE_SECRET_KEY) {
  console.warn('⚠️ [Cashfree] CASHFREE_APP_ID / SECRET_KEY missing in .env');
}

if (!process.env.APP_BASE_URL) {
  console.warn(
    '⚠️ [Cashfree] APP_BASE_URL not set - using fallback https://api.tubepilot.shop. Set APP_BASE_URL in .env'
  );
}

console.log(`💳 [Cashfree] ENV=${CASHFREE_ENV} | Base=${BASE_URL} | Configured=${isConfigured} | ReturnBase=${APP_BASE_URL}`);

const cashfreeHeaders = () => ({
  'x-client-id': CASHFREE_APP_ID,
  'x-client-secret': CASHFREE_SECRET_KEY,
  'x-api-version': CASHFREE_API_VERSION,
  'Content-Type': 'application/json'
});

const formatPhoneNumber = (phoneStr) => {
  if (!phoneStr) return '9999999999';
  const cleaned = String(phoneStr).replace(/\D/g, '');
  if (cleaned.length === 10) return cleaned;
  if (cleaned.length > 10) return cleaned.slice(-10);
  // If less than 10 digits, fallback to dummy but valid number
  return '9999999999';
};

// Sanitize order_id - Cashfree only allows alphanumeric, underscore, hyphen, max 40 chars
const sanitizeOrderId = (orderId) => {
  let clean = String(orderId).replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 40);
  if (clean.length < 4) clean = `TP${Date.now()}`;
  return clean;
};

const sanitizeCustomerId = (id) => {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50) || `user_${Date.now()}`;
};

/**
 * Creates a Cashfree Order - PRODUCTION READY
 * Docs: https://www.cashfree.com/docs/api-reference/payments/previous/v2023-08-01/orders/create.md
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
    const err = new Error('Cashfree credentials missing. Set CASHFREE_APP_ID and CASHFREE_SECRET_KEY in .env');
    err.code = 'CASHFREE_NOT_CONFIGURED';
    throw err;
  }

  const cleanOrderId = sanitizeOrderId(orderId);
  const cleanCustomerId = sanitizeCustomerId(customerId);
  const cleanPhone = formatPhoneNumber(customerPhone);
  const cleanEmail = (customerEmail && String(customerEmail).includes('@') && String(customerEmail).includes('.'))
    ? String(customerEmail).trim().toLowerCase()
    : `user_${cleanCustomerId}@tubepilot.shop`;
  const cleanName = (customerName || 'TubePilot User').substring(0, 100);

  // Amount must be number, >=1, with max 2 decimals
  const cleanAmount = Number(Number(amount).toFixed(2));
  if (isNaN(cleanAmount) || cleanAmount < 1) {
    throw new Error(`Invalid order amount: ${amount}`);
  }

  // ✅ FIXED return_url - points to public page that exists and is whitelisted
  // This is the URL user is redirected to after payment in browser
  const appReturnUrl = returnUrl || `${APP_BASE_URL}/payment/success?order_id={order_id}`;
  
  // notify_url for webhook - Cashfree will POST payment updates here (optional but recommended)
  const notifyUrl = `${APP_BASE_URL}/api/diamonds/webhook`;

  const payload = {
    order_id: cleanOrderId,
    order_amount: cleanAmount,
    order_currency: 'INR',
    customer_details: {
      customer_id: cleanCustomerId,
      customer_phone: cleanPhone,
      customer_email: cleanEmail,
      customer_name: cleanName
    },
    order_meta: {
      return_url: appReturnUrl,
      notify_url: notifyUrl,
      payment_methods: "cc,dc,upi,nb,app,wallet" // All methods allowed
    },
    // Optional: order note for dashboard
    order_note: `TubePilot Diamonds Purchase - ${cleanCustomerId}`
  };

  console.log(`💳 [Cashfree] Creating order: ${cleanOrderId} | Amount: ₹${cleanAmount} | Customer: ${cleanCustomerId}`);

  try {
    const res = await axios.post(`${BASE_URL}/orders`, payload, { 
      headers: cashfreeHeaders(),
      timeout: 15000 // 15 sec timeout
    });

    if (!res.data || !res.data.payment_session_id) {
      console.error('❌ [Cashfree] No payment_session_id in response:', res.data);
      throw new Error('Cashfree did not return payment_session_id');
    }

    console.log(`✅ [Cashfree] Order created - OrderID: ${res.data.order_id} | CF_OrderID: ${res.data.cf_order_id}`);

    return {
      orderId: res.data.order_id,
      paymentSessionId: res.data.payment_session_id,
      cfOrderId: res.data.cf_order_id,
      orderAmount: res.data.order_amount
    };

  } catch (err) {
    const cfError = err.response?.data;
    console.error('❌ [Cashfree] create-order API failed:', {
      orderId: cleanOrderId,
      amount: cleanAmount,
      cfError: cfError || err.message,
      status: err.response?.status
    });

    // Re-throw with proper details for routes/diamond.js to catch
    if (cfError) {
      const error = new Error(cfError.message || 'Cashfree order creation failed');
      error.response = { data: cfError };
      error.statusCode = err.response?.status;
      throw error;
    }
    throw err;
  }
};

/**
 * Get Cashfree Order Status
 * Used for verify-payment poll
 */
const getCashfreeOrderStatus = async (orderId) => {
  if (!isConfigured) {
    throw new Error('Cashfree credentials missing');
  }

  const cleanOrderId = sanitizeOrderId(orderId);

  try {
    const res = await axios.get(`${BASE_URL}/orders/${cleanOrderId}`, { 
      headers: cashfreeHeaders(),
      timeout: 10000
    });
    return res.data; // Contains order_status: PAID, ACTIVE, EXPIRED etc
  } catch (err) {
    console.error(`❌ [Cashfree] get-order-status failed for ${cleanOrderId}:`, err.response?.data || err.message);
    throw err;
  }
};

/**
 * Get payments for an order - more detailed than get order
 */
const getCashfreePaymentsForOrder = async (orderId) => {
  if (!isConfigured) {
    throw new Error('Cashfree credentials missing');
  }
  const cleanOrderId = sanitizeOrderId(orderId);
  try {
    const res = await axios.get(`${BASE_URL}/orders/${cleanOrderId}/payments`, {
      headers: cashfreeHeaders(),
      timeout: 10000
    });
    return res.data;
  } catch (err) {
    console.error(`❌ [Cashfree] get-payments failed for ${cleanOrderId}:`, err.response?.data || err.message);
    throw err;
  }
};

module.exports = { 
  createCashfreeOrder, 
  getCashfreeOrderStatus, 
  getCashfreePaymentsForOrder,
  isConfigured, 
  CASHFREE_ENV,
  BASE_URL
};
