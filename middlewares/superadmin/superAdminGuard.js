const config = require("config");
const jwt = require("jsonwebtoken");
const JWT_TOKEN_KEY = config.get("JWT_TOKEN_KEY");
const SuperAdminUser = require("../../models/superadmin/SuperAdminUserModel");
const SuperAdminToken = require("../../models/superadmin/SuperAdminTokenModel");

// Mirrors the existing middlewares/userAuth.js mechanics (bearer token,
// DB-backed allow-list, jwt.verify) but additionally requires
// payload.scope === "superadmin", so an LMS user token can never pass here
// and a super-admin token can never pass the existing userAuth middleware.
module.exports.superAdminGuard = async (req, res, next) => {
  const bearerHeader = req.headers["authorization"];
  let token = "";

  if (bearerHeader) {
    const bearer = bearerHeader.split(" ");
    token = bearer[1];
  }

  if (!token) {
    return res.status(401).json({
      message: [{ key: "error", value: "Not logged in" }],
    });
  }

  try {
    const tokenDoc = await SuperAdminToken.findOne({ token });
    if (!tokenDoc) {
      return res.status(401).json({
        message: [{ key: "error", value: "Invalid or expired token" }],
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_TOKEN_KEY);
    } catch (err) {
      await SuperAdminToken.deleteOne({ token });
      return res.status(401).json({
        message: [{ key: "error", value: "Invalid token" }],
      });
    }

    if (decoded.scope !== "superadmin") {
      return res.status(401).json({
        message: [{ key: "error", value: "This token is not authorized for the Super Admin module" }],
      });
    }

    const superAdmin = await SuperAdminUser.findById(decoded.id);
    if (!superAdmin || superAdmin.status !== "active") {
      await SuperAdminToken.deleteOne({ token });
      return res.status(401).json({
        message: [{ key: "error", value: "Super Admin account not found or inactive" }],
      });
    }

    req.superAdmin = superAdmin;
    req.superAdminToken = token;
    next();
  } catch (error) {
    console.error("Error in superAdminGuard middleware:", error);
    return res.status(500).json({
      message: [{ key: "error", value: "Internal server error" }],
    });
  }
};
