const mongoose = require("mongoose");

// Cross-tenant audit trail for platform-owner actions. Separate from the
// existing ActivityLog (which is tenant-user activity) because super-admin
// actions span institutions and reference a SuperAdmin-User actor, not an
// LMS-User. New collection — no impact on existing logging.
const superAdminAuditLogSchema = new mongoose.Schema(
  {
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "SuperAdmin-User" },
    actorEmail: { type: String, default: "" },

    action: { type: String, required: true }, // e.g. "institution.create", "permission.save"
    method: { type: String, default: "" }, // HTTP method
    path: { type: String, default: "" }, // request path
    statusCode: { type: Number, default: 0 },

    // Small, non-sensitive summary of what changed (never stores passwords).
    summary: { type: String, default: "" },
    targetId: { type: String, default: "" },

    ipAddress: { type: String, default: "" },
    userAgent: { type: String, default: "" },
  },
  { timestamps: true }
);

superAdminAuditLogSchema.index({ createdAt: -1 });
superAdminAuditLogSchema.index({ action: 1, createdAt: -1 });

module.exports = mongoose.model("SuperAdmin-AuditLog", superAdminAuditLogSchema);
