const mongoose = require("mongoose");

const testCaseSchema = new mongoose.Schema(
  {
    input: { type: String },
    expectedOutput: { type: String },
    isSample: { type: Boolean },
    isHidden: { type: Boolean },
    points: { type: Number },
    explanation: String,
  },
  { _id: true }
);

const solutionSchema = new mongoose.Schema(
  {
    startedCode: { type: String },
    functionName: { type: String },
    language: { type: String },
  },
  { _id: true }
);

const hintSchema = new mongoose.Schema(
  {
    hintText: { type: String },
    pointsDeduction: { type: Number },
    isPublic: { type: Boolean },
    sequence: { type: Number },
  },
  { _id: true }
);

const optionSchema = new mongoose.Schema({
  text: { type: String, required: true },
  isCorrect: { type: Boolean, default: false },
  imageUrl: { type: String, default: null },
  imageAlignment: { type: String, enum: ['left', 'center', 'right'] },
  imageSizePercent: { type: Number }
});

const titleandDescriptionSchema = new mongoose.Schema({
  text: { type: String, required: true },
  imageUrl: { type: String, default: null },
  imageAlignment: { type: String, enum: ['left', 'center', 'right'] },
  imageSizePercent: { type: Number }
});
const matchingPairSchema = new mongoose.Schema({
  left: { type: String, required: true },
  right: { type: String, required: true }
}, { _id: true });

const orderingItemSchema = new mongoose.Schema({
  text: { type: String, required: true },
  order: { type: Number, required: true }
}, { _id: true });

