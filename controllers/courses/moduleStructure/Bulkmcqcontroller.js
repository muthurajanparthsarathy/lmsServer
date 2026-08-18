/**
 * Bulk MCQ Upload Controller
 * Handles document upload, parsing, and bulk insertion for MCQ questions.
 *
 * Supported formats: JSON, CSV, TXT (pipe-delimited)
 * All parsing is lenient — invalid rows are skipped, valid ones proceed.
 */

const mongoose = require("mongoose");
const { createClient } = require("@supabase/supabase-js");
const Papa = require("papaparse"); // npm i papaparse

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const { resolvePedagogyScope } = require("../../../utils/pedagogyScope");

const modelMap = {
  modules:   { model: () => mongoose.model("Module1") },
  submodules:{ model: () => mongoose.model("SubModule1") },
  topics:    { model: () => mongoose.model("Topic1") },
  subtopics: { model: () => mongoose.model("SubTopic1") },
};

// ---------------------------------------------------------------------------
// CONSTANTS & DEFAULTS
// ---------------------------------------------------------------------------
const VALID_TYPES = [
  "multiple_choice", "multiple_select", "true_false",
  "short_answer", "essay", "dropdown",
  "matching", "ordering", "numeric",
];
const DEFAULT_TYPE       = "multiple_choice";
const DEFAULT_DIFFICULTY = "medium";
const ALLOWED_DIFFICULTIES = ["easy", "medium", "hard"];

// ---------------------------------------------------------------------------
// PARSING UTILITIES
// ---------------------------------------------------------------------------

/**
 * Normalise a raw MCQ question object coming from any file format.
 * Returns { ok: true, question } on success, { ok: false, reason, raw } on failure.
 */
