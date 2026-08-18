// server/models/Courses/StudentAttendanceModel.js
//
// One row per (course, student, day) — plus an optional sessionId slot that
// stays null for now so we don't need a schema migration when per-session
// attendance is added later. Status is a single letter so it round-trips
// cleanly to the client grid.

const mongoose = require("mongoose");

const studentAttendanceSchema = new mongoose.Schema(
  {
    courseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Course-Structure",
      required: [true, "courseId is required"],
      index: true,
    },
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "studentId is required"],
    },
    // The batch (course.batchAndParticipants subdoc _id) the mark was taken
    // under. Attendance is recorded per batch — b1's trainer marks b1's roster
    // — so the batch is part of the record's identity, not a display detail.
    // Null only on legacy rows written before batches reached attendance; the
    // backfill script (scripts/backfillAttendanceBatchIds.js) assigns those to
    // the batch each student was enrolled in.
    batchId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      index: true,
    },
    // Normalized to 00:00:00 UTC of the marking day so the compound unique
    // index below reliably de-dupes multiple marks for the same day.
    date: {
      type: Date,
      required: [true, "date is required"],
    },
    // P = Present, A = Absent, H = Half-day. Later: L (Late) if needed.
    status: {
      type: String,
      enum: ["P", "A", "H"],
      required: [true, "status is required"],
    },
    // Reserved for the future per-session flow. Null means "for the whole day".
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    markedBy: {
      type: String,
      default: "system",
    },
    // Required by the client whenever status is A or H. Empty string for P.
    reason: {
      type: String,
      default: "",
      trim: true,
    },
    // Only populated when status is 'H' — which half of the day the student
    // was out for. Empty for P / A.
    halfPeriod: {
      type: String,
      enum: ["first", "second", ""],
      default: "",
    },
  },
  {
    timestamps: true,
  }
);

// One record per student per day per batch per session (session null → per
// day). batchId joined the key when attendance became batch-scoped; the old
// (courseId, studentId, date, sessionId) unique index is dropped by the
// backfill script — left in place it would forbid the same student carrying
// marks in two batches on one day.
studentAttendanceSchema.index(
  { courseId: 1, batchId: 1, studentId: 1, date: 1, sessionId: 1 },
  { unique: true }
);

module.exports = mongoose.model("StudentAttendance", studentAttendanceSchema);
