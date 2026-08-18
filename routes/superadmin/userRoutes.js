const express = require("express");
const router = express.Router();
const { superAdminGuard } = require("../../middlewares/superadmin/superAdminGuard");
const { superAdminAudit } = require("../../middlewares/superadmin/superAdminAudit");
const {
  getAllUsers,
  createUser,
  updateUser,
  deleteUser,
  updateUserStatus,
  getUserPermissions,
  updateUserPermissions,
} = require("../../controllers/superadmin/userController");

router.use(superAdminGuard);

router.get("/", getAllUsers);
router.post("/", superAdminAudit("user.create", (req) => `Created ${req.body.email}`), createUser);
router.get("/:id/permissions", getUserPermissions);
router.put("/:id/permissions", superAdminAudit("user.permissions", () => "Updated user permissions"), updateUserPermissions);
router.put("/:id", superAdminAudit("user.update"), updateUser);
router.delete("/:id", superAdminAudit("user.delete"), deleteUser);
router.put("/:id/status", superAdminAudit("user.status", (req) => `Status → ${req.body.status}`), updateUserStatus);

module.exports = router;
