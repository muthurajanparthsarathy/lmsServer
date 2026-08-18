const User = require("../../models/UserModel");
const Role = require("../../models/RoleModel");
const RoleModulePermission = require("../../models/superadmin/RoleModulePermissionModel");
const { getSuperAdminPermissions } = require("../../utils/superAdminPermissions");
const { LOCKED_PERMISSION_KEYS } = require("../../config/superadmin/lockedPermissionKeys");
const { isHiddenInstitution } = require("../../config/superadmin/hiddenInstitutions");

// GET /superadmin/permissions?institution=&role=
// Merges the full module catalog with whatever this (institution, role) has
// saved so far — unsaved combinations simply show every non-locked module
// off. Also returns how many existing users would be touched by a save, so
// the client can show an affected-count confirmation before applying.
exports.getRolePermissions = async (req, res) => {
  try {
    const { institution, role } = req.query;
    if (!institution || !role) {
      return res.status(400).json({ message: [{ key: "error", value: "institution and role are required" }] });
    }
    if (isHiddenInstitution(institution)) {
      return res.status(404).json({ message: [{ key: "error", value: "Institution not found" }] });
    }

    const roleDoc = await Role.findById(role);
    if (!roleDoc || String(roleDoc.institution) !== String(institution)) {
      return res.status(400).json({ message: [{ key: "error", value: "Invalid role for this institution" }] });
    }

    const catalog = getSuperAdminPermissions();
    const saved = await RoleModulePermission.findOne({ institution, role }).lean();
    const savedByKey = new Map((saved?.modules || []).map((m) => [m.permissionKey, m]));

    const modules = catalog.map((mod) => {
      const isLocked = LOCKED_PERMISSION_KEYS.includes(mod.permissionKey);
      const savedEntry = savedByKey.get(mod.permissionKey);
      return {
        ...mod,
        isActive: isLocked ? true : savedEntry ? !!savedEntry.isActive : false,
        locked: isLocked,
      };
    });

    const affectedUserCount = await User.countDocuments({ institution, role });

    return res.status(200).json({
      message: [{ key: "success", value: "Permissions retrieved successfully" }],
      modules,
      affectedUserCount,
      lastUpdatedAt: saved?.updatedAt || null,
    });
  } catch (error) {
    console.error("superadmin getRolePermissions error:", error);
    return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};

// PUT /superadmin/permissions
// body: { institution, role, modules: [{ permissionKey, isActive }] }
// Saves the (institution, role) mapping, then propagates the resolved module
// set into the embedded permissions[] of every existing LMS-User with that
// institution+role — the exact shape the existing LMS read path
// (GET /user/get-permission/:userId → hasPermission()) already expects.
// The LMS read path itself is never modified.
exports.saveRolePermissions = async (req, res) => {
  try {
    const { institution, role, modules: requestedModules } = req.body;
    if (!institution || !role || !Array.isArray(requestedModules)) {
      return res.status(400).json({
        message: [{ key: "error", value: "institution, role and modules[] are required" }],
      });
    }
    if (isHiddenInstitution(institution)) {
      return res.status(404).json({ message: [{ key: "error", value: "Institution not found" }] });
    }

    const roleDoc = await Role.findById(role);
    if (!roleDoc || String(roleDoc.institution) !== String(institution)) {
      return res.status(400).json({ message: [{ key: "error", value: "Invalid role for this institution" }] });
    }

    const requestedByKey = new Map(requestedModules.map((m) => [m.permissionKey, !!m.isActive]));
    const catalog = getSuperAdminPermissions();

    // Locked modules are force-enabled regardless of what the client sent.
    const resolvedModules = catalog.map((mod) => ({
      permissionKey: mod.permissionKey,
      permissionName: mod.permissionName,
      permissionFunctionality: mod.permissionFunctionality,
      icon: mod.icon,
      color: mod.color,
      description: mod.description,
      order: mod.order,
      isActive: LOCKED_PERMISSION_KEYS.includes(mod.permissionKey)
        ? true
        : requestedByKey.get(mod.permissionKey) || false,
    }));

    await RoleModulePermission.findOneAndUpdate(
      { institution, role },
      { institution, role, modules: resolvedModules, updatedBy: req.superAdmin?.email || "superadmin" },
      { upsert: true, new: true }
    );

    // Enabled modules to apply, in the exact permissionItemSchema shape the
    // LMS already reads (models/UserModel.js). The dashboard module is applied
    // PER-USER below (not here) so each user keeps their role-appropriate
    // landing page — student/staff/admin dashboards are never swapped.
    const DASHBOARD_RE = /dashboard$/i;
    const toEmbedded = (m) => ({
      permissionName: m.permissionName,
      permissionKey: m.permissionKey,
      permissionFunctionality: m.permissionFunctionality,
      icon: m.icon,
      color: m.color,
      description: m.description,
      isActive: true,
      order: m.order,
    });
    const appliedModules = resolvedModules
      .filter((m) => m.isActive && !DASHBOARD_RE.test(m.permissionKey))
      .map(toEmbedded);

    // Fallback dashboard only for a user who somehow has none today.
    const fallbackDashboard = toEmbedded(
      resolvedModules.find((m) => m.permissionKey === "admindashboard")
    );

    // Per-user propagation: preserve each user's existing dashboard-family
    // permission(s), then set the resolved non-dashboard modules.
    const users = await User.find({ institution, role }).select("permissions").lean();
    const ops = users.map((u) => {
      const existingDashboards = (u.permissions || []).filter((p) => DASHBOARD_RE.test(p.permissionKey));
      const dashboards = existingDashboards.length ? existingDashboards : [fallbackDashboard];
      return {
        updateOne: {
          filter: { _id: u._id },
          update: { $set: { permissions: [...dashboards, ...appliedModules] } },
        },
      };
    });

    let affectedUsers = 0;
    if (ops.length) {
      const result = await User.bulkWrite(ops);
      affectedUsers = result.modifiedCount ?? ops.length;
    }

    return res.status(200).json({
      message: [{ key: "success", value: "Permissions saved and applied successfully" }],
      modules: resolvedModules,
      affectedUsers,
    });
  } catch (error) {
    console.error("superadmin saveRolePermissions error:", error);
    return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};
