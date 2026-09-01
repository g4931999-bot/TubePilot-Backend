const User = require('../models/User');

// Generates a unique user id like TP102458
const generateUserId = async () => {
  let userId;
  let exists = true;
  while (exists) {
    const rand = Math.floor(100000 + Math.random() * 900000);
    userId = `TP${rand}`;
    exists = await User.exists({ userId });
  }
  return userId;
};

// Generates a unique referral code like TP102458REF or short alnum code
const generateReferralCode = async (userId) => {
  let code;
  let exists = true;
  while (exists) {
    const rand = Math.random().toString(36).substring(2, 7).toUpperCase();
    code = `${userId.slice(2)}${rand}`;
    exists = await User.exists({ referralCode: code });
  }
  return code;
};

module.exports = { generateUserId, generateReferralCode };
