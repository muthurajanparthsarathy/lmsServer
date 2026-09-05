// External Assessment participant.
//
// THE POINT OF THIS FILE: an external participant is NOT an LMS user. Nothing
// here writes to `lms-users`, no Role is assigned, no password is issued, and
// none of these documents are reachable from User Management. A participant
// exists only in the context of ONE external assessment — invite the same
// person to two assessments and there are two rows, because their status,
// invitation and attempt differ per assessment.
//
// Their credential is the invitation token (see ExternalInvitationModel), not
// an account.

const mongoose = require("mongoose");

const externalParticipantSchema = new mongoose.Schema(
  {
    assessment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ExternalAssessment",
      required: true,
      index: true,
    },

    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, default: "", trim: true },
    // Lowercased on write so the per-assessment uniqueness check is
    // case-insensitive without needing a collation on the index — "A@x.com"
    // and "a@x.com" are the same person.
    email: { type: String, required: true, trim: true, lowercase: true },
    phone: { type: String, default: "", trim: true },

    // How this row got here — useful when reconciling a bulk upload.
    source: { type: String, enum: ["form", "bulk_upload"], default: "form" },

    // Invitation lifecycle. Distinct from the attempt: an invite can be sent
    // and never opened, and email delivery can fail without losing the
    // participant — the admin can resend from the Participants tab.
    invitationStatus: {
      type: String,
      enum: ["pending", "sent", "failed"],
      default: "pending",
      index: true,
    },
    invitationSentAt: { type: Date, default: null },
    invitationError: { type: String, default: "" },
    invitationAttempts: { type: Number, default: 0 },

    // Denormalised attempt summary so the Participants table renders without
    // joining the attempts collection per row. Written by the attempt flow.
    attemptStatus: {
      type: String,
      enum: ["not_started", "in_progress", "submitted", "expired"],
      default: "not_started",
      index: true,
    },
    lastAttemptAt: { type: Date, default: null },
    attemptCount: { type: Number, default: 0 },
    score: { type: Number, default: null },
    maxScore: { type: Number, default: null },
    isPassed: { type: Boolean, default: null },

    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: "LMS-User" },
  },
  { timestamps: true }
);

// One row per (assessment, email). This index IS the duplicate rule the bulk
// upload reports on — a repeat email in the same assessment is rejected by the
// database, not only by the controller's pre-check, so two concurrent uploads
// cannot both slip the same person in.
externalParticipantSchema.index({ assessment: 1, email: 1 }, { unique: true });
// Participants table: newest first within an assessment.
externalParticipantSchema.index({ assessment: 1, createdAt: -1 });

externalParticipantSchema.virtual("fullName").get(function fullName() {
  return `${this.firstName || ""} ${this.lastName || ""}`.trim();
});
externalParticipantSchema.set("toJSON", { virtuals: true });
externalParticipantSchema.set("toObject", { virtuals: true });

module.exports = mongoose.model("ExternalParticipant", externalParticipantSchema);
