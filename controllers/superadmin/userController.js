const User = require("../../models/UserModel");
const Role = require("../../models/RoleModel");
const Institution = require("../../models/InstitutionModal");
const { isHiddenInstitution } = require("../../config/superadmin/hiddenInstitutions");
const { getSuperAdminPermissions } = require("../../utils/superAdminPermissions");
const { LOCKED_PERMISSION_KEYS } = require("../../config/superadmin/lockedPermissionKeys");

// Base permissions every new user gets regardless of role — the always-on
// modules (see architecture doc section 3), pulled from the same catalog
// Permission Management uses so shape/icon/color never drift out of sync.
// Full role-driven module permissions are assigned afterwards via
// Permission Management (RoleModulePermission), which propagates into this
// same embedded shape.
const BASE_PERMISSIONS = getSuperAdminPermissions()
  .filter((p) => LOCKED_PERMISSION_KEYS.includes(p.permissionKey))
  .map((p) => ({ ...p, isActive: true }));

// Coerce a rich permissions payload (produced by the shared LMS PermissionModal
// — Assign Permission / Add User) into the exact embedded permissionItemSchema
// shape UserModel stores. Drops any client-only fields (e.g. `id`) and applies
// safe defaults so a malformed entry can't fail schema validation.
const sanitizePermissions = (arr) =>
  (Array.isArray(arr) ? arr : [])
    .filter((p) => p && p.permissionKey && p.permissionName)
    .map((p, i) => ({
      permissionName: String(p.permissionName),
      permissionKey: String(p.permissionKey),
      permissionFunctionality: Array.isArray(p.permissionFunctionality)
        ? p.permissionFunctionality.map(String)
        : [],
      icon: p.icon || "Shield",
      color: p.color || "blue",
      description: p.description || "",
      isActive: p.isActive !== false,
      order: typeof p.order === "number" ? p.order : i,
    }));

// Same institution-scoped human-readable id the existing Addusers flow uses
// (controllers/userAuth.js generateUserIdForInstitution) so both entry
// points share one sequence per institution.
const buildInstitutionPrefix = (instName) => {
  if (!instName || typeof instName !== "string") return "INS";
  const cleaned = instName.replace(/[^A-Za-z\s]/g, "").trim();
  if (!cleaned) return "INS";
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return words.map((w) => w[0].toUpperCase()).join("").slice(0, 4);
  return words[0].slice(0, 3).toUpperCase();
};

const generateUserIdForInstitution = async (institutionId) => {
  const updated = await Institution.findOneAndUpdate(
    { _id: institutionId },
    { $inc: { userIdCounter: 1 } },
    { new: true }
  );
  if (!updated) return null;
  const prefix = buildInstitutionPrefix(updated.inst_name);
  const seq = String(updated.userIdCounter).padStart(4, "0");
  return `${prefix}${seq}`;
};

exports.getAllUsers = async (req, res) => {
  try {
    const { institution } = req.query;
    if (!institution) {
      return res.status(400).json({ message: [{ key: "error", value: "institution is required" }] });
    }
    if (isHiddenInstitution(institution)) {
      return res.status(404).json({ message: [{ key: "error", value: "Institution not found" }] });
    }

    const users = await User.find({ institution })
      .select("-password -tokens -notes -ai_history -courses")
      .populate("role", "originalRole renameRole roleValue")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      message: [{ key: "success", value: "Users retrieved successfully" }],
      users,
    });
  } catch (error) {
    console.error("superadmin getAllUsers error:", error);
    return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};

