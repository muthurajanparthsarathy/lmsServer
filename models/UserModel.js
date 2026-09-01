const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const validator = require("validator");

const folderSchema = new mongoose.Schema({
  id: {
    type: String, // Changed from ObjectId to String
    required: true
  },
  name: {
    type: String,
    required: true
  },
  path: {
    type: String,
    required: true
  },
  parentPath: {
    type: String,
  },
  depth: {
    type: Number,
    default: 0
  },
  fileCount: {
    type: Number,
    default: 0
  },
  subfolderCount: {
    type: Number,
    default: 0
  }
}, {
  _id: false, // Important: Don't create _id for subdocuments
  timestamps: false
});

// Update fileSchema
const fileSchema = new mongoose.Schema({
  id: {
    type: String, // Changed from ObjectId to String
    required: true
  },
  filename: {
    type: String,
    required: true
  },
  content: {
    type: String,
    required: true
  },
  language: {
    type: String,
    required: true
  },
  path: {
    type: String,
    required: true
  },
  folderPath: {
    type: String,
    default: '/'
  },
  size: {
    type: Number,
    default: 0
  },
  isEntryPoint: {
    type: Boolean,
    default: false
  },
      isQueryFile: { type: Boolean, default: false }, // Query file

  lastModified: {
    type: Date,
    default: Date.now
  }
}, {
  _id: false, // Important: Don't create _id for subdocuments
  timestamps: false
});

// ─── EVALUATION BREAKDOWN — per-question detail of HOW the score was computed ──
// Populated by the client at Submit time based on the exercise's
// `evaluationMethod`:
//   • 'manual'   → not set. Trainer types the score on Review.
//   • 'testcase' → { method:'testcase', testcase:{ passed, total } }
//   • 'ai'       → { method:'ai', ai:{ perCriterionMax, criteria:[...], model, failed } }
// The Review Submission page reads this to render a breakdown card
// (Correctness 90% · Code Quality 70% …) and preserves it as history when
// the trainer overrides the total score.
const evaluationBreakdownCriterionSchema = new mongoose.Schema({
  key: { type: String },          // 'correctness' | 'codeQuality' | 'efficiency' | 'readability' | 'edgeCases' | 'bestPractices'
  percentage: { type: Number },   // 0–100 from Gemini
  score: { type: Number },        // absolute marks = perCriterionMax × percentage/100
  comment: { type: String },      // Gemini's 1-sentence rationale, or empty
}, { _id: false });

// Per-test-case row inside evaluationBreakdown.ai.testCases. Records what the
// student was judged against + AI's verdict, so the Review page can show
// "Passed 15/20" with expand-to-see per-case details.
const evaluationBreakdownAiTestCaseSchema = new mongoose.Schema({
  index: { type: Number },              // 0-based position in the evaluation
  source: { type: String, enum: ['question', 'ai'] }, // 'question' = trainer authored, 'ai' = AI-generated
  input: { type: String, default: '' },
  expectedOutput: { type: String, default: '' },
  passed: { type: Boolean, default: false },
  comment: { type: String, default: '' }, // AI's 1-line reason
}, { _id: false });

// Per-test-case row inside evaluationBreakdown.testcase.cases. Written by the
// student editors / rerun at scoring time so the Review page can show the
// trainer WHICH cases failed (input/expected/got), not just "passed 1/2".
const evaluationBreakdownTestCaseSchema = new mongoose.Schema({
  index: { type: Number },               // 0-based position in the question's testCases
  passed: { type: Boolean, default: false },
  hidden: { type: Boolean, default: false }, // question flagged it isHidden
  input: { type: String, default: '' },
  expectedOutput: { type: String, default: '' },
  actualOutput: { type: String, default: '' }, // what the student's code printed
}, { _id: false });