const questionsSchema = new mongoose.Schema({
  // Common Fields

  // Course-specific scope. When set, this question belongs to a single course's
  // bank and only surfaces in that course's Question Bank view (Course Specific
  // tab → Manage). When unset (default), the question is "general" and lives
  // in the institution-wide bank listing. String, not ObjectId ref, because
  // legacy course-structure records key on strings and we accept either.
  courseId: { type: String, default: null, index: true },

  questionCategory: {
    type: String,
    required: true,
    // Default keeps cloneQuestionsToBank saves valid — exercise questions
    // carry no category, and a missing required field failed the whole save.
    default: 'General',
  },
  questionType: {
    type: String,
    required: true,
    // Lowercase values are the current convention (mcq + the programming sub-types).
    // "MCQ" / "Programming" are kept for backward compatibility with existing data.
    enum: ["mcq", "programming", "frontend", "database", "MCQ", "Programming"]
  },

  // MCQ Specific Fields
    mcqQuestionTitle: { type: mongoose.Schema.Types.Mixed },
  mcqQuestionDescription: titleandDescriptionSchema,
  mcqQuestionType: { 
    type: String, 
    enum: [
      'multiple_choice', 
      'multiple_select', 
      'true_false', 
      'dropdown', 
      'short_answer', 
      'essay',
      'matching',
      'ordering',
      'numeric'
    ],
  },
  mcqQuestionDifficulty: { 
    type: String, 
    enum: ['easy', 'medium', 'hard'],
    default: 'medium' 
  },
  mcqQuestionTimeLimit: { type: Number },
  isActive: { type: Boolean, default: true },
  mcqQuestionOptionsPerRow: { type: Number },
  mcqQuestionRequired: { type: Boolean },
  mcqQuestionOptions: [optionSchema],
  mcqQuestionCorrectAnswers: [{ type: String }],
  // "Other" free-text option flag (choice types) — mirrors the exercise form.
  hasOtherOption: { type: Boolean, default: false },
  
  // True/False specific
  trueFalseAnswer: { type: Boolean, default: null },

  // Short Answer specific
  shortAnswer: { type: String, default: '' },

  // Essay specific — sample/model answer used for auto-correction
  essayAnswer: { type: String, default: '' },

  // Matching specific
  matchingPairs: [matchingPairSchema],

  // Ordering specific
  orderingItems: [orderingItemSchema],

  // Numeric specific
  numericAnswer: { type: Number, default: null },
  numericTolerance: { type: Number, default: null },

  // Explanation
  hasExplanation: { type: Boolean, default: false },
  explanation: { type: String },

  // MCQ score — written by create/update since day one but silently dropped
  // by strict mode until this field was declared.
  mcqQuestionScore: { type: Number },

  // ── Classification metadata (Create Question modal) ──────────────────────
  // problemType: broad problem family (e.g. "Algorithm Design", "Debugging").
  // topics/tags: free-form multi-labels for filtering and discovery.
  problemType: { type: String, default: null },
  topics: { type: [String], default: [] },
  tags: { type: [String], default: [] },
  // Expected complexity (programming only, optional prose like "O(n log n)").
  timeComplexity: { type: String, default: '' },
  spaceComplexity: { type: String, default: '' },

  // Question Source tag carried over from exercises ('scratch-manual' /
  // 'scratch-bank' / 'ai' / 'thirdParty') or stamped by the create modal.
  source: { type: String, default: null },

  // cloneQuestionsToBank dedupe markers — must be declared or strict mode
  // drops them and every exercise re-save re-clones every question.
  _clonedFromExercise: { type: String, default: null },
  _clonedFromExerciseQuestionId: { type: String, default: null },

  // Programming Specific Fields
  title: {
    type: String,
    trim: true,
  },
  description: {
    type: String,
  },
  difficulty: {
    type: String,
  },
  sampleInput: { type: String },
  sampleOutput: { type: String },
  // Database sub-type fields
  sampleQuery: { type: String },
  expectedResult: { type: String },
  score: { type: Number, min: 0, max: 100 },
  constraints: [{ type: String }],
  hints: [hintSchema],
  testCases: [testCaseSchema],
  solutions: solutionSchema,
  // Model/answer code ("Output Code" in the Create Question modal) — optional,
  // separate from solutions.startedCode which holds the starter scaffold.
  outputCode: { type: String, default: '' },
  // Code Setup — Starter is shown to students on attempt start; Solution is
  // author-only, used for validation, and stripped from every student-facing
  // pedagogy response. Programming/SQL store a code string; Frontend stores
  // { html, css, javascript }. Must be declared or strict mode drops them.
  starterCode: { type: mongoose.Schema.Types.Mixed, default: '' },
  solutionCode: { type: mongoose.Schema.Types.Mixed, default: '' },
  codeSetupLanguage: { type: String, default: '' },
  // Execution Setup — how the student submission is executed and graded.
  // Persist alongside starterCode so re-opening the question editor
  // restores the exact Function/Full Program + Blank/Generated/Custom
  // choice the teacher last saved. Mixed on functionContract so the
  // { functionName, returnType, parameters[] } shape round-trips without
  // needing a nested sub-schema per question type.
  executionType: { type: String, enum: ['function', 'fullProgram'], default: 'fullProgram' },
  functionContract: { type: mongoose.Schema.Types.Mixed, default: null },
  startingExperience: { type: String, enum: ['blank', 'generated', 'custom'], default: 'blank' },
  timeLimit: { type: Number, min: 0, max: 10000 },
  memoryLimit: { type: Number, min: 0, max: 1024 },
  
  // Metadata
  createdBy: { type: String },
  createdByEmail: { type: String },
  updatedBy: { type: String },
  updatedAt: { type: String }
}, { 
  timestamps: true,
  minimize: true,
  toJSON: { 
    transform: function(doc, ret) {
      if (Array.isArray(ret.constraints) && ret.constraints.length === 0) {
        delete ret.constraints;
      }
      if (Array.isArray(ret.hints) && ret.hints.length === 0) {
        delete ret.hints;
      }
      if (Array.isArray(ret.testCases) && ret.testCases.length === 0) {
        delete ret.testCases;
      }
      if (ret.solutions && Object.keys(ret.solutions).length === 0) {
        delete ret.solutions;
      }
      if (Array.isArray(ret.matchingPairs) && ret.matchingPairs.length === 0) {
        delete ret.matchingPairs;
      }
      if (Array.isArray(ret.orderingItems) && ret.orderingItems.length === 0) {
        delete ret.orderingItems;
      }
      return ret;
    }
  }
});

