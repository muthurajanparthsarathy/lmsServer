const mongoose = require("mongoose");

// ─── TEST CASE SCHEMA ─────────────────────────────────────────────────────────
const testCaseSchema = new mongoose.Schema(
  {
    input: { type: String },
    expectedOutput: { type: String },
    isSample: { type: Boolean, default: true },
    isHidden: { type: Boolean, default: true },
    points: { type: Number, default: 1 },
    explanation: String,
  },
  { _id: true }
);

// ─── SOLUTION SCHEMA ──────────────────────────────────────────────────────────
const solutionSchema = new mongoose.Schema(
  {
    startedCode: { type: String },
    functionName: { type: String },
    language: { type: String, default: "javascript" },
  },
  { _id: true }
);

// ─── HINT SCHEMA ──────────────────────────────────────────────────────────────
const hintSchema = new mongoose.Schema(
  {
    hintText: { type: String },
    pointsDeduction: { type: Number, default: 0 },
    isPublic: { type: Boolean, default: true },
    sequence: { type: Number, default: 0 },
  },
  { _id: true }
);

// ─── DESCRIPTION SCHEMA ───────────────────────────────────────────────────────
const descriptionSchema = new mongoose.Schema(
  {
    text: { type: String, default: "" },
    imageUrl: { type: String, default: null },
    imageAlignment: { type: String, enum: ["left", "center", "right"], default: "left" },
    imageSizePercent: { type: Number, min: 10, max: 100, default: 100 },
  },
  { _id: false, strict: false }
);

// ─── OPTION SCHEMA ────────────────────────────────────────────────────────────
const optionSchema = new mongoose.Schema({
  text: { type: String, default: "" },
  isCorrect: { type: Boolean, default: false },
  imageUrl: { type: String, default: null },
  imageAlignment: { type: String, enum: ["left", "center", "right"], default: "left" },
  imageSizePercent: { type: Number, default: 100 },
});

// ─── MATCHING PAIR SCHEMA ─────────────────────────────────────────────────────
const matchingPairSchema = new mongoose.Schema(
  {
    left: { type: String, default: "" },
    right: { type: String, default: "" },
  },
  { _id: true }
);

// ─── ORDERING ITEM SCHEMA ─────────────────────────────────────────────────────
const orderingItemSchema = new mongoose.Schema(
  {
    text: { type: String, default: "" },
    order: { type: Number, default: 0 },
  },
  { _id: true }
);

// ─── SECURITY SETTINGS SCHEMA ─────────────────────────────────────────────────
const securitySettingsSchema = new mongoose.Schema(
  {
    // Basic restrictions
    preventCopyPaste: { type: Boolean, default: true },
    preventRightClick: { type: Boolean, default: true },
    preventPrinting: { type: Boolean, default: true },
    preventScreenshot: { type: Boolean, default: true },
    preventScreenRecording: { type: Boolean, default: true },
    // Proctor capture — records the student's screen; URL replays in reviewSubmission
    screenRecordingEnabled: { type: Boolean, default: false },

    // Browser restrictions
    requireFullscreen: { type: Boolean, default: true },
    preventTabSwitch: { type: Boolean, default: true },
    maxTabSwitches: { type: Number, default: 3 },
    preventBrowserClose: { type: Boolean, default: true },
    preventDevTools: { type: Boolean, default: true },
    
    // Navigation restrictions
    preventBackNavigation: { type: Boolean, default: true },
    preventRefresh: { type: Boolean, default: true },
    preventUrlChange: { type: Boolean, default: false },
    
    // Time restrictions
    autoSubmitOnTimeout: { type: Boolean, default: true },
    warnBeforeTimeout: { type: Boolean, default: true },
    warningSeconds: { type: Number, default: 30 },
    
    // Identity verification
    enableFaceVerification: { type: Boolean, default: false },
    enableIdVerification: { type: Boolean, default: false },
    enableVoiceVerification: { type: Boolean, default: false },
    captureIntervalSeconds: { type: Number, default: 60 },
    // Face-detection proctoring (no face / multiple persons → warnings then auto-submit)
    multipleFaceDetection: { type: Boolean, default: false },
    faceWarningLimit: { type: Number, default: 3 },
    // Face-presence monitoring (no face → warnings then auto-submit)
    faceMonitoringDetection: { type: Boolean, default: false },
    faceMonitoringWarningLimit: { type: Number, default: 3 },
    
    // Network restrictions
    blockOtherIPs: { type: Boolean, default: false },
    allowedIPs: [{ type: String }],
    singleDeviceOnly: { type: Boolean, default: false },
    
    // Question restrictions
    shuffleQuestions: { type: Boolean, default: true },
    shuffleOptions: { type: Boolean, default: true },
    randomizeQuestionOrder: { type: Boolean, default: false },
    preventQuestionBacktrack: { type: Boolean, default: false },
    
    // Additional security
    sessionTimeoutMinutes: { type: Number, default: 30 },
    maxAttempts: { type: Number, default: 1 },
    graceAttempts: { type: Number, default: 0 },
    cooldownMinutes: { type: Number, default: 30 },
  },
  { _id: false }
);

