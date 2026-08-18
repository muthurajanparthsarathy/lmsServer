// Modules that are always available and can never be disabled for any role
// (see docs/ARCHITECTURE.md section 3 — "Default permissions always
// available: Dashboard, Profile, Change Password"). Keys must match entries
// in utils/superAdminPermissions.js's catalog. There is no separate
// "Change Password" page in the LMS today — it lives inside Profile — so
// only these two real catalog keys are locked.
const LOCKED_PERMISSION_KEYS = ["admindashboard", "profile"];

module.exports = { LOCKED_PERMISSION_KEYS };
