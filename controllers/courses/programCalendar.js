const ProgramCalendar = require("../../models/Courses/ProgramCalendarModel");
const CourseStructure = require("../../models/Courses/courseStructureModal");
const mongoose = require("mongoose");

// Normalize the sessions array coming from the client (it uses `id` for the uid).
const normalizeSessions = (sessions = []) =>
  (Array.isArray(sessions) ? sessions : []).map((s) => ({
    slotId: s.slotId || s.id || "",
    kind: s.kind === "break" ? "break" : "session",
    name: s.name || "",
    startTime: s.startTime || "",
    endTime: s.endTime || "",
    trainer: s.trainer || "",
    sessionType: s.sessionType || "",
  }));

// Normalize the holidays array coming from the client (it uses `id` for the uid).
const normalizeHolidays = (holidays = []) =>
  (Array.isArray(holidays) ? holidays : []).map((h) => ({
    holidayId: h.holidayId || h.id || "",
    name: h.name || "Holiday",
    date: h.date || "",
    duration: ["full", "first-half", "second-half"].includes(h.duration)
      ? h.duration
      : "full",
  }));

// Normalize the deviations array coming from the client.
const normalizeDeviations = (deviations = []) =>
  (Array.isArray(deviations) ? deviations : []).map((dv) => ({
    deviationId: dv.deviationId || dv.id || "",
    date: dv.date || "",
    reason: dv.reason || "",
    // Batch scope — empty means all batches (legacy rows and the explicit
    // "everyone" answer alike). Without this line the whitelist silently
    // dropped the scope and every deviation regressed to course-wide.
    appliesTo: Array.isArray(dv.appliesTo)
      ? dv.appliesTo.map(String).filter(Boolean)
      : [],
  }));

/**
 * Create or update the program calendar for a course (upsert by courseId).
 * One calendar per course — saving again overwrites the previous configuration.
 */
exports.saveProgramCalendar = async (req, res) => {
  try {
    const {
      courseId,
      startDate,
      sessions,
      deviations,
      status,
    } = req.body;

    if (!courseId || !mongoose.Types.ObjectId.isValid(courseId)) {
      return res.status(400).json({
        success: false,
        message: "A valid courseId is required",
      });
    }

    // Pull a fresh snapshot of the course identity so the calendar is
    // self-describing even if the course list isn't loaded.
    const course = await CourseStructure.findById(courseId).lean();
    if (!course) {
      return res.status(404).json({
        success: false,
        message: "Course not found",
      });
    }

    const who = req.user?.email || req.user?.name || req.body.createdBy || "";

    const update = {
      courseId,
      courseName: course.courseName || "",
      courseCode: course.courseCode || "",
      courseDetails: {
        category: course.category || "",
        courseLevel: course.courseLevel || "",
        courseDuration: course.courseDuration || "",
        serviceType: course.serviceType || "",
        serviceModal: course.serviceModal || "",
        clientName: String(course.clientName || ""),
      },
      // ONLY the inputs are stored: the start date a human chose, the session
      // template they built, and the deviations that actually happened. End
      // date, day counts, hour totals and holidays are all DERIVED — the page
      // recomputes them from these inputs (plus pedagogy hours and the holiday
      // module) on every load, so a stored copy could only go stale. The
      // derived fields are written as empty here to flush values persisted by
      // older saves — otherwise they would sit in the record as stale lies.
      startDate: startDate || "",
      endDate: "",
      dailyHours: 0,
      totalHours: 0,
      estimatedDays: 0,
      holidays: [],
      sessions: normalizeSessions(sessions),
      deviations: normalizeDeviations(deviations),
      status: status === "published" ? "published" : "draft",
      updatedBy: who,
      updatedAt: new Date(),
    };

    const existing = await ProgramCalendar.findOne({ courseId });

    let calendar;
    if (existing) {
      calendar = await ProgramCalendar.findOneAndUpdate(
        { courseId },
        { $set: update },
        { new: true }
      );
    } else {
      calendar = await ProgramCalendar.create({ ...update, createdBy: who });
    }

    return res.status(existing ? 200 : 201).json({
      success: true,
      message: existing
        ? "Program calendar updated successfully"
        : "Program calendar created successfully",
      data: calendar,
    });
  } catch (error) {
    console.error("Error saving program calendar:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};

/**
 * Get the program calendar for a single course.
 */
exports.getProgramCalendarByCourse = async (req, res) => {
  try {
    const { courseId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(courseId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid courseId" });
    }

    const calendar = await ProgramCalendar.findOne({ courseId }).lean();

    // Not an error — the course simply has no saved calendar yet.
    if (!calendar) {
      return res.status(200).json({
        success: true,
        message: "No program calendar saved for this course yet",
        data: null,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Program calendar fetched successfully",
      data: calendar,
    });
  } catch (error) {
    console.error("Error fetching program calendar:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};

/**
 * Get all saved program calendars (list view — excludes the heavy arrays).
 */
exports.getAllProgramCalendars = async (req, res) => {
  try {
    const calendars = await ProgramCalendar.find()
      .select("-sessions -holidays")
      .sort({ updatedAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      message: "Program calendars fetched successfully",
      data: calendars,
    });
  } catch (error) {
    console.error("Error fetching program calendars:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};

/**
 * Delete the program calendar for a course.
 */
exports.deleteProgramCalendar = async (req, res) => {
  try {
    const { courseId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(courseId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid courseId" });
    }

    const deleted = await ProgramCalendar.findOneAndDelete({ courseId });

    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: "Program calendar not found for this course",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Program calendar deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting program calendar:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};