// ─── SCORE SETTINGS SCHEMA ────────────────────────────────────────────────────
const scoreSettingsSchema = new mongoose.Schema(
  {
    scoreType: {
      type: String,
      enum: ["evenMarks", "separateMarks", "levelBasedMarks"],
    },
    evenMarks: { type: Number, min: 0, max: 100 },
    separateMarks: {
      general: [{ type: Number, min: 0, max: 100 }],
      levelBased: {
        easy: [{ type: Number, min: 0, max: 100 }],
        medium: [{ type: Number, min: 0, max: 100 }],
        hard: [{ type: Number, min: 0, max: 100 }],
      },
    },
    levelBasedMarks: {
      easy: { type: Number, default: 0, min: 0, max: 100 },
      medium: { type: Number, default: 0, min: 0, max: 100 },
      hard: { type: Number, default: 0, min: 0, max: 100 },
    },
    levelScoringConfiguration: {
      easy: {
        type: { type: String, enum: ["question_specific", "level_specific"], default: "level_specific" },
        totalMarks: { type: Number, min: 0, max: 1000, default: 0 },
        marksPerQuestion: { type: Number, min: 0, max: 100, default: 0 },
        questionCount: { type: Number, min: 0, max: 100, default: 0 },
      },
      medium: {
        type: { type: String, enum: ["question_specific", "level_specific"], default: "level_specific" },
        totalMarks: { type: Number, min: 0, max: 1000, default: 0 },
        marksPerQuestion: { type: Number, min: 0, max: 100, default: 0 },
        questionCount: { type: Number, min: 0, max: 100, default: 0 },
      },
      hard: {
        type: { type: String, enum: ["question_specific", "level_specific"], default: "level_specific" },
        totalMarks: { type: Number, min: 0, max: 1000, default: 0 },
        marksPerQuestion: { type: Number, min: 0, max: 100, default: 0 },
        questionCount: { type: Number, min: 0, max: 100, default: 0 },
      },
    },
    totalMarks: { type: Number, default: 0 },
  },
  { _id: false }
);

// ─── SECTION ITEM SCHEMA ──────────────────────────────────────────────────────
const sectionItemSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    name: { type: String, required: true },
    order: { type: Number, default: 1 },
    description: { type: String, default: "" },
  },
  { _id: false }
);

// ─── SECTION MCQ CONFIG SCHEMA ────────────────────────────────────────────────
const sectionMCQConfigSchema = new mongoose.Schema(
  {
    generalQuestionCount: { type: Number, default: 0 },
    scoreSettings: {
      scoreType: { type: String, enum: ["equalDistribution", "questionSpecific"], default: "equalDistribution" },
      equalDistribution: { type: Number, default: 0 },
      totalMarks: { type: Number, default: 0 },
    },
    attemptLimitEnabled: { type: Boolean, default: false },
    submissionAttempts: { type: Number, default: 1 },
  },
  { _id: false }
);

// ─── SECTION PROGRAMMING CONFIG SCHEMA ────────────────────────────────────────
const sectionProgrammingConfigSchema = new mongoose.Schema(
  {
    questionConfigType: { type: String, enum: ["general", "levelBased", "selectionLevel"], default: "general" },
    generalQuestionCount: { type: Number, default: 0 },
    levelBasedCounts: {
      easy: { type: Number, default: 0 },
      medium: { type: Number, default: 0 },
      hard: { type: Number, default: 0 },
    },
    selectionLevelCounts: {
      easy: { type: Number, default: 0 },
      medium: { type: Number, default: 0 },
      hard: { type: Number, default: 0 },
    },
    levelScoring: {
      easy: {
        type: { type: String, enum: ["level_specific", "question_specific"], default: "level_specific" },
        marksPerQuestion: { type: Number, default: 0 },
        totalMarks: { type: Number, default: 0 },
      },
      medium: {
        type: { type: String, enum: ["level_specific", "question_specific"], default: "level_specific" },
        marksPerQuestion: { type: Number, default: 0 },
        totalMarks: { type: Number, default: 0 },
      },
      hard: {
        type: { type: String, enum: ["level_specific", "question_specific"], default: "level_specific" },
        marksPerQuestion: { type: Number, default: 0 },
        totalMarks: { type: Number, default: 0 },
      },
    },
    scoreSettings: {
      equalDistribution: { type: Number, default: 0 },
    },
    questionFlow: { type: String, enum: ["freeFlow", "controlled"], default: "freeFlow" },
    attemptLimitEnabled: { type: Boolean, default: false },
    submissionAttempts: { type: Number, default: 1 },
  },
  { _id: false }
);

// ─── SECTION CONFIG SCHEMA ────────────────────────────────────────────────────
const sectionConfigSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    name: { type: String, required: true },
    exerciseType: { type: String, enum: ["MCQ", "Programming", "Combined", "Other", ""], default: "" },
    difficulty: { type: String, enum: ["easy", "medium", "hard"], default: "medium" },
    totalMarks: { type: Number, default: 0 },
    sectionNumber: { type: Number, default: 1 },
    mcqSectionMarks: { type: Number, default: 0 },
    programmingSectionMarks: { type: Number, default: 0 },
    mcqConfig: { type: sectionMCQConfigSchema },
    programmingConfig: { type: sectionProgrammingConfigSchema },
  },
  { _id: false }
);

// ─── QUESTION-LEVEL APPROVAL (mirrors moduleModal.js) ───────────────────────
const questionQuerySchema = new mongoose.Schema({
  raisedBy: { type: mongoose.Schema.Types.ObjectId, ref: "LMS-User" },
  raisedByName: { type: String, default: "" },
  raisedAt: { type: Date, default: Date.now },
  text: { type: String, default: "" },
  resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "LMS-User", default: null },
  resolvedByName: { type: String, default: "" },
  resolvedAt: { type: Date, default: null },
  resolutionNote: { type: String, default: "" },
}, { _id: true });

const questionApprovalSchema = new mongoose.Schema({
  status: { type: String, enum: ["pending", "queried", "approved", "rejected"], default: "pending" },
  currentStepOrder: { type: Number, default: null },
  decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: "LMS-User", default: null },
  decidedAt: { type: Date, default: null },
  rejectionMessage: { type: String, default: "" },
  editedSinceReject: { type: Boolean, default: false },
  queries: { type: [questionQuerySchema], default: [] },
}, { _id: false });

