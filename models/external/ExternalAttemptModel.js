// One external participant's sitting of one external assessment.
//
// Kept apart from the LMS `ExamSession` / `StudentResponse` collections for
// the same reason as everything else in this module: those are keyed by
// `studentId` (an LMS user), and an external participant has no such id.

const mongoose = require("mongoose");

// One answer. `answer` is Mixed because its shape follows the question type:
//   multiple_choice / dropdown  → string (option text)
//   multiple_select / checkboxes→ string[]
//   true_false                  → boolean
//   short_answer / essay        → string
//   numeric                     → number
//   matching                    → [{ left, right }]
//   ordering                    → string[] (items in the participant's order)
const responseSchema = new mongoose.Schema(
  {
    questionId: { type: mongoose.Schema.Types.ObjectId, required: true },
    answer: { type: mongoose.Schema.Types.Mixed, default: null },
    // null = not auto-gradable (essay / short answer awaiting manual review).
    isCorrect: { type: Boolean, default: null },
    score: { type: Number, default: 0 },
    maxScore: { type: Number, default: 0 },
    answeredAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const externalAttemptSchema = new mongoose.Schema(
  {
    assessment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ExternalAssessment",
      required: true,
      index: true,
    },
    participant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ExternalParticipant",
      required: true,
      index: true,
    },
    invitation: { type: mongoose.Schema.Types.ObjectId, ref: "ExternalInvitation" },

    attemptNumber: { type: Number, default: 1 },

    startedAt: { type: Date, default: Date.now },
    submittedAt: { type: Date, default: null },
    // Server-authoritative deadline, stamped at start from the assessment's
    // duration and clamped to the assessment's own end instant. The client
    // timer is advisory; this is what the submit endpoint enforces, so a
    // participant cannot buy time by pausing their clock or reloading.
    expiresAt: { type: Date, default: null, index: true },

    status: {
      type: String,
      enum: ["in_progress", "submitted", "expired"],
      default: "in_progress",
      index: true,
    },
    // submit — the participant pressed Submit
    // timer  — the duration ran out (or the assessment window closed)
    terminationReason: {
      type: String,
      enum: ["submit", "timer", null],
      default: null,
    },

    responses: [responseSchema],

    totalScore: { type: Number, default: 0 },
    maxScore: { type: Number, default: 0 },
    percentage: { type: Number, default: 0 },
    isPassed: { type: Boolean, default: null },
    // True while any essay/short-answer response still has isCorrect === null.
    needsManualReview: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// The access gate's hot path: "does this participant already have a sitting?"
externalAttemptSchema.index({ assessment: 1, participant: 1, attemptNumber: 1 }, { unique: true });
// Sweep for in-flight attempts whose deadline has passed.
externalAttemptSchema.index({ status: 1, expiresAt: 1 });

module.exports = mongoose.model("ExternalAttempt", externalAttemptSchema);