const questionbankSchema = new mongoose.Schema({
  institution: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "LMS-Institution",
    required: true 
  },
  questions: [questionsSchema],
}, { 
  timestamps: true,
  minimize: true 
});

// Add middleware to clean empty arrays before saving
questionbankSchema.pre('save', function(next) {
  const doc = this;
  
  if (Array.isArray(doc.questions) && doc.questions.length === 0) {
    doc.questions = undefined;
  }
  
  if (Array.isArray(doc.questions) && doc.questions.length > 0) {
    doc.questions = doc.questions.map(question => {
      if (Array.isArray(question.constraints) && question.constraints.length === 0) {
        question.constraints = undefined;
      }
      if (Array.isArray(question.hints) && question.hints.length === 0) {
        question.hints = undefined;
      }
      if (Array.isArray(question.testCases) && question.testCases.length === 0) {
        question.testCases = undefined;
      }
      if (question.solutions && Object.keys(question.solutions).length === 0) {
        question.solutions = undefined;
      }
      if (Array.isArray(question.matchingPairs) && question.matchingPairs.length === 0) {
        question.matchingPairs = undefined;
      }
      if (Array.isArray(question.orderingItems) && question.orderingItems.length === 0) {
        question.orderingItems = undefined;
      }
      return question;
    });
  }
  
  next();
});

const Question = mongoose.model("QuestionBank", questionbankSchema);

// ── Legacy Other Platform bank (deprecated — single-doc-with-array) ──────────
// The whole bank lived as ONE Mongo document with an embedded `questions[]`
// array. That shape was already at 9.2 MB of Mongo's hard 16 MB per-document
// cap, so any further Create-through-UI would eventually push it past the
// ceiling and every write would fail. Kept exported for the migration script
// (reads the old doc, splits it into `OtherPlatformQuestion` docs); every
// runtime path now uses the top-level collection below.
const otherPlatformSchema = questionbankSchema.clone();
otherPlatformSchema.path("institution").required(false);
const OtherPlatformBank = mongoose.model("OtherPlatformQuestionBank", otherPlatformSchema);

// ── Other Platform bank (current — one document per question) ────────────────
// Top-level collection replacing the legacy wrapper doc. Same field shape as
// the embedded question subdoc (reuses `questionsSchema` via clone), so the
// picker's response payload can be assembled with no field remapping. The
// bank stays GLOBAL — one collection shared by every institution.
//
// Indexes cover the picker's filters (questionType / mcqQuestionDifficulty /
// problemType / isActive), the newest-first default sort (createdAt), and the
// dedupe key readers use to reject re-imports (`_id`, which is the primary
// key — exercises store it in `bankQuestionId`).
const otherPlatformQuestionSchema = questionsSchema.clone();
otherPlatformQuestionSchema.index({ createdAt: -1 });
// Compound, for the paginated listing's newest-first sort. The single-field
// index above orders by createdAt but leaves rows that SHARE a createdAt in no
// defined order, which a skip/limit slice cannot tolerate — a tied row can be
// served on two consecutive pages, or on neither. Sorting by { createdAt, _id }
// makes the order total; this index is what keeps that sort a cheap index walk
// instead of a blocking in-memory sort of the whole collection.
otherPlatformQuestionSchema.index({ createdAt: -1, _id: -1 });
otherPlatformQuestionSchema.index({ questionType: 1, isActive: 1 });
otherPlatformQuestionSchema.index({ mcqQuestionDifficulty: 1 });
otherPlatformQuestionSchema.index({ problemType: 1 });
const OtherPlatformQuestion = mongoose.model(
  "OtherPlatformQuestion",
  otherPlatformQuestionSchema,
);

module.exports = Question;
module.exports.OtherPlatformBank = OtherPlatformBank;
module.exports.OtherPlatformQuestion = OtherPlatformQuestion;