const evaluationBreakdownSchema = new mongoose.Schema({
  method: { type: String, enum: ['manual', 'testcase', 'ai'] },
  testcase: {
    passed: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    // Absent on submissions scored before this field existed — Review falls
    // back to counts-only display.
    cases: { type: [evaluationBreakdownTestCaseSchema], default: [] },
  },
  ai: {
    perCriterionMax: { type: Number, default: 0 },
    criteria: { type: [evaluationBreakdownCriterionSchema], default: [] },
    // ── AI test-case evaluation (new in Phase 2 of this feature) ──────────
    // AI is asked to judge the student's code against `testCases[]` — a mix
    // of the question's authored testCases AND the ai.testCasesCount that
    // Gemini generated. `passedTestCases` / `totalTestCases` are the counts
    // used for the score. `criteriaPortion` + `testCasePortion` are the two
    // score halves (score = criteriaPortion + testCasePortion). Stored
    // separately so Review can show both signals independently.
    testCases: { type: [evaluationBreakdownAiTestCaseSchema], default: [] },
    passedTestCases: { type: Number, default: 0 },
    totalTestCases: { type: Number, default: 0 },
    criteriaPortion: { type: Number, default: 0 }, // score half from avg(criteria %) × M / 2
    testCasePortion: { type: Number, default: 0 }, // score half from (passed/total) × M / 2
    model: { type: String, default: '' },
    failed: { type: Boolean, default: false }, // Gemini call errored → student's Submit fell through to score:0
  },
}, { _id: false });

// Update questionAnswerSchema
const questionAnswerSchema = new mongoose.Schema({
  questionId: {
    type: mongoose.Schema.Types.ObjectId,
  },
  questionTitle: {
    type: String,
  },
  // Store multiple files
  files: [fileSchema],
  // Store folder structure
  folders: [folderSchema],
  // Enhanced project structure
  projectStructure: {
    folders: [folderSchema],
    folderTree: mongoose.Schema.Types.Mixed,
    hasFolders: Boolean,
    totalFolders: Number,
    totalFiles: Number,
    entryPoints: [String],
    fileDistribution: {
      html: Number,
      css: Number,
      javascript: Number,
      other: Number,
      sql: Number
    }
  },
    sqlMetadata: {
    databaseType: { type: String, default: 'mysql' }, // mysql, postgresql, sqlite, etc.
    hasSchemaFiles: { type: Boolean, default: false },
    hasDataFiles: { type: Boolean, default: false },
    hasProcedureFiles: { type: Boolean, default: false },
    totalQueries: { type: Number, default: 0 },
    databases: [{ // Multiple databases in project
      name: String,
      tables: [String],
      fileIds: [String] // Files belonging to this database
    }]
  },

  entryPoints: [String],
  codeAnswer: {
    type: String,
    trim: true
  },
  // For Others question type: file-upload answers (Supabase URLs)
  othersFiles: [
    {
      name: { type: String },
      url: { type: String },
      mimeType: { type: String },
    }
  ],
  // For Others notion type: multi-page Notion editor answer (PageData[] JSON)
  notionPages: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },
  language: {
    type: String,
  },
  isCorrect: {
    type: Boolean,
    default: false
  },
  totalScore: {
    type: Number,
    default: 0
  },
  score: {
    type: Number,
    default: 0
  },
  feedback: {
    type: String
  },
  status: {
    type: String,
    enum: ['solved', 'attempted', 'skipped', 'submitted', 'evaluated'],
    default: 'attempted'
  },
  // Per-question evaluation breakdown — see evaluationBreakdownSchema above.
  // Null for Manual submissions; populated for Test Case and AI submissions.
  evaluationBreakdown: { type: evaluationBreakdownSchema, default: null },
  // Audit trail of past scores for THIS student × question. Pushed to whenever
  // a Rerun overwrites the stored score. Each entry captures the score value
  // that WAS live before the rerun, so trainers can see "was 3, now 7 (rerun
  // on 2026-08-07)". Never truncated by app code; capped only by Mongo
  // document size in practice.
  scoreHistory: [{
    _id: false,
    previousScore: { type: Number, default: 0 },
    previousStatus: { type: String, default: '' },
    previousIsCorrect: { type: Boolean, default: false },
    at: { type: Date, default: Date.now },
    source: { type: String, enum: ['rerun', 'manual'], default: 'rerun' },
    note: { type: String, default: '' },
  }],
  // Marks the last time this submission's score was overwritten by a Rerun.
  // Distinct from `submittedAt` (which is the student's original attempt).
  lastRerunAt: { type: Date, default: null },
  attempts: {
    type: Number,
    default: 0
  },
  submittedAt: {
    type: Date,
    default: Date.now
  },
  fileStructure: {
    totalFiles: Number,
    htmlFiles: Number,
    cssFiles: Number,
    jsFiles: Number,
    otherFiles: Number,
    sqlFiles: Number,
    folders: Number,
    sqlFiles: Number,
    folderStructure: [{
      name: String,
      path: String,
      fileCount: Number
    }]
  }
}, {
  timestamps: true
});