function normaliseQuestion(raw, rowIndex) {
  // ── Locate title ──────────────────────────────────────────────────────────
  const title =
    raw.questionTitle   ||
    raw.question_title  ||
    raw.title           ||
    raw.question        ||
    raw.Question        ||
    raw.QuestionTitle   ||
    "";

  if (!title || !String(title).trim()) {
    return { ok: false, reason: "Missing questionTitle", raw, rowIndex };
  }

  // ── Build mcqQuestionTitle as content block array (matches DB format) ─────
  let questionContent = null;

  if (Array.isArray(raw.questionContent) && raw.questionContent.length > 0) {
    // Use provided content blocks — skip image blocks silently
    const blocks = raw.questionContent
      .filter((cb) => cb.type === "text" || cb.type === "code")
      .map((cb, i) => ({
        id: `doc-${rowIndex}-${cb.type}-${i}`,
        type: cb.type,
        value: cb.value || "",
        ...(cb.type === "code"
          ? {
              bgColor:  cb.bgColor  || "#1e1e1e",
              language: cb.language || "javascript",
            }
          : {}),
      }));

    if (blocks.length > 0) {
      questionContent = blocks;
    }
  }

  // Fallback: wrap plain title string in a single text block
  if (!questionContent) {
    questionContent = [
      {
        id: `doc-${rowIndex}-text-0`,
        type: "text",
        value: String(title).trim(),
      },
    ];
  }

  // ── Locate options ────────────────────────────────────────────────────────
  let options = [];

  if (raw.options && Array.isArray(raw.options)) {
    options = raw.options;
  } else if (raw.Options && Array.isArray(raw.Options)) {
    options = raw.Options;
  } else {
    const letters = ["A","B","C","D","E","F","G","H"];
    for (const l of letters) {
      const v = raw[`option${l}`] || raw[`option_${l}`] || raw[`Option${l}`] || raw[`Option_${l}`];
      if (v && String(v).trim()) options.push(String(v).trim());
    }
    for (let i = 1; i <= 8; i++) {
      const v = raw[`option${i}`] || raw[`option_${i}`];
      if (v && String(v).trim()) options.push(String(v).trim());
    }
  }

  // Normalise options to { text, isCorrect }
  const normOptions = options.map((o) => {
    if (typeof o === "string") return { text: o, isCorrect: false };
    if (typeof o === "object" && o !== null) {
      return {
        text:             String(o.text || o.label || o.value || "").trim(),
        isCorrect:        Boolean(o.isCorrect || o.correct || o.is_correct),
        imageUrl:         o.imageUrl || o.image_url || null,
        imageAlignment:   o.imageAlignment || "left",
        imageSizePercent: o.imageSizePercent || 100,
      };
    }
    return null;
  }).filter(Boolean).filter((o) => o.text);

  // ── Locate answer ─────────────────────────────────────────────────────────
  const answerRaw =
    raw.answer         ||
    raw.Answer         ||
    raw.correctAnswer  ||
    raw.correct_answer ||
    raw.correctAnswers ||
    raw.correct_answers||
    raw.answers        ||
    null;

  if (answerRaw !== null && answerRaw !== undefined && answerRaw !== "") {
    const answers = Array.isArray(answerRaw)
      ? answerRaw.map(String)
      : [String(answerRaw)];

    normOptions.forEach((o, idx) => {
      const byLetter = String.fromCharCode(65 + idx);
      const byIndex  = String(idx + 1);
      const byText   = o.text.toLowerCase().trim();

      o.isCorrect = answers.some((a) => {
        const ca = a.trim();
        return (
          ca.toUpperCase() === byLetter ||
          ca === byIndex ||
          ca.toLowerCase() === byText ||
          ca.toLowerCase() === byText.substring(0, 80)
        );
      });
    });
  }

  // ── Type ──────────────────────────────────────────────────────────────────
  const rawType = raw.type || raw.questionType || raw.question_type || raw.selectionType || raw.selection_type || DEFAULT_TYPE;
  const mappedType = mapTypeAlias(String(rawType).toLowerCase().trim());

  // ── Difficulty ────────────────────────────────────────────────────────────
  const diffRaw = String(raw.difficulty || raw.Difficulty || DEFAULT_DIFFICULTY).toLowerCase().trim();
  const difficulty = ALLOWED_DIFFICULTIES.includes(diffRaw) ? diffRaw : DEFAULT_DIFFICULTY;

  // ── Score ─────────────────────────────────────────────────────────────────
  const score = Number(raw.score || raw.Score || raw.marks || raw.Marks || 0) || undefined;

  // ── Explanation ───────────────────────────────────────────────────────────
  const explanation =
    raw.explanation || raw.Explanation || raw.reason || raw.Reason || "";

  // ── Build normalised question ─────────────────────────────────────────────
  const question = {
    mcqQuestionTitle:     questionContent,      // ← array of blocks now
    mcqQuestionType:      mappedType,
    mcqQuestionDifficulty: difficulty,
    mcqQuestionScore:     score,
    mcqQuestionOptions: normOptions.map((o) => ({
      text:             o.text,
      isCorrect:        o.isCorrect || false,
      imageUrl:         o.imageUrl || null,
      imageAlignment:   o.imageAlignment || "left",
      imageSizePercent: o.imageSizePercent || 100,
    })),
    mcqQuestionCorrectAnswers: normOptions
      .filter((o) => o.isCorrect)
      .map((o) => o.text),
    mcqQuestionRequired:      raw.required !== undefined ? Boolean(raw.required) : true,
    hasExplanation:           Boolean(explanation),
    mcqQuestionDescription:   String(explanation).trim() || undefined,
    mcqQuestionOptionsPerRow: Number(raw.optionsPerRow || raw.options_per_row || 1) || 1,
    isActive:                 raw.isActive !== undefined ? Boolean(raw.isActive) : true,
    questionType:             "mcq",
  };

  // ── Validation ────────────────────────────────────────────────────────────
  const isOptionBased = ["multiple_choice","multiple_select","dropdown","checkboxes"].includes(mappedType);

  if (isOptionBased) {
    if (question.mcqQuestionOptions.length < 2) {
      return { ok: false, reason: "Needs at least 2 options", raw, rowIndex };
    }
    if (!question.mcqQuestionOptions.some((o) => o.isCorrect)) {
      return { ok: false, reason: "No correct answer marked", raw, rowIndex };
    }
  }

  return { ok: true, question, rowIndex };
}

