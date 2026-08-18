const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const config = require("config");
const JWT_TOKEN_KEY = config.get("JWT_TOKEN_KEY");

const SuperAdminUser = require("../../models/superadmin/SuperAdminUserModel");
const SuperAdminToken = require("../../models/superadmin/SuperAdminTokenModel");

// Signs a token scoped to the super-admin domain — deliberately not reusing
// config/secretToken.js's createSecretToken, since that helper always signs
// a scope-less payload and existing LMS callers rely on that shape unchanged.
const createSuperAdminToken = (id) =>
  jwt.sign({ id, scope: "superadmin" }, JWT_TOKEN_KEY, { expiresIn: "3d" });

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        message: [{ key: "error", value: "Email and password are required" }],
      });
    }

    const superAdmin = await SuperAdminUser.findOne({ email: email.toLowerCase() });
    if (!superAdmin) {
      return res.status(400).json({
        message: [{ key: "error", value: "Email is invalid" }],
      });
    }

    if (superAdmin.status !== "active") {
      return res.status(403).json({
        message: [{ key: "error", value: "This account is inactive" }],
      });
    }

    const auth = await bcrypt.compare(password, superAdmin.password);
    if (!auth) {
      return res.status(400).json({
        message: [{ key: "error", value: "Password is incorrect" }],
      });
    }

    const token = createSuperAdminToken(superAdmin._id);
    // Same-second re-logins can regenerate an identical JWT; upsert so the
    // unique index doesn't reject a valid token.
    await SuperAdminToken.updateOne({ token }, { $setOnInsert: { token } }, { upsert: true });

    superAdmin.lastLoginAt = new Date();
    await superAdmin.save();

    return res.status(200).json({
      message: [{ key: "success", value: "Logged in successfully" }],
      token,
      superAdmin: {
        _id: superAdmin._id,
        name: superAdmin.name,
        email: superAdmin.email,
        phone: superAdmin.phone,
        status: superAdmin.status,
      },
    });
  } catch (error) {
    console.error("superadmin login error:", error);
    return res.status(500).json({
      message: [{ key: "error", value: "Internal server error" }],
    });
  }
};

exports.logout = async (req, res) => {
  try {
    if (req.superAdminToken) {
      await SuperAdminToken.deleteOne({ token: req.superAdminToken });
    }
    return res.status(200).json({
      message: [{ key: "success", value: "Logged out successfully" }],
    });
  } catch (error) {
    console.error("superadmin logout error:", error);
    return res.status(500).json({
      message: [{ key: "error", value: "Internal server error" }],
    });
  }
};

exports.me = async (req, res) => {
  const superAdmin = req.superAdmin;
  return res.status(200).json({
    superAdmin: {
      _id: superAdmin._id,
      name: superAdmin.name,
      email: superAdmin.email,
      phone: superAdmin.phone,
      status: superAdmin.status,
      lastLoginAt: superAdmin.lastLoginAt,
    },
  });
};

exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        message: [{ key: "error", value: "Current and new password are required" }],
      });
    }

    const superAdmin = req.superAdmin;
    const auth = await bcrypt.compare(currentPassword, superAdmin.password);
    if (!auth) {
      return res.status(400).json({
        message: [{ key: "error", value: "Current password is incorrect" }],
      });
    }

    superAdmin.password = newPassword; // re-hashed by the pre-save hook
    await superAdmin.save();

    return res.status(200).json({
      message: [{ key: "success", value: "Password updated successfully" }],
    });
  } catch (error) {
    console.error("superadmin changePassword error:", error);
    return res.status(500).json({
      message: [{ key: "error", value: "Internal server error" }],
    });
  }
};
