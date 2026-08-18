const express = require("express");
const router = express.Router();
const { superAdminGuard } = require("../../middlewares/superadmin/superAdminGuard");
const { getSystemSettings, updateSystemSettings } = require("../../controllers/superadmin/settingController");

router.use(superAdminGuard);
router.get("/", getSystemSettings);
router.put("/", updateSystemSettings);

module.exports = router;
