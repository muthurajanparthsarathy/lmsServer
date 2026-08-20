// Bring existing Point-of-Contact accounts onto the permission-driven sidebar.
//
// WHY THIS EXISTS
// ---------------
// The POC rail used to be a hardcoded list keyed off the ROLE (the old
// client/src/features/poc/nav.ts). Because of that, nobody ever cleaned up
// what POC accounts actually hold: most still carry admin-era grants —
// admindashboard, usermanagement, logs, dynamicfieldsettings — which the old
// role-driven rail and route gate simply ignored.
//
// The rail and the gate are now derived from those grants. So a stale grant
// stops being cosmetic and starts opening a real page: admindashboard and
// usermanagement have NO per-course scoping on the server (only course
// structure, attendance, client management and service mapping do — see
// utils/pocScope.js), so leaving them in place would show a POC
// institution-wide data.
//
// This script rewrites each POC's permission set to:
//   1. drop every module with no POC scoping (UNSCOPED_FOR_POC below),
//   2. keep everything else they already hold,
//   3. add "POC Dashboard" (pocdashboard) as order 0 — their landing page,
//   4. add "Profiles" if missing, and renumber orders from 0.
//
// Run from the Server folder. DRY RUN by default — nothing is written until
// you pass --apply:
//   node scripts/migratePocPermissions.js
//   node scripts/migratePocPermissions.js --apply
//   node scripts/migratePocPermissions.js --apply --email someone@x.com

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const User = require("../models/UserModel");
const Role = require("../models/RoleModel");
const { SUPER_ADMIN_PERMISSIONS } = require("../utils/superAdminPermissions");

// Modules a POC must not hold: the server applies no per-course scope to any
// of them, so each would expose the whole institution (or, for calendar,
// every tenant). Course Management, Attendance, Client Management and Service
// Mapping are deliberately absent — those ARE scoped, and a POC is meant to
// work on them.
const UNSCOPED_FOR_POC = new Set([
  "admindashboard",
  "studentdashboard",
  "dashboard",
  "usermanagement",
  "instutionmanagement",
  "dynamicfieldsettings",
  "logs",
  "calendar",
  "programcalender",
]);

// Stored keys are not consistently spelled — real POC accounts carry
// "user_management" and "course_management" alongside the canonical
// "usermanagement" / "coursestructure". Compare with separators stripped so a
// variant spelling can't slip an unscoped module past the filter. Mirrors
// canonicalPermissionKey() in client/src/app/lms/shared/ui/navItems.ts.
const normalizeKey = (v) => String(v || "").trim().toLowerCase().replace(/[\s\-_]/g, "");

// Exact match after stripping separators — never a substring test. A role
// literally named "POC Manager" is not this role. Mirrors isPocRoleValue in
// client/src/lib/session.ts.
const normalizeRole = (v) => String(v || "").trim().toLowerCase().replace(/[\s\-_]/g, "");
const isPocRoleDoc = (role) =>
  [role.roleValue, role.originalRole, role.renameRole]
    .map(normalizeRole)
    .some((v) => v === "poc" || v === "pointofcontact");

const catalogEntry = (key) => {
  const entry = SUPER_ADMIN_PERMISSIONS.find((p) => p.permissionKey === key);
  if (!entry) throw new Error(`"${key}" is missing from utils/superAdminPermissions.js`);
  return {
    permissionName: entry.permissionName,
    permissionKey: entry.permissionKey,
    permissionFunctionality: [...entry.permissionFunctionality],
    icon: entry.icon,
    color: entry.color,
    description: entry.description,
    isActive: true,
    order: 0,
  };
};

const main = async () => {
  const apply = process.argv.includes("--apply");
  const emailIdx = process.argv.indexOf("--email");
  const onlyEmail = emailIdx !== -1 ? process.argv[emailIdx + 1] : null;

  await mongoose.connect(process.env.MONGOURI);
  console.log("MongoDB connected");
  console.log(apply ? "MODE: apply (writes)\n" : "MODE: dry run — pass --apply to write\n");

  const pocRoleIds = (await Role.find({}).lean()).filter(isPocRoleDoc).map((r) => r._id);
  if (pocRoleIds.length === 0) {
    console.log("No POC role documents found. Nothing to do.");
    await mongoose.disconnect();
    return;
  }
  console.log(`POC role documents: ${pocRoleIds.length}`);

  const filter = { role: { $in: pocRoleIds } };
  if (onlyEmail) filter.email = new RegExp(`^${onlyEmail}$`, "i");

  const users = await User.find(filter).select("email permissions").lean();
  console.log(`POC users matched: ${users.length}\n`);

  let changed = 0;
  const ops = [];

  for (const u of users) {
    const before = (u.permissions || []).filter((p) => p.isActive !== false);

    const kept = before.filter((p) => {
      const key = normalizeKey(p.permissionKey);
      return !UNSCOPED_FOR_POC.has(key) && key !== "pocdashboard";
    });

    const next = [catalogEntry("pocdashboard"), ...kept];
    if (!next.some((p) => normalizeKey(p.permissionKey) === "profile")) {
      next.push(catalogEntry("profile"));
    }

    // Strip _id so mongoose mints fresh subdocument ids, and renumber.
    const permissions = next.map((p, i) => ({
      permissionName: p.permissionName,
      permissionKey: p.permissionKey,
      permissionFunctionality: [...(p.permissionFunctionality || [])],
      icon: p.icon || "Shield",
      color: p.color || "blue",
      description: p.description || "",
      isActive: true,
      order: i,
    }));

    const beforeKeys = before.map((p) => p.permissionKey).join(",");
    const afterKeys = permissions.map((p) => p.permissionKey).join(",");
    if (beforeKeys === afterKeys) {
      console.log(`= ${u.email} — already correct`);
      continue;
    }

    changed++;
    const removed = before
      .map((p) => p.permissionKey)
      .filter((k) => !permissions.some((p) => p.permissionKey === k));
    const added = permissions
      .map((p) => p.permissionKey)
      .filter((k) => !before.some((p) => p.permissionKey === k));

    console.log(`~ ${u.email}`);
    if (removed.length) console.log(`    removed: ${removed.join(", ")}`);
    if (added.length) console.log(`    added:   ${added.join(", ")}`);
    console.log(`    rail:    ${afterKeys}`);

    ops.push({
      updateOne: { filter: { _id: u._id }, update: { $set: { permissions } } },
    });
  }

  console.log(`\n${changed} of ${users.length} POC account(s) need changes.`);

  if (apply && ops.length) {
    const result = await User.bulkWrite(ops);
    console.log(`Applied to ${result.modifiedCount ?? ops.length} account(s).`);
    console.log("Each POC must log out and back in — the sidebar reads permissions at login.");
  } else if (ops.length) {
    console.log("Dry run — nothing written. Re-run with --apply to commit.");
  }

  await mongoose.disconnect();
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
