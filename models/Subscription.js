const mongoose = require('mongoose');

// One document per subscription attempt. 'active' => autopay mandate is registered.
//
// NEW PLAN (credit based, not calendar based):
//   Rs1  now           -> 20 uploads
//   credits hit 0      -> notice to user -> 24h later Rs10 auto-debit -> 30 uploads + 99 diamonds
//   that month starts on the day the credits ran out (cycleAnchor) and lasts 1 month.
const SubscriptionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  status: { type: String, enum: ['pending', 'active', 'cancelled', 'expired', 'failed'], default: 'pending', index: true },

  introAmount: { type: Number, default: 1 },
  planAmount: { type: Number, default: 10 },

  registrationTxnid: { type: String, default: null, index: true },
  // PayU "mihpayid" of the successful Rs1 registration payment = the mandate id for later debits.
  authPayuId: { type: String, default: null },

  firstPaidAt: { type: Date, default: null },

  // The paid Rs10 month: periodStart = day the credits ran out, currentPeriodEnd = +1 month.
  periodStart: { type: Date, default: null },
  currentPeriodEnd: { type: Date, default: null },

  // First moment our job saw this user with 0 upload credits (cleared when credits come back / after a debit).
  creditsZeroSeenAt: { type: Date, default: null },
  // The date the NEXT paid month will start from (set when the notice is sent).
  cycleAnchor: { type: Date, default: null },

  // Kept for the app: = debitOn while a notice is pending, else null.
  nextDebitAt: { type: Date, default: null, index: true },

  preDebitSentAt: { type: Date, default: null },
  debitOn: { type: Date, default: null },
  lastChargeAttemptAt: { type: Date, default: null },
  lastDebitAt: { type: Date, default: null },
  failCount: { type: Number, default: 0 },

  cancelledAt: { type: Date, default: null },
  mandateRevoked: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('Subscription', SubscriptionSchema);
