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
const { attachPocScope, guardCourseWrite } = require("../../middlewares/pocScope");

const router = express.Router();

router.use("/attendance", userAuth, attachPocScope);

// A POC may MARK attendance on the courses it is enrolled in — same action
// space as an admin, just narrower target set. Reads are still scoped through
// req.pocScope inside the handlers.
router.get("/attendance/overview", getAttendanceOverview);
router.get("/attendance/window/:courseId", getAttendanceWindow);
router.get("/attendance/get/:courseId", getAttendance);
router.get("/attendance/summary/:courseId", getAttendanceSummary);
router.post("/attendance/save/:courseId", guardCourseWrite(), bulkSaveAttendance);
router.delete("/attendance/reset/:courseId", guardCourseWrite(), resetAttendance);

module.exports = router;