exports.createUser = async (req, res) => {
  try {
    const { institution, role, firstName, lastName, email, phone, password, status, permissions: rawPermissions } = req.body;

    if (!institution || !role || !firstName || !email || !phone || !password) {
      return res.status(400).json({
        message: [{ key: "error", value: "Institution, role, name, email, phone and password are required" }],
      });
    }
    if (isHiddenInstitution(institution)) {
      return res.status(404).json({ message: [{ key: "error", value: "Institution not found" }] });
    }

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(403).json({ message: [{ key: "error", value: "A user with this email already exists" }] });
    }

    const roleDoc = await Role.findById(role);
    if (!roleDoc || String(roleDoc.institution) !== String(institution)) {
      return res.status(400).json({ message: [{ key: "error", value: "Invalid role for this institution" }] });
    }

    const userId = await generateUserIdForInstitution(institution);

    // Per-user permissions: the rich permissions[] payload from the shared
    // PermissionModal, or the always-on base set when none is sent.
    const permissions = Array.isArray(rawPermissions) && rawPermissions.length
      ? sanitizePermissions(rawPermissions)
      : BASE_PERMISSIONS;

    const user = await User.create({
      institution,
      role,
      firstName,
      lastName: lastName || "",
      email,
      phone,
      password, // hashed by UserModel's pre-save hook
      status: status || "active",
      permissions,
      userId,
      createdBy: req.superAdmin?.email || "superadmin",
    });

    return res.status(201).json({
      message: [{ key: "success", value: "User created successfully" }],
      user: {
        _id: user._id,
        userId: user.userId,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        status: user.status,
        institution: user.institution,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("superadmin createUser error:", error);
    if (error.name === "ValidationError") {
      return res.status(400).json({
        message: Object.keys(error.errors).map((key) => ({ key, value: error.errors[key].message })),
      });
    }
    return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};

exports.updateUser = async (req, res) => {
  try {
    const { firstName, lastName, phone, role, status } = req.body;
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: [{ key: "error", value: "User not found" }] });
    }

    if (role) {
      const roleDoc = await Role.findById(role);
      if (!roleDoc || String(roleDoc.institution) !== String(user.institution)) {
        return res.status(400).json({ message: [{ key: "error", value: "Invalid role for this institution" }] });
      }
      user.role = role;
    }

    user.firstName = firstName || user.firstName;
    user.lastName = lastName ?? user.lastName;
    user.phone = phone || user.phone;
    user.status = status || user.status;
    await user.save();

    return res.status(200).json({
      message: [{ key: "success", value: "User updated successfully" }],
      user: {
        _id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        phone: user.phone,
        status: user.status,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("superadmin updateUser error:", error);
    return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};

exports.deleteUser = async (req, res) => {
  try {
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) {
      return res.status(404).json({ message: [{ key: "error", value: "User not found" }] });
    }
    return res.status(200).json({ message: [{ key: "success", value: "User deleted successfully" }] });
  } catch (error) {
    console.error("superadmin deleteUser error:", error);
    return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};

exports.updateUserStatus = async (req, res) => {
  try {
    const { status } = req.body;
    if (!["active", "inactive"].includes(status)) {
      return res.status(400).json({ message: [{ key: "error", value: "status must be active or inactive" }] });
    }

    const user = await User.findByIdAndUpdate(req.params.id, { status }, { new: true }).select("_id status");
    if (!user) {
      return res.status(404).json({ message: [{ key: "error", value: "User not found" }] });
    }

    return res.status(200).json({ message: [{ key: "success", value: "Status updated successfully" }], user });
  } catch (error) {
    console.error("superadmin updateUserStatus error:", error);
    return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};

// GET /superadmin/users/:id/permissions
// Returns a user's embedded permissions[] so the shared PermissionModal can
// preselect them (Assign Permission). Superadmin-authenticated equivalent of
// the LMS GET /user/get-permission/:userId used by the same modal in the LMS.
exports.getUserPermissions = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select("permissions firstName lastName email").lean();
    if (!user) {
      return res.status(404).json({ message: [{ key: "error", value: "User not found" }] });
    }
    return res.status(200).json({
      message: [{ key: "success", value: "Permissions retrieved successfully" }],
      permissions: user.permissions || [],
    });
  } catch (error) {
    console.error("superadmin getUserPermissions error:", error);
    return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};

// PUT /superadmin/users/:id/permissions   body: { permissions: [...] }
// Overwrites a user's embedded permissions[] with the modal's selection.
// Superadmin-authenticated equivalent of the LMS PUT /user-permission/update.
exports.updateUserPermissions = async (req, res) => {
  try {
    const { permissions } = req.body;
    if (!Array.isArray(permissions)) {
      return res.status(400).json({ message: [{ key: "error", value: "permissions[] is required" }] });
    }
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: [{ key: "error", value: "User not found" }] });
    }
    user.permissions = sanitizePermissions(permissions);
    await user.save();
    return res.status(200).json({ message: [{ key: "success", value: "Permissions updated successfully" }] });
  } catch (error) {
    console.error("superadmin updateUserPermissions error:", error);
    if (error.name === "ValidationError") {
      return res.status(400).json({
        message: Object.keys(error.errors).map((key) => ({ key, value: error.errors[key].message })),
      });
    }
    return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};