// ─── QUESTION SCHEMA (UPDATED) ────────────────────────────────────────────────
const questionSchema = new mongoose.Schema(
  {
    questionType: { type: String },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "LMS-User", default: null },
    createdByEmail: { type: String, default: "" },
    approval: { type: questionApprovalSchema, default: () => ({}) },
    // Phase 3/4/6 — per-question source tag.
    source: { type: String, default: null },
    // Origin id of the Question Bank doc this was imported from — null for authored questions; drives duplicate-import rejection.
    bankQuestionId: { type: String, default: null },

    // ── NEW: Section linking field ────────────────────────────────────────────
    sectionId: { type: String, default: null },

    // ── MCQ Fields ────────────────────────────────────────────────────────────
    mcqQuestionTitle: { type: mongoose.Schema.Types.Mixed },
    mcqQuestionDescription: { type: String, default: "" },

    mcqQuestionType: {
      type: String,
      enum: [
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
      ],
    },

    mcqQuestionDifficulty: {
      type: String,
      enum: ["easy", "medium", "hard"],
    },

    mcqQuestionScore: { type: Number },
    mcqQuestionTimeLimit: { type: Number },
    isActive: { type: Boolean, default: true },
    mcqQuestionOptionsPerRow: { type: Number },
    mcqQuestionRequired: { type: Boolean },
    hasOtherOption: { type: Boolean, default: false },
    hasExplanation: { type: Boolean, default: false },

    mcqQuestionOptions: [optionSchema],
    mcqQuestionCorrectAnswers: [{ type: String }],

    // Image fields
    mcqQuestionImageUrl: { type: String, default: null },
    mcqQuestionImageAlignment: { type: String, enum: ["left", "center", "right"] },
    mcqQuestionImageSizePercent: { type: Number },

    // ── Type-specific answer fields ──────────────────────────────────────────
    trueFalseAnswer: { type: Boolean, default: null },
    shortAnswer: { type: String, default: "" },
    essayAnswer: { type: String, default: "" },
    numericAnswer: { type: Number, default: null },
    numericTolerance: { type: Number, default: null },
    matchingPairs: [matchingPairSchema],
    orderingItems: [orderingItemSchema],
    
    // sequence within exercise
    sequence: { type: Number, default: 0 },

    // ── Programming Fields ────────────────────────────────────────────────────
    programmingQuestionDescription: { type: mongoose.Schema.Types.Mixed },
    title: { type: mongoose.Schema.Types.Mixed },
    description: { type: mongoose.Schema.Types.Mixed, default: { text: "" } },
    difficulty: { type: String },
    sampleInput: { type: String },
    sampleOutput: { type: String },
    score: { type: Number, min: 0, max: 100 },
    constraints: [{ type: String }],
    hints: [hintSchema],
    testCases: [testCaseSchema],
    // Per-question AI test case count. Read at Submit time when the exercise's
    // evaluationMethod.ai.testCasesCountMode === 'perQuestion'. Enforced as a
    // required field in the Programming question authoring form for questions
    // authored under per-question mode; legacy questions may lack this and
    // fall back to the exercise's testCasesCount.
    aiTestCasesCount: { type: Number, default: null, min: 0, max: 50 },
    // AI-generated test cases cached on the question. Populated by the FIRST
    // student's Submit when evaluationMethod is 'ai' and the exercise's
    // ai.testCasesCount > 0. Reused for every subsequent student so the whole
    // cohort is judged against the same generated set. Cleared by the trainer
    // "Regenerate AI Test Cases" action (not built in the first pass).
    aiGeneratedTestCases: {
      type: [{
        input: { type: String, default: '' },
        expectedOutput: { type: String, default: '' },
      }],
      default: [],
    },
    aiGeneratedTestCasesModel: { type: String, default: '' },
    aiGeneratedTestCasesAt: { type: Date, default: null },
    solutions: solutionSchema,
    timeLimit: { type: Number, min: 0, max: 10000 },
    memoryLimit: { type: Number, min: 0, max: 1024 },
    // Link questions: teacher pastes one external URL instead of authoring
    // the question; students get it in an iframe instead of the compiler.
    isLinkQuestion: { type: Boolean, default: false },
    questionLink: { type: String, default: '' },
    // Code Setup — Starter shown to students on attempt start; Solution is
    // author-only (stripped for students by testCaseVisibility.js). A code
    // string for Programming/SQL, or { html, css, javascript } for Frontend.
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

    // ── Database Fields ───────────────────────────────────────────────────────
    sampleQuery: { type: String, default: '' },
    sampleResult: { type: mongoose.Schema.Types.Mixed, default: [] },
    isDatabase: { type: Boolean, default: false },
    moduleType: { type: String },
    databaseType: { type: String },
    points: { type: Number, min: 0, max: 100 },
    // See topicModal.js for the full docstring on this field.
    lastEditedAfterSubmissionAt: { type: Date, default: null },
  },
  {
    _id: true,
    strict: false,
    minimize: false,
  }
);

// ─── NOTIFICATION & GRADE SCHEMA ──────────────────────────────────────────────
const notificationGradeSchema = new mongoose.Schema(
  {
    notifyUsers: { type: Boolean, default: false },
    notifyGmail: { type: Boolean, default: false },
    notifyWhatsApp: { type: Boolean, default: false },
    gradeSheet: { type: Boolean, default: false },
  },
  { _id: false }
);

// ─── APPROVAL WORKFLOW SCHEMA (mirrors moduleModal.js) ────────────────────────
const approvalWorkflowStepSchema = new mongoose.Schema({
  order: { type: Number, required: true },
  roleId: { type: mongoose.Schema.Types.ObjectId, ref: "Role", required: true },
  roleName: { type: String, required: true },
  // See moduleModal.js for the rationale — kept in lockstep across all four
  // duplicated exercise-carrier files.
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "LMS-User", default: null },
  userName: { type: String, default: "" },
  status: { type: String, enum: ["waiting", "pending", "approved", "rejected"], default: "waiting" },
  decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: "LMS-User", default: null },
  decidedAt: { type: Date, default: null },
  comment: { type: String, default: "" },
  notifiedAt: { type: Date, default: null },
}, { _id: false });

