const mongoose = require('mongoose');

const NotificationSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: {
    type: String,
    enum: [
      'payment_approved', 'payment_rejected', 'upload_completed', 'upload_failed',
      'schedule_started', 'schedule_finished', 'subscription_expiring', 'free_upload_reset'
    ],
    required: true
  },
  title: { type: String, required: true },
  message: { type: String, default: '' },
  isRead: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('Notification', NotificationSchema);
