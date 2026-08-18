const mongoose = require("mongoose");

// ─── Proctor → Student message ──────────────────────────────────────────────
// One record per message PER RECIPIENT (a broadcast fans out to one doc per
// live student) so each student's chat history is a simple
// find({ assessmentId, studentId }). assessmentId/studentId are Strings to
// match ExamSessionModel and the socket payloads.
const proctorMessageSchema = new mongoose.Schema(
  {
    assessmentId: { type: String, required: true, index: true },
    studentId:    { type: String, required: true, index: true }, // recipient

    senderId:     { type: String, default: null },               // proctor / admin user id
    senderName:   { type: String, default: "Proctor" },

    message:      { type: String, required: true, maxlength: 1000 },
    scope:        { type: String, enum: ["individual", "broadcast"], default: "individual" },

    // unread until the student opens their chat panel
    read:         { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Fast history + unread-count lookups per (assessment, student).
proctorMessageSchema.index({ assessmentId: 1, studentId: 1, createdAt: 1 });

module.exports = mongoose.model("ProctorMessage", proctorMessageSchema);
