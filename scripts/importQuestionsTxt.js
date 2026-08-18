// Import competitive-programming questions from a flat questions.txt dump into
// the global OtherPlatformQuestionBank (ONE doc shared by all institutions).
//
// File format (5000 records, LF, UTF-8):
//   Title: <one line, often a truncated first sentence ending in "...">
//   Description: <one line, flattened statement excerpt>
//   Difficulty: Easy | Medium | Hard
//   Constraint: (none stated) | <flattened constraint text>
//   Input: <multi-line stdin>          \  repeated 1..n times; pairs after a
//   Output: <multi-line expected out>  /  "Hidden Test Cases:" line are hidden
//
// Known dirt handled here (all counted and reported):
//   - "Sample output:" glued to the end of an Input block while the real
//     Output: marker is empty -> split input there, recover the expected output
//   - trailing "Hint:" / "Description:" sections inside an Output block ->
//     moved to hints[] / that test case's explanation
//   - a second "Input:" label inside an input block -> merged as content
//   - Output blocks may legitimately contain blank lines; records are only
//     delimited by the next "Title: " line, never by blank lines
//
// Usage (run from server/):
//   node scripts/importQuestionsTxt.js [--file <questions.txt>]
//        [--out <preview.json>] [--commit]
//
// Default is a DRY RUN: parses everything, validates through the real mongoose
// schema (offline), writes a preview JSON and prints a summary. --commit
// connects with MONGOURI from server/.env and inserts each new question into
// the OtherPlatformQuestion collection (one document per question).
// Idempotent: dedupes on title+description among questions already carrying
// source "thirdParty:questions-txt", so re-runs never duplicate.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mongoose = require("mongoose");

const Question = require("../models/Courses/QuestionbankModal");
const OtherPlatformQuestion = Question.OtherPlatformQuestion;

// â”€â”€ CLI args â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const FILE = arg("file", "C:/Users/1404/Downloads/questions.txt");
const OUT_FILE = arg("out", path.join(__dirname, "questions-txt-preview.json"));
const COMMIT = process.argv.includes("--commit");

const IMPORT_SOURCE = "thirdParty:questions-txt";

