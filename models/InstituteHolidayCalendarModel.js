const mongoose = require("mongoose");

// ── Sub-schema: a single holiday entry on an institute's calendar ──
const HolidaySchema = new mongoose.Schema(
  {
    holidayId: { type: String }, // client-side uid
    name: { type: String, default: "Holiday" },
    date: { type: String, default: "" }, // "YYYY-MM-DD" — stored as string to avoid TZ shifts
    type: {
      type: String,
      enum: ["public", "optional", "institute", "exam", "festival", "other"],
      default: "institute",
    },
    duration: {
      type: String,
      enum: ["full", "first-half", "second-half"],
      default: "full",
    },
    note: { type: String, default: "" },
  },
  { _id: false }
);

// ── Main schema: one holiday calendar per institute ──
// Each institute owns a single holiday calendar document holding all of its
// holidays. Lookups happen by `instituteId` (the Institution document _id).
const InstituteHolidayCalendarSchema = new mongoose.Schema(
  {
    instituteId: {
      type: String, // Institution _id (kept as string for flexible lookups)
      required: true,
      unique: true, // one calendar per institute
      index: true,
    },
    instituteName: { type: String, default: "" }, // snapshot for self-describing records
    instituteCode: { type: String, default: "" }, // inst_id snapshot (e.g. "INS001")
    year: { type: Number, default: 0 }, // optional: the academic/calendar year this set targets (0 = all)

    holidays: { type: [HolidaySchema], default: [] },

    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

// Backs the getAll listing's sort — one calendar per institute/client scope,
// so the collection stays small, but the index costs nothing to have ready.
InstituteHolidayCalendarSchema.index({ updatedAt: -1 });

module.exports = mongoose.model(
  "Institute-Holiday-Calendar",
  InstituteHolidayCalendarSchema
);
