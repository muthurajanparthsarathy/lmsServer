const express = require('express');
const router = express.Router();
const { getUserNotifications, markNotificationAsRead, markAllNotificationsAsRead, deleteNotification, deleteAllNotifications, getNotificationCount, toggleFavoriteNotification } = require('../controllers/notifications');
const { userAuth } = require('../middlewares/userAuth');

// Get user notifications
router.get('/get/notifications',userAuth,  getUserNotifications);

// Get notification count (unread)
router.get('/notifications/count',userAuth,  getNotificationCount);

// Mark notification as read
router.put('/notifications/:notificationId/read', userAuth, markNotificationAsRead);

// Mark all notifications as read
router.put('/notifications/read-all',userAuth,  markAllNotificationsAsRead);

// Delete notification
router.delete('/delete-one/notifications/:notificationId',userAuth,  deleteNotification);

// Delete all notifications
router.delete('/delete-all/notifications',userAuth,  deleteAllNotifications);

router.put('/favorite/notifications/:notificationId',userAuth,  toggleFavoriteNotification);

module.exports = router;