const mongoose = require('mongoose');

// One document per subscription attempt. 'active' => autopay mandate is registered.
const SubscriptionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  status: { type: String, enum: ['pending', 'active', 'cancelled', 'expired', 'failed'], default: 'pending', index: true },

  introAmount: { type: Number, default: 1 },
  planAmount: { type: Number, default: 10 },

  registrationTxnid: { type: String, default: null, index: true },
  // PayU "mihpayid" of the successful Rs1 registration payment = the mandate id for later debits.
  authPayuId: { type: String, default: null },

  firstPaidAt: { type: Date, default: null },
  // null during the Rs1 phase. Set to (debit day + 1 month) after every successful Rs10 renewal.
  currentPeriodEnd: { type: Date, default: null },
  nextDebitAt: { type: Date, default: null },   // legacy (UPDATE39), no longer used for scheduling
  renewals: { type: Number, default: 0 },

  preDebitSentAt: { type: Date, default: null },
  debitOn: { type: Date, default: null },
  lastChargeAttemptAt: { type: Date, default: null },
  lastDebitAt: { type: Date, default: null },
  failCount: { type: Number, default: 0 },

  cancelledAt: { type: Date, default: null },
  mandateRevoked: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('Subscription', SubscriptionSchema);
