const express = require('express');
const router = express.Router();
const { userAuth } = require('../../../middlewares/userAuth');
const { createTopic, getAllTopics, getTopicById, updateTopic, deleteTopic } = require('../../../controllers/courses/moduleStructure/topic');

// Routes
router.post('/topic/create',userAuth, createTopic);
router.get('/topic/getAll',userAuth, getAllTopics);
router.get('/topic/getByid/:id',userAuth, getTopicById);
router.put('/topic/update/:id',userAuth, updateTopic);
router.delete('/topic/delete',userAuth, deleteTopic);

module.exports = router;