const approvalWorkflowSchema = new mongoose.Schema({
  steps: { type: [approvalWorkflowStepSchema], default: [] },
  currentStep: { type: Number, default: 0 },
  overallStatus: { type: String, enum: ["in_progress", "approved", "rejected"], default: "in_progress" },
  studentVisible: { type: Boolean, default: false },
  initiatedAt: { type: Date, default: null },
  // Snapshot of the submitter — mirrors moduleModal.js's approvalWorkflow
  // schema so the pending-approvals endpoint can find the trainer's name/
  // email regardless of which pedagogy node owns the exercise.
  initiatedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "LMS-User", default: null },
  initiatedByName: { type: String, default: "" },
  initiatedByEmail: { type: String, default: "" },
  completedAt: { type: Date, default: null },
  editedSinceReject: { type: Boolean, default: false },
  resubmissionCount: { type: Number, default: 0 },
  lastResubmittedAt: { type: Date, default: null },
}, { _id: false });

// ─── AVAILABILITY PERIOD SCHEMA ───────────────────────────────────────────────
const availabilityPeriodSchema = new mongoose.Schema({
  startDate: { type: Date },
  endDate: { type: Date },
  cutOffDate: { type: Date },
  cutOffEnabled: { type: Boolean, default: false },
  remindGradeBy: { type: Date },
  remindGradeByEnabled: { type: Boolean, default: false },
  gracePeriodAllowed: { type: Boolean, default: false },
  gracePeriodEnabled: { type: Boolean, default: false },
  gracePeriodDate: { type: Date },
  extendedDays: { type: Number, default: 0 },
  requiresAdminApproval: { type: Boolean, default: false },
  approvalScope: {
    type: String,
    enum: ["settings", "settings_and_questions"],
    default: "settings",
  },
});

// ─── NOTIFICATION SETTINGS SCHEMA ─────────────────────────────────────────────
const notificationSettingsSchema = new mongoose.Schema(
  {
    notifyUsers: { type: Boolean, default: false },
    notifyGmail: { type: Boolean, default: false },
    notifyWhatsApp: { type: Boolean, default: false },
    gradeSheet: { type: Boolean, default: true },
    notifyGradersSubmissions: { type: Boolean, default: false },
    notifyGradersLateSubmissions: { type: Boolean, default: false },
    notifyStudent: { type: Boolean, default: true },
  },
  { _id: false }
);

// ─── GRADE SETTINGS SCHEMA ────────────────────────────────────────────────────
const gradeSettingsSchema = new mongoose.Schema(
  {
    mcqGrade: { type: Number, default: null },
    mcqGradeToPass: { type: Number, default: null },
    programmingGrade: { type: Number, default: null },
    programmingGradeToPass: { type: Number, default: null },
    combinedGrade: { type: Number, default: null },
    combinedGradeToPass: { type: Number, default: null },
    separateMarks: { type: Boolean, default: false },

    // Difficulty-based pass marks
    difficultyPassEnabled: { type: Boolean, default: false },
    easyPassMark: { type: Number, default: null },
    mediumPassMark: { type: Number, default: null },
    hardPassMark: { type: Number, default: null },

    // Overall mark to pass (optional)
    overallMarkToPassEnabled: { type: Boolean, default: false },
    overallMarkToPass: { type: Number, default: null },

    // Grade bands (performance scale) — labelled percentage ranges of Total Mark.
    gradeBands: {
      type: [
        new mongoose.Schema(
          {
            id: { type: String },
            label: { type: String, default: '' },
            fromPercent: { type: Number, default: 0 },
            toPercent: { type: Number, default: 0 },
          },
          { _id: false }
        ),
      ],
      default: undefined,
    },
  },
  { _id: false }
);

// ─── ADDITIONAL OPTIONS SCHEMA ────────────────────────────────────────────────
const additionalOptionsSchema = new mongoose.Schema(
  {
    anonymousSubmissions: { type: Boolean, default: false },
    hideGraderIdentity: { type: Boolean, default: false },
  },
  { _id: false }
);

// ─── MCQ QUESTION CONFIG SCHEMA ───────────────────────────────────────────────
const mcqQuestionConfigSchema = new mongoose.Schema(
  {
    totalMcqQuestions: { type: Number, default: 0, min: 0, max: 100 },
    marksPerQuestion: { type: Number, default: 0, min: 0, max: 100 },
    mcqTotalMarks: { type: Number, default: 0, min: 0, max: 100 },
    attemptLimitEnabled: { type: Boolean, default: false },
    submissionAttempts: { type: Number, default: 1, min: 1, max: 10 },
    shuffleQuestions: { type: Boolean, default: true },
    scoringType: {
      type: String,
      enum: ["equalDistribution", "questionSpecific", "levelSpecific"],
      default: "equalDistribution",
    },
  },
  { _id: false }
);

// ─── PROGRAMMING QUESTION CONFIG SCHEMA ──────────────────────────────────────
const programmingQuestionConfigSchema = new mongoose.Schema(
  {
    questionConfigType: {
      type: String,
      enum: ["general", "levelBased", "selectionLevel"],
    },
    generalQuestionCount: { type: Number, default: 0, min: 0, max: 100 },
    // Phase 1 — strict E+M+H===Total pattern target.
    patternTotal: { type: Number, default: 0, min: 0, max: 100 },
    levelBasedCounts: {
      easy: { type: Number, default: 0, min: 0, max: 100 },
      medium: { type: Number, default: 0, min: 0, max: 100 },
      hard: { type: Number, default: 0, min: 0, max: 100 },
    },
    selectionLevelCounts: {
      easy: { type: Number, default: 0, min: 0, max: 100 },
      medium: { type: Number, default: 0, min: 0, max: 100 },
      hard: { type: Number, default: 0, min: 0, max: 100 },
    },
    scoreSettings: { type: scoreSettingsSchema },
    attemptLimitEnabled: { type: Boolean, default: false },
    submissionAttempts: { type: Number, default: 1, min: 1, max: 10 },
    questionFlow: { type: String, enum: ["freeFlow", "controlled"], default: "freeFlow" },
    compilerFileMode: { type: String, enum: ["single", "multiple"], default: "single" },
    allowCodeExecution: { type: Boolean, default: true },
    enableTestCases: { type: Boolean, default: true },
    showSampleCases: { type: Boolean, default: true },
  },
  { _id: false }
);

