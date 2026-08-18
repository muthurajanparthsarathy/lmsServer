const express = require("express");
const router = express.Router();
const { superAdminGuard } = require("../../middlewares/superadmin/superAdminGuard");
const { superAdminAudit } = require("../../middlewares/superadmin/superAdminAudit");
const { getRolePermissions, saveRolePermissions } = require("../../controllers/superadmin/permissionController");

router.use(superAdminGuard);

router.get("/", getRolePermissions);
router.put("/", superAdminAudit("permission.save", (req) => `Updated role modules`), saveRolePermissions);

module.exports = router;
