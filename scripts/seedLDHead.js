// Seed (or upgrade) an L&D Head user + role for an institution.
//
// Creates idempotently:
//   • An "L&D" role (roleValue: ldhead) for the institution. roleValue "ldhead"
//     is what the client already recognises as a manager tier (it is routed to
//     the admin DashboardLayout shell, permission-driven sidebar).
//   • A user with that role and an L&D permission set: a new L&D Dashboard
//     landing plus read access to the existing course / calendar / attendance /
//     grades / approvals / logs modules.
//
// Existing users/roles are NOT disturbed — this only adds the L&D role + user.
// The password of an already-existing user is not changed.
//
// Run from the Server folder:
//   node scripts/seedLDHead.js
//   node scripts/seedLDHead.js <email> <password> [--institution <idOrName>]

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");

const User = require("../models/UserModel");
const Role = require("../models/RoleModel");
const Institution = require("../models/InstitutionModal");
const { SUPER_ADMIN_PERMISSIONS } = require("../utils/superAdminPermissions");

const DEFAULT_EMAIL = "l&d@gmail.com";
const DEFAULT_PASSWORD = "123";

// ── L&D permission set: new dashboard + reuse of existing modules ───────────
const buildLDPermissions = () => {
  const pick = (key) => {
    const e = SUPER_ADMIN_PERMISSIONS.find((p) => p.permissionKey === key);
    return e ? { ...e, permissionFunctionality: [...e.permissionFunctionality] } : null;
  };
  const reused = [
    "coursestructure",
    "programcalender",
    "attendancemanagement",
    "grades",
    "approvals",
    "logs",
    "notifications",
    "profile",
  ];
  const permissions = [
    {
      permissionName: "L&D Dashboard",
      permissionKey: "lddashboard",
      permissionFunctionality: [],
      icon: "LayoutDashboard",
      color: "orange",
      description: "L&D portfolio overview",
      isActive: true,
      order: 0,
    },
    ...reused.map(pick).filter(Boolean),
  ];
  permissions.forEach((p, i) => {
    p.order = i;
    p.isActive = true;
  });
  return permissions;
};

// ── institution helpers (same as seedSuperAdmin) ────────────────────────────
const buildInstitutionPrefix = (instName) => {
  const words = String(instName || "INST").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "INST";
  if (words.length > 1) return words.map((w) => w[0].toUpperCase()).join("").slice(0, 4);
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

const resolveInstitution = async (wanted) => {
  if (wanted) {
    if (mongoose.Types.ObjectId.isValid(wanted)) {
      const byId = await Institution.findById(wanted);
      if (byId) return byId;
    }
    const byName = await Institution.findOne({ inst_name: { $regex: new RegExp(`^${wanted}$`, "i") } });
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

const findOrCreateLDRole = async (institutionId) => {
  const existing = await Role.findOne({ institution: institutionId, roleValue: "ldhead" });
  if (existing) {
    console.log(`Using existing L&D role (${existing._id})`);
    return existing;
  }
  const role = await new Role({
    institution: institutionId,
    originalRole: "L&D",
    renameRole: "L&D",
    roleValue: "ldhead",
    createdBy: "seedLDHead",
  }).save();
  console.log(`Created role "L&D" (roleValue ldhead) — ${role._id}`);
  return role;
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
  return { email: email || DEFAULT_EMAIL, password: password || DEFAULT_PASSWORD, institution };
};

const run = async () => {
  const { email, password, institution: instArg } = parseArgs();

  await mongoose.connect(process.env.MONGOURI);
  console.log("MongoDB connected");

  try {
    const institution = await resolveInstitution(instArg);
    if (!institution) process.exit(1);
    console.log(`Institution: ${institution.inst_name} (${institution._id})`);

    const role = await findOrCreateLDRole(institution._id);
    const permissions = buildLDPermissions();

    let user = await User.findOne({ email });
    if (user) {
      user.role = role._id;
      user.permissions = permissions;
      user.status = "active";
      if (!user.institution) user.institution = institution._id;
      await user.save();
      console.log(`Upgraded existing user ${email} → L&D with ${permissions.length} modules (password unchanged)`);
    } else {
      const userId = await generateUserIdForInstitution(institution._id);
      user = new User({
        email,
        firstName: "L&D",
        lastName: "Head",
        phone: "0000000000",
        password, // hashed by the UserModel pre-save hook
        role: role._id,
        institution: institution._id,
        userId,
        status: "active",
        permissions,
        createdBy: "seedLDHead",
      });
      await user.save();
      console.log(`Created L&D Head ${email} (userId ${userId}) with ${permissions.length} modules`);
      console.log(`Password: ${password}  — change it after first login`);
    }

    console.log("\nSidebar modules granted:");
    permissions.forEach((p) =>
      console.log(`  ${String(p.order).padStart(2)}  ${p.permissionName}  → /lms/pages/${p.permissionKey}`)
    );
    console.log("\nDone. Log in as this user (log out of any current session first).");
  } finally {
    await mongoose.disconnect();
  }
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
