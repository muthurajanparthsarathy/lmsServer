const express = require('express');
const { 
  createDegree, 
  getAllDegrees, 
  getDegreeById, 
  updateDegree, 
  deleteDegree,
  addDepartment,
  getAllDepartments,
  getDepartmentById,
  updateDepartment,
  removeDepartment
} = require('../../controllers/dynamicContent/degreeAndDepartment');
const { userAuth } = require('../../middlewares/userAuth');
const router = express.Router();

// Degree routes
router.post('/degrees/create', userAuth, createDegree);
router.get('/degrees/getAll', userAuth, getAllDegrees);
router.get('/degrees/getById/:id', userAuth, getDegreeById);
router.put('/degrees/update/:id', userAuth, updateDegree);
router.delete('/degrees/delete/:id', userAuth, deleteDegree);

// Department routes (nested within degree)
router.post('/degrees/:id/departments/add', userAuth, addDepartment);
router.get('/degrees/:id/departments/getAll', userAuth, getAllDepartments);
router.get('/degrees/:id/departments/getById/:departmentId', userAuth, getDepartmentById);
router.put('/degrees/:id/departments/update/:departmentId', userAuth, updateDepartment);
router.delete('/degrees/:id/departments/remove/:departmentId', userAuth, removeDepartment);

module.exports = router;