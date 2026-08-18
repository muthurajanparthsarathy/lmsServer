const express = require("express");
const router = express.Router();
const { superAdminGuard } = require("../../middlewares/superadmin/superAdminGuard");
const { getOverview, getInstitutionAnalytics, getInstitutionDetails, getLoginReport } = require("../../controllers/superadmin/reportController");

router.use(superAdminGuard);
router.get("/overview", getOverview);
router.get("/analytics", getInstitutionAnalytics);
router.get("/institution/:id", getInstitutionDetails);
router.get("/logins", getLoginReport);

module.exports = router;
