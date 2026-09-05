// Invitation token for one external participant's assessment link.
//
// DELIBERATELY NOT A JWT. A JWT signed with JWT_TOKEN_KEY would have to be
// inserted into the `lms-tokens` allow-list to be usable, and `userAuth` would
// then accept it as a full LMS user session — an external participant would
// hold a working LMS credential. Instead this is an opaque random string that
// ONLY the external-assessment access routes know how to resolve, so the blast
// radius of a leaked link is exactly one assessment sitting.
//
// The token is also what keeps database ids out of the emailed URL: the link
// is /assessment/<token>, never /assessment/<participantId>.

const mongoose = require("mongoose");
const crypto = require("crypto");

const externalInvitationSchema = new mongoose.Schema(
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

    // 32 bytes of CSPRNG entropy, hex-encoded (64 chars). Unique index so a
    // collision is a write error rather than a silent hijack.
    token: { type: String, required: true, unique: true, index: true },

    // Hard expiry, independent of the assessment window. Defaults to a while
    // after the assessment ends so a participant who opens a stale link gets
    // the "Assessment Expired" screen (which explains when it closed) rather
    // than a bare "invalid link".
    expiresAt: { type: Date, default: null },

    // Set the first time the link is opened; purely informational — the
    // access gate does NOT reject a re-opened link, because a participant may
    // legitimately close the tab and come back mid-window.
    firstAccessedAt: { type: Date, default: null },
    lastAccessedAt: { type: Date, default: null },
    accessCount: { type: Number, default: 0 },

    // An admin can kill one participant's link without deleting the row.
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// One live invitation per participant. Re-inviting replaces the token, which
// invalidates whatever was mailed before — that is the intended behaviour of
// "Resend invitation" and it is what makes revocation meaningful.
externalInvitationSchema.index({ participant: 1 }, { unique: true });

/** 64-char opaque token. Same crypto idiom as instituteHolidayCalendar.js. */
externalInvitationSchema.statics.generateToken = () =>
  crypto.randomBytes(32).toString("hex");

module.exports = mongoose.model("ExternalInvitation", externalInvitationSchema);
