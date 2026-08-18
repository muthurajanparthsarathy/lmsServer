const express = require("express");
const {
  saveProgramCalendar,
  getProgramCalendarByCourse,
  getAllProgramCalendars,
  deleteProgramCalendar,
} = require("../../controllers/courses/programCalendar");
const { userAuth } = require("../../middlewares/userAuth");

const router = express.Router();

// Create or update (upsert) the program calendar for a course
router.post("/program-calendar/save", userAuth, saveProgramCalendar);

// Fetch the saved calendar for one course
router.get(
  "/program-calendar/getByCourse/:courseId",
  userAuth,
  getProgramCalendarByCourse
);

// List all saved calendars
router.get("/program-calendar/getAll", userAuth, getAllProgramCalendars);

// Delete a course's calendar
router.delete(
  "/program-calendar/delete/:courseId",
  userAuth,
  deleteProgramCalendar
);

module.exports = router;
