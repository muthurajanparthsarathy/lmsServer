const mongoose = require("mongoose");

// One entry per toggleable module for a given (institution, role) pair — the
// role-level source of truth the existing LMS never had (it only stores
// permissions per-user, seeded once at creation; see docs/ARCHITECTURE.md
// section 3). Saving here propagates the resolved set into every matching
// LMS-User's embedded `permissions[]`, in the exact shape the LMS already
// reads — the LMS read path itself is never touched.
const moduleEntrySchema = new mongoose.Schema(
  {
    permissionKey: { type: String, required: true },
    permissionName: { type: String, required: true },
    permissionFunctionality: [{ type: String }],
    icon: { type: String, default: "Shield" },
    color: { type: String, default: "blue" },
    description: { type: String, default: "" },
    isActive: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
  },
  { _id: false }
);

const roleModulePermissionSchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: "LMS-Institution", required: true },
    role: { type: mongoose.Schema.Types.ObjectId, ref: "Role", required: true },
    modules: [moduleEntrySchema],
    updatedBy: { type: String },
  },
  { timestamps: true }
);

roleModulePermissionSchema.index({ institution: 1, role: 1 }, { unique: true });

module.exports = mongoose.model("client-RolePermission", roleModulePermissionSchema);
