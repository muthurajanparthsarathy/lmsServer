const express = require("express");
const router = express.Router();
const { superAdminGuard } = require("../../middlewares/superadmin/superAdminGuard");
const { superAdminAudit } = require("../../middlewares/superadmin/superAdminAudit");
const { broadcast, getAudienceCounts } = require("../../controllers/superadmin/notificationController");

router.use(superAdminGuard);
router.get("/audience", getAudienceCounts);
router.post("/broadcast", superAdminAudit("notification.broadcast", (req) => `Sent "${req.body.title}"`), broadcast);

module.exports = router;
