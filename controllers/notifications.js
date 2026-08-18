const mongoose = require("mongoose");
const User = require("../models/UserModel");



/** Escape a user-supplied search term so it is matched literally. */
const escapeNotifRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One page of the caller's notifications.
 *
 * Notifications are an embedded array on the User document, so the whole array
 * is read from disk either way — but only a page is walked, shaped and sent.
 * The list grows for the lifetime of an account and the page rendered EVERY
 * row, so this is the growth that had no ceiling.
 *
 * The filter and search are ports of the page's own `getFilteredNotifications`
 * (features/notifications/NotificationsPage.tsx), field for field.
 */
async function getUserNotificationsPaginated(req, res, userId) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const filter = String(req.query.filter || 'all');
  const search = String(req.query.search || '').trim();

  // The page's filter buckets. Anything that is not one of the four reserved
  // words matches EITHER relatedEntity OR type — that is the page's rule.
  let match = {};
  if (filter === 'unread') match = { 'notifications.isRead': { $ne: true } };
  else if (filter === 'read') match = { 'notifications.isRead': true };
  else if (filter === 'favorite') match = { 'notifications.isFavorite': true };
  else if (filter !== 'all') {
    match = {
      $or: [
        { 'notifications.relatedEntity': filter },
        { 'notifications.type': filter },
      ],
    };
  }
  if (search) {
    const rx = new RegExp(escapeNotifRegex(search), 'i');
    const searchMatch = {
      $or: [{ 'notifications.title': rx }, { 'notifications.message': rx }],
    };
    match = Object.keys(match).length ? { $and: [match, searchMatch] } : searchMatch;
  }

  // The filter applies to the ROWS and their total, but NOT to `unreadCount`:
  // that badge counts the caller's whole list, exactly as the legacy path did
  // (it derived it from every notification, before any filtering). Keeping the
  // filter out of that branch is the difference between the badge reading 1
  // and reading 0 while the "read" tab is open — caught by testing each filter.
  const filtered = Object.keys(match).length ? [{ $match: match }] : [];

  const [out] = await User.aggregate([
    { $match: { _id: new mongoose.Types.ObjectId(String(userId)) } },
    { $unwind: '$notifications' },
    {
      $facet: {
        rows: [
          ...filtered,
          { $sort: { 'notifications.createdAt': -1, 'notifications._id': -1 } },
          { $skip: (page - 1) * limit },
          { $limit: limit },
          { $replaceRoot: { newRoot: '$notifications' } },
        ],
        count: [...filtered, { $count: 'n' }],
        unread: [
          { $match: { 'notifications.isRead': { $ne: true } } },
          { $count: 'n' },
        ],
      },
    },
  ]);

  const rows = out?.rows || [];
  const total = out?.count?.[0]?.n || 0;

  // `enrolledBy` is an id here; the legacy path populated it. Resolve only the
  // ids on THIS page.
  const enrolledIds = [...new Set(rows.map((r) => r.enrolledBy).filter(Boolean).map(String))];
  const enrolledDocs = enrolledIds.length
    ? await User.find({ _id: { $in: enrolledIds } })
      .select('firstName lastName email').lean()
    : [];
  const byId = new Map(enrolledDocs.map((u) => [String(u._id), u]));

  const notifications = rows.map((n) => {
    // `metadata` is a Map in Mongoose; aggregation returns it as a plain
    // object already, but a missing value must still serialise as {} exactly
    // as the legacy path did.
    const metadata = n.metadata && typeof n.metadata === 'object' ? n.metadata : {};
    const src = n.enrolledBy ? byId.get(String(n.enrolledBy)) : null;
    return {
      ...n,
      metadata,
      enrolledByInfo: src
        ? {
          id: src._id,
          name: `${src.firstName || ''} ${src.lastName || ''}`.trim(),
          email: src.email,
          isPopulated: true,
        }
        : null,
    };
  });

  return res.status(200).json({
    success: true,
    data: {
      notifications,
      unreadCount: out?.unread?.[0]?.n || 0,
      totalCount: total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  });
}