// Update exerciseProgressSchema
const exerciseProgressSchema = new mongoose.Schema({
  exerciseId: {
    type: mongoose.Schema.Types.ObjectId,
  },
  exerciseName: {
    type: String,
  },
  questions: [questionAnswerSchema],
  status: {
    type: String,
    enum: ['in-progress', 'completed', 'terminated'],
    default: 'in-progress'
  },
  isLocked: {
    type: Boolean,
    default: false,
    description: "If true, user cannot re-enter this exercise"
  },
  selectedProgrammingLanguage: {
    type: String,
  },
  // Context information
  nodeId: {
    type: String,
    trim: true
  },
  nodeName: {
    type: String,
    trim: true
  },
  nodeType: {
    type: String,
    trim: true
  },
  subcategory: {
    type: String,
    trim: true,
  },
  screenRecording: {
    type: String,
  },
  // Folder structure metadata
  hasFolderStructure: {
    type: Boolean,
    default: false
  },
  folderCount: {
    type: Number,
    default: 0
  },
  projectType: {
    type: String,
    enum: ['single-file', 'multi-file'],
    default: 'single-file'
  },
  testSubmissions: {
    type: Number,
    default: 0
  },
  userAttempts: {
    type: Number,
    default: 0,
    description: "Total number of times user has attempted this exercise"
  },
  lastTestSubmittedAt: {
    type: Date,
    default: null,
    description: "Timestamp of last full Submit Exercise — used for double-click guard"
  },
  lateSubmission: {
    type: Boolean,
    default: false,
    description: "True if the most recent Submit Exercise happened after endDate but inside the cutOff window"
  },
  // How the most recent full Submit Exercise happened:
  //  'USER' = student manually submitted;
  //  'AUTO' = system auto-submitted on a rule/proctoring violation or timeout.
  submitType: {
    type: String,
    enum: ['USER', 'AUTO'],
    default: 'USER',
    description: "Manual (USER) vs system auto-submit (AUTO) for the most recent submission"
  },
  // When submitType === 'AUTO', the human-readable reason that triggered it
  // (e.g. 'Tab switch limit reached', 'Time limit reached', 'Face not detected',
  //  'Multiple person detected'). Empty string for manual (USER) submissions.
  autoSubmitReason: {
    type: String,
    default: '',
    description: "Stored violation/timeout reason for AUTO submissions; blank for USER"
  },
  // Per-student retest window granted by a coordinator via "Unlock Assessment".
  // When present and the current time is within [startDate, endDate], the student
  // can retake this assessment even if the assessment's own window has ended.
  // This is isolated to this student only — it never affects other students.
  retestWindow: {
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null },
    unlockedAt: { type: Date, default: null },
    unlockedBy: { type: mongoose.Schema.Types.ObjectId, default: null }
  }
}, {
  timestamps: true
});
// File MCQ answer record — one entry per question answered in a file quiz
const fileMcqAnswerSchema = new mongoose.Schema({
  pageNumber:     { type: Number },
  questionId:     { type: mongoose.Schema.Types.ObjectId },
  questionTitle:  { type: String, default: '' },
  selectedChoice: { type: String, default: '' },
  correctChoice:  { type: String, default: '' },
  isCorrect:      { type: Boolean, default: false },
  fileName:       { type: String, default: '' },
  submittedAt:    { type: Date, default: Date.now },
}, { _id: false });

