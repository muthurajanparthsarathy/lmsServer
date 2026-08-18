const express = require('express');
const router = express.Router();
const { createlevelView, getAlllevelsViews, getLevelViewById, updateLevelView, deleteLevelFromView, deleteLevelView } = require('../../../controllers/courses/moduleStructure/level');
const { userAuth } = require('../../../middlewares/userAuth');

// LevelView Routes
router.post('/create/levels',userAuth, createlevelView);
router.get('/getAll/levels', userAuth,getAlllevelsViews);
router.get('/getByid/levels/:id', userAuth,getLevelViewById);
router.put('/update/levels/:documentId', userAuth,updateLevelView);
router.delete('/delete/levels/ById/:id', userAuth,deleteLevelView);

module.exports = router;