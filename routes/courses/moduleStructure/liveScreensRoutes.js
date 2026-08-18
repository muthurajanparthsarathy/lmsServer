const express = require("express");
const router = express.Router();
const { userAuth } = require("../../../middlewares/userAuth");
const { requireProctor } = require("../../../middlewares/requireProctor");
const {
  getLiveScreens,
  getScreenViolations,
} = require("../../../controllers/courses/moduleStructure/liveScreens");

// Role-based access (#12): userAuth then requireProctor (non-students only).
router.get("/api/assessment/live-screens", userAuth, requireProctor, getLiveScreens);
router.get("/api/assessment/screen-violations", userAuth, requireProctor, getScreenViolations);

module.exports = router;
