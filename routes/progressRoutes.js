// routes/progressRoutes.js
const express = require('express');
const router = express.Router();
const progressController = require('../controllers/dynamicContent/progressController');

router.patch('/progress/:userId/courses/:courseId/visit-node',    progressController.recordNodeVisit);
router.patch('/progress/:userId/courses/:courseId/open-resource', progressController.recordResourceOpen);
router.patch('/progress/:userId/courses/:courseId/close-resource', progressController.recordResourceClose);
router.patch('/progress/:userId/courses/:courseId/select-method', progressController.recordMethodSelect);
router.patch('/progress/:userId/courses/:courseId/select-activity', progressController.recordActivitySelect);
router.get(  '/progress/:userId/courses/:courseId',               progressController.getProgress);

module.exports = router;