const express = require('express');
const { protect } = require('../middleware/auth');
const Notification = require('../models/Notification');
const router = express.Router();

// @route GET /api/notifications
router.get('/', protect, async (req, res) => {
  const notifications = await Notification.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(50);
  const unreadCount = await Notification.countDocuments({ user: req.user._id, isRead: false });
  res.json({ success: true, notifications, unreadCount });
});

// @route PATCH /api/notifications/:id/read
router.patch('/:id/read', protect, async (req, res) => {
  const notification = await Notification.findOneAndUpdate(
    { _id: req.params.id, user: req.user._id },
    { isRead: true },
    { new: true }
  );
  if (!notification) return res.status(404).json({ success: false, message: 'Notification not found' });
  res.json({ success: true, notification });
});

// @route PATCH /api/notifications/read-all
router.patch('/read-all', protect, async (req, res) => {
  await Notification.updateMany({ user: req.user._id, isRead: false }, { isRead: true });
  res.json({ success: true, message: 'All notifications marked as read' });
});

// @route POST /api/notifications/register-device  { fcmToken }
// Called by the Flutter app after login so the backend can push real
// phone notifications (upload completed, payment approved, etc.)
router.post('/register-device', protect, async (req, res) => {
  const { fcmToken } = req.body;
  if (!fcmToken) return res.status(400).json({ success: false, message: 'fcmToken is required' });
  if (!req.user.fcmTokens.includes(fcmToken)) {
    req.user.fcmTokens.push(fcmToken);
    await req.user.save();
  }
  res.json({ success: true, message: 'Device registered for push notifications' });
});

// @route POST /api/notifications/register-onesignal-player  { playerId }
// Called by the Flutter app (OneSignal SDK) once it has a player/subscription
// id, so the backend can send OneSignal alerts. This is used ONLY for the
// "your free uploads + diamonds are exhausted, please buy more" alert (see
// utils/oneSignalPush.js -> sendOneSignalToUser). Kept completely separate
// from register-device (Firebase/FCM) above, which handles every other push.
router.post('/register-onesignal-player', protect, async (req, res) => {
  const { playerId } = req.body;
  if (!playerId) return res.status(400).json({ success: false, message: 'playerId is required' });
  if (!req.user.oneSignalPlayerIds.includes(playerId)) {
    req.user.oneSignalPlayerIds.push(playerId);
    await req.user.save();
  }
  res.json({ success: true, message: 'Device registered for OneSignal alerts' });
});

// Add these two routes to backend/routes/notifications.js if they don't
// already exist there. Assumes a Notification model with a `user` field
// referencing the owning user (matches the pattern used by other routes
// like GET /notifications and PATCH /notifications/:id/read).

// @route DELETE /api/notifications/:id
// Deletes a single notification belonging to the current user.
router.delete('/:id', protect, async (req, res) => {
  try {
    const notification = await Notification.findOneAndDelete({
      _id: req.params.id,
      user: req.user._id, // ensures a user can only delete their own notifications
    });
    if (!notification) {
      return res.status(404).json({ success: false, message: 'Notification not found' });
    }
    res.json({ success: true, message: 'Notification deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route DELETE /api/notifications
// Deletes ALL notifications belonging to the current user.
router.delete('/', protect, async (req, res) => {
  try {
    await Notification.deleteMany({ user: req.user._id });
    res.json({ success: true, message: 'All notifications deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