/** Map common type aliases to canonical backend values */
function mapTypeAlias(raw) {
  const aliases = {
    "multiple_choice":  "multiple_choice",
    "multiple-choice":  "multiple_choice",
    "multiplechoice":   "multiple_choice",
    "single":           "multiple_choice",
    "single_choice":    "multiple_choice",
    "mcq":              "multiple_choice",
    "multiple_select":  "multiple_select",
    "multiple-select":  "multiple_select",
    "multiselect":      "multiple_select",
    "multi_select":     "multiple_select",
    "checkbox":         "multiple_select",
    "checkboxes":       "multiple_select",
    "true_false":       "true_false",
    "true-false":       "true_false",
    "truefalse":        "true_false",
    "tf":               "true_false",
    "boolean":          "true_false",
    "short_answer":     "short_answer",
    "short-answer":     "short_answer",
    "shortanswer":      "short_answer",
    "fill":             "short_answer",
    "fill_blank":       "short_answer",
    "essay":            "essay",
    "paragraph":        "essay",
    "long_answer":      "essay",
    "dropdown":         "dropdown",
    "select":           "dropdown",
    "matching":         "matching",
    "match":            "matching",
    "ordering":         "ordering",
    "sequence":         "ordering",
    "order":            "ordering",
    "numeric":          "numeric",
    "number":           "numeric",
    "numerical":        "numeric",
  };
  return aliases[raw] || (VALID_TYPES.includes(raw) ? raw : DEFAULT_TYPE);
}

// ---------------------------------------------------------------------------
// FILE PARSERS
// ---------------------------------------------------------------------------

function parseJSON(buffer) {
  const text = buffer.toString("utf8").trim();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON: ${e.message}`);
  }

  // Accept { questions: [...] } or top-level array
  const arr = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.questions)
    ? parsed.questions
    : [parsed];

  return arr;
}

function parseCSV(buffer) {
  const text = buffer.toString("utf8");
  const result = Papa.parse(text, {
    header:       true,
    skipEmptyLines: true,
    dynamicTyping: false,
    transformHeader: (h) => h.trim(),
  });
  if (result.errors?.length) {
    // Only hard-fail on critical parse errors; row-level errors come through as meta
    const fatal = result.errors.filter((e) => e.type === "Delimiter" || e.type === "Quotes");
    if (fatal.length) throw new Error(`CSV parse error: ${fatal[0].message}`);
  }
  return result.data;
}

/**
 * TXT: pipe-delimited or JSON-per-line.
 * Pipe format: questionTitle | optionA | optionB | optionC | optionD | answer | difficulty
 */
function parseTXT(buffer) {
  const text = buffer.toString("utf8");
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rows = [];

  for (const line of lines) {
    // Try JSON-per-line first
    if (line.startsWith("{")) {
      try {
        rows.push(JSON.parse(line));
        continue;
      } catch (_) { /* fall through to pipe */ }
    }

    // Pipe-delimited: title|optA|optB|optC|optD|answer|difficulty
    if (line.includes("|")) {
      const parts = line.split("|").map((p) => p.trim());
      if (parts.length >= 3) {
        const [questionTitle, ...rest] = parts;
        const answer     = rest.pop() && rest[rest.length - 1] === rest[rest.length - 1] ? rest.pop() : undefined;
        const difficulty = ALLOWED_DIFFICULTIES.includes(rest[rest.length - 1]?.toLowerCase())
          ? rest.pop()
          : undefined;
        rows.push({ questionTitle, options: rest.filter(Boolean), answer, difficulty });
        continue;
      }
    }

    // Tab-delimited fallback
    if (line.includes("\t")) {
      const parts = line.split("\t").map((p) => p.trim());
      if (parts.length >= 3) {
        const [questionTitle, ...rest] = parts;
        rows.push({ questionTitle, options: rest });
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// SUPABASE UPLOAD
// ---------------------------------------------------------------------------

async function storeDocumentInSupabase(fileBuffer, originalName, exerciseId, uploadedBy) {
  const timestamp  = Date.now();
  const safeName   = originalName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const filePath   = `bulk-uploads/${exerciseId}/${timestamp}_${safeName}`;

  const { data, error } = await supabase.storage
    .from("smartlms")
    .upload(filePath, fileBuffer, {
      contentType: "application/octet-stream",
      cacheControl: "3600",
      upsert: false,
    });

  if (error) throw new Error(`Supabase upload failed: ${error.message}`);

  const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/smartlms/${filePath}`;
  return { filePath, publicUrl };
}

// ---------------------------------------------------------------------------
// CONTROLLER: Parse & Preview  (POST /bulk-upload/parse/:type/:id/exercise/:exerciseId)
// ---------------------------------------------------------------------------

