// External Assessment — an assessment run for people who are NOT LMS users.
//
// Deliberately its OWN top-level collection rather than an embedded exercise
// on the pedagogy tree (module/subModule/topic/subTopic), because an external
// assessment belongs to no course: there is no module to hang it under, and
// nothing about it should be reachable from a course query. Participants live
// in `external-participants` and never touch `lms-users`.
//
// The question subdocument mirrors the LMS `questionSchema` field names
// (mcqQuestionTitle / mcqQuestionOptions / mcqQuestionCorrectAnswers / …) so
// the admin question-authoring UI can be reused with the same payload shape.
// It is a COPY, not a shared import: the pedagogy schemas are duplicated
// across four files that are kept in lockstep, and importing one of them here
// would couple this module to that churn.

const mongoose = require("mongoose");

// One MCQ option. Same shape as the LMS optionSchema.
const optionSchema = new mongoose.Schema(
  {
    text: { type: String, default: "" },
    isCorrect: { type: Boolean, default: false },
    imageUrl: { type: String, default: null },
  },
  { _id: true }
);

const matchingPairSchema = new mongoose.Schema(
  { left: { type: String, default: "" }, right: { type: String, default: "" } },
  { _id: true }
);

const orderingItemSchema = new mongoose.Schema(
  { text: { type: String, default: "" }, order: { type: Number, default: 0 } },
  { _id: true }
);

// Question types match the LMS `mcqQuestionType` enum exactly, so the shared
// authoring UI's type picker needs no translation layer.
const QUESTION_TYPES = [
  "multiple_choice",
  "multiple_select",
  "true_false",
  "short_answer",
  "essay",
  "dropdown",
  "matching",
  "ordering",
  "numeric",
  "checkboxes",
];

// One programming test case. Mirrors the LMS `testCaseSchema`
// (subTopicModal.js:4-14).
const testCaseSchema = new mongoose.Schema(
  {
    input: { type: String, default: "" },
    expectedOutput: { type: String, default: "" },
    // Sample cases are shown to the participant; hidden ones only judge.
    isSample: { type: Boolean, default: false },
    isHidden: { type: Boolean, default: false },
    points: { type: Number, default: 0, min: 0 },
    explanation: { type: String, default: "" },
  },
  { _id: true }
);

const externalQuestionSchema = new mongoose.Schema(
  {
    // Which authoring form produced this question, and which form reopens it.
    // `mcq` covers all ten objective types (the mcqQuestionType field below
    // says which); `programming` is the code-question shape.
    questionKind: {
      type: String,
      enum: ["mcq", "programming"],
      default: "mcq",
      index: true,
    },
    // Where it came from — drives the per-source quota counters on the
    // Add Question picker.
    source: {
      type: String,
      enum: ["scratch", "bank", "ai", "thirdParty", "document"],
      default: "scratch",
    },

    mcqQuestionType: { type: String, enum: QUESTION_TYPES, default: "multiple_choice" },
    mcqQuestionTitle: { type: String, default: "" },
    mcqQuestionDescription: { type: String, default: "" },
    mcqQuestionLevel: { type: String, enum: ["easy", "medium", "hard"], default: "easy" },
    mcqQuestionScore: { type: Number, default: 1 },
    mcqQuestionOptions: [optionSchema],
    // Stored as option TEXT (not index) so re-ordering options cannot silently
    // change which answer is correct — same rule the LMS bank follows.
    mcqQuestionCorrectAnswers: [{ type: String }],
    trueFalseAnswer: { type: Boolean, default: null },
    shortAnswer: { type: String, default: "" },
    essayAnswer: { type: String, default: "" },
    numericAnswer: { type: Number, default: null },
    numericTolerance: { type: Number, default: null },
    matchingPairs: [matchingPairSchema],
    orderingItems: [orderingItemSchema],

    // ── Programming questions (questionKind === "programming") ──
    // Field names follow the LMS programming payload (apiServices/question.ts)
    // so the authoring UI produces the same shape on both sides.
    title: { type: String, default: "" },
    description: { type: String, default: "" },
    category: { type: String, default: "" },
    tags: { type: [String], default: [] },
    // function     — the participant fills in one function body
    // fullProgram  — they write the whole program including I/O
    executionMode: { type: String, enum: ["function", "fullProgram"], default: "fullProgram" },
    // blank  — empty editor
    // custom — pre-filled with `starterCode`
    starterMode: { type: String, enum: ["blank", "custom"], default: "blank" },
    starterCode: { type: String, default: "" },
    solutionCode: { type: String, default: "" },
    functionName: { type: String, default: "" },
    language: { type: String, default: "" },
    constraints: { type: [String], default: [] },
    hints: { type: [String], default: [] },
    sampleInput: { type: String, default: "" },
    sampleOutput: { type: String, default: "" },
    testCases: { type: [testCaseSchema], default: [] },
    // Seconds / MB ceilings for a run. Same bounds the LMS uses.
    timeLimit: { type: Number, default: 2, min: 0, max: 10000 },
    memoryLimit: { type: Number, default: 256, min: 0, max: 1024 },

    sequence: { type: Number, default: 0 },
  },
  { _id: true, strict: false, minimize: false }
);

