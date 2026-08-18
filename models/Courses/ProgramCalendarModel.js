const mongoose = require("mongoose");

// ── Sub-schema: a single time slot in the daily template ──
// kind === 'session' is a teaching block; kind === 'break' is a recess.
const DaySlotSchema = new mongoose.Schema(
  {
    slotId: { type: String }, // client-side uid (kept so the UI can re-key cleanly)
    kind: {
      type: String,
      enum: ["session", "break"],
      default: "session",
    },
    name: { type: String, default: "" },
    startTime: { type: String, default: "" }, // "HH:mm" (24h)
    endTime: { type: String, default: "" }, // "HH:mm" (24h)
    trainer: { type: String, default: "" }, // optional, session only
    sessionType: { type: String, default: "" }, // optional, session only
  },
  { _id: false }
);

// ── Sub-schema: a single holiday / leave day ──
const HolidaySchema = new mongoose.Schema(
  {
    holidayId: { type: String }, // client-side uid
    name: { type: String, default: "Holiday" },
    date: { type: String, default: "" }, // "YYYY-MM-DD" — stored as string to avoid TZ shifts
    duration: {
      type: String,
      enum: ["full", "first-half", "second-half"],
      default: "full",
    },
  },
  { _id: false }
);

// ── Sub-schema: an actual-calendar deviation (cancelled session day) ──
const DeviationSchema = new mongoose.Schema(
  {
    deviationId: { type: String }, // client-side uid
    date: { type: String, default: "" }, // "YYYY-MM-DD" — the cancelled day
    reason: { type: String, default: "" },
    // Which batches the cancellation hits — batchAndParticipants subdoc ids.
    // EMPTY means all batches: that is both the pre-batch legacy meaning and
    // the explicit "applies to everyone" answer, so old records need no
    // migration. A non-empty list is what lets one batch's end date drift
    // (b2 loses a day, b2 alone ends later) while the others hold.
    appliesTo: { type: [String], default: [] },
  },
  { _id: false }
);

// ── Sub-schema: a scheduled assessment day block ──
const AssessmentDaySchema = new mongoose.Schema(
  {
    asmtId: { type: String },         // client-side uid
    name: { type: String, default: "Assessment" },
    date: { type: String, default: "" },  // "YYYY-MM-DD" — start date of the block
    days: { type: Number, default: 1 },   // how many consecutive calendar days it occupies
  },
  { _id: false }
);

// ── Main schema: one program calendar per course ──
// Stores ONLY the calendar configuration (start/end, sessions, holidays) plus a
// lightweight snapshot of course identity. Modules/topics/subtopics are NOT stored
// here — they are loaded dynamically from their own collections.
const ProgramCalendarSchema = new mongoose.Schema(
  {
    // ── Course identity ──
    courseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Course-Structure",
      required: true,
      unique: true, // one calendar per course
      index: true,
    },
    courseName: { type: String, default: "" },
    courseCode: { type: String, default: "" },
    // Lightweight course meta snapshot (not the hierarchy)
    courseDetails: {
      category: { type: String, default: "" },
      courseLevel: { type: String, default: "" },
      courseDuration: { type: String, default: "" },
      serviceType: { type: String, default: "" },
      serviceModal: { type: String, default: "" },
      clientName: { type: String, default: "" },
    },

    // ── Schedule configuration ──
    startDate: { type: String, default: "" }, // "YYYY-MM-DD"
    endDate: { type: String, default: "" }, // estimated end date, "YYYY-MM-DD"
    workingDays: {
      type: [Number], // 0=Sun … 6=Sat (Sunday excluded by default → [1,2,3,4,5,6])
      default: [1, 2, 3, 4, 5, 6],
    },
    dailyHours: { type: Number, default: 0 }, // teaching hours per day
    totalHours: { type: Number, default: 0 }, // total content hours (incl. assessment)
    estimatedDays: { type: Number, default: 0 },

    // ── The daily session template (sessions + breaks) ──
    sessions: { type: [DaySlotSchema], default: [] },

    // ── Holidays / leaves ──
    holidays: { type: [HolidaySchema], default: [] },

    // ── Actual-calendar deviations (cancelled days + reason) ──
    deviations: { type: [DeviationSchema], default: [] },

    // ── Scheduled assessment day blocks ──
    assessmentDays: { type: [AssessmentDaySchema], default: [] },

    // ── Status & metadata ──
    status: {
      type: String,
      enum: ["draft", "published"],
      default: "draft",
    },
    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Program-Calendar", ProgramCalendarSchema);
