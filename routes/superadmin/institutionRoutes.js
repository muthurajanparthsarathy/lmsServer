const express = require("express");
const router = express.Router();
const { superAdminGuard } = require("../../middlewares/superadmin/superAdminGuard");
const { superAdminAudit } = require("../../middlewares/superadmin/superAdminAudit");
const {
  createInstitution,
  getAllInstitutions,
  getInstitutionById,
  deleteInstitution,
  updateInstitutionStatus,
  getInstitutionPermissions,
  updateInstitutionPermissions,
} = require("../../controllers/superadmin/institutionController");

router.use(superAdminGuard);

router.post("/", superAdminAudit("institution.create", (req) => `Created "${req.body.inst_name}"`), createInstitution);
router.get("/", getAllInstitutions);
router.get("/:id/permissions", getInstitutionPermissions);
router.put("/:id/permissions", superAdminAudit("institution.permissions", () => "Updated institution permissions"), updateInstitutionPermissions);
router.get("/:id", getInstitutionById);
router.delete("/:id", superAdminAudit("institution.delete"), deleteInstitution);
router.put("/:id/status", superAdminAudit("institution.status", (req) => `Status → ${req.body.status}`), updateInstitutionStatus);

module.exports = router;