// Updated Answer Schema with Map structure
const answerSchema = new mongoose.Schema({
  I_Do: {
    type: Map,
    of: mongoose.Schema.Types.Mixed,
    default: new Map()
  },
  We_Do: {
    type: Map,
    of: mongoose.Schema.Types.Mixed,
    default: new Map()
  },
  You_Do: {
    type: Map,
    of: mongoose.Schema.Types.Mixed,
    default: new Map()
  },
});

// Individual Course Schema
const userCourseSchema = new mongoose.Schema({
  courseId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Course-Structure",
  },

  answers: answerSchema,
  lastAccessed: { type: Date },
  
  progress: {           // ← ADD THIS BLOCK
    visitedNodes: [{ 
      type: String 
    }],
    openedResources: [{ 
      type: String 
    }],
    completedExercises: [{ 
      type: String 
    }],
    lastVisitedNode: { 
      type: String, 
      default: "" 
    },
    lastVisitedAt: { 
      type: Date 
    }
  }
})

// Update User Schema to use userCourseSchema directly
const permissionItemSchema = new mongoose.Schema({
  permissionName: { 
    type: String, 
    required: [true, "Permission name is required"],
    trim: true
  },
  permissionKey: { 
    type: String, 
    required: [true, "Permission key is required"],
    trim: true,
    unique: true
  },
  permissionFunctionality: [{ 
    type: String, 
    trim: true 
  }],
  icon: {
    type: String,
    required: [true, "Icon name is required"],
    trim: true,
    default: "Shield"
  },
  color: {
    type: String,
    required: [true, "Color is required"],
    trim: true,
    default: "blue"
  },
  description: {
    type: String,
    trim: true,
    default: ""
  },
  isActive: {
    type: Boolean,
    default: true
  },
  order: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

const tokenSchema = new mongoose.Schema({
  token: { type: String, required: true },
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 86400,
  },
});

const noteSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, "Note title is required"],
    trim: true,
    maxlength: 200,
    default: "Untitled Note"
  },
  content: {
    type: String,
    default: ""
  },
  tags: [{
    type: String,
    trim: true
  }],
  isPinned: {
    type: Boolean,
    default: false
  },
  color: {
    type: String,
    default: "#ffffff"
  },
  lastEdited: {
    type: Date,
    default: Date.now
  },
  resourceId: {
    type: String,
    index: true
  },
  resourceType: {
    type: String,
    enum: ['pdf', 'ppt', 'video']
  },
  anchor: {
    page: { type: Number },
    timestamp: { type: Number }
  }
}, {
  timestamps: true
});
const aiHistorySchema = new mongoose.Schema({
  sessionId: {
    type: String,
    required: true,
    default: () => `chat_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  },
  title: {
    type: String,
    default: "New Chat",
    trim: true,
    maxlength: 100
  },
  messages: [{
    content: {
      type: String,
      required: true
    },
    role: {
      type: String,
      enum: ["user", "assistant"],
      required: true
    },
    timestamp: {
      type: Date,
      default: Date.now
    },
    metadata: {
      context: {
        topicTitle: String,
        fileName: String,
        fileType: String,
        isDocumentView: Boolean
      }
    }
  }],
  context: {
    topicTitle: String,
    fileName: String,
    fileType: String,
    isDocumentView: Boolean
  },
  isArchived: {
    type: Boolean,
    default: false
  },
  lastMessageAt: {
    type: Date,
    default: Date.now
  },
  messageCount: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

const notificationSchema = new mongoose.Schema({
  title: {
    type: String,
    trim: true
  },
  message: {
    type: String,
  },
  type: {
    type: String,
    enum: ['info', 'success', 'warning', 'error', 'enrollment'],
    default: 'info'
  },
  relatedEntity: {
    type: String,
    // 'exercise' + 'question' were being pushed by other flows without ever
    // being declared here, so every user.save() on a user whose notifications
    // array contained one exploded on validation ("`exercise` is not a valid
    // enum value" from submitMultipleFiles' final user.save). Widening the
    // enum keeps the historical rows valid and lets future notifications
    // point at the right entity type instead of getting misfiled as
    // 'assignment'.
    enum: ['course', 'assignment', 'exercise', 'question', 'announcement', 'enrollment', 'system'],
    default: 'enrollment'
  },
  relatedEntityId: {
    type: mongoose.Schema.Types.ObjectId
  },
  isRead: {
    type: Boolean,
    default: false
  },
  metadata: {
    type: Map,
    of: mongoose.Schema.Types.Mixed,
    default: new Map()
  },
  // Add enrolledBy as a separate reference
  enrolledBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'LMS-User',
    default: null
  },
  isFavorite: {
    type: Boolean,
    default: false
  },
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days from now
  }
}, {
  timestamps: true
});

// Updated User Schema - Remove firstSchema and secondSchema
const userSchema = new mongoose.Schema({
  institution: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "LMS-Institution",
    // The primary access pattern for user lists (find({ institution })) —
    // without this every institution-scoped query is a collection scan.
    index: true,
  },
  userId: {
    type: String,
    index: true,
    sparse: true,
  },
  email: {
    type: String,
    required: [true, "Your email address is required"],
    unique: true,
    lowercase: true,
    validate: (value) => {
      return validator.isEmail(value);
    },
  },
  firstName: {
    type: String,
    required: true,
  },
  lastName: {
    type: String,
  },
  phone: {
    type: String,
    required: true,
  },
  gender: {
    type: String,
  },
  password: {
    type: String,
    required: [true, "Your password is required"],
  },
  profile: {
    type: String,
  },
  role: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Role",
    default: null,
  },
  degree: {
    type: String,
  },
  department: {
    type: String,
  },
  year: {
    type: String,
  },
  semester: {
    type: String,
  },
  section: {
    type: String,
  },
  // Student roll / register number — optional, entered on Add User.
  rollNumber: {
    type: String,
  },
  batch: {
    type: String,
  },
  phase: {
    type: String,
  },
  studentType: {
    type: String,
  },
  // The service model chosen in Add/Bulk User — identifies which service mapping
  // (and hierarchy structure) this user belongs to.
  serviceModel: {
    type: String,
  },
  // The _id of the exact service mapping chosen. serviceModel is only a name and
  // a client may run several mappings under the same one (e.g. two "placement
  // training" services with different courses). Auto-enrolment reads this to
  // scope a placement user to their OWN service's courses instead of every
  // placement course the client offers.
  serviceMappingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "LMS-ServiceMapping",
  },
  clientName: {
    type: String,
  },
  clientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "LMS-ClientManagement",
  },
  // Additional service enrolments beyond the legacy single service above.
  // The legacy serviceModel/serviceMappingId/clientId/clientName stay the
  // user's first enrolment; Reassign Users (bulk-add-service) appends here so
  // a user can belong to several services at once. Readers wanting "all of a
  // user's services" must union the legacy fields with this array.
  services: [
    {
      serviceMappingId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "LMS-ServiceMapping",
      },
      serviceModel: {
        type: String,
      },
      clientId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "LMS-ClientManagement",
      },
      clientName: {
        type: String,
      },
    },
  ],
  permissions: [permissionItemSchema],
  status: {
    type: String,
    enum: ["active", "inactive"],
  },
  notes: [noteSchema],
    ai_history: [aiHistorySchema],

      notifications: [notificationSchema],

  createdAt: {
    type: Date,
    default: new Date(),
  },
  createdBy: {
    type: String,
  },
  // Simple courses array with userCourseSchema
  courses: [userCourseSchema],
  tokens: [tokenSchema],
}, {
  timestamps: true
});

// Pre-save hook for password hashing
userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();

  try {
    this.password = await bcrypt.hash(this.password, 12);
    next();
  } catch (error) {
    next(error);
  }
});
userSchema.methods.addNotification = async function(notificationData) {
  try {
    const notification = {
      ...notificationData,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    
    this.notifications.unshift(notification); // Add to beginning for newest first
    this.unreadNotificationCount = this.notifications.filter(n => !n.isRead).length;
    
    await this.save();
    return notification;
  } catch (error) {
    console.error('Error adding notification:', error);
    throw error;
  }
};

// Method to mark notification as read
userSchema.methods.markNotificationAsRead = async function(notificationId) {
  const notification = this.notifications.id(notificationId);
  if (notification && !notification.isRead) {
    notification.isRead = true;
    notification.updatedAt = new Date();
    this.unreadNotificationCount = Math.max(0, this.unreadNotificationCount - 1);
    await this.save();
  }
  return notification;
};

// Method to mark all notifications as read
userSchema.methods.markAllNotificationsAsRead = async function() {
  this.notifications.forEach(notification => {
    if (!notification.isRead) {
      notification.isRead = true;
      notification.updatedAt = new Date();
    }
  });
  this.unreadNotificationCount = 0;
  await this.save();
};

// Pre-save hook to update unread notification count
userSchema.pre('save', function(next) {
  if (this.isModified('notifications')) {
    this.unreadNotificationCount = this.notifications.filter(n => !n.isRead).length;
  }
  next();
});
// Update lastEdited timestamp before saving notes
userSchema.pre('save', function(next) {
  if (this.isModified('notes')) {
    this.notes.forEach(note => {
      if (note.isModified()) {
        note.lastEdited = new Date();
      }
    });
  }
  next();
});

// ── Indexes for the paginated user directory ────────────────────────────────
// getUserAccess's paginated mode always filters by institution and then sorts.
// Without a compound index every page is a collection scan plus a blocking
// in-memory sort — survivable at a few hundred users, not at six figures.
//
// The sort keys carry a collation (locale en, strength 2, numericOrdering) to
// match the page's `toLowerCase() + localeCompare(numeric)`. A collated SORT
// can only use an index built with the SAME collation, so those are declared
// with it; the default newest-first index needs none because createdAt/_id are
// not strings.
//
// EVERY key column ends with `createdAt: -1, _id: -1` because that is the
// controller's tie-break, and an index only serves a sort when it covers the
// WHOLE sort spec. Leaving those off (the first version of this) still built a
// usable index for filtering, but each sorted page fell back to a blocking
// in-memory SORT of the entire institution — verified with explain(), which
// showed SORT <- FETCH <- IXSCAN and every matching document examined instead
// of just the page's 25.
//
// The directions are the ASCENDING spec; a descending sort is its exact
// reverse, which MongoDB serves by scanning the same index backwards. The
// leading `institution` is an equality match, so its direction is irrelevant.
userSchema.index({ institution: 1, createdAt: -1, _id: -1 });
userSchema.index(
  { institution: 1, firstName: 1, lastName: 1, createdAt: -1, _id: -1 },
  { collation: { locale: "en", strength: 2, numericOrdering: true } }
);
userSchema.index(
  { institution: 1, phone: 1, createdAt: -1, _id: -1 },
  { collation: { locale: "en", strength: 2, numericOrdering: true } }
);
// Serves both the status FILTER and the bucketed status SORT.
userSchema.index({ institution: 1, status: 1, createdAt: -1, _id: -1 });
// Serves the role multi-select filter and the bucketed role sort.
userSchema.index({ institution: 1, role: 1, createdAt: -1, _id: -1 });

module.exports = mongoose.model("LMS-User", userSchema);