const express = require('express');
const router = express.Router();
const { userAuth } = require('../../../middlewares/userAuth');
const { createSubModule, getAllSubModules, getSubModuleById, updateSubModule, deleteSubModule } = require('../../../controllers/courses/moduleStructure/subModule');

// Routes
router.post('/sub-module/create',userAuth, createSubModule);
router.get('/sub-module/getAll',userAuth, getAllSubModules);
router.get('/sub-module/getByid/:id',userAuth, getSubModuleById);
router.put('/sub-module/update/:id',userAuth, updateSubModule);
router.delete('/sub-module/delete',userAuth, deleteSubModule);

module.exports = router;
