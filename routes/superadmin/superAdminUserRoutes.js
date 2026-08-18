const express = require("express");
const router = express.Router();
const superAdminUserController = require("../controllers/superadmin/SuperAdminUserController");
const { authenticateSuperAdmin } = require("../middleware/superadminAuth");

// All routes require super admin authentication
router.use(authenticateSuperAdmin);

// User management routes
router.get("/users", superAdminUserController.getAllUsers);
router.post("/users", superAdminUserController.createUser);
router.put("/users/:id", superAdminUserController.updateUser);
router.delete("/users/:id", superAdminUserController.deleteUser);
router.patch("/users/:id/status", superAdminUserController.updateUserStatus);
router.patch("/users/:id/password", superAdminUserController.changePassword);

module.exports = router;