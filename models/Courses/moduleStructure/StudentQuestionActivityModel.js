const mongoose = require("mongoose");

// ─── Student Question Activity ─────────────────────────────────────────────
// One record per (exam session, question). Powers the per-student details view
// on the Live Dashboard. assessmentId / studentId are duplicated here (as
// Strings) so we can query a student's activity without an extra join.
const studentQuestionActivitySchema = new mongoose.Schema(
  {
    examSessionId: { type: mongoose.Schema.Types.ObjectId, ref: "ExamSession", required: true, index: true },

    assessmentId: { type: String, required: true, index: true },
    studentId:    { type: String, required: true, index: true },

    questionId:    { type: String, required: true },
    questionNo:    { type: String, default: "" },   // e.g. "Q1"
    questionTitle: { type: String, default: "" },
    questionType:  { type: String, default: "" },
    marks:         { type: Number, default: 0 },

    status: {
      type: String,
      enum: ["pending", "answered", "submitted"],
      default: "pending",
    },

    answer:           { type: String, default: null },
    submittedAt:      { type: Date, default: null },
    timeTakenSeconds: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// One activity row per question per session.
studentQuestionActivitySchema.index({ examSessionId: 1, questionId: 1 }, { unique: true });

module.exports = mongoose.model("StudentQuestionActivity", studentQuestionActivitySchema);
