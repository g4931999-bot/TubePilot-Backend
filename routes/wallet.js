const express = require('express');
const { protect } = require('../middleware/auth');
const Transaction = require('../models/Transaction');
const Video = require('../models/Video');

const router = express.Router();

// @route GET /api/wallet
router.get('/', protect, async (req, res) => {
  try {
    const [pending, approved, rejected] = await Promise.all([
      Transaction.countDocuments({ user: req.user._id, status: 'pending' }),
      Transaction.countDocuments({ user: req.user._id, status: 'approved' }),
      Transaction.countDocuments({ user: req.user._id, status: 'rejected' })
    ]);

    const transactions = await Transaction.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(30);

    res.json({
      success: true,
      wallet: {
        diamondBalance: req.user.diamondBalance,
        freeUploadsRemaining: req.user.freeUploadsRemaining,
        pendingPayments: pending,
        approvedPayments: approved,
        rejectedPayments: rejected,
        transactions
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route GET /api/wallet/refunds?days=30   (UPDATE15 - Wallet & Refund Logs)
// REAL auto-refund history: every upload of this user that failed after retries
// and was refunded (Video.refundIssued === true, set by cron/scheduler.js).
// days = 7 | 30 | 90 (default 30). The refund time is the video's updatedAt
// (the refund is the last write the scheduler makes on it).
router.get('/refunds', protect, async (req, res) => {
  try {
    const days = [7, 30, 90].includes(parseInt(req.query.days, 10)) ? parseInt(req.query.days, 10) : 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const videos = await Video.find({ user: req.user._id, refundIssued: true, updatedAt: { $gte: since } })
      .sort({ updatedAt: -1 })
      .limit(100);

    const refunds = videos.map((v) => {
      const plats = Array.isArray(v.platforms) ? v.platforms : [];
      const failed = plats.find((p) => p.failReason) || plats[0] || {};
      const diamonds = Number(v.diamondsCharged) || 0;
      return {
        id: String(v._id),
        title: v.title || plats.find((p) => p.title)?.title || '',
        platform: failed.platform || '',
        diamondsRefunded: diamonds,
        freeUploadRefunded: diamonds === 0 && !!v.usedFreeUpload,
        reason: failed.failReason || '',
        refundedAt: v.updatedAt
      };
    });

    res.json({
      success: true,
      days,
      totalDiamondsRefunded: refunds.reduce((s, r) => s + r.diamondsRefunded, 0),
      refunds
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
