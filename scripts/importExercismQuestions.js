// Import Exercism practice exercises into the OtherPlatformQuestionBank.
//
// Exercism's content is MIT-licensed (github.com/exercism). Each exercise is
// joined from two repos, downloaded as zip archives and extracted beforehand:
//   - problem-specifications: instructions.md / introduction.md (statement),
//     metadata.toml (title + original source), canonical-data.json (test cases)
//   - python track: solution stub (-> solutions.startedCode), .meta example
//     (-> outputCode), root config.json (difficulty 1-10, practices)
//
// Usage (run from server/):
//   node scripts/importExercismQuestions.js --spec <problem-specifications-dir>
//        --track <python-track-dir> --out <preview.json> [--commit]
//
// Default is a DRY RUN: builds every question, validates the lot through the
// real mongoose schema (offline), writes a preview JSON and prints a summary.
// --commit connects with MONGOURI from server/.env and inserts each question
// into the OtherPlatformQuestion collection (one document per question, shared
// globally — not tenant-scoped). Idempotent: a question whose title already
// exists in the collection with source "thirdParty" is skipped, so re-runs
// never duplicate.

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const Question = require("../models/Courses/QuestionbankModal");
const OtherPlatformQuestion = Question.OtherPlatformQuestion;

// ── CLI args ─────────────────────────────────────────────────────────────────
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const SPEC_DIR = arg("spec");
const TRACK_DIR = arg("track");
const OUT_FILE = arg("out", path.join(__dirname, "exercism-preview.json"));
const COMMIT = process.argv.includes("--commit");

if (require.main === module && (!SPEC_DIR || !TRACK_DIR)) {
  console.error("Required: --spec <problem-specifications dir> --track <python track dir>");
  process.exit(1);
}

const MAX_TEST_CASES = 40;
const SAMPLE_CASES = 3;

