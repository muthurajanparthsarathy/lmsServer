// Migrate the legacy OtherPlatformQuestionBank (ONE Mongo document with an
// embedded `questions[]` array) into the top-level `OtherPlatformQuestion`
// collection — one document per question.
//
// Why: the legacy shape was already at ~9.2 MB of Mongo's hard 16 MB per-
// document cap. Any Create-through-UI would eventually push the doc past the
// ceiling and every write would then fail. The new collection removes the
// ceiling entirely and lets pagination + Mongo indexes do their normal work.
//
// What it preserves:
//   - Each embedded question's `_id` — exercises store it in `bankQuestionId`
//     for dedupe on re-import. Losing identity would let duplicates back in.
//   - `createdAt` / `updatedAt` — Mongoose subdoc timestamps carry over.
//   - Every field on the question subdoc, verbatim.
//
// Safety:
//   - Idempotent. Re-running skips questions that already exist in the new
//     collection (matched by `_id`).
//   - Does NOT delete the legacy doc. Verify counts, hit the picker, then
//     drop the old collection by hand (see the log message at the end).
//
// Usage (from server/):  node scripts/migrateOtherPlatformBankToCollection.js

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const Question = require("../models/Courses/QuestionbankModal");

async function main() {
  const envRaw = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
  const uriLine = envRaw.split(/\r?\n/).find((l) => l.startsWith("MONGOURI="));
  if (!uriLine) throw new Error("MONGOURI not found in server/.env");
  await mongoose.connect(uriLine.slice("MONGOURI=".length).trim(), {
    serverSelectionTimeoutMS: 20000,
  });

  const bank = await Question.OtherPlatformBank.findOne({}).lean();
  if (!bank) {
    console.log("No legacy OtherPlatformQuestionBank doc found — nothing to migrate.");
    await mongoose.disconnect();
    return;
  }

  const embedded = Array.isArray(bank.questions) ? bank.questions : [];
  console.log(`Legacy doc holds ${embedded.length} embedded questions.`);
  if (embedded.length === 0) {
    console.log("Legacy doc is empty — nothing to migrate.");
    await mongoose.disconnect();
    return;
  }

  const OtherPlatformQuestion = Question.OtherPlatformQuestion;

  // Skip anything already migrated (rerun-safe). Matched by `_id`.
  const existingIds = new Set(
    (await OtherPlatformQuestion.find({}, { _id: 1 }).lean()).map((d) => String(d._id))
  );
  const toInsert = embedded.filter((q) => !existingIds.has(String(q._id)));
  console.log(
    `${existingIds.size} already in new collection, ${toInsert.length} to insert this run.`
  );

  if (toInsert.length === 0) {
    console.log("Nothing new to migrate.");
    await mongoose.disconnect();
    return;
  }

  // Insert in chunks so a single bad document can be isolated without
  // aborting the whole migration (5148 questions in one insertMany can spend
  // minutes rolling back on a single validation failure).
  const CHUNK = 200;
  let inserted = 0;
  const failures = [];
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const batch = toInsert.slice(i, i + CHUNK);
    try {
      const res = await OtherPlatformQuestion.insertMany(batch, {
        ordered: false,
        // Do not throw on validation errors — collect and continue.
        rawResult: false,
      });
      inserted += res.length;
      process.stdout.write(
        `  inserted ${inserted}/${toInsert.length}\r`
      );
    } catch (err) {
      // `insertMany({ ordered:false })` throws a BulkWriteError whose
      // `insertedDocs` is what actually landed. Count those and log the rest.
      const landed = err && Array.isArray(err.insertedDocs) ? err.insertedDocs.length : 0;
      inserted += landed;
      const writeErrors = (err && err.writeErrors) || [];
      for (const we of writeErrors) {
        failures.push({
          index: i + (we.err && we.err.index != null ? we.err.index : "?"),
          message: (we.err && we.err.errmsg) || String(we),
        });
      }
    }
  }
  process.stdout.write("\n");

  console.log(`Inserted ${inserted} new documents.`);
  if (failures.length) {
    console.log(`${failures.length} failed:`);
    for (const f of failures.slice(0, 20)) console.log(`  [${f.index}] ${f.message}`);
    if (failures.length > 20) console.log(`  ... and ${failures.length - 20} more`);
  }

  const newTotal = await OtherPlatformQuestion.estimatedDocumentCount();
  console.log(
    `New collection now has ${newTotal} documents; legacy doc still holds ${embedded.length} ` +
    `(kept intact — drop it by hand once the picker is verified: ` +
    `db.otherplatformquestionbanks.drop()).`
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
