const mongoose = require("mongoose");

// Separate token allow-list for the Super Admin console — deliberately NOT the
// LMS's `tokenModal` (models/tokenModal.js). Keeping them apart means a Super
// Admin token is simply never found by the LMS's userAuth middleware, so an
// LMS route rejects it with a clean 401 instead of verifying it and running
// into the LMS's user-lookup path. Full auth-domain isolation, zero changes to
// existing LMS code.
const superAdminTokenSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true },
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 259200, // 3 days — matches the super-admin JWT TTL
  },
});

module.exports = mongoose.model("SuperAdmin-Token", superAdminTokenSchema);