const settingsSchema = new mongoose.Schema(
  {
    shuffleQuestions: { type: Boolean, default: false },
    shuffleOptions: { type: Boolean, default: false },
    // How many times ONE participant may sit the assessment. 1 is the norm for
    // an invited external sitting.
    maxAttempts: { type: Number, default: 1, min: 1, max: 10 },
    negativeMarking: { type: Boolean, default: false },
    negativeMarkPerWrong: { type: Number, default: 0 },
    // Whether the participant sees their score on submit. Off by default —
    // an external sitting is usually scored by the organiser first.
    showResultToParticipant: { type: Boolean, default: false },
    autoSubmitOnTimeout: { type: Boolean, default: true },
  },
  { _id: false }
);

// ─── Wizard field groups ──────────────────────────────────────────────────
// These mirror the LMS exercise sub-schemas (subTopicModal.js) field-for-field
// so the External create wizard can collect the SAME inputs the You_Do
// Create Assessment wizard collects. They are copies rather than imports: the
// LMS versions are embedded in four pedagogy files kept in lockstep, and
// importing one would couple this module to that churn.

// Step 2 — Question Configuration.
const questionConfigSchema = new mongoose.Schema(
  {
    // equalDistribution — every question worth the same
    // questionSpecific  — each question carries its own mark
    scoringType: {
      type: String,
      enum: ["equalDistribution", "questionSpecific"],
      default: "equalDistribution",
    },
    totalQuestions: { type: Number, default: 0, min: 0 },
    marksPerQuestion: { type: Number, default: 1, min: 0 },
    attemptLimitEnabled: { type: Boolean, default: false },
    submissionAttempts: { type: Number, default: 1, min: 1, max: 10 },
    // freeFlow   — answer in any order
    // controlled — must move through in sequence
    questionFlow: {
      type: String,
      enum: ["freeFlow", "controlled"],
      default: "freeFlow",
    },
    // Level split, used when the author wants a fixed easy/medium/hard mix.
    levelBasedEnabled: { type: Boolean, default: false },
    levelCounts: {
      easy: { type: Number, default: 0, min: 0 },
      medium: { type: Number, default: 0, min: 0 },
      hard: { type: Number, default: 0, min: 0 },
    },
  },
  { _id: false }
);

