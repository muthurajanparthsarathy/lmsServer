const express = require("express");
const router = express.Router();
const { superAdminGuard } = require("../../middlewares/superadmin/superAdminGuard");
const { login, logout, me, changePassword } = require("../../controllers/superadmin/authController");

router.post("/login", login);
router.post("/logout", superAdminGuard, logout);
router.get("/me", superAdminGuard, me);
router.put("/change-password", superAdminGuard, changePassword);

module.exports = router;
