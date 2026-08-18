const express = require("express");
const {
  addCategory,
  getAllCategories,
  getCategoryById,
  updateCategory,
  deleteCategory,
  addService,
  getAllServices,
  getServiceById,
  updateService,
  deleteService,
  addServiceModal,
  getAllServiceModals,
  getServiceModalById,
  updateServiceModal,
  deleteServiceModal,
  getOrCreateCourseStructure,
  getAllCourseStructureWithPopulated,
} = require("../../controllers/dynamicContent/courseStructureDynamic");
const { userAuth } = require("../../middlewares/userAuth");
const router = express.Router();

// Course Structure Routes
router.get('/course-structure', getOrCreateCourseStructure);

router.get('/getAll/course-dynamic',userAuth, getAllCourseStructureWithPopulated);

// CLIENT ROUTES — removed. Clients are managed by the standalone Client
// Management module (/client-management/*, models/ClientManagementModel.js),
// not by the Dynamic Field Settings tab that used to own /clients/*.

// CATEGORY ROUTES
router.post('/categories/create',userAuth, addCategory);
router.get('/categories/getAll',userAuth, getAllCategories);
router.get('/categories/getById/:categoryId',userAuth, getCategoryById);
router.put('/categories/update/:categoryId',userAuth, updateCategory);
router.delete('/categories/delete/:categoryId',userAuth, deleteCategory);

// SERVICE ROUTES
// SERVICE ROUTES
router.post('/services/create',userAuth, addService);
router.get('/services/getAll',userAuth, getAllServices);
router.get('/services/getById/:serviceId',userAuth, getServiceById);
router.put('/services/update/:serviceId',userAuth, updateService);
router.delete('/services/delete/:serviceId',userAuth, deleteService);
 
// SERVICE MODAL ROUTES
router.post('/service-modals/create',userAuth, addServiceModal);
router.get('/service-modals/getAll',userAuth, getAllServiceModals);
router.get('/service-modals/getById/:serviceModalId',userAuth, getServiceModalById);
router.put('/service-modals/update/:serviceId/:modalId',userAuth, updateServiceModal);
router.delete('/service-modals/delete/:serviceId/:modalId', userAuth, deleteServiceModal);
 
module.exports = router;