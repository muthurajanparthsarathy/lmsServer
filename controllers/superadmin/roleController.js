const Role = require("../../models/RoleModel");
const User = require("../../models/UserModel");

// Unlike controllers/role.js (existing), the Super Admin isn't scoped to one
// institution via req.user — institution is always an explicit param here.
exports.getAllRoles = async (req, res) => {
  try {
    const { institution } = req.query;
    if (!institution) {
      return res.status(400).json({ message: [{ key: "error", value: "institution is required" }] });
    }

    const roles = await Role.find({ institution }).sort({ createdAt: -1 });
    return res.status(200).json({
      message: [{ key: "success", value: "Roles retrieved successfully" }],
      roles,
    });
  } catch (error) {
    console.error("superadmin getAllRoles error:", error);
    return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};

exports.createRole = async (req, res) => {
  try {
    const { institution, originalRole, renameRole, roleValue } = req.body;
    if (!institution || !originalRole) {
      return res.status(400).json({ message: [{ key: "error", value: "institution and originalRole are required" }] });
    }

    const role = new Role({
      institution,
      originalRole,
      renameRole: renameRole || originalRole,
      roleValue: roleValue || originalRole.toLowerCase().replace(/\s+/g, "_"),
      createdBy: req.superAdmin?.email || "superadmin",
    });
    await role.save();

    return res.status(201).json({
      message: [{ key: "success", value: "Role created successfully" }],
      role,
    });
  } catch (error) {
    console.error("superadmin createRole error:", error);
    return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};

exports.updateRole = async (req, res) => {
  try {
    const { originalRole, renameRole, roleValue } = req.body;
    const role = await Role.findById(req.params.id);
    if (!role) {
      return res.status(404).json({ message: [{ key: "error", value: "Role not found" }] });
    }

    role.originalRole = originalRole || role.originalRole;
    role.renameRole = renameRole || role.renameRole;
    role.roleValue = roleValue || role.roleValue;
    await role.save();

    return res.status(200).json({
      message: [{ key: "success", value: "Role updated successfully" }],
      role,
    });
  } catch (error) {
    console.error("superadmin updateRole error:", error);
    return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};

exports.deleteRole = async (req, res) => {
  try {
    const role = await Role.findById(req.params.id);
    if (!role) {
      return res.status(404).json({ message: [{ key: "error", value: "Role not found" }] });
    }

    const userCount = await User.countDocuments({ role: role._id });
    if (userCount > 0) {
      return res.status(409).json({
        message: [{ key: "error", value: `Cannot delete: ${userCount} user(s) still have this role` }],
      });
    }

    await Role.findByIdAndDelete(req.params.id);
    return res.status(200).json({ message: [{ key: "success", value: "Role deleted successfully" }] });
  } catch (error) {
    console.error("superadmin deleteRole error:", error);
    return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};
