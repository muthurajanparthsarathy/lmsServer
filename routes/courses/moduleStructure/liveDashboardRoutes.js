const express = require("express");
const router = express.Router();
const { userAuth } = require("../../../middlewares/userAuth");
const {
  getLiveDashboard,
  getStudentDetails,
  getMessages,
  markMessagesRead,
} = require("../../../controllers/courses/moduleStructure/liveDashboard");

router.get("/api/assessment/live-dashboard", userAuth, getLiveDashboard);
router.get("/api/assessment/student-details", userAuth, getStudentDetails);
router.get("/api/assessment/messages", userAuth, getMessages);
router.post("/api/assessment/messages/read", userAuth, markMessagesRead);

module.exports = router;
