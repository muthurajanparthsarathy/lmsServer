// ─── Proctor access check ───────────────────────────────────────────────────
// Role-based access for the Live Screen Monitoring feature. The JWT only
// carries the user id (see config/secretToken.js), so role MUST be resolved
// from the database. Rule (per product decision): anyone who is NOT a student
// (admin / coordinator / faculty / staff …) may view student screens.
//
// Shared by the REST middleware (requireProctor) and the socket handlers
// (liveScreenSocket) so both enforce the exact same rule. Results are cached
// briefly to avoid a DB round-trip on every socket signaling event.

const User = require("../models/UserModel");
const Role = require("../models/RoleModel");

const TTL_MS = 60 * 1000;
const cache = new Map(); // userId -> { isProctor, ts }

async function isProctorUser(userId) {
  if (!userId) return false;
  const key = String(userId);

  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.isProctor;

  let isProctor = false;
  try {
    const user = await User.findById(key).select("role").lean();
    if (user && user.role) {
      const role = await Role.findById(user.role)
        .select("originalRole renameRole roleValue")
        .lean();
      const name = (role?.renameRole || role?.originalRole || role?.roleValue || "")
        .toString()
        .toLowerCase()
        .trim();
      // Any assigned, non-student role is allowed to proctor.
      isProctor = !!name && name !== "student";
    }
  } catch (e) {
    console.error("isProctorUser error:", e.message);
    isProctor = false;
  }

  cache.set(key, { isProctor, ts: Date.now() });
  return isProctor;
}

module.exports = { isProctorUser };
