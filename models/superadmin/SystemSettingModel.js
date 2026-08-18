const mongoose = require("mongoose");

// Platform-level configuration — a single settings document (singleton).
// New collection; the existing LMS reads none of this, so it is purely
// additive and cannot cause regressions.
const systemSettingSchema = new mongoose.Schema(
  {
    scope: { type: String, default: "global", unique: true },

    platformName: { type: String, default: "Enterprise LMS" },
    supportEmail: { type: String, default: "" },

    // Access / security posture
    maintenanceMode: { type: Boolean, default: false },
    allowInstitutionSelfSignup: { type: Boolean, default: false },
    sessionTimeoutMinutes: { type: Number, default: 2880 }, // 2 days, matches token TTL
    passwordMinLength: { type: Number, default: 8 },
    enforceStrongPassword: { type: Boolean, default: true },

    // Notification channels
    emailNotificationsEnabled: { type: Boolean, default: true },

    updatedBy: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model("SuperAdmin-SystemSetting", systemSettingSchema);
