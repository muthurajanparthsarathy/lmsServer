const express = require("express");
const {
  saveInstituteHolidayCalendar,
  getInstituteHolidayCalendarByInstitute,
  getAllInstituteHolidayCalendars,
  deleteInstituteHolidayCalendar,
  addInstituteHolidays,
  updateInstituteHoliday,
  deleteInstituteHoliday,
  deleteInstituteHolidaysByDate,
} = require("../controllers/instituteHolidayCalendar");
const { userAuth } = require("../middlewares/userAuth");

const router = express.Router();

// Create or update (upsert) an institute's holiday calendar.
//
// LEGACY WHOLE-ARRAY WRITE — it replaces `holidays` with exactly what it is
// sent, so the caller must hold the complete list. Prefer the per-holiday
// routes below; they mutate one entry and never touch the rest, which is what
// makes a scoped read safe.
router.post(
  "/institute-holiday-calendar/save",
  userAuth,
  saveInstituteHolidayCalendar
);

// ── Per-holiday writes ──
// The literal "holidays" segment comes FIRST so these can never be confused
// with /save, /getAll, /getByInstitute/:id or /delete/:id.

// Add or merge one holiday (`{ holiday }`) or many (`{ holidays: [...] }`),
// keyed by date. Never a replacement — untouched dates stay untouched.
router.post(
  "/institute-holiday-calendar/holidays/:instituteId",
  userAuth,
  addInstituteHolidays
);

// Update one holiday in place, by id (?date=YYYY-MM-DD legacy fallback)
router.patch(
  "/institute-holiday-calendar/holidays/:instituteId/:holidayId",
  userAuth,
  updateInstituteHoliday
);

// Delete one holiday, by id (?date=YYYY-MM-DD legacy fallback)
router.delete(
  "/institute-holiday-calendar/holidays/:instituteId/:holidayId",
  userAuth,
  deleteInstituteHoliday
);

// Delete every holiday on one date (?date=YYYY-MM-DD)
router.delete(
  "/institute-holiday-calendar/holidays/:instituteId",
  userAuth,
  deleteInstituteHolidaysByDate
);

// Fetch the saved holiday calendar for one institute.
// Optional ?from=YYYY-MM-DD&to=YYYY-MM-DD narrows `holidays` to that window and
// adds `holidayTotal`; with no query the response is unchanged.
router.get(
  "/institute-holiday-calendar/getByInstitute/:instituteId",
  userAuth,
  getInstituteHolidayCalendarByInstitute
);

// List all saved holiday calendars.
// Optional ?counts=1 swaps each record's `holidays[]` for a `holidayCount`.
router.get(
  "/institute-holiday-calendar/getAll",
  userAuth,
  getAllInstituteHolidayCalendars
);

// Delete an institute's holiday calendar
router.delete(
  "/institute-holiday-calendar/delete/:instituteId",
  userAuth,
  deleteInstituteHolidayCalendar
);

module.exports = router;
