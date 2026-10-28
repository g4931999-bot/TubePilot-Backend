const crypto = require('crypto');
const axios = require('axios');

const PAYU_KEY = (process.env.PAYU_KEY || '').trim();
const PAYU_SALT = (process.env.PAYU_SALT || '').trim();
const RAW_ENV = (process.env.PAYU_ENV || 'PRODUCTION').trim().toUpperCase();
const IS_PROD = RAW_ENV === 'PRODUCTION' || RAW_ENV === 'PROD';
const isConfigured = !!(PAYU_KEY && PAYU_SALT);
const APP_BASE = (process.env.APP_BASE_URL || process.env.PUBLIC_BACKEND_URL || '').trim().replace(/\/+$/, '');

const VERIFY_URL = IS_PROD
  ? 'https://info.payu.in/merchant/postservice?form=2'
  : 'https://test.payu.in/merchant/postservice?form=2';

console.log(`ℹ️  [PayU] env=${IS_PROD ? 'PRODUCTION' : 'TEST'}, configured=${isConfigured}, base=${APP_BASE || '(NOT SET)'}`);

const sha512 = (s) => crypto.createHash('sha512').update(s).digest('hex');

// Hash for the Flutter SDK (payment hash + lookup hashes)
const generateHash = ({ hashString, hashType, postSalt }) => {
  if (String(hashType || '').toUpperCase() === 'V2') {
    return crypto.createHmac('sha256', PAYU_SALT).update(hashString).digest('hex');
  }
  return sha512(`${hashString}${PAYU_SALT}${postSalt || ''}`);
};

const clean = (s, max) => String(s || '').replace(/[^A-Za-z0-9 ]/g, '').trim().slice(0, max);

const buildCheckoutParams = ({ txnid, amount, productinfo, user, userIdentifier }) => {
  if (!isConfigured) {
    const err = new Error('PayU credentials (PAYU_KEY / PAYU_SALT) are missing in environment variables.');
    err.code = 'PAYU_NOT_CONFIGURED';
    throw err;
  }
  if (!APP_BASE.startsWith('https://')) {
    throw new Error('APP_BASE_URL must be a real https URL for PayU success/failure callbacks.');
  }
  const phoneDigits = String(user.phone || '').replace(/\D/g, '');
  const result = `${APP_BASE}/api/payment/payu/result`;
  return {
    key: PAYU_KEY,
    txnid,
    amount: Number(amount).toFixed(2),
    productinfo,
    firstname: clean(user.name, 40) || 'TubePilot',
    email: (user.email && user.email.includes('@')) ? user.email : `user_${userIdentifier}@tubepilot.app`,
    phone: phoneDigits.length >= 10 ? phoneDigits.slice(-10) : '9999999999',
    surl: result,
    furl: result,
    environment: IS_PROD ? '0' : '1',
    userId: clean(userIdentifier, 30) || 'user'
  };
};

// Server-to-server truth check. Returns PayU's transaction record or null.
const verifyPayment = async (txnid) => {
  if (!isConfigured) throw new Error('PayU credentials are missing.');
  const command = 'verify_payment';
  const hash = sha512(`${PAYU_KEY}|${command}|${txnid}|${PAYU_SALT}`);
  const body = new URLSearchParams({ key: PAYU_KEY, command, var1: txnid, hash });
  const res = await axios.post(VERIFY_URL, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 20000
  });
  return res.data?.transaction_details?.[txnid] || null;
};

module.exports = { isConfigured, PAYU_KEY, IS_PROD, generateHash, buildCheckoutParams, verifyPayment };
