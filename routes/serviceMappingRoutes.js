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
const { attachPocScope, guardMappingWrite, guardClientWrite } = require("../middlewares/pocScope");

const router = express.Router();

router.use("/service-mapping", userAuth, attachPocScope);

// A POC keeps the mapping actions, but only for mappings whose client is in
// its scope. Create is guarded on the body's `client` id.
router.post("/service-mapping/create", guardClientWrite("_client_"), createMapping);
router.get("/service-mapping/getAll", getAllMappings);
router.get("/service-mapping/getById/:mappingId", getMappingById);
router.get("/service-mapping/getByClient/:clientId", getMappingsByClient);
router.put("/service-mapping/update/:mappingId", guardMappingWrite(), updateMapping);
router.delete("/service-mapping/delete/:mappingId", guardMappingWrite(), deleteMapping);
router.put("/service-mapping/toggle-status/:mappingId", guardMappingWrite(), toggleMappingStatus);

module.exports = router;