/**
 * Step 1 — Upload document to Supabase and return parsed + validated questions.
 * Does NOT write to MongoDB.  The client uses the preview to confirm before calling
 * the bulk-insert endpoint.
 */
exports.parseBulkDocument = async (req, res) => {
  try {
    const { type, id, exerciseId } = req.params;
    const { tabType, subcategory }  = req.body;

    if (!modelMap[type]) {
      return res.status(400).json({
        message: [{ key: "error", value: `Invalid entity type: ${type}` }],
      });
    }

    // ── File ──────────────────────────────────────────────────────────────────
    const file = req.files?.document;
    if (!file) {
      return res.status(400).json({
        message: [{ key: "error", value: "No file uploaded. Field name must be 'document'." }],
      });
    }

    // ── Safe extension extraction ─────────────────────────────────────────────
    const rawName = file.name || file.originalname || "";
    const dotIndex = rawName.lastIndexOf(".");
    let ext = dotIndex >= 0 ? rawName.slice(dotIndex + 1).toLowerCase() : "";

    // ── Content-sniff FIRST — before the block-check ──────────────────────────
    // Fixes cases where filename extension is mangled (.son, .SON, etc.)
    const preview = file.data.toString("utf8").trim().substring(0, 10);
    if (preview.startsWith("{") || preview.startsWith("[")) {
      ext = "json";
    }

    // ── Block-check AFTER sniff has corrected ext ─────────────────────────────
    const allowedExts = ["json", "csv", "txt"];
    if (!allowedExts.includes(ext)) {
      return res.status(400).json({
        message: [{ key: "error", value: `Unsupported file type .${ext}. Use: json, csv, txt` }],
      });
    }

    // ── Upload to Supabase for audit/re-use ───────────────────────────────────
    let storageResult = null;
    try {
      storageResult = await storeDocumentInSupabase(
        file.data,
        file.name,
        exerciseId,
        req.user?.email || "system"
      );
    } catch (storageErr) {
      // Non-fatal — parsing continues even if storage fails
      console.warn("⚠️ Document storage failed (non-fatal):", storageErr.message);
    }

    // ── Parse ─────────────────────────────────────────────────────────────────
    let rawRows = [];
    try {
      if (ext === "json")      rawRows = parseJSON(file.data);
      else if (ext === "csv")  rawRows = parseCSV(file.data);
      else                     rawRows = parseTXT(file.data);
    } catch (parseErr) {
      return res.status(422).json({
        message: [{ key: "error", value: `File parse error: ${parseErr.message}` }],
      });
    }

    if (!rawRows.length) {
      return res.status(422).json({
        message: [{ key: "error", value: "Document contains no rows." }],
      });
    }

    // ── Normalise every row ───────────────────────────────────────────────────
    const valid   = [];
    const invalid = [];

    rawRows.forEach((raw, i) => {
      const result = normaliseQuestion(raw, i + 1);
      if (result.ok) valid.push({ ...result.question, _previewId: `prev-${i}` });
      else invalid.push({ rowIndex: result.rowIndex, reason: result.reason, raw: result.raw });
    });

    // ── Fetch current exercise to compute capacity ────────────────────────────
    let exerciseCapacity = null;
    try {
      const Model  = modelMap[type].model();
      const entity = await Model.findById(id);
      // Resources by Batch — read capacity from the SAME container the
      // questions will be written to. Against the shared container a
      // batch-wise exercise looks absent, and the upload gets sized against
      // the wrong exercise (or refused outright).
      const { container: pedagogyRoot } = entity
        ? await resolvePedagogyScope(entity, tabType, req)
        : { container: null };
      if (pedagogyRoot?.[tabType]) {
        const tabData = pedagogyRoot[tabType] instanceof Map
          ? Object.fromEntries(pedagogyRoot[tabType])
          : pedagogyRoot[tabType];
        const exercises = tabData[subcategory] || [];
        const found = exercises.find(
          (ex) => ex._id?.toString() === exerciseId || ex.exerciseInformation?.exerciseId === exerciseId
        );
        if (found) {
          const cfg      = found.questionConfiguration?.mcqQuestionConfiguration;
          const existing = (found.questions || []).filter((q) => q.questionType === "mcq");
          if (cfg) {
            const scoringType = cfg.scoringType || "equalDistribution";
            if (scoringType === "equalDistribution") {
              exerciseCapacity = {
                scoringType,
                totalAllowed:     cfg.totalMcqQuestions || 0,
                currentCount:     existing.length,
                remaining:        Math.max(0, (cfg.totalMcqQuestions || 0) - existing.length),
                marksPerQuestion: cfg.marksPerQuestion || 0,
              };
            } else {
              const usedMarks = existing.reduce((s, q) => s + (q.mcqQuestionScore || 0), 0);
              exerciseCapacity = {
                scoringType,
                maxMarks:       cfg.mcqTotalMarks || 0,
                usedMarks,
                remainingMarks: Math.max(0, (cfg.mcqTotalMarks || 0) - usedMarks),
              };
            }
          }
        }
      }
    } catch (_) {
      // Capacity check is best-effort
    }

    // ── Override score for equalDistribution ──────────────────────────────────
    if (
      exerciseCapacity?.scoringType === "equalDistribution" &&
      exerciseCapacity.marksPerQuestion
    ) {
      valid.forEach((q) => {
        q.mcqQuestionScore = exerciseCapacity.marksPerQuestion;
      });
    }

    return res.status(200).json({
      message: [{ key: "success", value: `Parsed ${rawRows.length} rows` }],
      data: {
        valid,
        invalid,
        summary: {
          total:   rawRows.length,
          valid:   valid.length,
          invalid: invalid.length,
        },
        exerciseCapacity,
        storage: storageResult
          ? { url: storageResult.publicUrl, path: storageResult.filePath }
          : null,
      },
    });
  } catch (err) {
    console.error("❌ parseBulkDocument error:", err);
    res.status(500).json({
      message: [{ key: "error", value: `Internal server error: ${err.message}` }],
    });
  }
};

