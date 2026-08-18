// Seed (or upgrade) the Super Admin for an institution.
//
// Creates idempotently:
//   • A "Super Admin" role (roleValue: super_admin) for the institution
//   • A user with that role and the FULL permission catalog
//     (utils/superAdminPermissions.js) — every sidebar module unlocked.
//
// If the email already exists, the user is upgraded in place: role switched
// to Super Admin, permissions replaced with the full catalog, status active.
// The password of an existing user is NOT changed.
//
// Run from the Server folder:
//   node scripts/seedSuperAdmin.js <email> [password]
//   node scripts/seedSuperAdmin.js <email> [password] --institution <idOrName>
//
// Password default for NEW users: Admin@123 (change after first login).
// --institution is optional when exactly one institution exists.

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");

const User = require("../models/UserModel");
const Role = require("../models/RoleModel");
const Institution = require("../models/InstitutionModal");
const { getSuperAdminPermissions, isSuperAdminRoleName } = require("../utils/superAdminPermissions");

const DEFAULT_PASSWORD = "Admin@123";

// ── Same userId generation the app's Addusers flow uses ─────────────────────
const buildInstitutionPrefix = (instName) => {
  const words = String(instName || "INST").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "INST";
  if (words.length > 1) {
    return words.map((w) => w[0].toUpperCase()).join("").slice(0, 4);
  }
  return words[0].slice(0, 3).toUpperCase();
};

const generateUserIdForInstitution = async (institutionId) => {
  const updated = await Institution.findOneAndUpdate(
    { _id: institutionId },
    { $inc: { userIdCounter: 1 } },
    { new: true }
  );
  if (!updated) return null;
  const prefix = buildInstitutionPrefix(updated.inst_name);
  const seq = String(updated.userIdCounter).padStart(4, "0");
  return `${prefix}${seq}`;
};

const parseArgs = () => {
  const args = process.argv.slice(2);
  const instFlag = args.indexOf("--institution");
  let institution = null;
  if (instFlag !== -1) {
    institution = args[instFlag + 1] || null;
    args.splice(instFlag, 2);
  }
  const [email, password] = args;
  return { email, password: password || DEFAULT_PASSWORD, institution };
};

const resolveInstitution = async (wanted) => {
  if (wanted) {
    if (mongoose.Types.ObjectId.isValid(wanted)) {
      const byId = await Institution.findById(wanted);
      if (byId) return byId;
    }
    const byName = await Institution.findOne({
      inst_name: { $regex: new RegExp(`^${wanted}$`, "i") },
    });
    if (byName) return byName;
    console.error(`Institution not found: "${wanted}"`);
    return null;
  }

  const all = await Institution.find().select("inst_name inst_owner");
  if (all.length === 1) return all[0];
  if (all.length === 0) {
    console.error("No institutions exist yet — register an institution first.");
    return null;
  }
  console.error("Multiple institutions found — pass --institution <idOrName>:");
  all.forEach((i) => console.error(`  ${i._id}  ${i.inst_name} (${i.inst_owner})`));
  return null;
};

const findOrCreateSuperAdminRole = async (institutionId) => {
  const roles = await Role.find({ institution: institutionId });
  const existing = roles.find(
    (r) =>
      isSuperAdminRoleName(r.roleValue) ||
      isSuperAdminRoleName(r.renameRole) ||
      isSuperAdminRoleName(r.originalRole)
  );
  if (existing) {
    console.log(`Using existing role: ${existing.originalRole || existing.roleValue} (${existing._id})`);
    return existing;
  }
  const role = await new Role({
    institution: institutionId,
    originalRole: "Super Admin",
    renameRole: "Super Admin",
    roleValue: "super_admin",
    createdBy: "seedSuperAdmin",
  }).save();
  console.log(`Created role "Super Admin" (${role._id})`);
  return role;
};

const run = async () => {
  const { email, password, institution: instArg } = parseArgs();

  if (!email || !email.includes("@")) {
    console.error("Usage: node scripts/seedSuperAdmin.js <email> [password] [--institution <idOrName>]");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGOURI);
  console.log("MongoDB connected");

  try {
    const institution = await resolveInstitution(instArg);
    if (!institution) process.exit(1);
    console.log(`Institution: ${institution.inst_name} (${institution._id})`);

    const role = await findOrCreateSuperAdminRole(institution._id);
    const permissions = getSuperAdminPermissions();

    let user = await User.findOne({ email });

    if (user) {
      user.role = role._id;
      user.permissions = permissions;
      user.status = "active";
      if (!user.institution) user.institution = institution._id;
      await user.save();
      console.log(`Upgraded existing user ${email} → Super Admin with ${permissions.length} modules (password unchanged)`);
    } else {
      const userId = await generateUserIdForInstitution(institution._id);
      user = new User({
        email,
        firstName: "Super",
        lastName: "Admin",
        phone: "0000000000", // placeholder — update in profile
        password, // hashed by the UserModel pre-save hook
        role: role._id,
        institution: institution._id,
        userId,
        status: "active",
        permissions,
        createdBy: "seedSuperAdmin",
      });
      await user.save();
      console.log(`Created Super Admin ${email} (userId ${userId}) with ${permissions.length} modules`);
      console.log(`Password: ${password}  — change it after first login`);
    }

    console.log("Sidebar modules granted:");
    permissions.forEach((p) => console.log(`  ${String(p.order).padStart(2)}  ${p.permissionName}  → /lms/pages/${p.permissionKey}`));
  } finally {
    await mongoose.disconnect();
  }
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
