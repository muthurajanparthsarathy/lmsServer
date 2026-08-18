const mongoose = require('mongoose');

const activityLogSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'LMS-User',
    required: true,
  },
  userName:  { type: String, default: '' },
  userEmail: { type: String, default: '' },
  userRole:  { type: String, default: '' },

  courseId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Course-Structure', default: null },
  courseName: { type: String, default: null },

  action: {
    type: String,
    enum: ['login', 'node_visit', 'resource_open', 'method_select', 'activity_select', 'exercise_submit', 'exercise_start'],
    required: true,
  },

  details: {
    nodeId:       { type: String, default: null },
    nodeName:     { type: String, default: null },
    nodeType:     { type: String, default: null },
    resourceId:   { type: String, default: null },
    resourceName: { type: String, default: null },
    resourceType: { type: String, default: null },
    duration:     { type: Number, default: null }, // seconds — resource view duration (close − open)
    closedAt:     { type: Date,   default: null }, // when the resource viewer was closed
    exerciseId:   { type: String, default: null },
    exerciseName: { type: String, default: null },
    method:       { type: String, default: null },
    activity:     { type: String, default: null },
    status:       { type: String, default: null },
    ipAddress:    { type: String, default: null },
    location:     { type: String, default: null },
    device:       { type: String, default: null },
    browser:      { type: String, default: null },
    os:           { type: String, default: null },
    userAgent:    { type: String, default: null },
  },

  // Set on logout for `login` sessions
  logoutTime:      { type: Date,   default: null },
  sessionDuration: { type: Number, default: null }, // seconds (logout − login)
}, { timestamps: true });

activityLogSchema.index({ createdAt: -1 });
activityLogSchema.index({ action: 1, createdAt: -1 });
// The paginated login feed sorts { createdAt: -1, _id: -1 } — `_id` breaks
// ties so paging is stable. An index only serves a sort when it covers the
// WHOLE sort spec, so the tie-break column has to be in it; without `_id` here
// every page fell back to a blocking in-memory sort of all 20k login events.
activityLogSchema.index({ action: 1, createdAt: -1, _id: -1 });
activityLogSchema.index({ courseId: 1, createdAt: -1 });
// The paginated course report filters on courseId and sorts { createdAt: -1,
// _id: -1 }. The index above stops one column short of that spec, so it could
// not serve the sort: with a student selected the planner preferred
// { userId, courseId } and fell back to a blocking in-memory SORT of the whole
// course. Carrying the tie-break column here is what removes it.
activityLogSchema.index({ courseId: 1, createdAt: -1, _id: -1 });
activityLogSchema.index({ userId: 1, courseId: 1 });

module.exports = mongoose.model('ActivityLog', activityLogSchema);