// ---------------------------------------------------------------------------
// CONTROLLER: Bulk Insert  (POST /bulk-upload/insert/:type/:id/exercise/:exerciseId)
// ---------------------------------------------------------------------------

/**
 * Step 2 — Insert the confirmed (client-selected) questions into MongoDB.
 * Applies all existing exercise constraints before writing.
 *
 * Body: { tabType, subcategory, questions: [ ...normalised MCQ objects ] }
 */
exports.insertBulkQuestions = async (req, res) => {
  try {
    const { type, id, exerciseId } = req.params;
    const { tabType, subcategory, questions } = req.body;

    if (!modelMap[type]) {
      return res.status(400).json({
        message: [{ key: "error", value: `Invalid entity type: ${type}` }],
      });
    }

    if (!Array.isArray(questions) || !questions.length) {
      return res.status(400).json({
        message: [{ key: "error", value: "questions array is required and must not be empty." }],
      });
    }

    const Model = modelMap[type].model();

    // ── READ only — lean() so no Mongoose tracking, no VersionError ───────────
    const entity = await Model.findById(id).lean();
    if (!entity) {
      return res.status(404).json({
        message: [{ key: "error", value: `${type} with ID ${id} not found` }],
      });
    }

    // ── Locate the exercises array for this tabType + subcategory ─────────────
    // Resources by Batch — resolve the container first, so a batch-wise
    // exercise is found in its own batch instead of reported missing.
    const { container: pedagogyRoot } = await resolvePedagogyScope(entity, tabType, req);
    const tabData = pedagogyRoot?.[tabType];
    if (!tabData) {
      return res.status(404).json({
        message: [{ key: "error", value: `tabType "${tabType}" not found` }],
      });
    }

    // lean() converts Maps to plain objects, so just access by key
    const exercises =
      Array.isArray(tabData)
        ? tabData
        : Array.isArray(tabData[subcategory])
        ? tabData[subcategory]
        : null;

    if (!Array.isArray(exercises)) {
      return res.status(404).json({
        message: [{ key: "error", value: `subcategory "${subcategory}" not found` }],
      });
    }

    // ── Find the exercise — match by _id OR exerciseInformation.exerciseId ────
    const exercise = exercises.find(
      (ex) =>
        ex._id?.toString() === exerciseId ||
        ex.exerciseInformation?.exerciseId === exerciseId
    );

    if (!exercise) {
      return res.status(404).json({
        message: [{ key: "error", value: `Exercise "${exerciseId}" not found` }],
      });
    }

    // ── Use the REAL subdocument _id for the atomic update ────────────────────
    // exerciseId param may be exerciseInformation.exerciseId (a string),
    // NOT the MongoDB _id — so we always use the actual _id from the lean read
    const actualExerciseObjectId = exercise._id;

    const cfg         = exercise.questionConfiguration?.mcqQuestionConfiguration;
    const scoringType = cfg?.scoringType || "equalDistribution";
    const existingMCQ = (exercise.questions || []).filter(
      (q) => q.questionType === "mcq"
    );

    // ── Apply capacity constraints ─────────────────────────────────────────────
    let accepted = [...questions];
    const rejected = [];

    if (cfg) {
      if (scoringType === "equalDistribution") {
        const remaining = Math.max(
          0,
          (cfg.totalMcqQuestions || 0) - existingMCQ.length
        );
        if (remaining <= 0) {
          return res.status(409).json({
            message: [{ key: "error", value: "Exercise MCQ question limit already reached." }],
          });
        }
        if (accepted.length > remaining) {
          rejected.push(
            ...accepted.slice(remaining).map((q) => ({
              question: q,
              reason: `Exceeds question limit (max ${cfg.totalMcqQuestions})`,
            }))
          );
          accepted = accepted.slice(0, remaining);
        }
      } else if (scoringType === "questionSpecific") {
        const usedMarks = existingMCQ.reduce(
          (s, q) => s + (q.mcqQuestionScore || 0),
          0
        );
        const maxMarks = cfg.mcqTotalMarks || 0;
        let remaining  = maxMarks - usedMarks;

        const filtered = [];
        for (const q of accepted) {
          const qScore = Number(q.mcqQuestionScore) || 0;
          if (qScore > 0 && remaining - qScore < 0) {
            rejected.push({
              question: q,
              reason: `Would exceed marks budget (remaining: ${remaining.toFixed(1)})`,
            });
          } else {
            remaining -= qScore;
            filtered.push(q);
          }
        }
        accepted = filtered;
      }
    }

    if (!accepted.length) {
      return res.status(409).json({
        message: [{ key: "error", value: "No questions could be added due to exercise constraints." }],
        data: { rejected },
      });
    }

    // ── Build new question documents ───────────────────────────────────────────
    const startSeq     = (exercise.questions || []).length;
    const newQuestions = [];
    const inserted     = [];

    for (let i = 0; i < accepted.length; i++) {
      const q   = accepted[i];
      const qId = new mongoose.Types.ObjectId();

      const newQ = {
        _id:          qId,
        questionType: "mcq",
        // Bulk-document imports bill the Manual quota slice — same tag the
        // in-form .txt upload stamps ('scratch-manual'), so per-source
        // quota math and the source badge cover this ingress too.
        source:       q.source || "scratch-manual",

        mcqQuestionTitle:      q.mcqQuestionTitle,
        mcqQuestionType:       q.mcqQuestionType      || "multiple_choice",
        mcqQuestionDifficulty: q.mcqQuestionDifficulty || "medium",

        mcqQuestionScore:
          scoringType === "equalDistribution"
            ? cfg?.marksPerQuestion || 0
            : Number(q.mcqQuestionScore) || 0,

        mcqQuestionOptions: (q.mcqQuestionOptions || []).map((o) => ({
          _id:              new mongoose.Types.ObjectId(),
          text:             String(o.text || "").trim(),
          isCorrect:        Boolean(o.isCorrect),
          imageUrl:         o.imageUrl         || null,
          imageAlignment:   o.imageAlignment   || "left",
          imageSizePercent: o.imageSizePercent || 100,
        })),

        mcqQuestionCorrectAnswers: q.mcqQuestionCorrectAnswers || [],
        mcqQuestionRequired:       q.mcqQuestionRequired !== false,
        mcqQuestionOptionsPerRow:  Number(q.mcqQuestionOptionsPerRow) || 1,
        hasOtherOption:            false,
        hasExplanation:            Boolean(q.mcqQuestionDescription),
        mcqQuestionDescription:    q.mcqQuestionDescription || undefined,
        isActive:                  true,
        sequence:                  startSeq + i,
        createdAt:                 new Date(),
        updatedAt:                 new Date(),
      };

      newQuestions.push(newQ);
      inserted.push({
        questionId: qId.toString(),
        title:      q.mcqQuestionTitle,
        sequence:   newQ.sequence,
      });
    }

    // ── Atomic $push using the actual subdocument _id ─────────────────────────
    const updateResult = await Model.findOneAndUpdate(
      {
        _id: id,
        // Match the correct exercise using its real MongoDB _id
        [`pedagogy.${tabType}.${subcategory}._id`]: actualExerciseObjectId,
      },
      {
        $push: {
          [`pedagogy.${tabType}.${subcategory}.$.questions`]: {
            $each: newQuestions,
          },
        },
        $set: {
          updatedAt: new Date(),
          updatedBy: req.user?.email || "system",
        },
      },
      {
        new: true,
        runValidators: false,
      }
    );

    if (!updateResult) {
      return res.status(404).json({
        message: [
          {
            key: "error",
            value: "Could not locate exercise to update. Please refresh and try again.",
          },
        ],
      });
    }

    return res.status(201).json({
      message: [
        {
          key: "success",
          value: `Successfully inserted ${inserted.length} MCQ question(s)`,
        },
      ],
      data: {
        inserted,
        rejected,
        exercise: {
          exerciseId:     exercise.exerciseInformation?.exerciseId || exerciseId,
          exerciseName:   exercise.exerciseInformation?.exerciseName,
          totalQuestions: startSeq + newQuestions.length,
        },
      },
    });
  } catch (err) {
    console.error("❌ insertBulkQuestions error:", err);

    if (err.name === "VersionError") {
      return res.status(409).json({
        message: [
          {
            key: "error",
            value: "Document was modified concurrently. Please refresh and try again.",
          },
        ],
      });
    }

    return res.status(500).json({
      message: [
        {
          key: "error",
          value: `Internal server error: ${err.message}`,
        },
      ],
    });
  }
};
// ---------------------------------------------------------------------------
// CONTROLLER: Download template  (GET /bulk-upload/template/:format)
// ---------------------------------------------------------------------------
exports.downloadTemplate = (req, res) => {
  const { format = "json" } = req.params;

  const sampleJSON = JSON.stringify(
    {
      questions: [
        {
          questionTitle: "Which of the following is a JavaScript data type?",
          type: "multiple_choice",
          difficulty: "easy",
          score: 5,
          options: [
            { text: "String",  isCorrect: true  },
            { text: "Integer", isCorrect: false },
            { text: "Float",   isCorrect: false },
            { text: "Char",    isCorrect: false },
          ],
          answer: "String",
          explanation: "JavaScript has String, Number, Boolean, null, undefined, Object, Symbol.",
        },
        {
          questionTitle: "Select all primitive types in JavaScript.",
          type: "multiple_select",
          difficulty: "medium",
          score: 10,
          options: [
            { text: "String",  isCorrect: true  },
            { text: "Number",  isCorrect: true  },
            { text: "Array",   isCorrect: false },
            { text: "Boolean", isCorrect: true  },
          ],
        },
        {
          questionTitle: "JavaScript is a compiled language.",
          type: "true_false",
          difficulty: "easy",
          score: 3,
          answer: "false",
        },
        {
          questionTitle: "What keyword is used to declare a constant?",
          type: "short_answer",
          difficulty: "easy",
          score: 5,
          answer: "const",
        },
        {
          questionTitle: "What value does 5 + '3' produce in JavaScript?",
          type: "multiple_choice",
          difficulty: "hard",
          score: 10,
          options: [
            { text: "8",   isCorrect: false },
            { text: "53",  isCorrect: true  },
            { text: "NaN", isCorrect: false },
            { text: "15",  isCorrect: false },
          ],
          answer: "53",
          explanation: "JS coerces 5 to '5', then concatenates to '53'.",
        },
      ],
    },
    null,
    2
  );

  const sampleCSV = [
    "questionTitle,optionA,optionB,optionC,optionD,answer,difficulty,score,type",
    "Which keyword declares a constant?,var,let,const,def,C,easy,5,multiple_choice",
    "Which are JS primitives?,String,Number,Array,Boolean,A|B|D,medium,10,multiple_select",
    "JS is interpreted at runtime?,True,False,,,B,easy,3,true_false",
  ].join("\n");
const sampleTXT = JSON.stringify(
  {
    questions: [
      {
        questionTitle: "What is the output of this code?",
        questionContent: [
          { type: "text", value: "What is the output of this code?" },
          { type: "code", value: "console.log(typeof null);", bgColor: "#1e1e1e", language: "javascript" }
        ],
        options: [
          { text: "null",      isCorrect: false },
          { text: "undefined", isCorrect: false },
          { text: "object",    isCorrect: true  },
          { text: "string",    isCorrect: false }
        ],
        answer: "C",
        difficulty: "hard",
        score: 10
      },
      {
        questionTitle: "What does this function return?",
        questionContent: [
          { type: "text", value: "What does this function return?" },
          { type: "code", value: "function add(a, b) {\n  return a + b;\n}\nconsole.log(add(2, '3'));", bgColor: "#1e1e1e", language: "javascript" }
        ],
        options: [
          { text: "5",     isCorrect: false },
          { text: "23",    isCorrect: true  },
          { text: "NaN",   isCorrect: false },
          { text: "Error", isCorrect: false }
        ],
        answer: "B",
        difficulty: "medium",
        score: 10
      },
      {
        questionTitle: "What is the output of this snippet?",
        questionContent: [
          { type: "text", value: "What is the output of this snippet?" },
          { type: "code", value: "const arr = [1, 2, 3];\nconsole.log(arr[arr.length]);", bgColor: "#1e1e1e", language: "javascript" }
        ],
        options: [
          { text: "3",         isCorrect: false },
          { text: "undefined", isCorrect: true  },
          { text: "null",      isCorrect: false },
          { text: "Error",     isCorrect: false }
        ],
        answer: "B",
        difficulty: "medium",
        score: 10
      },
      {
        questionTitle: "What will this code print?",
        questionContent: [
          { type: "text", value: "What will this code print?" },
          { type: "code", value: "let x = 5;\nlet y = x++;\nconsole.log(x, y);", bgColor: "#282a36", language: "javascript" }
        ],
        options: [
          { text: "5 5", isCorrect: false },
          { text: "6 5", isCorrect: true  },
          { text: "5 6", isCorrect: false },
          { text: "6 6", isCorrect: false }
        ],
        answer: "B",
        difficulty: "medium",
        score: 10
      },
      {
        questionTitle: "What does this arrow function return?",
        questionContent: [
          { type: "text", value: "What does this arrow function return?" },
          { type: "code", value: "const fn = () => ({ key: 'value' });\nconsole.log(fn());", bgColor: "#1e1e1e", language: "javascript" }
        ],
        options: [
          { text: "undefined",        isCorrect: false },
          { text: "{ key: 'value' }", isCorrect: true  },
          { text: "SyntaxError",      isCorrect: false },
          { text: "null",             isCorrect: false }
        ],
        answer: "B",
        difficulty: "hard",
        score: 10
      },
      {
        questionTitle: "Which keyword declares a block-scoped variable?",
        options: [
          { text: "var",   isCorrect: false },
          { text: "let",   isCorrect: true  },
          { text: "scope", isCorrect: false },
          { text: "def",   isCorrect: false }
        ],
        answer: "B",
        difficulty: "easy",
        score: 5
      },
      {
        questionTitle: "JavaScript is a statically typed language.",
        type: "true_false",
        options: [
          { text: "True",  isCorrect: false },
          { text: "False", isCorrect: true  }
        ],
        answer: "B",
        difficulty: "easy",
        score: 3
      },
      {
        questionTitle: "What method converts a JSON string to a JavaScript object?",
        options: [
          { text: "JSON.stringify", isCorrect: false },
          { text: "JSON.parse",     isCorrect: true  },
          { text: "JSON.convert",   isCorrect: false },
          { text: "JSON.decode",    isCorrect: false }
        ],
        answer: "B",
        difficulty: "easy",
        score: 5
      }
    ]
  },
  null,
  2
);

  if (format === "csv") {
    res.setHeader("Content-Disposition", 'attachment; filename="mcq_template.csv"');
    res.setHeader("Content-Type", "text/csv");
    return res.send(sampleCSV);
  }
  if (format === "txt") {
    res.setHeader("Content-Disposition", 'attachment; filename="mcq_template.txt"');
    res.setHeader("Content-Type", "text/plain");
    return res.send(sampleTXT);
  }
  // default JSON
  res.setHeader("Content-Disposition", 'attachment; filename="mcq_template.json"');
  res.setHeader("Content-Type", "application/json");
  return res.send(sampleJSON);
};