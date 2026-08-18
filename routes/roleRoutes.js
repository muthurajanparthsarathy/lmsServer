const express = require('express');
const { createRole, getAllRole, getRoleById, updateRole, deleteRole } = require('../controllers/role');
const { userAuth } = require('../middlewares/userAuth');
const router = express.Router();

// Role routes
router.post('/roles/create',userAuth,  createRole);
router.get('/roles/getAll', userAuth, getAllRole);
router.get('/roles/getByid/:id',userAuth,  getRoleById);
router.put('/roles/update/:id',userAuth,  updateRole);
router.delete('/roles/delete/:id', userAuth, deleteRole);

module.exports = router;