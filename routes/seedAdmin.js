const express = require('express');
const User = require('../models/User');
const PaymentSettings = require('../models/PaymentSettings');
const { generateUserId, generateReferralCode } = require('../utils/idGenerator');

const router = express.Router();

// @route GET /api/seed-admin?key=YOUR_SEED_SECRET
// Optional: &resetPassword=true -> also resets the existing admin's password
// to the CURRENT value of ADMIN_PASSWORD (use this if login keeps failing
// even though "Admin already exists" is returned — it means the account
// was created earlier with a different password than what's set now).
//
// One-time setup route: creates the admin user + default payment settings
// directly inside whatever database this deployed instance is connected to.
// Protected by SEED_SECRET so random visitors can't trigger it.
router.get('/', async (req, res) => {
  try {
    if (!process.env.SEED_SECRET) {
      return res.status(500).json({ success: false, message: 'SEED_SECRET is not set in environment variables' });
    }
    if (req.query.key !== process.env.SEED_SECRET) {
      return res.status(403).json({ success: false, message: 'Invalid or missing key' });
    }

    const log = [];
    const adminEmail = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();

    let admin = await User.findOne({ email: adminEmail });
    if (!admin) {
      const userId = await generateUserId();
      const referralCode = await generateReferralCode(userId);
      admin = await User.create({
        userId,
        name: 'Admin',
        email: adminEmail,
        password: process.env.ADMIN_PASSWORD,
        authProvider: 'local',
        role: 'admin',
        referralCode,
        freeUploadsRemaining: 0
      });
      log.push(`Admin created: ${adminEmail}`);
    } else {
      log.push(`Admin already exists: ${admin.email} (role: ${admin.role})`);

      if (admin.role !== 'admin') {
        admin.role = 'admin';
        await admin.save();
        log.push('Fixed: role was not "admin" — updated it now');
      }

      if (req.query.resetPassword === 'true') {
        admin.password = process.env.ADMIN_PASSWORD; // pre-save hook re-hashes this
        await admin.save();
        log.push('Password reset to current ADMIN_PASSWORD value');
      }
    }

    let settings = await PaymentSettings.findOne();
    if (!settings) {
      settings = await PaymentSettings.create({
        upiId: 'tubepilot@upi',
        accountName: 'TubePilot',
        merchantName: 'TubePilot',
        qrImageUrl: ''
      });
      log.push('Default payment settings created (update UPI ID/QR from Admin Panel)');
    } else {
      log.push('Payment settings already exist — no changes made');
    }

    res.json({ success: true, log });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
