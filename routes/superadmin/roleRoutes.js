const express = require("express");
const router = express.Router();
const { superAdminGuard } = require("../../middlewares/superadmin/superAdminGuard");
const { getAllRoles, createRole, updateRole, deleteRole } = require("../../controllers/superadmin/roleController");

router.use(superAdminGuard);

router.get("/", getAllRoles);
router.post("/", createRole);
router.put("/:id", updateRole);
router.delete("/:id", deleteRole);

module.exports = router;
