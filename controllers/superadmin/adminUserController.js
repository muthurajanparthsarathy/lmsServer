const SuperAdminUser = require("../../models/superadmin/SuperAdminUserModel");

// Platform-owner (Super Admin) account management. Distinct from the
// institution user controller (controllers/superadmin/userController.js) —
// these are the accounts that log into the Super Admin console itself.
const publicShape = (admin) => ({
  _id: admin._id,
  name: admin.name,
  email: admin.email,
  phone: admin.phone,
  status: admin.status,
  lastLoginAt: admin.lastLoginAt,
  createdAt: admin.createdAt,
});

exports.getAllAdmins = async (req, res) => {
  try {
    const admins = await SuperAdminUser.find().select("-password").sort({ createdAt: -1 });
    return res.status(200).json({
      message: [{ key: "success", value: "Super admins retrieved successfully" }],
      admins,
    });
  } catch (error) {
    console.error("superadmin getAllAdmins error:", error);
    return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};

exports.createAdmin = async (req, res) => {
  try {
    const { name, email, phone, password, status } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ message: [{ key: "error", value: "Name, email and password are required" }] });
    }

    const existing = await SuperAdminUser.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(403).json({ message: [{ key: "error", value: "A super admin with this email already exists" }] });
    }

    const admin = await SuperAdminUser.create({
      name,
      email,
      phone: phone || "",
      password, // hashed by the model's pre-save hook
      status: status || "active",
    });

    return res.status(201).json({
      message: [{ key: "success", value: "Super admin created successfully" }],
      admin: publicShape(admin),
    });
  } catch (error) {
    console.error("superadmin createAdmin error:", error);
    if (error.name === "ValidationError") {
      return res.status(400).json({
        message: Object.keys(error.errors).map((key) => ({ key, value: error.errors[key].message })),
      });
    }
    return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};

exports.updateAdmin = async (req, res) => {
  try {
    const { name, phone, status, password } = req.body;
    const admin = await SuperAdminUser.findById(req.params.id);
    if (!admin) {
      return res.status(404).json({ message: [{ key: "error", value: "Super admin not found" }] });
    }

    if (name !== undefined) admin.name = name;
    if (phone !== undefined) admin.phone = phone;
    if (status !== undefined) admin.status = status;
    if (password) admin.password = password; // re-hashed by the pre-save hook
    await admin.save();

    return res.status(200).json({
      message: [{ key: "success", value: "Super admin updated successfully" }],
      admin: publicShape(admin),
    });
  } catch (error) {
    console.error("superadmin updateAdmin error:", error);
    if (error.name === "ValidationError") {
      return res.status(400).json({
        message: Object.keys(error.errors).map((key) => ({ key, value: error.errors[key].message })),
      });
    }
    return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};

exports.updateAdminStatus = async (req, res) => {
  try {
    const { status } = req.body;
    if (!["active", "inactive"].includes(status)) {
      return res.status(400).json({ message: [{ key: "error", value: "status must be active or inactive" }] });
    }
    if (status === "inactive" && String(req.superAdmin?._id) === String(req.params.id)) {
      return res.status(400).json({ message: [{ key: "error", value: "You cannot deactivate your own account" }] });
    }

    const admin = await SuperAdminUser.findByIdAndUpdate(req.params.id, { status }, { new: true }).select("_id status");
    if (!admin) {
      return res.status(404).json({ message: [{ key: "error", value: "Super admin not found" }] });
    }
    return res.status(200).json({ message: [{ key: "success", value: "Status updated successfully" }], admin });
  } catch (error) {
    console.error("superadmin updateAdminStatus error:", error);
    return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};

exports.deleteAdmin = async (req, res) => {
  try {
    if (String(req.superAdmin?._id) === String(req.params.id)) {
      return res.status(400).json({ message: [{ key: "error", value: "You cannot delete your own account" }] });
    }
    const count = await SuperAdminUser.countDocuments();
    if (count <= 1) {
      return res.status(400).json({ message: [{ key: "error", value: "Cannot delete the last super admin" }] });
    }

    const admin = await SuperAdminUser.findByIdAndDelete(req.params.id);
    if (!admin) {
      return res.status(404).json({ message: [{ key: "error", value: "Super admin not found" }] });
    }
    return res.status(200).json({ message: [{ key: "success", value: "Super admin deleted successfully" }] });
  } catch (error) {
    console.error("superadmin deleteAdmin error:", error);
    return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};
