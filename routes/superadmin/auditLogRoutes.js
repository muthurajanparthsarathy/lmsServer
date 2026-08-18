const express = require("express");
const router = express.Router();
const { superAdminGuard } = require("../../middlewares/superadmin/superAdminGuard");
const { getAuditLogs, getLoginLogs } = require("../../controllers/superadmin/auditLogController");

router.use(superAdminGuard);
router.get("/", getAuditLogs);
router.get("/logins", getLoginLogs);

module.exports = router;
