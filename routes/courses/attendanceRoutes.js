const express = require("express");
const {
  getAttendance,
  bulkSaveAttendance,
  resetAttendance,
  getAttendanceOverview,
  getAttendanceWindow,
  getAttendanceSummary,
} = require("../../controllers/courses/attendance");
const { userAuth } = require("../../middlewares/userAuth");

const router = express.Router();

// The Attendance Management listing: every course the requester may mark,
// with per-batch student counts and marked-today flags, role-scoped.
router.get("/attendance/overview", userAuth, getAttendanceOverview);

// The batch's training window — the marking boundary the save enforces.
router.get("/attendance/window/:courseId", userAuth, getAttendanceWindow);

// Fetch attendance for a course over a date range (optionally ?batchId=).
router.get("/attendance/get/:courseId", userAuth, getAttendance);

// The Report/Analytics aggregates for a course over a date range, computed in
// Mongo. The pages used to derive these from every record in the range.
router.get("/attendance/summary/:courseId", userAuth, getAttendanceSummary);

// Bulk upsert / clear attendance for a course.
router.post("/attendance/save/:courseId", userAuth, bulkSaveAttendance);

// Wipe attendance for a course (optionally scoped by a date range).
router.delete("/attendance/reset/:courseId", userAuth, resetAttendance);

module.exports = router;