exports.getUserNotifications = async (req, res) => {
  try {
    const userId = req.user.id;

    // ── Paginated mode (opt-in via `page`) ───────────────────────────────────
    // Without `page` the original response is unchanged, so the notification
    // bell and any other consumer are untouched.
    if (req.query.page !== undefined) {
      return await getUserNotificationsPaginated(req, res, userId);
    }

    // Populate enrolledBy field with user details
    const user = await User.findById(userId)
      .populate({
        path: 'notifications.enrolledBy',
        select: 'firstName lastName email',
        model: 'LMS-User'
      })
      .select('notifications');
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    // Sort notifications by date (newest first)
    const sortedNotifications = user.notifications.sort((a, b) => 
      new Date(b.createdAt) - new Date(a.createdAt)
    );
    
    // Convert notifications to plain objects and handle Map
    const processedNotifications = sortedNotifications.map(notification => {
      const notificationObj = notification.toObject();
      
      // Convert metadata Map to object
      const metadataObj = {};
      if (notificationObj.metadata && notificationObj.metadata.forEach) {
        notificationObj.metadata.forEach((value, key) => {
          metadataObj[key] = value;
        });
      }
      
      // Check if enrolledBy is populated
      let enrolledByInfo = null;
      if (notificationObj.enrolledBy) {
        const enrolledByUser = notificationObj.enrolledBy;
        enrolledByInfo = {
          id: enrolledByUser._id,
          name: `${enrolledByUser.firstName || ''} ${enrolledByUser.lastName || ''}`.trim(),
          email: enrolledByUser.email,
          isPopulated: true
        };
      }
      
      return {
        ...notificationObj,
        metadata: metadataObj,
        enrolledByInfo: enrolledByInfo
      };
    });
    
    // Count unread notifications
    const unreadCount = processedNotifications.filter(notif => !notif.isRead).length;
    
    res.status(200).json({
      success: true,
      data: {
        notifications: processedNotifications,
        unreadCount,
        totalCount: processedNotifications.length
      }
    });
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch notifications',
      error: error.message
    });
  }
};

// Mark notification as read
exports.markNotificationAsRead = async (req, res) => {
  try {
    const userId = req.user.id;
    const { notificationId } = req.params;
    
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    const notification = await user.markNotificationAsRead(notificationId);
    
    res.status(200).json({
      success: true,
      message: 'Notification marked as read',
      data: notification
    });
  } catch (error) {
    console.error('Error marking notification as read:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to mark notification as read',
      error: error.message
    });
  }
};

// Mark all notifications as read
// In your notifications.js controller
exports.markAllNotificationsAsRead = async (req, res) => {
  try {
    
    // Try different possible user ID properties
    const userId = req.user.id;
    
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated'
      });
    }
    
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    await user.markAllNotificationsAsRead();
    
    res.status(200).json({
      success: true,
      message: 'All notifications marked as read'
    });
  } catch (error) {
    console.error('Error marking all notifications as read:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to mark notifications as read',
      error: error.message
    });
  }
};

// Delete notification
exports.deleteNotification = async (req, res) => {
  try {
    const userId = req.user.id;
    const { notificationId } = req.params;
    
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    // Find the notification
    const notification = user.notifications.id(notificationId);
    if (!notification) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }
    
    // Check if notification was unread to update count
    const wasUnread = !notification.isRead;
    
    // Remove the notification using pull method
    user.notifications.pull({ _id: notificationId });
    
    // Update unread count if needed
    if (wasUnread) {
      user.unreadNotificationCount = Math.max(0, user.unreadNotificationCount - 1);
    }
    
    await user.save();
    
    res.status(200).json({
      success: true,
      message: 'Notification deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting notification:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete notification',
      error: error.message
    });
  }
};


// Get notification count
exports.getNotificationCount = async (req, res) => {
  try {
    const userId = req.user.id;
    
    const user = await User.findById(userId)
      .select('unreadNotificationCount');
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    res.status(200).json({
      success: true,
      data: {
        unreadCount: user.unreadNotificationCount
      }
    });
  } catch (error) {
    console.error('Error fetching notification count:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch notification count',
      error: error.message
    });
  }
};

// Delete all notifications
exports.deleteAllNotifications = async (req, res) => {
  try {
    const userId = req.user.id;
    
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    // Clear all notifications
    user.notifications = [];
    user.unreadNotificationCount = 0;
    await user.save();
    
    res.status(200).json({
      success: true,
      message: 'All notifications deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting all notifications:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete notifications',
      error: error.message
    });
  }
};


exports.toggleFavoriteNotification = async (req, res) => {
  try {
    const userId = req.user.id;
    const { notificationId } = req.params;
    
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    // Find the notification
    const notification = user.notifications.id(notificationId);
    if (!notification) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }
    
    // Toggle favorite status
    notification.isFavorite = !notification.isFavorite;
    await user.save();
    
    res.status(200).json({
      success: true,
      message: `Notification ${notification.isFavorite ? 'added to' : 'removed from'} favorites`,
      data: {
        isFavorite: notification.isFavorite,
        notification: {
          _id: notification._id,
          title: notification.title,
          message: notification.message,
          type: notification.type,
          relatedEntity: notification.relatedEntity,
          isRead: notification.isRead,
          isFavorite: notification.isFavorite,
          createdAt: notification.createdAt
        }
      }
    });
  } catch (error) {
    console.error('Error toggling favorite notification:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to toggle favorite status',
      error: error.message
    });
  }
};