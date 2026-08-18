// ─── requireProctor middleware ──────────────────────────────────────────────
// Place AFTER userAuth (which populates req.user). Blocks students from the
// Live Screens REST endpoints; allows admin / coordinator / faculty / staff.
const { isProctorUser } = require("../utils/proctorAccess");

module.exports.requireProctor = async (req, res, next) => {
  try {
    const userId = req.user?._id || req.user?.id;
    const ok = await isProctorUser(userId);
    if (!ok) {
      return res.status(403).json({
        message: [{ key: "error", value: "Not authorized to view live screens" }],
      });
    }
    next();
  } catch (err) {
    console.error("requireProctor error:", err.message);
    return res.status(500).json({
      message: [{ key: "error", value: "Authorization check failed" }],
    });
  }
};
