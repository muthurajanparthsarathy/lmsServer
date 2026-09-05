// Admin routes for External Assessment. Mounted at /api/admin/external.
//
// Every route here requires a logged-in LMS user. Page-level permission
// (`externalassessment`) is enforced client-side by the route gate and the
// sidebar; `userAuth` is the server-side floor that stops an unauthenticated
// caller reaching any of it.

const express = require("express");
const router = express.Router();

const { userAuth } = require("../../middlewares/userAuth");
const assessment = require("../../controllers/external/assessmentController");
const participant = require("../../controllers/external/participantController");

// ── Assessments ──
router.get("/assessments", userAuth, assessment.listAssessments);
router.post("/assessments", userAuth, assessment.createAssessment);
router.get("/assessments/:id", userAuth, assessment.getAssessment);
router.put("/assessments/:id", userAuth, assessment.updateAssessment);
router.delete("/assessments/:id", userAuth, assessment.deleteAssessment);

// ── Questions (embedded on the assessment) ──
router.get("/assessments/:id/questions", userAuth, assessment.listQuestions);
router.post("/assessments/:id/questions", userAuth, assessment.addQuestion);
router.put("/assessments/:id/questions/:questionId", userAuth, assessment.updateQuestion);
router.delete("/assessments/:id/questions/:questionId", userAuth, assessment.deleteQuestion);

// ── Participants ──
// The bulk-upload route accepts `?mode=validate` for a dry run that reports
// what would import without writing anything.
router.get("/assessments/:id/participants", userAuth, participant.listParticipants);
router.post("/assessments/:id/participants", userAuth, participant.addParticipant);
router.post("/assessments/:id/participants/bulk-upload", userAuth, participant.bulkUploadParticipants);
router.delete("/assessments/:id/participants/:participantId", userAuth, participant.deleteParticipant);
router.get("/assessments/:id/participants/:participantId/link", userAuth, participant.getParticipantLink);

// ── Invitations ──
router.post("/assessments/:id/invitations", userAuth, participant.sendPendingInvitations);
router.post("/assessments/:id/participants/:participantId/invite", userAuth, participant.resendInvitation);

// ── Results ──
router.get("/assessments/:id/results", userAuth, assessment.getResults);

module.exports = router;
