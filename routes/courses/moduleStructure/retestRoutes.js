const express = require("express");
const router = express.Router();
const { userAuth } = require("../../../middlewares/userAuth");
const {
  createRetestRequest,
  getRetestRequests,
  getStudentRetestRequests,
  unlockAssessment,
} = require("../../../controllers/courses/moduleStructure/retest");

// Student creates a retest request
router.post("/retest/request", userAuth, createRetestRequest);

// Coordinator lists all retest requests for an assessment (Request List tab)
router.get("/retest/requests/:courseId/:exerciseId", userAuth, getRetestRequests);

// Student lists their own requests for a course (to disable duplicate requests)
router.get("/retest/my-requests/:courseId", userAuth, getStudentRetestRequests);

// Coordinator unlocks an assessment for a student (reset + per-student window)
router.post("/retest/unlock", userAuth, unlockAssessment);

module.exports = router;
