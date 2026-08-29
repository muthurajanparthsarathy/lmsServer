const express = require("express");
const router = express.Router();
const {
  submitAnswer,
  getAllUsers,
  evaluateStudentAnswer,
  submitMultipleFiles,
  getPreviousSubmission,
  persistAiTestCases,
  rerunSubmissions,
  getRerunContext,
} = require("../../../controllers/courses/moduleStructure/answer");
const {
  startAttempt,
  getAttemptState,
  setCurrentQuestion,
  finaliseAttempt,
  requestResume,
  approveResume,
  rejectResume,
} = require("../../../controllers/courses/moduleStructure/attemptController");
const { userAuth } = require("../../../middlewares/userAuth");

const {
  getAnswerByQuestionId,
} = require("../../../controllers/courses/moduleStructure/answer");

router.post("/courses/answers/submit", userAuth, submitAnswer);

// ── Assessment Recovery & Resume ──────────────────────────────────────────
// Idempotent attempt lifecycle. See attemptController.js for the contract.
router.post("/courses/attempt/start", userAuth, startAttempt);
router.get("/courses/attempt/state", userAuth, getAttemptState);
router.patch("/courses/attempt/current-question", userAuth, setCurrentQuestion);
router.post("/courses/attempt/submit", userAuth, finaliseAttempt);
// Permission gate — student requests, trainer approves/rejects
router.post("/courses/attempt/request-resume", userAuth, requestResume);
router.post("/courses/attempt/approve-resume", userAuth, approveResume);
router.post("/courses/attempt/reject-resume", userAuth, rejectResume);

router.get("/users/answer/:courseId", userAuth, getAllUsers);

router.post("/users/update/submission-score", userAuth, evaluateStudentAnswer);

router.get("/courses/answers/single", userAuth, getAnswerByQuestionId);

router.post(
  "/courses/answers/submit-multiple-files",
  userAuth,
  submitMultipleFiles,
);
router.get(
  "/courses/answers/previous-submission",
  userAuth,
  getPreviousSubmission,
);
// Persist AI-generated test cases on the question doc (fire-and-forget from
// the first student's Submit; every subsequent student reuses these).
router.post(
  "/courses/answers/persist-ai-test-cases",
  userAuth,
  persistAiTestCases,
);

// Rerun — bulk re-score submissions against current question test cases / AI
// prompt. Actual code execution + AI eval runs in the teacher's browser; this
// endpoint just persists the batch of results and pushes previous scores to
// scoreHistory[]. See answer.js:rerunSubmissions for the full contract.
router.post("/courses/answers/rerun", userAuth, rerunSubmissions);

// Rerun context — questions eligible for rerun (with recently-edited flag)
// plus every student's stored code, for the client-side batch runner.
router.get(
  "/courses/exercises/:exerciseId/rerun-context",
  userAuth,
  getRerunContext,
);

module.exports = router;