// ─── PROGRAMMING SETTINGS SCHEMA ─────────────────────────────────────────────
const programmingSettingsSchema = new mongoose.Schema({
  selectedModule: { type: String },
  selectedLanguages: [{ type: String }],
});

// ─── EXERCISE INFORMATION SCHEMA ──────────────────────────────────────────────
const exerciseInformationSchema = new mongoose.Schema(
  {
    exerciseId: { type: String, required: true },
    exerciseName: { type: String, required: true },
    description: String,
    exerciseLevel: {
      type: String,
      enum: ["beginner", "intermediate", "expert"],
      default: "beginner",
    },
    exerciseType: { type: String },
    testType: {
      type: String,
      enum: ["mock", "final", "practice"],
      default: "mock",
    },
    totalDuration: { type: Number },
    totalMarksMCQ: { type: Number, default: 0 },
    totalMarksProgramming: { type: Number, default: 0 },
    totalMarks: { type: Number, default: 0 },
    selectedModule: { type: String, default: "" },
    selectedLanguages: [{ type: String }],
    isSectionBased: { type: Boolean, default: false },
    sectionBasedDuration: { type: Boolean, default: false },
  },
  { _id: false, strict: false }
);

// ─── CONFIGURATION TYPE SCHEMA ────────────────────────────────────────────────
const configurationTypeSettSchema = new mongoose.Schema({
  mcqMode: { type: Boolean, default: false },
  programmingMode: { type: Boolean, default: false },
  combinedMode: { type: Boolean, default: false },
  otherMode: { type: Boolean, default: false },
});

// ─── OTHERS QUESTION CONFIG SCHEMA ───────────────────────────────────────────
const othersQuestionConfigSchema = new mongoose.Schema(
  {
    questionConfigType: {
      type: String,
      enum: ["general", "levelBased", "selectionLevel"],
      default: "general",
    },
    generalQuestionCount: { type: Number, default: 0, min: 0, max: 100 },
    generalMarksPerQuestion: { type: Number, default: 0, min: 0 },
    // Phase 1 — strict E+M+H===Total pattern target.
    patternTotal: { type: Number, default: 0, min: 0, max: 100 },
    levelBasedCounts: {
      easy:   { type: Number, default: 0, min: 0, max: 100 },
      medium: { type: Number, default: 0, min: 0, max: 100 },
      hard:   { type: Number, default: 0, min: 0, max: 100 },
    },
    selectionLevelCounts: {
      easy:   { type: Number, default: 0, min: 0, max: 100 },
      medium: { type: Number, default: 0, min: 0, max: 100 },
      hard:   { type: Number, default: 0, min: 0, max: 100 },
    },
    scoreSettings: { type: scoreSettingsSchema },
    questionFlow: { type: String, enum: ["freeFlow", "controlled"], default: "freeFlow" },
    attemptLimitEnabled: { type: Boolean, default: false },
    submissionAttempts: { type: Number, default: 1, min: 1, max: 10 },
  },
  { _id: false }
);

// ─── QUESTION CONFIGURATION SCHEMA ───────────────────────────────────────────
const questionConfigurationSchema = new mongoose.Schema(
  {
    mcqQuestionConfiguration: { type: mcqQuestionConfigSchema },
    programmingQuestionConfiguration: { type: programmingQuestionConfigSchema },
    othersQuestionConfiguration: { type: othersQuestionConfigSchema },
  },
  { _id: false, strict: false }
);

// ─── CUSTOM DISTRIBUTION SCHEMA (Phase 5) ────────────────────────────────────
const customDistributionCellSchema = new mongoose.Schema(
  {
    scratch: { type: Number, default: 0, min: 0, max: 100 },
    ai: { type: Number, default: 0, min: 0, max: 100 },
    thirdParty: { type: Number, default: 0, min: 0, max: 100 },
  },
  { _id: false }
);
const customDistributionSchema = new mongoose.Schema(
  {
    easy: { type: customDistributionCellSchema, default: () => ({}) },
    medium: { type: customDistributionCellSchema, default: () => ({}) },
    hard: { type: customDistributionCellSchema, default: () => ({}) },
  },
  { _id: false }
);

// ─── EVALUATION METHOD SCHEMA ──────────────────────────────────────────────
// How submissions are evaluated for this exercise. Captured in the exercise
// settings / create-assessment wizards and STORED ONLY — the grading pipeline
// reads it later. Exactly one method: "testcase" scores against the question's
// test cases, "ai" hands the submission to an AI evaluator (what that evaluator
// should look for is specified in the evaluation prompt at grading time, not
// stored here). Test-case evaluation is the historical behaviour, so an
// exercise without this field is treated as test-case based.
const evaluationMethodSchema = new mongoose.Schema(
  {
    method: { type: String, enum: ["manual", "testcase", "ai"], default: "manual" },
    // AI-mode extras. `criteria` is the checkbox multi-select of what the AI
    // evaluator should judge submissions on. Stored even when method is
    // "testcase" (harmless — simply unused).
    ai: {
      criteria: {
        type: [{
          type: String,
          enum: [
            "correctness",
            "codeQuality",
            "efficiency",
            "readability",
            "edgeCases",
            "bestPractices",
          ],
        }],
        default: [],
      },
      // 'common'      → one testCasesCount applies to every Programming question
      //                   in the exercise (the field just below)
      // 'perQuestion' → each Programming question carries its OWN
      //                   `aiTestCasesCount` in its authoring form; the field
      //                   below is only a legacy fallback for questions that
      //                   don't carry one.
      testCasesCountMode: {
        type: String,
        enum: ['common', 'perQuestion'],
        default: 'common',
      },
      // Count of AI-generated test cases to judge against at student Submit
      // time. Judged IN ADDITION to any test cases the trainer stored on the
      // question. Cached on the question doc after first Submit so every
      // student is tested against the same generated set. 0 = skip generation.
      testCasesCount: { type: Number, default: 20, min: 0, max: 50 },
    },
  },
  { _id: false }
);

