const mongoose = require('mongoose');

const PaymentSettingsSchema = new mongoose.Schema({
  upiId: { type: String, default: '' },
  qrImageUrl: { type: String, default: '' },
  accountName: { type: String, default: '' },
  merchantName: { type: String, default: 'TubePilot' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, { timestamps: true });

// Singleton pattern - only one settings doc should ever exist
module.exports = mongoose.model('PaymentSettings', PaymentSettingsSchema);
