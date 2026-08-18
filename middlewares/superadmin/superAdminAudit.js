const AuditLog = require("../../models/superadmin/SuperAdminAuditLogModel");

// Records a Super Admin action after the response is sent. Attach to mutating
// routes: superAdminAudit("institution.create"). Fire-and-forget — never
// blocks or fails the request. Only records mutations that succeeded (2xx).
const superAdminAudit = (action, summaryFn) => (req, res, next) => {
  res.on("finish", () => {
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    try {
      const rawIp = (req.headers["x-forwarded-for"] || "").split(",")[0].trim()
        || req.socket?.remoteAddress || req.ip || "";
      AuditLog.create({
        actorId: req.superAdmin?._id,
        actorEmail: req.superAdmin?.email || "",
        action,
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        summary: typeof summaryFn === "function" ? summaryFn(req) : "",
        targetId: req.params?.id || req.body?.institution || "",
        ipAddress: /^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/.test(rawIp) ? "localhost" : rawIp,
        userAgent: req.headers["user-agent"] || "",
      }).catch(() => {});
    } catch {
      /* never let auditing break a request */
    }
  });
  next();
};

module.exports = { superAdminAudit };
