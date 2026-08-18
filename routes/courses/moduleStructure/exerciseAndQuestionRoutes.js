const express = require("express");
const router = express.Router();
const { userAuth } = require("../../../middlewares/userAuth");
const {
  addExercise,
  updateExercise,
  deleteExercise,
  getExercises,
  addQuestion,
  getQuestions,
  getQuestionById,
  updateQuestion,
  deleteQuestion,
  lockExercise,
  getExerciseStatus,
  getCourseExercisesWithUserScores,
  getEnrolledStudentsForExercise,
  getStudentExerciseQuestions,
  getCourseExercisesAdminView,
  getUserExerciseGradeAnalytics,
  getExerciseById,
  addMCQQuestions,
  updateMCQQuestion,
  deleteMCQQuestion,
  uploadQuestionImage,
  uploadQuestionFile,
  addYouDoExercise,
  updateYouDoExercise,
  getYouDoExercises,
  saveAssessmentRecording,
  listPendingApprovals,
  approveExerciseStep,
  rejectExerciseStep,
  resubmitExerciseForApproval,
  getCourseApprovalsOverview,
  approveQuestion,
  approveAllQuestions,
  rejectQuestion,
  raiseQuestionQuery,
  resolveQuestionQuery,
} = require("../../../controllers/courses/moduleStructure/exerciseAndQuestion");
const {
  parseBulkDocument,
  insertBulkQuestions,
  downloadTemplate,
} = require("../../../controllers/courses/moduleStructure/Bulkmcqcontroller");

// We Do Routes can be added here in future

router.put("/exercise/add/:type/:id", userAuth, addExercise);

// Update a specific exercise by ID
router.put("/exercise/update/:type/:id/:exerciseId", userAuth, updateExercise);

// Delete a specific exercise by ID
router.delete(
  "/exercise/delete/:type/:id/:exerciseId",
  userAuth,
  deleteExercise,
);

// Get exercises by subcategory
router.get("/exercise/get/:type/:id", userAuth, getExercises);

router.post(
  "/question-add/:type/:id/exercise/:exerciseId",
  userAuth,
  addQuestion,
);

// Get all questions for an exercise
router.get("/questions-get/:type/:id/:exerciseId", userAuth, getQuestions);

// Get single question by ID
router.get(
  "/exercise/:exerciseId/question/:questionId/question-getByid",
  userAuth,
  getQuestionById,
);

// Update question
router.put(
  "/question-update/:type/:id/:exerciseId/:questionId",
  userAuth,
  updateQuestion,
);

// Delete question
router.delete(
  "/question-delete/:type/:id/:exerciseId/:questionId",
  userAuth,
  deleteQuestion,
);


// Route for getting all exercises with user scores
router.get(
  '/course/:courseId/exercises-with-scores',
  userAuth,
  getCourseExercisesWithUserScores
);


router.get('/course/:courseId/exercises', userAuth, getCourseExercisesAdminView); // NEW ROUTE
router.get('/exercises/:courseId/:exerciseId/students', userAuth, getEnrolledStudentsForExercise); // NEW ROUTE


router.get(
  '/course/:courseId/student/:studentId/exercise/:exerciseId/questions',
  userAuth,
  getStudentExerciseQuestions
);

router.get(
  '/analytics/exercise/:exerciseId',
  userAuth,
  getUserExerciseGradeAnalytics
);
 

router.post("/exercise/lock", userAuth, lockExercise);
// 2. Check Exercise Status
router.get("/exercise/status", userAuth, getExerciseStatus);
// 3. Save proctoring screen-recording URL (client uploads to Cloudinary, sends URL here)
router.post("/assessment/recording", userAuth, saveAssessmentRecording);

router.get("/exercise/:exerciseId", userAuth, getExerciseById);


router.post(
  "/mcq-question-add/:type/:id/exercise/:exerciseId",
  userAuth,
  addMCQQuestions,
);


router.post("/bulk-upload/parse/:type/:id/exercise/:exerciseId", userAuth, parseBulkDocument);
router.post("/bulk-upload/insert/:type/:id/exercise/:exerciseId", userAuth, insertBulkQuestions);
router.get("/bulk-upload/template/:format", downloadTemplate);
router.put(
  '/:type/:id/exercise/:exerciseId/mcq/question/:questionId',
  userAuth,
  updateMCQQuestion
);  

router.delete(
  '/:type/:id/exercise/:exerciseId/mcq/question/:questionId',
  userAuth,
  deleteMCQQuestion
);

router.post('/upload/question-image', userAuth, uploadQuestionImage);
router.post('/upload/question-file', userAuth, uploadQuestionFile);


//  You Do Routes can be added here in future
router.put("/you-do/exercise/add/:type/:id", userAuth, addYouDoExercise);

router.put("/you-do/exercise/update/:type/:id/:exerciseId", userAuth, updateYouDoExercise);

router.get("/you-do/exercise/getAll/:type/:id", userAuth, getYouDoExercises);

// Approval workflow
router.get("/approvals/pending", userAuth, listPendingApprovals);
router.get("/courses/:courseId/approvals/overview", userAuth, getCourseApprovalsOverview);
router.post("/exercise/approve", userAuth, approveExerciseStep);
router.post("/exercise/reject", userAuth, rejectExerciseStep);
router.post("/exercise/resubmit", userAuth, resubmitExerciseForApproval);
router.post("/exercise/question/approve", userAuth, approveQuestion);
router.post("/exercise/question/approve-all", userAuth, approveAllQuestions);
router.post("/exercise/question/reject", userAuth, rejectQuestion);
router.post("/exercise/question/query", userAuth, raiseQuestionQuery);
router.post("/exercise/question/resolve-query", userAuth, resolveQuestionQuery);

module.exports = router;