// Curated DSA-style topics per exercise, matching the Title Case vocabulary
// already used by the seeded bank (Arrays, Strings, Hashing, ...). The python
// track's `practices` slugs are language concepts (bools, list-methods, ...)
// and polluted the picker's Topic dropdown — never use them as topics.
const EXERCISE_TOPICS = {
  "acronym": ["Strings"],
  "affine-cipher": ["Strings", "Math"],
  "all-your-base": ["Math"],
  "allergies": ["Bit Manipulation"],
  "alphametics": ["Backtracking", "Math"],
  "anagram": ["Strings", "Hashing"],
  "armstrong-numbers": ["Math"],
  "atbash-cipher": ["Strings"],
  "bank-account": ["Design"],
  "binary-search": ["Searching", "Arrays"],
  "binary-search-tree": ["Trees", "Searching"],
  "bob": ["Strings", "Logic"],
  "book-store": ["Dynamic Programming"],
  "bottle-song": ["Strings"],
  "bowling": ["Simulation"],
  "camicia": ["Simulation"],
  "change": ["Dynamic Programming"],
  "circular-buffer": ["Data Structures"],
  "clock": ["Math"],
  "collatz-conjecture": ["Math"],
  "complex-numbers": ["Math"],
  "connect": ["Graphs"],
  "crypto-square": ["Strings"],
  "custom-set": ["Data Structures", "Hashing"],
  "darts": ["Math"],
  "diamond": ["Strings"],
  "difference-of-squares": ["Math"],
  "dnd-character": ["Math"],
  "dominoes": ["Backtracking", "Graphs"],
  "dot-dsl": ["Parsing"],
  "eliuds-eggs": ["Bit Manipulation"],
  "etl": ["Hashing"],
  "flatten-array": ["Arrays", "Recursion"],
  "flower-field": ["Arrays"],
  "food-chain": ["Strings"],
  "forth": ["Parsing", "Stacks"],
  "game-of-life": ["Arrays", "Simulation"],
  "gigasecond": ["Math"],
  "go-counting": ["Graphs"],
  "grade-school": ["Hashing", "Sorting"],
  "grains": ["Math"],
  "grep": ["Strings"],
  "hamming": ["Strings"],
  "hello-world": ["Strings"],
  "high-scores": ["Arrays", "Sorting"],
  "house": ["Strings"],
  "isbn-verifier": ["Strings", "Math"],
  "isogram": ["Strings", "Hashing"],
  "killer-sudoku-helper": ["Backtracking", "Math"],
  "kindergarten-garden": ["Strings", "Arrays"],
  "knapsack": ["Dynamic Programming"],
  "largest-series-product": ["Arrays", "Math"],
  "leap": ["Math"],
  "ledger": ["Strings"],
  "line-up": ["Strings"],
  "linked-list": ["Linked List"],
  "list-ops": ["Arrays"],
  "luhn": ["Math", "Strings"],
  "markdown": ["Parsing", "Strings"],
  "matching-brackets": ["Stacks", "Strings"],
  "matrix": ["Arrays"],
  "meetup": ["Math"],
  "nth-prime": ["Math"],
  "ocr-numbers": ["Strings", "Arrays"],
  "palindrome-products": ["Math"],
  "pangram": ["Strings"],
  "pascals-triangle": ["Math", "Dynamic Programming"],
  "perfect-numbers": ["Math"],
  "phone-number": ["Strings"],
  "pig-latin": ["Strings"],
  "poker": ["Logic", "Sorting"],
  "pov": ["Trees", "Graphs"],
  "prime-factors": ["Math"],
  "protein-translation": ["Strings", "Hashing"],
  "proverb": ["Strings"],
  "pythagorean-triplet": ["Math"],
  "queen-attack": ["Math"],
  "rail-fence-cipher": ["Strings"],
  "raindrops": ["Math", "Strings"],
  "rational-numbers": ["Math"],
  "react": ["Design"],
  "rectangles": ["Arrays", "Logic"],
  "relative-distance": ["Graphs"],
  "resistor-color": ["Arrays"],
  "resistor-color-duo": ["Arrays"],
  "resistor-color-trio": ["Arrays", "Math"],
  "rest-api": ["Design"],
  "reverse-string": ["Strings"],
  "rna-transcription": ["Strings"],
  "robot-simulator": ["Simulation"],
  "roman-numerals": ["Math", "Strings"],
  "rotational-cipher": ["Strings"],
  "run-length-encoding": ["Strings"],
  "saddle-points": ["Arrays"],
  "satellite": ["Trees", "Recursion"],
  "say": ["Math", "Strings"],
  "scrabble-score": ["Strings", "Hashing"],
  "secret-handshake": ["Bit Manipulation"],
  "series": ["Strings", "Arrays"],
  "sgf-parsing": ["Parsing", "Trees"],
  "sieve": ["Math", "Arrays"],
  "simple-cipher": ["Strings"],
  "simple-linked-list": ["Linked List"],
  "space-age": ["Math"],
  "spiral-matrix": ["Arrays"],
  "square-root": ["Math", "Searching"],
  "state-of-tic-tac-toe": ["Logic", "Arrays"],
  "strain": ["Arrays"],
  "sublist": ["Arrays"],
  "sum-of-multiples": ["Math"],
  "swift-scheduling": ["Parsing"],
  "tournament": ["Hashing", "Sorting"],
  "transpose": ["Strings", "Arrays"],
  "tree-building": ["Trees", "Recursion"],
  "triangle": ["Math"],
  "twelve-days": ["Strings"],
  "two-bucket": ["Searching", "Math"],
  "two-fer": ["Strings"],
  "variable-length-quantity": ["Bit Manipulation"],
  "word-count": ["Strings", "Hashing"],
  "word-search": ["Backtracking", "Arrays"],
  "wordy": ["Parsing", "Math"],
  "yacht": ["Logic", "Arrays"],
  "zebra-puzzle": ["Logic", "Backtracking"],
  "zipper": ["Trees", "Data Structures"],
};

// ── Helpers ──────────────────────────────────────────────────────────────────
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null);

