// Backfill auto-enrolment for students who were created BEFORE the hook in
// Addusers existed (or before the server was restarted to pick it up).
//
// Runs the exact same autoEnrollUser used on user creation, so a backfilled
// enrolment is indistinguishable from one made at signup — same match, same
// batch handling, same idempotency. Re-running is safe: a student already in a
// batch is skipped, not duplicated.
//
// Run from the server folder. Dry run first — it writes nothing:
//   node scripts/backfillAutoEnrol.js
//   node scripts/backfillAutoEnrol.js --apply
//   node scripts/backfillAutoEnrol.js --apply --email=s@gmail.com

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const User = require("../models/UserModel");
const Role = require("../models/RoleModel");
const CourseStructure = require("../models/Courses/courseStructureModal");
const { autoEnrollUser } = require("../utils/autoEnrollUser");

const APPLY = process.argv.includes("--apply");
const EMAIL = (process.argv.find((a) => a.startsWith("--email=")) || "").split("=")[1] || "";

const norm = (v) => String(v ?? "").trim().toLowerCase();

const run = async () => {
  if (!process.env.MONGOURI) throw new Error("MONGOURI not found in server/.env");
  await mongoose.connect(process.env.MONGOURI, { serverSelectionTimeoutMS: 20000 });

  const studentRoleIds = (await Role.find().lean())
    .filter((r) => [r.renameRole, r.originalRole, r.roleName, r.name].some((n) => norm(n) === "student"))
    .map((r) => r._id);

  const filter = { role: { $in: studentRoleIds } };
  if (EMAIL) filter.email = new RegExp(`^${EMAIL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");

  // NOT .lean() — autoEnrollUser saves the user document to link course ids
  // onto its courses[] array.
  const students = await User.find(filter);

  console.log(`\n${APPLY ? "APPLY" : "DRY RUN — nothing will be written"}`);
  console.log(`${students.length} student(s)${EMAIL ? ` matching ${EMAIL}` : ""}\n`);

  let totalEnrolled = 0;
  for (const s of students) {
    if (!APPLY) {
      // Preview using the same predicate, without touching anything. Loading
      // the module's internals is not possible, so this mirrors the query and
      // reports what WOULD be considered; --apply is what actually decides.
      const candidates = await CourseStructure.find({
        institution: s.institution,
        clientId: s.clientId,
      }).select("courseName coursePath").lean();
      console.log(`  ${s.email}  [${s.degree || "-"} / ${s.department || "-"} / ${s.section || "-"}]  ` +
        `${candidates.length} course(s) in scope for this client`);
      continue;
    }

    const r = await autoEnrollUser(s, s.institution, "backfill-script");
    totalEnrolled += r.enrolled.length;
    const where = `${s.degree || "-"}/${s.department || "-"}/${s.section || "-"}`;
    console.log(`  ${s.email.padEnd(28)} [${where}]  enrolled ${r.enrolled.length}, skipped ${r.skipped.length}` +
      (r.error ? `  ERROR: ${r.error}` : ""));
    r.enrolled.forEach((e) => console.log(`      + ${e.course}  (batch "${e.batch}")  ${e.courseId}`));
    r.skipped.forEach((e) => console.log(`      - ${e.course || "(user)"}: ${e.reason}`));
  }

  if (APPLY) console.log(`\n${totalEnrolled} enrolment(s) written`);
  else console.log("\nRe-run with --apply to write.");

  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error("\nBackfill failed:", err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
