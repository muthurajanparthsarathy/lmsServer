const express = require("express");
const { userAuth } = require("../../middlewares/userAuth");
const { attachPocScope, guardCourseWrite, guardClientWrite } = require("../../middlewares/pocScope");
const {
  createCourseStructure,
  getCourseStructure,
  getCourseStructureById,
  updateCourseStructure,
  deleteCourseStructure,
  batchAddParticipants,
  deleteAddParticipants,
  deleteMultipleParticipants,
  updateParticipantEnrollment,
  getCourseBatches,
  updateBatch,
  deleteBatch,
  getApprovalHierarchy,
  updateApprovalHierarchy,
} = require("../../controllers/courses/courseStructure");
const router = express.Router();

// Per-route, not `router.use`, because this router owns several path prefixes
// and its `/courses/...` overlap with answerRoutes and exerciseAndQuestionRoutes.
const scoped = [userAuth, attachPocScope];

// Create: gated on `req.body.clientId` so a POC can only stand up a new course
// under a client it already works with.
router.post("/courses-structure/create", scoped, guardClientWrite(), createCourseStructure);
router.get("/courses-structure/getAll", scoped, getCourseStructure);
router.get("/courses-structure/getById/:id", scoped, getCourseStructureById);
router.put("/courses-structure/update/:courseId", scoped, guardCourseWrite(), updateCourseStructure);
router.delete("/courses-structure/delete/:id", scoped, guardCourseWrite("id"), deleteCourseStructure);

router.post("/add-participants/:courseId", scoped, guardCourseWrite(), batchAddParticipants);
router.delete("/delete/participant/:courseId/:userId", scoped, guardCourseWrite(), deleteAddParticipants);
router.delete("/delete-participants/multiple/:courseId", scoped, guardCourseWrite(), deleteMultipleParticipants);
router.put('/update-enrollment/:courseId/:participantId', scoped, guardCourseWrite(), updateParticipantEnrollment);

router.get("/courses/:courseId/batches", scoped, getCourseBatches);
router.put("/courses/:courseId/batches/:batchId", scoped, guardCourseWrite(), updateBatch);
router.delete("/courses/:courseId/batches/:batchId", scoped, guardCourseWrite(), deleteBatch);

router.get('/courses/:courseId/approval-hierarchy', scoped, getApprovalHierarchy);
router.put('/courses/:courseId/approval-hierarchy', scoped, guardCourseWrite(), updateApprovalHierarchy);

module.exports = router;