// ─── EXERCISE SCHEMA (UPDATED) ────────────────────────────────────────────────
const exerciseSchema = new mongoose.Schema(
  {
    exerciseType: { type: String },
    isGraded: { type: Boolean, default: true },
    stepsSaved: { type: [String], default: [] },
    configurationType: configurationTypeSettSchema,
    programmingSettings: { type: programmingSettingsSchema },
    exerciseInformation: exerciseInformationSchema,
    questionConfiguration: questionConfigurationSchema,
    // Phase 2 — teacher's chosen question source.
    questionSource: {
      type: String,
      enum: ["scratch", "ai", "thirdParty", "custom", null],
      default: null,
    },
    // Phase 5 — custom-mode E/M/H × source distribution.
    customDistribution: { type: customDistributionSchema, default: null },
    // Section-based Custom mix: per-section E/M/H × source distribution,
    // keyed by sectionId. Stored as Mixed so Mongoose doesn't strip the
    // dynamic section-id keys; client validates the shape before sending.
    customDistributionBySection: { type: mongoose.Schema.Types.Mixed, default: {} },
    // Custom-mode sub-source selection.
    customSources: {
      type: [{ type: String, enum: ["scratch", "ai", "thirdParty"] }],
      default: [],
    },
    // Phase 6 — save attached questions to Question Bank on save.
    saveToBank: { type: Boolean, default: false },
    // Evaluation config — "testcase" or "ai". Stored now; consumed by the
    // grading pipeline later. null = never configured, which downstream code
    // should read as test-case based.
    evaluationMethod: { type: evaluationMethodSchema, default: null },
    availabilityPeriod: availabilityPeriodSchema,
    approvalWorkflow: { type: approvalWorkflowSchema, default: null },
    notificationSettings: { type: notificationSettingsSchema },
    gradeSettings: { type: gradeSettingsSchema },
    additionalOptions: { type: additionalOptionsSchema },
    
    // ── NEW: Sections array for Part A, Part B, etc. ──────────────────────────
    sections: [sectionConfigSchema],
    
    // keep legacy field so old data still reads correctly
    questions: [questionSchema],
    
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    createdBy: String,
    updatedBy: String,
    version: { type: Number, default: 1 },
  },
  { _id: true, strict: false }
);

// Pre-save middleware for exerciseSchema
exerciseSchema.pre("save", function (next) {
  if (this.questions && Array.isArray(this.questions)) {
    this.exerciseInformation.totalQuestions = this.questions.length;
    this.exerciseInformation.totalPoints = this.questions.reduce(
      (total, question) => total + (question.score || 0),
      0
    );
  }

  if (this.questionConfiguration?.programmingQuestionConfiguration?.scoreSettings) {
    const scoreSettings =
      this.questionConfiguration.programmingQuestionConfiguration.scoreSettings;
    const programmingConfig =
      this.questionConfiguration.programmingQuestionConfiguration;

    const calculateMarks = (scoreSettings, programmingConfig) => {
      const { scoreType, evenMarks, separateMarks, levelBasedMarks, levelScoringStrategies } =
        scoreSettings;
      let totalMarks = 0;

      if (scoreType === "evenMarks") {
        if (programmingConfig.questionConfigType === "general") {
          return (programmingConfig.generalQuestionCount || 0) * evenMarks;
        } else {
          const counts = programmingConfig.levelBasedCounts || { easy: 0, medium: 0, hard: 0 };
          return (counts.easy + counts.medium + counts.hard) * evenMarks;
        }
      } else if (scoreType === "levelBasedMarks") {
        if (levelScoringStrategies) {
          let counts = programmingConfig.levelBasedCounts || { easy: 0, medium: 0, hard: 0 };
          Object.keys(levelScoringStrategies).forEach((level) => {
            const strategy = levelScoringStrategies[level];
            const count = counts[level] || 0;
            if (strategy.type === "level_specific" && strategy.marks) {
              totalMarks += count * strategy.marks;
            }
          });
          return totalMarks;
        } else {
          let counts = programmingConfig.levelBasedCounts || { easy: 0, medium: 0, hard: 0 };
          return (
            (counts.easy || 0) * (levelBasedMarks.easy || 0) +
            (counts.medium || 0) * (levelBasedMarks.medium || 0) +
            (counts.hard || 0) * (levelBasedMarks.hard || 0)
          );
        }
      } else if (scoreType === "separateMarks") {
        if (programmingConfig.questionConfigType === "general") {
          return (separateMarks.general || []).reduce((sum, mark) => sum + mark, 0);
        } else {
          const easyMarks = (separateMarks.levelBased?.easy || []).reduce((sum, mark) => sum + mark, 0);
          const mediumMarks = (separateMarks.levelBased?.medium || []).reduce((sum, mark) => sum + mark, 0);
          const hardMarks = (separateMarks.levelBased?.hard || []).reduce((sum, mark) => sum + mark, 0);
          return easyMarks + mediumMarks + hardMarks;
        }
      }
      return 0;
    };

    this.questionConfiguration.programmingQuestionConfiguration.scoreSettings.totalMarks =
      calculateMarks(scoreSettings, programmingConfig);
  }

  this.updatedAt = new Date();
  next();
});

// ─── TAG SCHEMA ───────────────────────────────────────────────────────────────
const tagSchema = new mongoose.Schema({
  tagName: { type: String },
  tagColor: { type: String, default: "#000000" },
});

// ─── FILE MCQ OPTION SCHEMA ───────────────────────────────────────────────────
const fileMCOptionSchema = new mongoose.Schema({
  text: { type: String, default: "" },
  isCorrect: { type: Boolean, default: false },
  imageUrl: { type: String, default: null },
  imageAlignment: { type: String, enum: ["left", "center", "right"] },
  imageSizePercent: { type: Number },
});

