// Re-topic the Exercism questions already imported into the
// OtherPlatformQuestion collection.
//
// The first import copied the python track's `practices` slugs (bools,
// class-composition, list-methods, ...) into topics[], which polluted the
// picker's Topic dropdown with language concepts instead of DSA topics.
// This script rewrites each imported question with:
//   - topics:      curated Title Case DSA topics (EXERCISE_TOPICS map,
//                  shared with importExercismQuestions.js)
//   - problemType: "Algorithm Design" (matches the seeded questions;
//                  the first import wrote "Algorithms")
//   - tags:        ["exercism"] (the per-exercise slug tags bloated the
//                  Tags dropdown with 125 entries)
//
// The exercise slug is recovered from the attribution link in the question
// description, so re-runs are safe after tags no longer carry the slug.
// Idempotent: rewrites are stable. Uses MONGOURI from server/.env.
//
// Usage (run from server/):  node scripts/retopicOtherPlatformImports.js

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const Question = require("../models/Courses/QuestionbankModal");
const { EXERCISE_TOPICS } = require("./importExercismQuestions");

const SLUG_RE = /exercism\.org\/tracks\/python\/exercises\/([a-z0-9-]+)/;

async function main() {
  const envRaw = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
  const uriLine = envRaw.split(/\r?\n/).find((l) => l.startsWith("MONGOURI="));
  if (!uriLine) throw new Error("MONGOURI not found in server/.env");
  await mongoose.connect(uriLine.slice("MONGOURI=".length).trim(), {
    serverSelectionTimeoutMS: 20000,
  });

  // Only Exercism-imported questions have the attribution link; scoping the
  // query keeps the retopic pass off the questions-txt CP corpus.
  const docs = await Question.OtherPlatformQuestion.find({ source: "thirdParty" });
  if (docs.length === 0) throw new Error("No Exercism-imported questions found");

  let updated = 0;
  const unmapped = [];
  for (const q of docs) {
    const m = (q.description || "").match(SLUG_RE);
    if (!m) continue; // not an Exercism import — leave untouched
    const slug = m[1];
    const topics = EXERCISE_TOPICS[slug];
    if (!topics) {
      unmapped.push(slug);
      continue;
    }
    q.topics = topics;
    q.problemType = "Algorithm Design";
    q.tags = ["exercism"];
    await q.save();
    updated += 1;
  }

  const allTopics = new Set();
  const allTags = new Set();
  for (const q of docs) {
    (q.topics || []).forEach((t) => allTopics.add(t));
    (q.tags || []).forEach((t) => allTags.add(t));
  }
  console.log(`Re-topiced ${updated} Exercism questions` +
    (unmapped.length ? `; ${unmapped.length} unmapped slugs: ${unmapped.join(", ")}` : "") + ".");
  console.log("Distinct topics on Exercism questions:", [...allTopics].sort().join(", "));
  console.log("Distinct tags on Exercism questions:", [...allTags].sort().join(", "));
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
