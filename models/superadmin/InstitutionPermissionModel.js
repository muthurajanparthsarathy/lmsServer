const mongoose = require("mongoose");

// Per-institution permission allow-list, set by the Super Admin via
// Clients → Permission Management. Holds the permissions each role category
// (student / staff / admin) may use in this institution — the Add User /
// Assign Permission modals are limited to this set. One doc per institution.
// `id` is the permission modal's catalog id (e.g. "admin-usermanagement") and
// is what the client filters by, so it is stored alongside the embedded shape.
const permissionItemSchema = new mongoose.Schema(
  {
    id: { type: String },
    permissionName: { type: String },
    permissionKey: { type: String },
    permissionFunctionality: [{ type: String }],
    icon: { type: String, default: "Shield" },
    color: { type: String, default: "blue" },
    description: { type: String, default: "" },
    isActive: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
  },
  { _id: false }
);

const institutionPermissionSchema = new mongoose.Schema(
  {
    institution: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LMS-Institution",
      required: true,
      unique: true,
    },
    permissions: [permissionItemSchema],
    updatedBy: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model("client-InstitutionPermission", institutionPermissionSchema);
