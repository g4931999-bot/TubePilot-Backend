const express = require('express');
const { protect } = require('../middleware/auth');
const Transaction = require('../models/Transaction');

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

module.exports = router;