// Step 2 — Programming / Others configuration.
//
// Mirrors the LMS `programmingQuestionConfigSchema` / `othersQuestionConfigSchema`
// (subTopicModal.js:569-598 / :644-671): the same three strategies, the same
// per-level counts, the same flow and attempt controls.
const levelCountsSchema = new mongoose.Schema(
  {
    easy: { type: Number, default: 0, min: 0 },
    medium: { type: Number, default: 0, min: 0 },
    hard: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

// Per-level scoring. `scoreType` decides how the `marks` figure is read:
//   level_specific    — marks is PER QUESTION; the level total is count × marks
//   question_specific — marks IS the level total; individual questions carry
//                       their own values, set later in the Questions panel
// Mirrors the LMS `levelScoringConfiguration` (subTopicModal.js:137-180).
const levelScoreSchema = new mongoose.Schema(
  {
    scoreType: {
      type: String,
      enum: ["level_specific", "question_specific"],
      default: "level_specific",
    },
    marks: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const codeConfigSchema = new mongoose.Schema(
  {
    // general        — one flat question count
    // levelBased     — split across easy/medium/hard
    // selectionLevel — the author picks which levels are in play
    questionConfigType: {
      type: String,
      enum: ["general", "levelBased", "selectionLevel"],
      default: "general",
    },
    generalQuestionCount: { type: Number, default: 0, min: 0 },
    levelBasedCounts: { type: levelCountsSchema, default: () => ({}) },
    selectionLevelCounts: { type: levelCountsSchema, default: () => ({}) },
    levelScoring: {
      easy: { type: levelScoreSchema, default: () => ({}) },
      medium: { type: levelScoreSchema, default: () => ({}) },
      hard: { type: levelScoreSchema, default: () => ({}) },
    },
    // Superseded by levelScoring.<level>.marks. Kept so configs written before
    // the scoring grid existed still read back with their per-level marks.
    levelMarks: { type: levelCountsSchema, default: () => ({}) },
    questionFlow: { type: String, enum: ["freeFlow", "controlled"], default: "freeFlow" },
    attemptLimitEnabled: { type: Boolean, default: false },
    submissionAttempts: { type: Number, default: 1, min: 1, max: 10 },
    // No `allowedLanguages` here: the languages a paper covers are chosen once
    // as the Skill Set on Step 1 (`selectedLanguages`). A second per-config
    // list only let the two disagree about the same thing.
  },
  { _id: false }
);

// How answers are judged. Mirrors the LMS evaluationMethodSchema
// (subTopicModal.js:709-749) and AI_CRITERIA_OPTIONS from
// component/evaluation/EvaluationMethodConfig.tsx. External assessments
// default to `testcase` because there is no trainer sitting behind the paper
// to mark by hand.
const AI_CRITERIA = [
  "correctness",
  "codeQuality",
  "efficiency",
  "readability",
  "edgeCases",
  "bestPractices",
];

const evaluationMethodSchema = new mongoose.Schema(
  {
    method: { type: String, enum: ["manual", "testcase", "ai"], default: "testcase" },
    ai: {
      // Which dimensions the AI evaluator scores on. Enum-constrained so a
      // typo'd criterion cannot reach the grader as an unknown instruction.
      criteria: { type: [{ type: String, enum: AI_CRITERIA }], default: [] },
      // common      — one count for the whole exercise
      // perQuestion — each question carries its own
      testCasesCountMode: { type: String, enum: ["common", "perQuestion"], default: "common" },
      testCasesCount: { type: Number, default: 20, min: 0, max: 50 },
    },
  },
  { _id: false }
);

// Step 7 — the LMS `additionalOptionsSchema`.
const additionalOptionsSchema = new mongoose.Schema(
  {
    anonymousSubmissions: { type: Boolean, default: false },
    hideGraderIdentity: { type: Boolean, default: false },
  },
  { _id: false }
);

// Step 3 — Question Source.
//
// Sources are a SET, not one choice: an assessment can draw its questions from
// any combination of Manual / AI Automation / Other Platform, and when more
// than one is ticked the author distributes the question count across them.
// Mirrors the LMS `customDistribution` shape (subTopicModal.js).
const SOURCE_KEYS = ["scratch", "ai", "thirdParty"];

const sourceCountsSchema = new mongoose.Schema(
  {
    scratch: { type: Number, default: 0, min: 0 },     // Manual
    ai: { type: Number, default: 0, min: 0 },          // AI Automation
    thirdParty: { type: Number, default: 0, min: 0 },  // Other Platform
  },
  { _id: false }
);

// One row per difficulty when the config is level-based; `general` is the
// single-row case (no level split), which is what most papers use.
const customDistributionSchema = new mongoose.Schema(
  {
    general: { type: sourceCountsSchema, default: () => ({}) },
    easy: { type: sourceCountsSchema, default: () => ({}) },
    medium: { type: sourceCountsSchema, default: () => ({}) },
    hard: { type: sourceCountsSchema, default: () => ({}) },
  },
  { _id: false }
);

// Step 4 — Schedule extras beyond the core window.
const scheduleExtrasSchema = new mongoose.Schema(
  {
    cutOffEnabled: { type: Boolean, default: false },
    cutOffDate: { type: Date, default: null },
    cutOffTime: { type: String, default: "" },
    gracePeriodEnabled: { type: Boolean, default: false },
    gracePeriodMinutes: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

// Step 5 — Security Settings. Same four groups the LMS SecuritySettings step
// renders (Lockdown · Proctoring · Timing · Extra Restrictions).
const securitySettingsSchema = new mongoose.Schema(
  {
    // Lockdown
    preventTabSwitch: { type: Boolean, default: false },
    maxTabSwitches: { type: Number, default: 3, min: 0 },
    preventCopyPaste: { type: Boolean, default: false },
    preventBrowserClose: { type: Boolean, default: false },
    // Proctoring
    enableFaceVerification: { type: Boolean, default: false },
    multipleFaceDetection: { type: Boolean, default: false },
    faceWarningLimit: { type: Number, default: 3, min: 0 },
    recordScreen: { type: Boolean, default: false },
    // Timing
    autoSubmitOnTimeout: { type: Boolean, default: true },
    warnBeforeTimeout: { type: Boolean, default: true },
    warningSeconds: { type: Number, default: 300, min: 0 },
    // Extra restrictions
    requireFullscreen: { type: Boolean, default: false },
    preventDevTools: { type: Boolean, default: false },
    preventRightClick: { type: Boolean, default: false },
    preventPrinting: { type: Boolean, default: false },
    preventPageRefresh: { type: Boolean, default: false },
    preventBackNavigation: { type: Boolean, default: false },
  },
  { _id: false }
);

// Step 6 — Notifications.
const notificationSettingsSchema = new mongoose.Schema(
  {
    notifyOnInvite: { type: Boolean, default: true },
    notifyOnSubmission: { type: Boolean, default: false },
    notifyBeforeStart: { type: Boolean, default: false },
    reminderHoursBefore: { type: Number, default: 24, min: 0 },
    notifyOnResult: { type: Boolean, default: false },
  },
  { _id: false }
);

// Step 7 — Grade Settings. Bands mirror the LMS DEFAULT_GRADE_BANDS.
const gradeBandSchema = new mongoose.Schema(
  {
    label: { type: String, default: "" },
    fromPercent: { type: Number, default: 0, min: 0, max: 100 },
    toPercent: { type: Number, default: 0, min: 0, max: 100 },
  },
  { _id: true }
);

const gradeSettingsSchema = new mongoose.Schema(
  {
    enablePassMark: { type: Boolean, default: true },
    gradeBandsEnabled: { type: Boolean, default: false },
    gradeBands: { type: [gradeBandSchema], default: undefined },
  },
  { _id: false }
);

// Step 1 — a section, when the assessment is split into parts.
const sectionSchema = new mongoose.Schema(
  {
    name: { type: String, default: "" },
    description: { type: String, default: "" },
    order: { type: Number, default: 0 },
    totalMarks: { type: Number, default: 0, min: 0 },
    totalDuration: { type: Number, default: 0, min: 0 },
    questionCount: { type: Number, default: 0, min: 0 },
  },
  { _id: true }
);

const externalAssessmentSchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: "LMS-Institution", index: true },

    // Human-facing reference, shown read-only in the wizard's first step the
    // way the LMS shows "Exercise ID". Generated on create (EX###) — not the
    // Mongo _id, which is what the invitation token exists to keep hidden.
    assessmentCode: { type: String, default: "", trim: true, index: true },

    assessmentName: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    instructions: { type: String, default: "" },

    // ── Step 1: Exercise Details ──
    testType: { type: String, enum: ["mock", "final", "practice"], default: "mock" },
    exerciseType: {
      type: String,
      enum: ["MCQ", "Programming", "Combined", "Other", "SectionBased"],
      default: "MCQ",
    },
    exerciseLevel: {
      type: String,
      enum: ["beginner", "intermediate", "expert"],
      default: "beginner",
    },
    // Skill Set — the module + languages chips on the LMS step.
    selectedModule: { type: String, default: "" },
    selectedLanguages: { type: [String], default: [] },
    isSectionBased: { type: Boolean, default: false },
    sectionBasedDuration: { type: Boolean, default: false },
    sections: { type: [sectionSchema], default: [] },

    // ── Step 2 / 3 ──
    // `questionConfiguration` is the MCQ half (kept under its original name so
    // records written before the other three types existed still resolve).
    // Programming and Other each get their own, and Combined uses BOTH the MCQ
    // and programming configs — same split the LMS wizard makes.
    questionConfiguration: { type: questionConfigSchema, default: () => ({}) },
    programmingConfig: { type: codeConfigSchema, default: () => ({}) },
    othersConfig: { type: codeConfigSchema, default: () => ({}) },
    evaluationMethod: { type: evaluationMethodSchema, default: () => ({}) },
    // Combined splits the total between the two halves.
    totalMarksMCQ: { type: Number, default: 0, min: 0 },
    totalMarksProgramming: { type: Number, default: 0, min: 0 },
    // Where the paper comes from. A SET — Manual / AI Automation / Other
    // Platform can be combined, and `customDistribution` then says how many
    // questions come from each.
    questionSources: {
      type: [{ type: String, enum: SOURCE_KEYS }],
      default: ["scratch"],
    },
    customDistribution: { type: customDistributionSchema, default: () => ({}) },
    // Legacy single-value field, kept so records written before the picker
    // became multi-select still resolve. Mirrored from questionSources[0] on
    // save; nothing reads it in preference to the array.
    questionSource: {
      type: String,
      enum: ["scratch", "bank", "ai", "thirdParty", "mixed", null],
      default: "scratch",
    },

    // ── Steps 5 / 6 / 7 ──
    securitySettings: { type: securitySettingsSchema, default: () => ({}) },
    notificationSettings: { type: notificationSettingsSchema, default: () => ({}) },
    gradeSettings: { type: gradeSettingsSchema, default: () => ({}) },
    scheduleExtras: { type: scheduleExtrasSchema, default: () => ({}) },
    additionalOptions: { type: additionalOptionsSchema, default: () => ({}) },

    // Which wizard steps the author has saved, by TITLE. Lets the modal
    // reopen on an existing assessment with the right steps already ticked,
    // exactly as the LMS wizard's `stepsSaved` does.
    stepsSaved: { type: [String], default: [] },

    // The schedule is captured the way the admin enters it — a DATE and a
    // wall-clock TIME, kept apart so editing one does not disturb the other.
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null },
    startTime: { type: String, default: "" }, // "HH:mm", 24h
    endTime: { type: String, default: "" },   // "HH:mm", 24h

    // …and denormalised into absolute instants on save (see the pre-hook).
    // Every access check compares against these two, so the gate never has to
    // re-derive a timestamp from a date + a string at request time.
    startAt: { type: Date, default: null, index: true },
    endAt: { type: Date, default: null, index: true },

    durationMinutes: { type: Number, default: 60, min: 1, max: 24 * 60 },
    totalMarks: { type: Number, default: 0 },
    passingMarks: { type: Number, default: 0 },

    // draft      — being authored, no invitations may go out
    // published  — live; invitations may be sent and the link works in-window
    // archived   — hidden from the default list, link permanently closed
    status: {
      type: String,
      enum: ["draft", "published", "archived"],
      default: "draft",
      index: true,
    },

    settings: { type: settingsSchema, default: () => ({}) },
    questions: [externalQuestionSchema],

    // Denormalised counters so the list screen needs no per-row aggregation.
    totalQuestions: { type: Number, default: 0 },
    participantCount: { type: Number, default: 0 },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "LMS-User" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "LMS-User" },
    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

// Combine a Date (day) with an "HH:mm" wall-clock string into one instant.
// Returns null when either half is missing — an assessment may legitimately be
// saved as a draft before its window is decided, and the access gate treats a
// null window as "not schedulable yet" rather than "open forever".
const combineDateAndTime = (date, time) => {
  if (!date) return null;
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const [h, m] = String(time || "").split(":");
  const hours = Number(h);
  const mins = Number(m);
  d.setHours(
    Number.isFinite(hours) ? hours : 0,
    Number.isFinite(mins) ? mins : 0,
    0,
    0
  );
  return d;
};

externalAssessmentSchema.statics.combineDateAndTime = combineDateAndTime;

// Keep the denormalised fields honest on every save: the absolute window, the
// question count, and totalMarks when the admin has not pinned it by hand.
externalAssessmentSchema.pre("save", function preSave(next) {
  // Stamp the human-facing code once, on first save. Matches the LMS wizard's
  // EX### shape. Not unique-indexed: it is a display reference, and forcing
  // uniqueness on a 3-digit random would start colliding at a few hundred rows.
  if (!this.assessmentCode) {
    this.assessmentCode = `EX${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`;
  }

  // Keep the legacy scalar in step with the array: "mixed" when several
  // sources are ticked, otherwise the single one.
  const sources = Array.isArray(this.questionSources) ? this.questionSources : [];
  this.questionSource = sources.length > 1 ? "mixed" : sources[0] || "scratch";

  this.startAt = combineDateAndTime(this.startDate, this.startTime);
  this.endAt = combineDateAndTime(this.endDate, this.endTime);
  this.totalQuestions = Array.isArray(this.questions) ? this.questions.length : 0;

  // Sum the per-question scores when the author has not set a total. An
  // explicitly-entered totalMarks wins, so a paper worth 100 with 20 questions
  // scored 1 each is respected rather than silently rewritten to 20.
  if (!this.totalMarks && Array.isArray(this.questions) && this.questions.length) {
    this.totalMarks = this.questions.reduce(
      (sum, q) => sum + (Number(q?.mcqQuestionScore) || 0),
      0
    );
  }
  next();
});

// List screen: newest first within an institution, excluding soft-deleted rows.
externalAssessmentSchema.index({ institution: 1, isDeleted: 1, createdAt: -1 });
// The scheduler/gate reads the window.
externalAssessmentSchema.index({ status: 1, startAt: 1, endAt: 1 });

module.exports = mongoose.model("ExternalAssessment", externalAssessmentSchema);
module.exports.QUESTION_TYPES = QUESTION_TYPES;
module.exports.AI_CRITERIA = AI_CRITERIA;
module.exports.SOURCE_KEYS = SOURCE_KEYS;
