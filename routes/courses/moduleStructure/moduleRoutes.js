const express = require('express');
const router = express.Router();
const { createModule, getAllModules, getModuleById, updateModule, deleteModule } = require('../../../controllers/courses/moduleStructure/module');
const { userAuth } = require('../../../middlewares/userAuth');

// Routes
router.post('/module/create',userAuth, createModule);
router.get('/module/getAll',userAuth, getAllModules);
router.get('/module/getByid/:id',userAuth, getModuleById);
router.put('/module/update/:id',userAuth, updateModule);
router.delete('/module/delete',userAuth, deleteModule);

module.exports = router;
