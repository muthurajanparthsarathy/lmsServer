const Role = require("../models/RoleModel");
const { isSuperAdminRoleName } = require("../utils/superAdminPermissions");

// Normalize role names so "Super Admin", "super_admin" and "superadmin"
// all compare equal.
const normalizeRoleName = (name) =>
  String(name || "").toLowerCase().replace(/[\s_-]+/g, "_");

// req.user.role is an ObjectId (userAuth does not populate it), so the role
// document is resolved here and compared by roleValue/renameRole/originalRole.
const userRole = (allowedRoles) => {
  const allowed = allowedRoles.map(normalizeRoleName);

  return async (req, res, next) => {
    try {
      const user = req.user;

      if (!user || !user.role) {
        return res.status(403).json({ message: [{ key: 'error', value: 'Access denied' }] });
      }

      // Support both a populated role object and a raw ObjectId.
      const roleDoc = user.role.roleValue || user.role.originalRole
        ? user.role
        : await Role.findById(user.role).select("originalRole renameRole roleValue").lean();

      if (!roleDoc) {
        return res.status(403).json({ message: [{ key: 'error', value: 'Access denied' }] });
      }

      const rawNames = [roleDoc.roleValue, roleDoc.renameRole, roleDoc.originalRole].filter(Boolean);
      const names = rawNames.map(normalizeRoleName);

      if (names.some((name) => allowed.includes(name))) {
        return next();
      }

      // "super_admin" also accepts any super-admin-style role name
      // ("Super Administrator", "superadmin", …) via the shared matcher.
      if (allowed.includes("super_admin") && rawNames.some(isSuperAdminRoleName)) {
        return next();
      }

      return res.status(403).json({ message: [{ key: 'error', value: 'Access denied' }] });
    } catch (error) {
      console.error("Error in userRole middleware:", error);
      return res.status(500).json({ message: [{ key: 'error', value: 'Internal server error' }] });
    }
  };
};

module.exports = { userRole };
