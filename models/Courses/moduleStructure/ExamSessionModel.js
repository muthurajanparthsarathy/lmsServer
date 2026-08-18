const mongoose = require("mongoose");

// ─── Exam Session ──────────────────────────────────────────────────────────
// One record per (assessment, student). Drives the teacher Live Dashboard.
// assessmentId === the exercise _id (assessments are embedded exercises in the
// pedagogy tree, so we store the id as a String for reliable matching against
// query params and socket payloads).
const examSessionSchema = new mongoose.Schema(
  {
    assessmentId:   { type: String, required: true, index: true },
    studentId:      { type: String, required: true, index: true },

    joinedAt:       { type: Date, default: Date.now },
    submittedAt:    { type: Date, default: null },

    isOnline:       { type: Boolean, default: true },
    lastActivityAt: { type: Date, default: Date.now },

    totalQuestions:    { type: Number, default: 0 },
    completedCount:    { type: Number, default: 0 },
    notAttemptedCount: { type: Number, default: 0 },

    // current question the student is viewing (for the details view)
    currentQuestionId: { type: String, default: null },

    inProgress: { type: Boolean, default: true },

    // ── Live Screen Monitoring ──────────────────────────────────────────────
    // Whether the student is currently sharing their screen, and how many
    // proctoring warnings/violations they have accumulated.
    isSharingScreen: { type: Boolean, default: false },
    warningCount:    { type: Number, default: 0 },
  },
  { timestamps: true }
);

// One session per student per assessment.
examSessionSchema.index({ assessmentId: 1, studentId: 1 }, { unique: true });

module.exports = mongoose.model("ExamSession", examSessionSchema);
