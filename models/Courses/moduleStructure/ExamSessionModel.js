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

    // ── Attempt lifecycle (Recovery & Resume) ─────────────────────────────
    // startedAt is stamped once by /courses/attempt/start and NEVER overwritten
    // — refreshing / reopening the assessment reuses this timestamp so the
    // student can't reset their timer. joinedAt above still moves whenever
    // the student re-enters, so the two together tell the story of the
    // attempt (started once, joined/reconnected N times).
    startedAt:       { type: Date, default: null },
    // Total duration (seconds) the exercise allows for the whole attempt,
    // stamped once at start. Together with `lastSubmittedAt` this drives the
    // elapsed-time timer: `remaining = totalDurationSeconds - max(0,
    // (lastSubmittedAt || startedAt) - startedAt)`. `null` when the exercise
    // has no timer configured.
    totalDurationSeconds: { type: Number, default: null },
    // Moment of the most recent question submission. Freezes the clock — time
    // between the last submit and now doesn't count against the student, so
    // leaving/reopening the assessment doesn't burn time. Written by
    // submitAnswer + submitMultipleFiles on every question submission.
    lastSubmittedAt:      { type: Date, default: null },
    // Deprecated wall-clock deadline. Kept on the model so pre-existing rows
    // don't break, but no longer authoritative — the new elapsed-time model
    // uses `totalDurationSeconds` + `lastSubmittedAt` instead. Read paths
    // fall back to this only for legacy rows without totalDurationSeconds.
    serverExpiresAt:      { type: Date, default: null },
    // ── Resume permission gate (Recovery & Resume — new workflow) ─────────
    // Whenever the student exits (crash, close, submit-test), the attempt
    // enters `awaiting_approval` on their next reopen. The trainer approves
    // from the Live Dashboard, flipping it to `approved_for_resume`, and the
    // student sees a Resume button. `active` = fresh session with no prior
    // exit. `rejected` = trainer denied a resume request.
    resumeState: {
      type: String,
      enum: ["active", "awaiting_approval", "approved_for_resume", "rejected"],
      default: "active",
      index: true,
    },
    resumeRequestedAt: { type: Date, default: null },
    resumeApprovedAt:  { type: Date, default: null },
    resumeApprovedBy:  { type: String, default: null }, // trainer's userId
    // Attempt lifecycle, distinct from the socket-presence `inProgress` flag
    // below. `active`  → resume path applies.
    //                    `submitted`   → student pressed Submit (terminal).
    //                    `terminated`  → server ended the attempt (timer expiry
    //                                    OR a proctor / admin action).
    status: {
      type: String,
      enum: ["active", "submitted", "terminated"],
      default: "active",
      index: true,
    },
    // Why the attempt ended. `submit` for user-initiated; `timer` for the
    // sweep job's expiry finalisation; `security` reserved for future
    // proctoring integration. Null while status === 'active'.
    terminationReason: {
      type: String,
      enum: ["submit", "timer", "security", null],
      default: null,
    },

    isOnline:       { type: Boolean, default: true },
    lastActivityAt: { type: Date, default: Date.now },

    totalQuestions:    { type: Number, default: 0 },
    completedCount:    { type: Number, default: 0 },
    notAttemptedCount: { type: Number, default: 0 },

    // current question the student is viewing (for the details view)
    currentQuestionId: { type: String, default: null },

    // Live socket-presence flag — true while the student's browser tab is
    // connected. The 30 s grace timer in liveDashboardSocket.js flips this
    // to false on disconnect. This is NOT the attempt-lifecycle signal —
    // use `status` above for that.
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
// Sweep job in liveDashboardSocket.js scans `status: 'active'` sessions past
// their `serverExpiresAt` — this compound index makes that query cheap. Still
// used by the legacy wall-clock fallback for pre-existing rows.
examSessionSchema.index({ status: 1, serverExpiresAt: 1 });
// The new elapsed-time sweep scans on (status, startedAt, lastSubmittedAt).
// Same index shape — mongo can prefix-match the first two columns.
examSessionSchema.index({ status: 1, startedAt: 1 });

module.exports = mongoose.model("ExamSession", examSessionSchema);
