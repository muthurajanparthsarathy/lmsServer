const express = require('express');
const router = express.Router();
const { getLoginLogs, getCourseActivityLogs, getCourseReport, postLoginSession, postLogout, getMyLearningTime } = require('../controllers/activityLogController');
const { userAuth } = require('../middlewares/userAuth');

// The caller's OWN measured study time. Auth-guarded and self-scoped — the
// course-wide endpoints below return every user's rows and must not be used
// from a student-facing page.
router.get('/activity-logs/me/learning-time', userAuth, getMyLearningTime);

router.get('/activity-logs/logins', getLoginLogs);
router.get('/activity-logs/courses/:courseId/report', getCourseReport);
router.get('/activity-logs/courses/:courseId', getCourseActivityLogs);
router.post('/activity-logs/login-session', postLoginSession);
router.post('/activity-logs/logout', postLogout);

module.exports = router;
