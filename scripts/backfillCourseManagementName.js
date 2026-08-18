// One-time backfill of the stored display name for the Course Management module.
//
// `coursestructure` is the ROUTE key (/lms/pages/coursestructure) — it is not the
// module's name. The name shown to users is "Course Management", which is what
// utils/superAdminPermissions.js has always seeded. Two other write paths spelled
// it differently, so some stored grants disagree with the sidebar:
//
//   • the assign-permission tree called the page "Manage" (it was nested under a
//     "Course Management" container, so the modal read correctly but the flat
//     storage entry it wrote did not) — client/src/config/permissions.tree.ts
//   • anything hand-edited to "Course Structure", the pre-rename label
//
// Both now emit "Course Management", so this script only repairs rows written
// before that change. It matches on permissionKey — never on the old name — so
// every variant is caught in one pass.
//
// Only permissionName is written ($set through an arrayFilter, timestamps off), so
// legacy documents missing unrelated required fields cannot fail validation and
// updatedAt does not move. Rows already reading "Course Management" are skipped,
// making the script idempotent and safe to re-run.
//
// Run from the server folder. Dry run first — it writes nothing:
//     node scripts/backfillCourseManagementName.js
//     node scripts/backfillCourseManagementName.js --apply

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");

const APPLY = process.argv.includes("--apply");

const CANONICAL_NAME = "Course Management";
const ROUTE_KEY = /^coursestructure$/i;

// Every collection that embeds the permission catalog, and the array field it
// lives in. Kept explicit rather than derived so a new embedding site has to be
// added here deliberately.
const TARGETS = [
  { collection: "lms-users", field: "permissions", label: "LMS users" },
  { collection: "client-institutionpermissions", field: "permissions", label: "Institution permissions" },
  { collection: "client-rolepermissions", field: "modules", label: "Client role permissions" },
  { collection: "superadmin-rolepermissions", field: "modules", label: "Super-admin role permissions" },
];

const main = async () => {
  if (!process.env.MONGOURI) {
    console.error("MONGOURI is not set — run this from the server folder.");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGOURI);
  const db = mongoose.connection.db;
  console.log(`MongoDB connected — ${APPLY ? "APPLY" : "DRY RUN (no writes)"}\n`);

  const present = new Set((await db.listCollections().toArray()).map((c) => c.name));
  let totalRows = 0;
  let totalDocs = 0;

  for (const { collection, field, label } of TARGETS) {
    if (!present.has(collection)) {
      console.log(`${label} (${collection}) — collection absent, skipped`);
      continue;
    }

    const filter = {
      [field]: {
        $elemMatch: { permissionKey: ROUTE_KEY, permissionName: { $ne: CANONICAL_NAME } },
      },
    };

    // Report the exact names being replaced, so a dry run shows what will change.
    const breakdown = await db
      .collection(collection)
      .aggregate([
        { $match: filter },
        { $unwind: `$${field}` },
        {
          $match: {
            [`${field}.permissionKey`]: ROUTE_KEY,
            [`${field}.permissionName`]: { $ne: CANONICAL_NAME },
          },
        },
        { $group: { _id: `$${field}.permissionName`, rows: { $sum: 1 } } },
        { $sort: { rows: -1 } },
      ])
      .toArray();

    const docCount = await db.collection(collection).countDocuments(filter);
    if (docCount === 0) {
      console.log(`${label} (${collection}) — already canonical, nothing to do`);
      continue;
    }

    const rows = breakdown.reduce((sum, b) => sum + b.rows, 0);
    totalRows += rows;
    totalDocs += docCount;
    console.log(`${label} (${collection}) — ${docCount} document(s), ${rows} entr(ies):`);
    breakdown.forEach((b) => console.log(`    "${b._id}" → "${CANONICAL_NAME}"  (${b.rows})`));

    if (!APPLY) continue;

    const res = await db.collection(collection).updateMany(
      filter,
      { $set: { [`${field}.$[entry].permissionName`]: CANONICAL_NAME } },
      {
        arrayFilters: [
          { "entry.permissionKey": ROUTE_KEY, "entry.permissionName": { $ne: CANONICAL_NAME } },
        ],
      },
    );
    console.log(`    ✓ matched ${res.matchedCount}, modified ${res.modifiedCount}`);
  }

  console.log("");
  if (totalDocs === 0) {
    console.log("Nothing to backfill — every stored entry already reads \"Course Management\".");
  } else if (APPLY) {
    console.log(`Done — updated ${totalRows} entr(ies) across ${totalDocs} document(s).`);
    console.log("Affected users must sign out and back in: the sidebar reads permissions");
    console.log("from the localStorage copy written at login.");
  } else {
    console.log(`Dry run — ${totalRows} entr(ies) across ${totalDocs} document(s) would change.`);
    console.log("Re-run with --apply to write.");
  }

  await mongoose.disconnect();
};

main().catch(async (err) => {
  console.error("Backfill failed:", err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
