const express = require("express");
const router = express.Router();

// Every sub-router here is namespaced under /superadmin — fully independent
// from the existing LMS routers mounted at "/" in server.js.
router.use("/superadmin/auth", require("./authRoutes"));
router.use("/superadmin/institutions", require("./institutionRoutes"));
router.use("/superadmin/roles", require("./roleRoutes"));
router.use("/superadmin/users", require("./userRoutes"));
router.use("/superadmin/admins", require("./adminUserRoutes"));
router.use("/superadmin/permissions", require("./permissionRoutes"));
router.use("/superadmin/resources", require("./resourceRoutes"));
router.use("/superadmin/subscriptions", require("./subscriptionRoutes"));
router.use("/superadmin/settings", require("./settingRoutes"));
router.use("/superadmin/reports", require("./reportRoutes"));
router.use("/superadmin/notifications", require("./notificationRoutes"));
router.use("/superadmin/audit-logs", require("./auditLogRoutes"));

module.exports = router;
