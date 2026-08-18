const mongoose = require('mongoose');

const SEND_TYPES = {
  USER_REGISTRATION: 'USER_REGISTRATION',
  ADMIN_REGISTRATION:'ADMIN_REGISTRATION',
  PASSWORD_RESET: 'PASSWORD_RESET',
  EVENT_INVITATION: 'EVENT_INVITATION',
  STUDENT_ENABLE: 'STUDENT_ENABLE',
  GENERAL_NOTIFICATION: 'GENERAL_NOTIFICATION',
  BULK_COMMUNICATION: 'BULK_COMMUNICATION',
  CUSTOM_COMMUNICATION: 'CUSTOM_COMMUNICATION',
  SUPPORT_TICKET_NOTIFICATION:'SUPPORT_TICKET_NOTIFICATION',
  BULK_USER_CREATION: 'BULK_USER_CREATION' // Add this
};

const userNotificationSchema = new mongoose.Schema({
  userId: {
    email: { type: String },
    firstName: { type: String },
    lastName: { type: String },
    phone: { type: String },
    role: { type: String },
  },
  sendDate: {
    type: String,
    default: () => {
      const date = new Date();
      const options = { 
        weekday: 'short', 
        year: 'numeric', 
        month: 'short', 
        day: '2-digit', 
        hour: '2-digit', 
        minute: '2-digit', 
        second: '2-digit', 
        hour12: true, 
        timeZone: 'Asia/Kolkata' 
      };
      return date.toLocaleString('en-US', options).replace(',', '');
    }
  },
  sendType: { 
    type: String, 
    required: true, 
    enum: Object.values(SEND_TYPES),
  },
});

const notificationSchema = new mongoose.Schema({
  mailNotificationCount: { type: Number, default: 0 },
  mailUsers: [userNotificationSchema],
});

const notificationCountSchema = new mongoose.Schema({
  institution: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'LMS-Institution',
    required: true,
  },
  successfulNotifications: notificationSchema,
  failedNotifications: notificationSchema,
}, { timestamps: true });

const NotificationCount = mongoose.model('Individual_Messaging_Data', notificationCountSchema);
module.exports = NotificationCount;