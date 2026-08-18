const AuditLog = require("../../models/superadmin/SuperAdminAuditLogModel");
const ActivityLog = require("../../models/ActivityLog");

exports.getAuditLogs = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const logs = await AuditLog.find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return res.status(200).json({
      message: [{ key: "success", value: "Audit logs retrieved" }],
      logs,
    });
  } catch (error) {
    console.error("superadmin getAuditLogs error:", error);
    return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};

// GET /superadmin/audit-logs/logins
// Returns LMS user login sessions (login action only, most recent first) so the
// Super Admin console can search/audit who signed in — same data the LMS staff
// logs page consumes, but behind the super-admin guard. Course activity is
// intentionally excluded.
exports.getLoginLogs = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 500, 1000);
    const logs = await ActivityLog.find({ action: "login" })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return res.status(200).json({
      message: [{ key: "success", value: "Login logs retrieved" }],
      data: logs,
    });
  } catch (error) {
    console.error("superadmin getLoginLogs error:", error);
    return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};
