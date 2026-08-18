const express = require('express');
const router = express.Router();
const { userAuth } = require('../../../middlewares/userAuth');
const { createSubTopic, getAllSubTopics, getSubTopicById, updateSubTopic, deleteSubTopic } = require('../../../controllers/courses/moduleStructure/subTopic');

// Routes
router.post('/sub-topic/create',userAuth, createSubTopic);
router.get('/sub-topic/getAll',userAuth, getAllSubTopics);
router.get('/sub-topic/getByid/:id',userAuth, getSubTopicById);
router.put('/sub-topic/update/:id',userAuth, updateSubTopic);
router.delete('/sub-topic/delete',userAuth, deleteSubTopic);

module.exports = router;
