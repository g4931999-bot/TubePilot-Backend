const axios = require('axios');

const CASHFREE_APP_ID = process.env.CASHFREE_APP_ID;
const CASHFREE_SECRET_KEY = process.env.CASHFREE_SECRET_KEY;
const CASHFREE_ENV = (process.env.CASHFREE_ENV || 'SANDBOX').toUpperCase();
const APP_BASE_URL = (process.env.APP_BASE_URL || 'https://api.tubepilot.shop').replace(/\/$/, '');

const isConfigured = Boolean(CASHFREE_APP_ID && CASHFREE_SECRET_KEY);

const getCashfreeBaseUrl = () => {
  return CASHFREE_ENV === 'PRODUCTION' ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';
};

const cleanOrderId = (id) => String(id).replace(/[^a-zA-Z0-9]/g, '').slice(0, 40);
const cleanCustomerId = (id) => String(id).replace(/[^a-zA-Z0-9@_-]/g, '').slice(0, 50) || 'user_guest';
const cleanPhone = (phone) => {
  if (!phone) return '9999999999';
  const digits = String(phone).replace(/\D/g, '').slice(-10);
  return digits.length === 10 ? digits : '9999999999';
};
const cleanEmail = (email) => {
  if (!email || !String(email).includes('@')) return 'user@tubepilot.shop';
  return String(email).trim().slice(0, 100);
};

const createCashfreeOrder = async ({ orderId, amount, customerId, customerPhone, customerEmail, customerName }) => {
  if (!isConfigured) {
    const err = new Error('Cashfree credentials not configured');
    err.code = 'CASHFREE_NOT_CONFIGURED';
    throw err;
  }

  const finalOrderId = cleanOrderId(orderId);
  const finalCustomerId = cleanCustomerId(customerId);
  const finalPhone = cleanPhone(customerPhone);
  const finalEmail = cleanEmail(customerEmail);
  const finalAmount = Number(amount);

  const returnUrl = `${APP_BASE_URL}/payment/success?order_id={order_id}`;
  const notifyUrl = `${APP_BASE_URL}/api/diamonds/webhook`;

  const payload = {
    order_id: finalOrderId,
    order_amount: finalAmount,
    order_currency: 'INR',
    order_meta: {
      return_url: returnUrl,
      notify_url: notifyUrl
    },
    customer_details: {
      customer_id: finalCustomerId,
      customer_email: finalEmail,
      customer_phone: finalPhone,
      customer_name: (customerName || finalCustomerId).slice(0, 100)
    },
    order_note: `TubePilot ${finalAmount} INR`
  };

  console.log(`💳 [Cashfree] Creating ${finalOrderId} | ₹${finalAmount} | Return: ${returnUrl}`);

  try {
    const response = await axios.post(`${getCashfreeBaseUrl()}/orders`, payload, {
      headers: {
        'x-api-version': '2023-08-01',
        'x-client-id': CASHFREE_APP_ID,
        'x-client-secret': CASHFREE_SECRET_KEY,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });
    const data = response.data;
    console.log(`✅ Order OK: ${data.order_id} | CF: ${data.cf_order_id}`);
    return {
      orderId: data.order_id,
      cfOrderId: data.cf_order_id,
      paymentSessionId: data.payment_session_id,
      orderStatus: data.order_status
    };
  } catch (err) {
    const cfData = err.response?.data;
    console.error('❌ Create failed:', cfData || err.message);
    throw err;
  }
};

const getCashfreeOrderStatus = async (orderId) => {
  if (!isConfigured) throw new Error('Cashfree not configured');
  const finalOrderId = cleanOrderId(orderId);
  try {
    const response = await axios.get(`${getCashfreeBaseUrl()}/orders/${finalOrderId}`, {
      headers: {
        'x-api-version': '2023-08-01',
        'x-client-id': CASHFREE_APP_ID,
        'x-client-secret': CASHFREE_SECRET_KEY
      },
      timeout: 10000
    });
    return response.data;
  } catch (err) {
    console.error(`❌ get-status ${finalOrderId} failed:`, err.response?.data || err.message);
    throw err;
  }
};

module.exports = { createCashfreeOrder, getCashfreeOrderStatus, isConfigured, CASHFREE_ENV };
