const express = require("express");
const router = express.Router();
const { superAdminGuard } = require("../../middlewares/superadmin/superAdminGuard");
const { getSubscriptions, upsertSubscription } = require("../../controllers/superadmin/subscriptionController");

router.use(superAdminGuard);
router.get("/", getSubscriptions);
router.put("/", upsertSubscription);

module.exports = router;
