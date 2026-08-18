const express = require("express");
const router = express.Router();
const { userAuth } = require("../middlewares/userAuth");
const { 
    getAllFeedback, 
    createFeedback, 
    getFeedbackById, 
    getFeedbackByCourse, 
    updateFeedback, 
    deleteFeedback, 
    toggleFeedbackStatus, 
    getAllStudentResponses, 
    getFeedbackStatistics, 
    getQuestionResponses, 
    getCourseFeedbackStatistics, 
    submitStudentResponse, 
    getStudentResponses,
    getAllStudentResponsesByCourse,
    syncAllFeedbackStatus
} = require("../controllers/feedback");

// ==================== ADMIN/INSTRUCTOR ROUTES ====================


// Create feedback
router.post("/create/feedback",   createFeedback);

// Get all feedback
router.get("/getAll/feedback",   getAllFeedback);

// Get feedback by Object ID
router.get("/getByid/feedback/:id",   getFeedbackById);

// Get feedback by course
router.get("/getByCourse/feedback/course/:courseId",   getFeedbackByCourse);

// Update feedback by Object ID
router.put("/update/feedback/:id",   updateFeedback);

// Delete feedback by Object ID
router.delete("/feedback/delete/:id",   deleteFeedback);

// Toggle feedback status by Object ID
router.patch("/toggle/feedback/:id",   toggleFeedbackStatus);

// Get all student responses for a feedback by Object ID
router.get("/getAll/student/responses/:id",   getAllStudentResponses);

// Get all student responses by course
router.get("/getAll/student/responses/course/:courseId",   getAllStudentResponsesByCourse);

// Get feedback statistics by Object ID
router.get("/getAll/feedback/statistics/:id",   getFeedbackStatistics);

// Get question responses by Object ID
router.get("/getAll/feedback/questions/:id/responses",   getQuestionResponses);

// Get course feedback statistics
router.get("/getAll/feedback/statistics/course/:courseId",   getCourseFeedbackStatistics);

// ==================== STUDENT ROUTES ====================

// Submit student response by Object ID
router.post("/student/submit/feedback/:id", userAuth,   submitStudentResponse);

// Get student's own responses by Object ID
router.get("/student/:id/my-responses",   getStudentResponses);


router.post("/feedback/sync-status",  syncAllFeedbackStatus);

module.exports = router;