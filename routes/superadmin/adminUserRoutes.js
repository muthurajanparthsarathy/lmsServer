const express = require("express");
const router = express.Router();
const { superAdminGuard } = require("../../middlewares/superadmin/superAdminGuard");
const { superAdminAudit } = require("../../middlewares/superadmin/superAdminAudit");
const {
  getAllAdmins,
  createAdmin,
  updateAdmin,
  updateAdminStatus,
  deleteAdmin,
} = require("../../controllers/superadmin/adminUserController");

router.use(superAdminGuard);

router.get("/", getAllAdmins);
router.post("/", superAdminAudit("admin.create", (req) => `Created admin ${req.body.email}`), createAdmin);
router.put("/:id/status", superAdminAudit("admin.status", (req) => `Status → ${req.body.status}`), updateAdminStatus);
router.put("/:id", superAdminAudit("admin.update"), updateAdmin);
router.delete("/:id", superAdminAudit("admin.delete"), deleteAdmin);

module.exports = router;
