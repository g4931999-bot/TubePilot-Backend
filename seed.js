// Run once: node seed.js
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/User');
const PaymentSettings = require('./models/PaymentSettings');
const { generateUserId, generateReferralCode } = require('./utils/idGenerator');

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const existingAdmin = await User.findOne({ email: process.env.ADMIN_EMAIL });
  if (!existingAdmin) {
    const userId = await generateUserId();
    const referralCode = await generateReferralCode(userId);
    await User.create({
      userId,
      name: 'Admin',
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD,
      authProvider: 'local',
      role: 'admin',
      referralCode,
      freeUploadsRemaining: 0
    });
    console.log(`✅ Admin created: ${process.env.ADMIN_EMAIL}`);
  } else {
    console.log('ℹ️ Admin already exists');
  }

  const existingSettings = await PaymentSettings.findOne();
  if (!existingSettings) {
    await PaymentSettings.create({
      upiId: 'tubepilot@upi',
      accountName: 'TubePilot',
      merchantName: 'TubePilot',
      qrImageUrl: ''
    });
    console.log('✅ Default payment settings created (update UPI ID/QR from Admin Panel)');
  }

  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
