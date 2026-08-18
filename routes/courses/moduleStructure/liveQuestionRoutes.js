const express = require('express');
const router = express.Router();
const { userAuth } = require('../../../middlewares/userAuth');
const { createLiveQuestion, getLiveQuestions,getResponses,getRealtimeAnalytics,getLiveQuestionByLink,startAttempt,submitAnswer, submitTest } = require('../../../controllers/courses/moduleStructure/liveQuestion');

// Staff routes
router.post('/live-questions/create', userAuth,  createLiveQuestion);
router.get('/live-questions/getAll', userAuth,  getLiveQuestions);
router.get('/live-questions/:liveQuestionId/responses', userAuth,  getResponses);
router.get('/live-questions/:liveQuestionId/analytics', userAuth,  getRealtimeAnalytics);

// Student routes (public access via link)
router.get('/link/:link', getLiveQuestionByLink);
router.post('/link/:link/start', userAuth, startAttempt);
router.post('/attempt/:attemptId/submit-answer', userAuth, submitAnswer);
router.post('/attempt/:attemptId/submit-test', userAuth, submitTest);

module.exports = router;