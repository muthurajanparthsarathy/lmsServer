// Backfill batchId on pre-batch attendance records.
//
// Attendance became batch-scoped: each record now names the batch it was
// marked under, and the unique index includes batchId. Records written before
// that carry no batchId, which would hide them from every batch-scoped view.
// This script:
//   1. drops the old (courseId, studentId, date, sessionId) unique index —
//      left in place it would forbid the same student holding marks in two
//      batches on one day;
//   2. sets batchId on each legacy record to the batch its student is
//      enrolled in on that course (first containing batch wins; a student in
//      no batch falls back to the course's first batch so the record stays
//      visible somewhere rather than vanishing);
//   3. ensures the new unique index exists.
//
// Idempotent: records that already have a batchId are never touched, the
// index drops/creates are guarded. Uses MONGOURI from server/.env like the
// other backfill scripts.

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const envRaw = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
const uriLine = envRaw.split(/\r?\n/).find((l) => l.startsWith("MONGOURI="));
if (!uriLine) throw new Error("MONGOURI not found in server/.env");
const MONGOURI = uriLine.slice("MONGOURI=".length).trim();

async function main() {
  await mongoose.connect(MONGOURI, { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;
  const attendance = db.collection("studentattendances");
  const courses = db.collection("course-structures");

  // 1. Drop the pre-batch unique index if it is still around.
  const indexes = await attendance.indexes();
  const oldIdx = indexes.find(
    (ix) =>
      ix.unique &&
      JSON.stringify(ix.key) ===
        JSON.stringify({ courseId: 1, studentId: 1, date: 1, sessionId: 1 })
  );
  if (oldIdx) {
    await attendance.dropIndex(oldIdx.name);
    console.log(`Dropped old index ${oldIdx.name}`);
  } else {
    console.log("Old index already gone");
  }

  // 2. Assign batchIds to legacy records, course by course.
  const legacy = await attendance
    .find({ $or: [{ batchId: null }, { batchId: { $exists: false } }] })
    .toArray();
  console.log(`Legacy records without batchId: ${legacy.length}`);

  const byCourse = new Map();
  legacy.forEach((r) => {
    const key = String(r.courseId);
    if (!byCourse.has(key)) byCourse.set(key, []);
    byCourse.get(key).push(r);
  });

  let updated = 0;
  let unresolved = 0;
  for (const [courseId, records] of byCourse) {
    const course = await courses.findOne(
      { _id: new mongoose.Types.ObjectId(courseId) },
      { projection: { batchAndParticipants: 1 } }
    );
    const batches = course?.batchAndParticipants || [];
    if (!batches.length) {
      unresolved += records.length;
      console.log(`  course ${courseId}: no batches — ${records.length} records left as-is`);
      continue;
    }
    const batchOfStudent = (studentId) => {
      const sid = String(studentId);
      const hit = batches.find((b) =>
        (b.users || []).some((u) => String(u.user?._id || u.user) === sid)
      );
      return (hit || batches[0])._id;
    };
    const ops = records.map((r) => ({
      updateOne: {
        filter: { _id: r._id },
        update: { $set: { batchId: batchOfStudent(r.studentId) } },
      },
    }));
    const result = await attendance.bulkWrite(ops, { ordered: false });
    updated += result.modifiedCount || 0;
  }
  console.log(`Backfilled ${updated} records; ${unresolved} left without batchId`);

  // 3. Ensure the new unique index.
  await attendance.createIndex(
    { courseId: 1, batchId: 1, studentId: 1, date: 1, sessionId: 1 },
    { unique: true }
  );
  console.log("New unique index ensured");
}

main()
  .then(() => console.log("Done"))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
