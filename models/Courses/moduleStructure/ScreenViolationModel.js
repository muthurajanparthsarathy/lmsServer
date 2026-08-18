const mongoose = require("mongoose");

// ─── Screen Violation ──────────────────────────────────────────────────────
// One record per proctoring violation during a live-monitored assessment.
// Powers the per-student "Violation history" in the Live Screens zoom view.
// assessmentId / studentId stored as Strings to match ExamSession + socket
// payloads (assessments are embedded exercises; ids arrive as query/socket
// strings).
const screenViolationSchema = new mongoose.Schema(
  {
    assessmentId: { type: String, required: true, index: true },
    studentId:    { type: String, required: true, index: true },

    type: {
      type: String,
      enum: [
        "share_stopped",    // student stopped / ended screen sharing
        "not_full_screen",  // shared a tab/window instead of the entire screen
        "tab_switch",       // switched away from the exam tab
        "reconnect",        // network drop + reconnect
        "manual_warning",   // proctor-issued warning
        "other",
      ],
      default: "other",
    },

    detail: { type: String, default: "" },
  },
  { timestamps: true }
);

// Most queries are "all violations for this student in this assessment".
screenViolationSchema.index({ assessmentId: 1, studentId: 1, createdAt: -1 });

module.exports = mongoose.model("ScreenViolation", screenViolationSchema);