// â”€â”€ Parsing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Phase-aware state machine. Marker lines are only honored in the position the
// format puts them (Title -> Description -> Difficulty -> Constraint -> pairs);
// anywhere else the same text is question content, which matters because a few
// Output blocks genuinely contain lines like "Description:".
function parseFile(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const records = [];
  const fileAnomalies = [];
  let rec = null;
  let pair = null;
  let phase = "none";

  const flushPair = () => {
    if (pair) {
      rec.pairs.push(pair);
      pair = null;
    }
  };
  const flushRec = () => {
    if (rec) {
      flushPair();
      records.push(rec);
      rec = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const at = i + 1;

    if (line.startsWith("Title: ")) {
      flushRec();
      rec = {
        line: at,
        title: line.slice("Title: ".length),
        desc: [],
        difficulty: "",
        constraint: [],
        pairs: [],
        sawHidden: false,
        anomalies: [],
      };
      phase = "preamble";
      continue;
    }
    if (!rec) {
      if (line.trim()) fileAnomalies.push(`line ${at}: content before first Title`);
      continue;
    }

    if (phase === "preamble" || phase === "description") {
      if (phase === "preamble" && line.startsWith("Description:")) {
        rec.desc.push(line.slice("Description:".length).replace(/^ /, ""));
        phase = "description";
      } else if (line.startsWith("Difficulty:")) {
        rec.difficulty = line.slice("Difficulty:".length).trim();
        phase = "difficulty";
      } else {
        rec.desc.push(line);
      }
      continue;
    }
    if (phase === "difficulty") {
      if (line.startsWith("Constraint:")) {
        rec.constraint.push(line.slice("Constraint:".length).replace(/^ /, ""));
        phase = "constraint";
      } else {
        rec.anomalies.push(`line ${at}: unexpected content after Difficulty`);
        rec.desc.push(line);
      }
      continue;
    }

    // phases past Constraint: "constraint" | "input" | "output" | "cases"
    if (line.startsWith("Input:") && phase !== "input") {
      flushPair();
      pair = { input: [], output: [], hidden: rec.sawHidden, sawOutput: false };
      const rest = line.slice("Input:".length).replace(/^ /, "");
      if (rest !== "") pair.input.push(rest);
      phase = "input";
      continue;
    }
    if (line.startsWith("Output:") && phase === "input") {
      pair.sawOutput = true;
      const rest = line.slice("Output:".length).replace(/^ /, "");
      if (rest !== "") pair.output.push(rest);
      phase = "output";
      continue;
    }
    if (line === "Hidden Test Cases:") {
      flushPair();
      rec.sawHidden = true;
      phase = "cases";
      continue;
    }

    if (phase === "constraint") {
      rec.constraint.push(line);
    } else if (phase === "input") {
      if (line.startsWith("Input:")) {
        rec.anomalies.push(`line ${at}: nested Input label merged into input`);
        const rest = line.slice("Input:".length).replace(/^ /, "");
        if (rest !== "") pair.input.push(rest);
      } else {
        pair.input.push(line);
      }
    } else if (phase === "output") {
      pair.output.push(line);
    } else if (phase === "cases") {
      if (line.trim() !== "") {
        rec.anomalies.push(`line ${at}: stray content between test cases: ${line.slice(0, 60)}`);
      }
    }
  }
  flushRec();
  return { records, fileAnomalies };
}

// â”€â”€ Block cleanup helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Trim trailing whitespace per line, drop leading/trailing blank lines,
// keep internal blank lines (some judges print them).
function tidyBlock(lines) {
  const cleaned = lines.map((l) => l.replace(/\s+$/, ""));
  let start = 0;
  let end = cleaned.length;
  while (start < end && cleaned[start] === "") start++;
  while (end > start && cleaned[end - 1] === "") end--;
  return cleaned.slice(start, end).join("\n");
}

function cleanTitle(t) {
  return t
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/^#+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

// "----- - 1 <= T <= 1000 - 0 <= N <= 10^7" -> ["1 <= T <= 1000", "0 <= N <= 10^7"]
function parseConstraints(raw) {
  const text = raw.replace(/^[-\s]+/, "").trim();
  if (!text || /^\(none stated\)$/i.test(text)) return [];
  const parts = text.split(/ - /).map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : [text];
}

const stats = {
  repairedSampleOutputInInput: 0,
  hintsRecovered: 0,
  caseExplanationsRecovered: 0,
  emptyExpectedOutputs: 0,
  noTestCases: 0,
  withConstraints: 0,
  withHidden: 0,
  duplicatesSkipped: 0,
  anomalies: [],
};

// â”€â”€ Build one schema-shaped question from a parsed record â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function buildQuestion(rec) {
  const title = cleanTitle(rec.title) || `Untitled question (line ${rec.line})`;
  let description = tidyBlock(rec.desc);
  if (!description) description = title;

  let difficulty = rec.difficulty.toLowerCase();
  if (!["easy", "medium", "hard"].includes(difficulty)) {
    rec.anomalies.push(`unknown difficulty "${rec.difficulty}" -> medium`);
    difficulty = "medium";
  }
  const score = { easy: 10, medium: 20, hard: 30 }[difficulty];

  const constraints = parseConstraints(tidyBlock(rec.constraint));
  if (constraints.length) stats.withConstraints++;

  const hints = [];
  const testCases = [];
  let visibleN = 0;
  let hiddenN = 0;

  for (const pair of rec.pairs) {
    let inputLines = pair.input;
    let outputLines = pair.output;
    let explanation = "";

    // Trailing "Hint:" / "Description:" section inside the output block.
    for (let k = outputLines.length - 1; k >= 0; k--) {
      const m = outputLines[k].match(/^(Hint|Description)\s*:\s*$/);
      if (m) {
        const tail = tidyBlock(outputLines.slice(k + 1));
        outputLines = outputLines.slice(0, k);
        if (m[1] === "Hint" && tail) {
          hints.push({ hintText: tail, isPublic: true, sequence: hints.length + 1 });
          stats.hintsRecovered++;
        } else if (tail) {
          explanation = tail.slice(0, 500);
          stats.caseExplanationsRecovered++;
        }
        break;
      }
    }

    let input = tidyBlock(inputLines);
    let expectedOutput = tidyBlock(outputLines);

    // "Sample output:" glued into the input while the Output marker was empty.
    if (expectedOutput === "") {
      const inLines = input.split("\n");
      for (let k = inLines.length - 1; k >= 0; k--) {
        if (/^Sample output\s*:\s*$/i.test(inLines[k])) {
          expectedOutput = tidyBlock(inLines.slice(k + 1));
          input = tidyBlock(inLines.slice(0, k));
          stats.repairedSampleOutputInInput++;
          break;
        }
      }
    }

    if (input === "" && expectedOutput === "" && !pair.sawOutput) continue;
    if (expectedOutput === "") stats.emptyExpectedOutputs++;

    const hidden = pair.hidden;
    const n = hidden ? ++hiddenN : ++visibleN;
    testCases.push({
      input,
      expectedOutput,
      isSample: !hidden,
      isHidden: hidden,
      points: 1,
      explanation: explanation || (hidden ? `Hidden Test Case ${n}` : `Test Case ${n}`),
    });
  }

  if (!testCases.length) stats.noTestCases++;
  if (rec.sawHidden) stats.withHidden++;
  for (const a of rec.anomalies) stats.anomalies.push(`"${title.slice(0, 50)}": ${a}`);

  const firstVisible = testCases.find((tc) => tc.isSample) || testCases[0];

  const q = {
    questionType: "programming",
    questionCategory: "Competitive Programming",
    title,
    description,
    difficulty,
    score,
    testCases,
    problemType: "Algorithm Design",
    topics: [],
    tags: [],
    source: IMPORT_SOURCE,
    createdBy: "questions.txt import",
    isActive: true,
  };
  if (firstVisible) {
    q.sampleInput = firstVisible.input;
    q.sampleOutput = firstVisible.expectedOutput;
  }
  if (constraints.length) q.constraints = constraints;
  if (hints.length) q.hints = hints;
  return q;
}

// â”€â”€ Main â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function main() {
  const text = fs.readFileSync(FILE, "utf8");
  const { records, fileAnomalies } = parseFile(text);
  stats.anomalies.push(...fileAnomalies);
  console.log(`Parsed ${records.length} records from ${FILE}`);

  const questions = [];
  const seen = new Set();
  for (const rec of records) {
    const q = buildQuestion(rec);
    const hash = crypto
      .createHash("sha1")
      .update([q.title, q.description, q.difficulty, JSON.stringify(q.testCases)].join("\u0000"))
      .digest("hex");
    if (seen.has(hash)) {
      stats.duplicatesSkipped++;
      continue;
    }
    seen.add(hash);
    questions.push(q);
  }

  // Smoke-test the schema shape on the first question before writing anything;
  // insertMany runs validators per-document at commit time so bad rows are
  // surfaced individually rather than aborting the whole batch.
  if (questions.length) {
    await new OtherPlatformQuestion(questions[0]).validate();
  }

  const byDifficulty = questions.reduce((acc, q) => {
    acc[q.difficulty] = (acc[q.difficulty] || 0) + 1;
    return acc;
  }, {});
  const totalCases = questions.reduce((n, q) => n + q.testCases.length, 0);
  const hiddenCases = questions.reduce(
    (n, q) => n + q.testCases.filter((tc) => tc.isHidden).length,
    0
  );
  const addedBytes = calculateObjectSize({ questions });

  fs.writeFileSync(OUT_FILE, JSON.stringify(questions, null, 1));
  console.log(
    `Built ${questions.length} questions ${JSON.stringify(byDifficulty)}, ` +
      `${totalCases} test cases (${hiddenCases} hidden), ~${(addedBytes / 1048576).toFixed(1)}MB BSON. ` +
      `Schema validation passed.`
  );
  console.log(
    `Repairs: ${stats.repairedSampleOutputInInput} sample-output-in-input, ` +
      `${stats.hintsRecovered} hints, ${stats.caseExplanationsRecovered} case explanations. ` +
      `Flags: ${stats.emptyExpectedOutputs} empty expected outputs, ` +
      `${stats.noTestCases} statement-only questions (no test cases), ` +
      `${stats.withHidden} questions with hidden sections, ` +
      `${stats.withConstraints} with constraints, ` +
      `${stats.duplicatesSkipped} exact in-file duplicates skipped.`
  );
  if (stats.anomalies.length) {
    console.log(`Anomalies (${stats.anomalies.length}):`);
    for (const a of stats.anomalies.slice(0, 30)) console.log(`  - ${a}`);
    if (stats.anomalies.length > 30) console.log(`  ... ${stats.anomalies.length - 30} more`);
  }
  console.log(`Preview written to ${OUT_FILE}`);

  if (!COMMIT) {
    console.log("\nDry run only â€” re-run with --commit to write to Mongo.");
    return;
  }

  // â”€â”€ Commit â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const envRaw = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
  const uriLine = envRaw.split(/\r?\n/).find((l) => l.startsWith("MONGOURI="));
  if (!uriLine) throw new Error("MONGOURI not found in server/.env");
  await mongoose.connect(uriLine.slice("MONGOURI=".length).trim(), {
    serverSelectionTimeoutMS: 20000,
  });

  // One document per question now â€” no 16MB doc-cap concern. Dedupe still runs
  // on title+description among prior imports carrying this same source tag.

  const dupKey = (q) => `${q.title}` + String.fromCharCode(0) + `${q.description}`;
  const existingDocs = await OtherPlatformQuestion
    .find({ source: IMPORT_SOURCE }, { title: 1, description: 1 })
    .lean();
  const existing = new Set(existingDocs.map(dupKey));
  const toAdd = questions.filter((q) => !existing.has(dupKey(q)));

  if (toAdd.length === 0) {
    console.log("\nNothing new to import — all questions already present.");
    await mongoose.disconnect();
    return;
  }

  const inserted = await OtherPlatformQuestion.insertMany(toAdd, { ordered: false });
  const totalNow = await OtherPlatformQuestion.estimatedDocumentCount();

  console.log(
    `\nCommitted to the OtherPlatformQuestion collection: added ${inserted.length}, ` +
      `skipped ${questions.length - toAdd.length} already-imported, ` +
      `collection now holds ${totalNow} questions.`
  );
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
