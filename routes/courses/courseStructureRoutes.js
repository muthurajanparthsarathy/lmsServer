const express = require("express");
const { userAuth } = require("../../middlewares/userAuth");
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

router.post("/courses-structure/create", userAuth, createCourseStructure);

router.get("/courses-structure/getAll", userAuth, getCourseStructure);

router.get("/courses-structure/getById/:id", userAuth, getCourseStructureById);
router.put("/courses-structure/update/:courseId", userAuth, updateCourseStructure);
router.delete("/courses-structure/delete/:id", userAuth, deleteCourseStructure);

router.post("/add-participants/:courseId", userAuth, batchAddParticipants);
router.delete("/delete/participant/:courseId/:userId", userAuth, deleteAddParticipants);
router.delete("/delete-participants/multiple/:courseId", userAuth, deleteMultipleParticipants);
router.put('/update-enrollment/:courseId/:participantId',userAuth, updateParticipantEnrollment);

router.get("/courses/:courseId/batches", userAuth, getCourseBatches);
router.put("/courses/:courseId/batches/:batchId", userAuth, updateBatch);
router.delete("/courses/:courseId/batches/:batchId", userAuth, deleteBatch);

router.get('/courses/:courseId/approval-hierarchy', userAuth, getApprovalHierarchy);
router.put('/courses/:courseId/approval-hierarchy', userAuth, updateApprovalHierarchy);

module.exports = router;
