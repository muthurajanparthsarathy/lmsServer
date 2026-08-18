const express = require("express");
const router = express.Router();
const { superAdminGuard } = require("../../middlewares/superadmin/superAdminGuard");
const { getResourceSettings, updateResourceSettings } = require("../../controllers/superadmin/resourceController");

router.use(superAdminGuard);
router.get("/", getResourceSettings);
router.put("/", updateResourceSettings);

module.exports = router;
