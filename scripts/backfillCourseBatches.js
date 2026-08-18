// One-off backfill: copy each service mapping course's own batch names
// (MappedCourse.batches) onto the course-structure record set up from it, into
// the new `batches` field that getCourseBatches unions into the enrolment
// page's batch tabs. Records saved before the field existed carry none, so
// their enrolment pages fell back to a "Default" batch even when the mapping
// named b1/b2.
//
// Matching mirrors how Course Setup identifies a record: mappingId + coursePath
// (+ courseName when several courses share a path). Idempotent — records whose
// batches already match are left untouched. Run from server/:
//   node scripts/backfillCourseBatches.js          (dry run)
//   node scripts/backfillCourseBatches.js --apply  (write)
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const envRaw = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
const uriLine = envRaw.split(/\r?\n/).find((l) => l.startsWith("MONGOURI="));
if (!uriLine) throw new Error("MONGOURI not found in server/.env");
const MONGOURI = uriLine.slice("MONGOURI=".length).trim();

const APPLY = process.argv.includes("--apply");
const norm = (s) => String(s || "").trim().toLowerCase();

async function main() {
  await mongoose.connect(MONGOURI, { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;

  const courses = await db
    .collection("course-structures")
    .find({ mappingId: { $exists: true, $nin: [null, ""] } })
    .project({ courseName: 1, courseCode: 1, mappingId: 1, coursePath: 1, batches: 1 })
    .toArray();
  console.log(`${courses.length} course-structure record(s) carry a mappingId`);

  let changed = 0;
  for (const c of courses) {
    if (!mongoose.Types.ObjectId.isValid(c.mappingId)) continue;
    const mapping = await db
      .collection("lms-servicemappings")
      .findOne(
        { _id: new mongoose.Types.ObjectId(c.mappingId) },
        { projection: { courses: 1 } }
      );
    if (!mapping) continue;

    // Same identity Course Setup uses: path first, then name inside the path.
    const atPath = (mapping.courses || []).filter((mc) => norm(mc.path) === norm(c.coursePath));
    const entry =
      atPath.find((mc) => norm(mc.courseName) === norm(c.courseName)) || atPath[0];
    if (!entry) continue;

    const want = (entry.batches || []).map((b) => String(b).trim()).filter(Boolean);
    const have = (c.batches || []).map((b) => String(b).trim()).filter(Boolean);
    if (JSON.stringify(want) === JSON.stringify(have)) continue;

    changed++;
    console.log(
      `${APPLY ? "UPDATE" : "WOULD update"} ${c.courseName} (${c.courseCode || "no code"}) ` +
      `path=${JSON.stringify(c.coursePath || "")}: batches ${JSON.stringify(have)} -> ${JSON.stringify(want)}`
    );
    if (APPLY) {
      await db
        .collection("course-structures")
        .updateOne({ _id: c._id }, { $set: { batches: want, updatedAt: new Date() } });
    }
  }
  console.log(`${changed} record(s) ${APPLY ? "updated" : "need updating"}${APPLY ? "" : " — rerun with --apply to write"}`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
