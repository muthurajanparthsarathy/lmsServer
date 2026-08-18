const express = require("express");
const {
  createMapping,
  getAllMappings,
  getMappingById,
  getMappingsByClient,
  updateMapping,
  deleteMapping,
  toggleMappingStatus,
} = require("../controllers/serviceMappingController");
const { userAuth } = require("../middlewares/userAuth");

const router = express.Router();

// Service Mapping routes (client ↔ service configuration, standalone module)
router.post("/service-mapping/create", userAuth, createMapping);
router.get("/service-mapping/getAll", userAuth, getAllMappings);
router.get("/service-mapping/getById/:mappingId", userAuth, getMappingById);
router.get("/service-mapping/getByClient/:clientId", userAuth, getMappingsByClient);
router.put("/service-mapping/update/:mappingId", userAuth, updateMapping);
router.delete("/service-mapping/delete/:mappingId", userAuth, deleteMapping);
router.put("/service-mapping/toggle-status/:mappingId", userAuth, toggleMappingStatus);

module.exports = router;