// ─── FILE MCQ QUESTION SCHEMA ─────────────────────────────────────────────────
const fileMcqQuestionSchema = new mongoose.Schema(
  {
    isActive: { type: Boolean, default: true },
    sequence: { type: Number, required: true },
    timestamp: { type: Number, required: true, min: 0 },
    videoTimestamp: { type: Number, required: true, min: 0 },
    mcqQuestion: {
      questionTitle: { type: String },
      options: [fileMCOptionSchema],
      correctAnswers: [{ type: String }],
      mcqQuestionType: {
        type: String,
        enum: [
          "multiple_choice", "multiple_select", "true_false",
          "short_answer", "essay", "dropdown",
          "matching", "ordering", "numeric",
          "checkboxes",
        ],
      },
      mcqQuestionOptionsPerRow: { type: Number },
      mcqQuestionRequired: { type: Boolean },
      explanation: { type: String, default: "" },
      trueFalseAnswer: { type: Boolean, default: null },
      shortAnswer: { type: String, default: "" },
      essayAnswer: { type: String, default: "" },
      numericAnswer: { type: Number, default: null },
      numericTolerance: { type: Number, default: null },
      matchingPairs: [matchingPairSchema],
      orderingItems: [orderingItemSchema],
    },
  },
  { timestamps: true, _id: true }
);

// ─── FILE SCHEMA ──────────────────────────────────────────────────────────────
const fileSchema = new mongoose.Schema(
  {
    fileName: String,
    fileType: String,
    size: String,
    uploadedAt: { type: Date, default: Date.now },
    tags: [tagSchema],
    fileUrl: { type: Map, of: String, default: {} },
    isVideo: { type: Boolean, default: false },
    isReference: { type: Boolean },
    availableResolutions: [String],
    mcqQuestions: [fileMcqQuestionSchema],
    fileDescription: { type: String, default: "" },
    fileSettings: {
      showToStudents: { type: Boolean, default: true },
      allowDownload: { type: Boolean, default: true },
      lastModified: { type: Date, default: Date.now },
    },
  },
  { _id: true, strict: false }
);

// ─── Reusable Page Document Schema ───────────────────────────────────────────
const pageDocSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    blocks: { type: mongoose.Schema.Types.Mixed, default: [] },
    combinedCode: { type: String, default: "" },
    pagesData: [{
      id: { type: String },
      name: { type: String },
      html: { type: String },
      blocks: { type: mongoose.Schema.Types.Mixed },
    }],
    isMultiPage: { type: Boolean, default: false },
    pageCount: { type: Number, default: 1 },
    version: { type: String, default: "1.0.0" },
    folderId: { type: String, default: null },
    folderPath: [{ type: String }],
    // Group context — set when the page was created from a group's "Add"
    // action. Mirrors the same fields used on files/folders so a page can
    // be rendered inside its group row alongside the rest of the group.
    groupId: { type: String, default: null },
    groupName: { type: String, default: null },
    createdBy: { type: String },
    updatedBy: { type: String },
  },
  { _id: true, timestamps: true }
);

// ─── FOLDER SCHEMA ────────────────────────────────────────────────────────────
const folderSchema = new mongoose.Schema(
  {
    name: { type: String },
    files: [fileSchema],
    subfolders: { type: mongoose.Schema.Types.Mixed, default: [] },
    tags: [tagSchema],
    parentGroupId: { type: String, default: null },
    groupName: { type: String, default: null },
    groupDescription: { type: String, default: null },
    uploadedAt: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    pages: [
      {
        _id: { type: mongoose.Schema.Types.ObjectId, auto: true },
        title: { type: String, required: true },
        blocks: { type: mongoose.Schema.Types.Mixed },
        combinedCode: { type: String },
        createdAt: { type: Date, default: Date.now },
        updatedAt: { type: Date, default: Date.now },
        version: { type: String, default: "1.0.0" },
        folderId: { type: String, default: null },
        folderPath: [{ type: String }],
        // Group context — a folder belongs to a group when parentGroupId is
        // set; a page created inside such a folder inherits the same group.
        groupId: { type: String, default: null },
        groupName: { type: String, default: null },
        createdBy: { type: String },
        updatedBy: { type: String },
      },
    ],
  },
  { _id: true }
);

// ─── PEDAGOGY ELEMENT SCHEMA ──────────────────────────────────────────────────
const pedagogyElementSchema = new mongoose.Schema(
  {
    description: { type: mongoose.Schema.Types.Mixed, default: { text: "" } },
    files: [fileSchema],
    folders: [folderSchema],
    pages: [
      {
        _id: { type: mongoose.Schema.Types.ObjectId, auto: true },
        title: { type: String, required: true },
        blocks: { type: mongoose.Schema.Types.Mixed },
        combinedCode: { type: String },
        createdAt: { type: Date, default: Date.now },
        updatedAt: { type: Date, default: Date.now },
        version: { type: String, default: "1.0.0" },
        folderId: { type: String, default: null },
        folderPath: [{ type: String }],
        // Group context — populated when the page was created from a
        // group's "Add" action so the UI can render it inside that group.
        groupId: { type: String, default: null },
        groupName: { type: String, default: null },
        createdBy: { type: String },
        updatedBy: { type: String },
      },
    ],
  },
  { strict: false }
);

// ─── PEDAGOGY SCHEMA ──────────────────────────────────────────────────────────
const pedagogySchema = new mongoose.Schema(
  {
    I_Do: { type: Map, of: pedagogyElementSchema, default: {} },
    We_Do: { type: Map, of: [exerciseSchema], default: {} },
    You_Do: { type: Map, of: mongoose.Schema.Types.Mixed, default: {} },
  },
  { strict: false }
);