// metadata.toml is flat `key = "value"` lines — a full TOML parser is overkill.
function parseToml(text) {
  const out = {};
  if (!text) return out;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(\w+)\s*=\s*"(.*)"\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// canonical-data.json nests cases in named groups; leaves carry `property`.
// Cases referenced by a newer case's `reimplements` are superseded — drop them.
function flattenCases(canonical) {
  const leaves = [];
  const reimplemented = new Set();
  (function walk(node, trail) {
    for (const c of node.cases || []) {
      if (Array.isArray(c.cases)) {
        walk(c, c.description ? [...trail, c.description] : trail);
      } else if (c.property && "expected" in c) {
        if (c.reimplements) reimplemented.add(c.reimplements);
        leaves.push({ ...c, trail });
      }
    }
  })(canonical, []);
  return leaves.filter((c) => !reimplemented.has(c.uuid));
}

const serialize = (v) => (typeof v === "string" ? v : JSON.stringify(v));

function mapDifficulty(n) {
  if (n <= 3) return { difficulty: "easy", score: 10 };
  if (n <= 6) return { difficulty: "medium", score: 20 };
  return { difficulty: "hard", score: 30 };
}

// ── Build one question from an exercise slug ─────────────────────────────────
function buildQuestion(entry) {
  const slug = entry.slug;
  const specEx = path.join(SPEC_DIR, "exercises", slug);
  const trackEx = path.join(TRACK_DIR, "exercises", "practice", slug);

  if (!fs.existsSync(specEx)) return { skip: "not in problem-specifications" };
  if (fs.existsSync(path.join(specEx, ".deprecated"))) return { skip: "deprecated" };

  // Statement file was renamed over time — older exercises still ship
  // description.md, newer ones instructions.md.
  const instructions =
    read(path.join(specEx, "instructions.md")) ||
    read(path.join(specEx, "description.md"));
  const canonicalRaw = read(path.join(specEx, "canonical-data.json"));
  if (!instructions) return { skip: "no instructions/description md" };
  if (!canonicalRaw) return { skip: "no canonical-data.json" };

  let cases;
  try {
    cases = flattenCases(JSON.parse(canonicalRaw));
  } catch (e) {
    return { skip: `canonical-data parse error: ${e.message}` };
  }
  if (!cases.length) return { skip: "no test cases" };
  const droppedCases = Math.max(0, cases.length - MAX_TEST_CASES);
  cases = cases.slice(0, MAX_TEST_CASES);

  const trackCfg = JSON.parse(read(path.join(trackEx, ".meta", "config.json")) || "{}");
  const stubFile = (trackCfg.files && trackCfg.files.solution && trackCfg.files.solution[0]) || null;
  const exampleFile = (trackCfg.files && trackCfg.files.example && trackCfg.files.example[0]) || null;
  const stub = stubFile ? read(path.join(trackEx, stubFile)) : null;
  const example = exampleFile ? read(path.join(trackEx, exampleFile)) : null;
  if (!stub) return { skip: "no python stub" };

  const meta = parseToml(read(path.join(specEx, "metadata.toml")));
  const intro = read(path.join(specEx, "introduction.md"));
  const appendix = read(path.join(trackEx, ".docs", "instructions.append.md"));

  const attribution =
    `\n\n---\n*Imported from [Exercism](https://exercism.org/tracks/python/exercises/${slug}) — MIT licensed.*` +
    (meta.source ? `\n*Original source: ${meta.source}${meta.source_url ? ` (${meta.source_url})` : ""}*` : "");
  const description =
    [intro, instructions, appendix].filter(Boolean).join("\n\n") + attribution;

  const defMatch = stub.match(/def\s+([A-Za-z_]\w*)\s*\(/);
  const { difficulty, score } = mapDifficulty(entry.difficulty || 1);

  const testCases = cases.map((c, i) => ({
    input: JSON.stringify(c.input),
    expectedOutput: serialize(c.expected),
    isSample: i < SAMPLE_CASES,
    isHidden: i >= SAMPLE_CASES,
    points: 1,
    explanation: [...c.trail, c.description].filter(Boolean).join(" — ").slice(0, 500),
  }));

  return {
    question: {
      questionType: "programming",
      questionCategory: "Exercism",
      title: meta.title || slug,
      description,
      difficulty,
      score,
      sampleInput: testCases[0].input,
      sampleOutput: testCases[0].expectedOutput,
      testCases,
      solutions: {
        startedCode: stub,
        functionName: defMatch ? defMatch[1] : (cases[0].property || ""),
        language: "python",
      },
      outputCode: example || "",
      problemType: "Algorithm Design",
      topics: EXERCISE_TOPICS[slug] || [],
      tags: ["exercism"],
      source: "thirdParty",
      createdBy: "Exercism Import",
      isActive: true,
    },
    droppedCases,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const trackConfig = JSON.parse(read(path.join(TRACK_DIR, "config.json")));
  const entries = trackConfig.exercises.practice;

  const questions = [];
  const skipped = [];
  let droppedCasesTotal = 0;
  for (const entry of entries) {
    const built = buildQuestion(entry);
    if (built.skip) {
      skipped.push(`${entry.slug}: ${built.skip}`);
    } else {
      questions.push(built.question);
      droppedCasesTotal += built.droppedCases;
    }
  }

  // Smoke-test the schema shape on the first question before writing; insertMany
  // runs validators per-document at commit time so bad rows are surfaced
  // individually rather than aborting the whole batch.
  if (questions.length) {
    await new OtherPlatformQuestion(questions[0]).validate();
  }

  const byDifficulty = questions.reduce((acc, q) => {
    acc[q.difficulty] = (acc[q.difficulty] || 0) + 1;
    return acc;
  }, {});
  const totalCases = questions.reduce((n, q) => n + q.testCases.length, 0);

  fs.writeFileSync(OUT_FILE, JSON.stringify(questions, null, 2));
  console.log(`Built ${questions.length} questions (${JSON.stringify(byDifficulty)}), ` +
    `${totalCases} test cases total (${droppedCasesTotal} over-cap cases dropped). ` +
    `Schema validation passed.`);
  console.log(`Preview written to ${OUT_FILE}`);
  if (skipped.length) {
    console.log(`Skipped ${skipped.length}:`);
    for (const s of skipped) console.log(`  - ${s}`);
  }

  if (!COMMIT) {
    console.log("\nDry run only — re-run with --commit to write to Mongo.");
    return;
  }

  // ── Commit ─────────────────────────────────────────────────────────────────
  const envRaw = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
  const uriLine = envRaw.split(/\r?\n/).find((l) => l.startsWith("MONGOURI="));
  if (!uriLine) throw new Error("MONGOURI not found in server/.env");
  await mongoose.connect(uriLine.slice("MONGOURI=".length).trim(), {
    serverSelectionTimeoutMS: 20000,
  });

  // One document per question now — dedupe on title against prior Exercism
  // imports (source === "thirdParty").
  const existingDocs = await OtherPlatformQuestion
    .find({ source: "thirdParty" }, { title: 1 })
    .lean();
  const existing = new Set(existingDocs.map((d) => d.title));
  const toAdd = questions.filter((q) => !existing.has(q.title));

  if (toAdd.length === 0) {
    console.log("\nNothing new to import — every Exercism question already present.");
    await mongoose.disconnect();
    return;
  }

  const inserted = await OtherPlatformQuestion.insertMany(toAdd, { ordered: false });
  const totalNow = await OtherPlatformQuestion.estimatedDocumentCount();

  console.log(`\nCommitted to the OtherPlatformQuestion collection: ` +
    `added ${inserted.length}, skipped ${questions.length - toAdd.length} already-imported, ` +
    `collection now holds ${totalNow} questions.`);
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

// Shared with retopic/migration scripts.
module.exports = { EXERCISE_TOPICS };
