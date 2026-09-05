const express = require("express");
const router = express.Router();
// `userAuthOptional` identifies the caller WITHOUT rejecting anonymous ones.
// The courses-data reads below have always been open, but Resources by Batch
// needs to know whether the viewer is a student (and which batch they are in)
// to narrow what comes back. Anonymous callers keep the course-level view.
const { userAuth, userAuthOptional } = require("../../../middlewares/userAuth");
const {

  createPedagogyView,
  getAllPedagogyViews,
  getPedagogyViewById,
  updatePedagogyView,
  deletePedagogyView,
  deleteDocument,
  getAllCoursesData,
  // Lightweight Resources-page-only variants. See pedagogyView.js for the
  // rationale — they exist to avoid the ~95% wasted payload `getAllCoursesData`
  // ships when the page only renders the sidebar tree + selected-node pedagogy.
  getAllCoursesDataLight,
  // Review-submission-only variant — drops pedagogy.I_Do + non-exercise
  // resources + the user.permissions field + other-course enrolment data.
  getCoursesDataForReview,
  getNodePedagogy,
  // Resources by Batch — see utils/batchResources.js.
  getResourceBatchContext,
  duplicateCourseHierarchy,
  updateEntity,          // ← must be here
  updateFileSettings,    // ← keep this too
  getAllCoursesDataWithoutAINotes,
  studentDashboardAnalyticsOptimized,
  getStudentCourseProgress,
  staffStudentAnalytics,
  ldOverviewSignals,
  createPage,
  updatePage,
  deletePage,
  addMCQQuestionToFile,
  getExerciseSubmissionStatus,
  getFileMCQQuestions,
  updateFileMCQQuestion,
  deleteFileMCQQuestion,
  upsertStudentFileProgress,
  getStudentFileProgress,
  getStudentActivityDetail,
getCourseStudents
} = require("../../../controllers/courses/moduleStructure/pedagogyView");

// Routes
router.post("/pedagogy-view/create", userAuth, createPedagogyView);
router.get("/pedagogy-view/getAll", userAuth, getAllPedagogyViews);
router.get("/pedagogy-view/getByid/:id", userAuth, getPedagogyViewById);
router.put("/pedagogy-view/update/:id", userAuth, updatePedagogyView);
router.delete(
  "/pedagogy-view/delete/:activityType/:itemId",
  deletePedagogyView
);

router.delete("/delete/:model/:id", deleteDocument);

// common data fetch for course related data
//
// IMPORTANT ROUTE ORDERING NOTE:
//   Express resolves routes in declaration order. A more-specific path like
//   `/getAll/courses-data/light/:courseId` MUST be declared BEFORE the
//   wildcard `/getAll/courses-data/:courseId`, otherwise the wildcard
//   swallows the request with `courseId === "light"`. The lightweight
//   routes therefore come first.
router.get("/getAll/courses-data/light/:courseId", userAuthOptional, getAllCoursesDataLight);
router.get("/getAll/courses-data/node-pedagogy/:type/:id", userAuthOptional, getNodePedagogy);
// Both read pedagogy, so both need `req.user` for batch scoping — without it
// the resolver sees an unidentified caller and returns the shared,
// course-level set, which on a batch-wise course means the grading screen
// shows no exercises at all.
router.get(
  "/getAll/courses-data/without-ai-notes/:courseId/:exerciseId",
  userAuthOptional,
  getAllCoursesDataWithoutAINotes
);
router.get("/getAll/courses-data/review/:courseId", userAuthOptional, getCoursesDataForReview);
// Generic catch-all comes LAST.
router.get("/getAll/courses-data/:courseId", userAuthOptional, getAllCoursesData);

// Resources-by-Batch context on its own — mode, batch list, the caller's batch.
// Pages that need to decide whether to render the batch strip (and with which
// names) can ask for just this instead of pulling a whole course payload.
router.get("/resource-batches/:courseId", userAuthOptional, getResourceBatchContext);

router.get(
  "/student-Dashboard/courses-data/analytics",
  userAuth,
  studentDashboardAnalyticsOptimized
);

router.get(
  '/analytics/staff/analytics/students',
  userAuth,
  staffStudentAnalytics
);

// Attempt-level practice health + the weekly submission series behind the L&D
// Overview's Training Performance Trend. Additive companion to the roll-up
// above, which averages both away — see `ldOverviewSignals`.
router.get(
  '/analytics/staff/analytics/ld-signals',
  userAuth,
  ldOverviewSignals
);

router.get(
  '/analytics/staff/analytics/student-progress/:courseId/:studentId',
  userAuth,
 getStudentCourseProgress
);

router.post("/dupicate-date", userAuth, duplicateCourseHierarchy);

// ✅ ONLY these two lines for uploadResourses — no duplicates
router.put("/uploadResourses/:type/:id",          userAuth, updateEntity);
router.put("/uploadResourses/:type/:id/settings", userAuth, updateFileSettings);

// Pages routes
router.post(  "/pages/:type/:id/pages",         userAuth, createPage);
router.put(   "/pages/:type/:id/pages/:pageId", userAuth, updatePage);
router.delete("/pages/:type/:id/pages/:pageId", userAuth, deletePage);

router.post('/file-mcq-add/:type/:id', userAuth, addMCQQuestionToFile);
router.get('/file-mcq-list/:type/:id', userAuth, getFileMCQQuestions);
router.put('/file-mcq-update/:type/:id', userAuth, updateFileMCQQuestion);
router.delete('/file-mcq-delete/:type/:id', userAuth, deleteFileMCQQuestion);
router.post('/student-file-progress/:type/:id', userAuth, upsertStudentFileProgress);
router.get('/student-file-progress/:type/:id', userAuth, getStudentFileProgress);

router.get(
  '/analytics/staff/analytics/student-activity/:courseId/:studentId',
  userAuth,
  getStudentActivityDetail
);

// Check which exercises have at least one student submission
// Query: courseId, tabType, subcategory, exerciseIds (comma-separated)
router.get('/analytics/exercise-submission-status', userAuth, getExerciseSubmissionStatus);
// In your routes file, update the two page routes:
router.get('/staff/analytics/course/:courseId/students', userAuth, getCourseStudents);

// All three must have the same /pages/ prefix

module.exports = router;
