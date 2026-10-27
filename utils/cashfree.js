const axios = require('axios');

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

console.log(`💳 [Cashfree] ENV=${CASHFREE_ENV} | Base=${BASE_URL} | Configured=${isConfigured}`);

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
  return '9999999999';
};

const sanitizeOrderId = (orderId) => {
  let clean = String(orderId).replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 40);
  if (clean.length < 4) clean = `TP${Date.now()}`;
  return clean;
};

const sanitizeCustomerId = (id) => {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50) || `user_${Date.now()}`;
};

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
    const err = new Error('Cashfree credentials missing');
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
  const cleanAmount = Number(Number(amount).toFixed(2));

  if (isNaN(cleanAmount) || cleanAmount < 1) {
    throw new Error(`Invalid amount: ${amount}`);
  }

  const appReturnUrl = returnUrl || `${APP_BASE_URL}/payment/success?order_id={order_id}`;
  const notifyUrl = `${APP_BASE_URL}/api/diamonds/webhook`;

  // ✅ FIXED - payment_methods field REMOVED completely
  // Cashfree will allow all enabled methods by default if not sent
  // If you want to restrict, use only: cc,dc,upi,nb,app,ccc,ppc,emi,paylater
  // wallet is INVALID - don't use it
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
      notify_url: notifyUrl
      // payment_methods REMOVED - let Cashfree use dashboard config
    },
    order_note: `TubePilot ${cleanAmount} INR - ${cleanCustomerId}`
  };

  console.log(`💳 [Cashfree] Creating: ${cleanOrderId} | ₹${cleanAmount} | ${cleanCustomerId}`);

  try {
    const res = await axios.post(`${BASE_URL}/orders`, payload, { 
      headers: cashfreeHeaders(),
      timeout: 15000
    });

    if (!res.data?.payment_session_id) {
      console.error('❌ No session_id in response:', res.data);
      throw new Error('No payment_session_id');
    }

    console.log(`✅ Order OK: ${res.data.order_id} | CF: ${res.data.cf_order_id}`);

    return {
      orderId: res.data.order_id,
      paymentSessionId: res.data.payment_session_id,
      cfOrderId: res.data.cf_order_id
    };

  } catch (err) {
    const cfError = err.response?.data;
    console.error('❌ Create failed:', {
      orderId: cleanOrderId,
      cfError: cfError || err.message,
      status: err.response?.status
    });
    if (cfError) {
      const e = new Error(cfError.message || 'Cashfree failed');
      e.response = { data: cfError };
      throw e;
    }
    throw err;
  }
};

const getCashfreeOrderStatus = async (orderId) => {
  if (!isConfigured) throw new Error('Cashfree missing');
  const cleanOrderId = sanitizeOrderId(orderId);
  try {
    const res = await axios.get(`${BASE_URL}/orders/${cleanOrderId}`, { 
      headers: cashfreeHeaders(),
      timeout: 10000
    });
    return res.data;
  } catch (err) {
    console.error(`❌ get-status ${cleanOrderId}:`, err.response?.data || err.message);
    throw err;
  }
};

const getCashfreePaymentsForOrder = async (orderId) => {
  if (!isConfigured) throw new Error('Cashfree missing');
  const cleanOrderId = sanitizeOrderId(orderId);
  try {
    const res = await axios.get(`${BASE_URL}/orders/${cleanOrderId}/payments`, {
      headers: cashfreeHeaders(),
      timeout: 10000
    });
    return res.data;
  } catch (err) {
    console.error(`❌ get-payments ${cleanOrderId}:`, err.response?.data || err.message);
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