// ─── BATCH PEDAGOGY SCHEMA ────────────────────────────────────────────────────
// Resources by Batch. The batch is its OWN level of the hierarchy, holding a
// complete I_Do / We_Do / You_Do set inside it — exactly the shape the spec
// describes:
//
//   node
//     ├── pedagogy                ← course-level / shared
//     │     ├── I_Do   ├── We_Do   └── You_Do
//     └── batchPedagogy
//           ├── <batchId>         ← Batch A
//           │     ├── I_Do   ├── We_Do   └── You_Do
//           └── <batchId>         ← Batch B
//                 ├── I_Do   ├── We_Do   └── You_Do
//
// Keyed by the batch's `_id` from `Course-Structure.batchAndParticipants`, not
// its name — renaming a batch must not orphan the material under it.
//
// Only elements ticked batch-wise in Course Setup are ever written here; the
// rest keep living on `pedagogy` above and stay shared across every batch.
// That is what lets a course with no batches, or one with shared resources,
// keep working with nothing migrated.
const batchPedagogySchema = { type: Map, of: pedagogySchema, default: {} };


const subModuleSchema = new mongoose.Schema({
  institution: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'LMS-Institution',
    required: true,
  },
  courses: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Course-Structure',
    required: true,
  },
  moduleId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Module1',
  },
  title: {
    type: String,
    required: true,
  },
  description: String,
  duration: { type: Number, default:30 },
   level:String,
  index: Number,
  pedagogy: pedagogySchema, // ✅ dynamic pedagogy
  batchPedagogy: batchPedagogySchema, // Resources by Batch — see above
  testConfiguration: {
    coreProgram: [{ type: String }],
    frontend: [{ type: String }],
    database: [{ type: String }]
  },
  createdAt: { type: Date, default: Date.now },
  createdBy: String,
  updatedAt: { type: Date, default: Date.now },
  updatedBy: String,
}, {
  strict: false,
  minimize: false
});

// FIXED: Safe pre-save middleware without recursion issues
subModuleSchema.pre('save', function(next) {
  try {
    // Skip if no pedagogy
    if (!this.pedagogy) {
      return next();
    }

    const normalizeValue = (value, visited = new WeakSet()) => {
      // Guard against null/undefined
      if (!value || typeof value !== 'object') return;
      
      // Prevent circular references
      if (visited.has(value)) return;
      visited.add(value);
      
      // Handle arrays
      if (Array.isArray(value)) {
        value.forEach(item => {
          if (item && typeof item === 'object') {
            normalizeValue(item, visited);
          }
        });
        return;
      }
      
      // Skip Mongoose internal objects and models
      if (value.constructor && value.constructor.name === 'model') return;
      if (value.$__ && value.$isMongooseModelPrototype) return;
      if (value._doc && value.$__) return; // Mongoose document
      
      // Handle description field
      if (value.description !== undefined) {
        if (typeof value.description === 'string') {
          value.description = { text: value.description };
        } else if (value.description && typeof value.description === 'object') {
          if (!value.description.text) value.description.text = '';
        }
      }
      
      // Recursively check all properties (but only own properties)
      try {
        Object.keys(value).forEach(key => {
          // Skip mongoose internal fields and special fields
          if (key.startsWith('$') || 
              key === '_id' || 
              key === '__v' || 
              key === '_doc' ||
              key === '$__' ||
              key === '$init' ||
              key === 'ownerDocument' ||
              key === '$parent') {
            return;
          }
          
          const prop = value[key];
          if (prop && typeof prop === 'object') {
            normalizeValue(prop, visited);
          }
        });
      } catch (err) {
        // If we can't iterate properties, skip this object
        console.warn('Could not iterate object properties:', err.message);
      }
    };

    // Process each section with depth limiting
    const processSection = (sectionData, depth = 0, maxDepth = 10) => {
      if (depth > maxDepth) return;
      
      if (!sectionData) return;
      
      if (sectionData instanceof Map) {
        sectionData.forEach((value, key) => {
          if (value && typeof value === 'object') {
            normalizeValue(value);
          }
        });
      } else if (typeof sectionData === 'object') {
        // Only process if it's a plain object, not a Mongoose model
        if (sectionData.constructor && sectionData.constructor.name === 'Object') {
          normalizeValue(sectionData);
        }
      }
    };

    // Process each section with try-catch blocks
    try {
      if (this.pedagogy.I_Do) processSection(this.pedagogy.I_Do);
    } catch (err) {
      console.warn('Error processing I_Do:', err.message);
    }
    
    try {
      if (this.pedagogy.We_Do) processSection(this.pedagogy.We_Do);
    } catch (err) {
      console.warn('Error processing We_Do:', err.message);
    }
    
    try {
      if (this.pedagogy.You_Do) processSection(this.pedagogy.You_Do);
    } catch (err) {
      console.warn('Error processing You_Do:', err.message);
    }

    // Resources by Batch — a batch-wise element's material lives under
    // batchPedagogy.<batchId>, so it needs the same description normalisation
    // the three shared sections get above. Skipping it would leave batch
    // uploads in a subtly different shape from shared ones.
    try {
      if (this.batchPedagogy) {
        const buckets = typeof this.batchPedagogy.values === 'function'
          ? Array.from(this.batchPedagogy.values())
          : Object.values(this.batchPedagogy);
        for (const bucket of buckets) {
          if (!bucket) continue;
          for (const key of ['I_Do', 'We_Do', 'You_Do']) {
            if (bucket[key]) processSection(bucket[key]);
          }
        }
      }
    } catch (err) {
      console.warn('Error processing batchPedagogy:', err.message);
    }
    
    this.updatedAt = new Date();
    next();
  } catch (error) {
    console.error('Error in pre-save middleware:', error);
    next(); // Continue to avoid blocking saves
  }
});


// The approvals queue and per-course overview filter these nodes by
// institution and by course membership; neither field was indexed, so
// every listing was a collection scan.
subModuleSchema.index({ institution: 1 });
subModuleSchema.index({ courses: 1 });

module.exports = mongoose.model('SubModule1', subModuleSchema);
