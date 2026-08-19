// server/controllers/courses/attendance.js
//
// Endpoints:
//   GET    /get/attendance/:courseId?from=YYYY-MM-DD&to=YYYY-MM-DD
//   POST   /save/attendance/:courseId   body: { records: [{studentId, date, status}] }
//   DELETE /reset/attendance/:courseId?from=&to=
//
// All dates are normalized to 00:00:00 UTC of the day so the compound unique
// index on (courseId, studentId, date, sessionId) works cleanly.

const mongoose = require("mongoose");
const StudentAttendance = require("../../models/Courses/StudentAttendanceModel");
const CourseStructure = require("../../models/Courses/courseStructureModal");
const User = require("../../models/UserModel");
const Role = require("../../models/RoleModel");
const { scopeHasCourse } = require("../../utils/pocScope");

// Normalize any incoming date value (string or Date) to midnight UTC.
const dayUtc = (value) => {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

const okId = (v) => mongoose.Types.ObjectId.isValid(v);

// The course's stored schedule instants are the browser's LOCAL midnights, so
// their UTC calendar day can sit one day early (00:00 IST = 18:30Z the day
// before). Half a day of slack recovers the intended day for any timezone
// east of UTC — where this system runs — without a timezone table.
const scheduleDay = (value) => {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return dayUtc(new Date(d.getTime() + 12 * 60 * 60 * 1000));
};

// Admin (originalRole "Admin", displayed as Super Administrator) sees and
// marks everything; every other role is scoped to the batches they are
// enrolled in as staff. req.user is the full User doc — its role is a Role
// reference on newer users but a plain role-name STRING on legacy ones, so
// both shapes resolve here.
const isAdminUser = async (user) => {
  try {
    const role = user?.role;
    if (!role) return false;
    if (typeof role === "object" && role.originalRole) {
      return String(role.originalRole).toLowerCase() === "admin";
    }
    const raw = String(role);
    if (!mongoose.Types.ObjectId.isValid(raw)) {
      return raw.trim().toLowerCase() === "admin";
    }
    const roleDoc = await Role.findById(raw).select("originalRole renameRole").lean();
    return (
      String(roleDoc?.originalRole || roleDoc?.renameRole || "").toLowerCase() === "admin"
    );
  } catch {
    return false;
  }
};

// Institution-wide VIEWER tier (read-only): L&D Head / Sub Head see attendance
// for every course in the overview, like an admin, but do NOT gain marking or
// reset rights — those stay gated on isAdminUser. Matched by roleValue
// ("ldhead" / "subhead") so it is precise and additive.
//
// POC used to be in this tier, on the reasoning that it was "an
// institution-level contact role — never client-bound, never enrolled in
// batches". That is no longer true: a POC is enrolled into courses exactly as
// a trainer is, and is scoped to those courses and their clients. It is
// deliberately NOT institution-wide here — its attendance reach comes from
// `req.pocScope.courseIds` instead. L&D Head and Sub Head are unchanged.
const isManagerViewer = async (user) => {
  try {
    const role = user?.role;
    if (!role) return false;
    let rv = "";
    if (typeof role === "object") {
      rv = String(role.roleValue || "").toLowerCase();
      if (!rv && role._id) {
        const d = await Role.findById(role._id).select("roleValue").lean();
        rv = String(d?.roleValue || "").toLowerCase();
      }
    } else {
      const raw = String(role);
      if (mongoose.Types.ObjectId.isValid(raw)) {
        const d = await Role.findById(raw).select("roleValue").lean();
        rv = String(d?.roleValue || "").toLowerCase();
      } else {
        rv = raw.toLowerCase();
      }
    }
    return rv === "ldhead" || rv === "subhead";
  } catch {
    return false;
  }
};

// Whether a user id appears in a batch's users — enrolment there (as staff)
// is what grants a non-admin the right to mark that batch.
const memberOfBatch = (batch, userId) =>
  (batch?.users || []).some(
    (u) => String(u?.user?._id || u?.user || "") === String(userId)
  );

// Students sit in batches too — that is their enrolment, not a marking
// right. Destructive operations (reset) must tell the two memberships
// apart; same role-shape resolution as isAdminUser.
const isStudentUser = async (user) => {
  try {
    const role = user?.role;
    if (!role) return false;
    if (typeof role === "object" && role.originalRole) {
      return String(role.originalRole).toLowerCase() === "student";
    }
    const raw = String(role);
    if (!mongoose.Types.ObjectId.isValid(raw)) {
      return raw.trim().toLowerCase() === "student";
    }
    const roleDoc = await Role.findById(raw).select("originalRole renameRole").lean();
    return (
      String(roleDoc?.originalRole || roleDoc?.renameRole || "").toLowerCase() === "student"
    );
  } catch {
    return false;
  }
};

// ── Training window ─────────────────────────────────────────────────────────
// Attendance records a training session that HAPPENED, so marking is bounded
// by the training window: the Program Calendar's start date through each
// batch's deviation-adjusted end. Nothing here is stored — the window is
// resolved from the calendar's inputs (start + session template + deviations),
// the pedagogy hours and the holiday module, the same derivation the calendar
// page performs, so the two can never disagree.
const ProgramCalendar = require("../../models/Courses/ProgramCalendarModel");
const PedagogyView = require("../../models/Courses/moduleStructure/pedagogyViewModal");
const InstituteHolidayCalendar = require("../../models/InstituteHolidayCalendarModel");

const parseTimeMins = (t) => {
  const [h, m] = String(t || "").split(":").map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
};
const isoDay = (d) => d.toISOString().slice(0, 10);

// Pure window computation from preloaded pieces — shared by the per-course
// resolver below and the overview's bulk pass, so both derive identically.
const computeWindow = (calendar, totalHours, holidayDuration) => {
  if (!calendar || !calendar.startDate) return { exists: false };

  // Daily capacity from the stored session template (sessions only, breaks
  // don't teach).
  const sessionMins = (calendar.sessions || [])
    .filter((s) => s && s.kind === "session")
    .reduce(
      (sum, s) =>
        sum + Math.max(0, parseTimeMins(s.endTime) - parseTimeMins(s.startTime)),
      0
    );
  const dailyHours = sessionMins / 60;
  const estimatedDays =
    dailyHours > 0 && totalHours > 0 ? Math.ceil(totalHours / dailyHours) : 0;

  // Same working-day rule the calendar page uses: Mon–Sat, full holidays skip.
  const WORKING = new Set([1, 2, 3, 4, 5, 6]);
  const isWorking = (d) =>
    WORKING.has(d.getUTCDay()) && holidayDuration.get(isoDay(d)) !== "full";

  // The date on which the Nth working day lands, counting the start as day 1.
  const endAfter = (days) => {
    if (days <= 0) return null;
    const d = new Date(calendar.startDate + "T00:00:00Z");
    if (Number.isNaN(d.getTime())) return null;
    let counted = 0;
    let guard = 0;
    while (guard++ < 5000) {
      if (isWorking(d)) {
        counted++;
        if (counted >= days) return isoDay(d);
      }
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return null;
  };

  // Each cancelled day consumes a working day without teaching, so a batch's
  // end extends by one working day per deviation that applies to it. Empty
  // appliesTo = all batches.
  const deviations = calendar.deviations || [];
  const devCountFor = (batchId) =>
    deviations.filter(
      (dv) =>
        !(dv.appliesTo && dv.appliesTo.length) ||
        (batchId && dv.appliesTo.includes(String(batchId)))
    ).length;

  return {
    exists: true,
    startDate: calendar.startDate,
    endFor: (batchId) =>
      estimatedDays > 0
        ? endAfter(estimatedDays + devCountFor(batchId ? String(batchId) : null))
        : null,
  };
};

// Merge holiday docs into a date → duration map. Client entries override the
// institute's on the same date, so the (longer-keyed) client doc applies last.
const holidayMapOf = (holidayDocs) => {
  const sorted = [...holidayDocs].sort(
    (a, b) => String(a.instituteId).length - String(b.instituteId).length
  );
  const holidayDuration = new Map();
  for (const doc of sorted) {
    for (const h of doc.holidays || []) {
      if (h && h.date) holidayDuration.set(h.date, h.duration || "full");
    }
  }
  return holidayDuration;
};

const pedagogyDurationsOf = (field) => ({
  $sum: {
    $map: {
      input: { $ifNull: [field, []] },
      as: "a",
      in: { $ifNull: ["$$a.duration", 0] },
    },
  },
});

// Resolve one course's training window. Returns { exists:false } when no
// calendar (or no start date) is saved — the caller decides what that means.
// endFor(batchId) is null when hours/sessions aren't set yet (no computable
// end → only the start bound applies).
const resolveTrainingWindow = async (courseId, course) => {
  const calendar = await ProgramCalendar.findOne({ courseId }).lean();
  if (!calendar || !calendar.startDate) return { exists: false };

  const hourAgg = await PedagogyView.aggregate([
    { $match: { courses: course._id } },
    { $unwind: "$pedagogies" },
    {
      $project: {
        t: {
          $add: [
            pedagogyDurationsOf("$pedagogies.iDo"),
            pedagogyDurationsOf("$pedagogies.weDo"),
            pedagogyDurationsOf("$pedagogies.youDo"),
          ],
        },
      },
    },
    { $group: { _id: null, total: { $sum: "$t" } } },
  ]);
  const totalHours = (hourAgg[0] && hourAgg[0].total) || 0;

  const instituteId = String(course.institution || "");
  const scopeIds = [instituteId];
  if (course.clientId) scopeIds.push(`${instituteId}__client__${course.clientId}`);
  const holidayDocs = instituteId
    ? await InstituteHolidayCalendar.find({ instituteId: { $in: scopeIds } }).lean()
    : [];

  return computeWindow(calendar, totalHours, holidayMapOf(holidayDocs));
};

// ── GET ─────────────────────────────────────────────────────────────────────
exports.getAttendance = async (req, res) => {
  try {
    const { courseId } = req.params;
    const { from, to, batchId, studentId } = req.query;

    if (!okId(courseId)) {
      return res
        .status(400)
        .json({ message: [{ key: "error", value: "Invalid courseId" }] });
    }

    // `courseId` is caller-supplied and this route has never checked that the
    // caller may read the course at all. For a POC it now does: attendance
    // carries no clientId, so the course set is the only thing that can bound
    // it. `batchId`/`studentId` below only narrow an already-scoped set.
    if (!scopeHasCourse(req.pocScope, courseId)) {
      return res
        .status(403)
        .json({ message: [{ key: "error", value: "Not authorized for this course" }] });
    }

    const filter = { courseId };
    // Optional batch scope. Omitted → the whole course (Report/Analytics
    // aggregate across batches and depend on that).
    if (batchId && okId(batchId)) filter.batchId = batchId;
    // Optional single-student scope. The student dashboard asks for its own
    // rows: it used to request the whole course for a 180-day window and drop
    // every classmate's records client-side (150 records across 10 students,
    // to keep ~15). Additive — omitting it returns the course-wide set the
    // marking grid and the reports rely on.
    //
    // NOTE this narrows the RESPONSE, not the permission: this route is
    // `userAuth` only and still has no check that the caller may read the
    // course's attendance at all. That gap is flagged separately.
    if (studentId && okId(studentId)) filter.studentId = studentId;
    // Several students at once — the Report grid renders cells for the page of
    // students on screen, so it asks for those rows and no others. Comma
    // separated; ignored when absent, so every existing caller is untouched.
    const idList = String(req.query.studentIds || "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s && okId(s));
    if (idList.length && !filter.studentId) {
      filter.studentId = { $in: idList.map((s) => new mongoose.Types.ObjectId(s)) };
    }
    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = dayUtc(from);
      if (to) filter.date.$lte = dayUtc(to);
    }

    // The Report grid paints one letter per cell and reads nothing else, so it
    // asks for the three fields it uses. The marking grid still needs `reason`
    // and the rest, so this is opt-in and the default response is unchanged.
    const slim = req.query.slim === "1" || req.query.slim === "true";

    const records = await StudentAttendance.find(filter)
      .select(slim ? "studentId date status" : undefined)
      .sort({ date: 1, studentId: 1 })
      .lean();

    return res.status(200).json({
      message: [{ key: "success", value: "Attendance retrieved" }],
      data: records,
    });
  } catch (err) {
    console.error("getAttendance error:", err);
    return res
      .status(500)
      .json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};

// ── BULK SAVE (upsert) ─────────────────────────────────────────────────────
exports.bulkSaveAttendance = async (req, res) => {
  try {
    const { courseId } = req.params;
    const { records, batchId } = req.body || {};

    if (!okId(courseId)) {
      return res
        .status(400)
        .json({ message: [{ key: "error", value: "Invalid courseId" }] });
    }
    if (!Array.isArray(records)) {
      return res
        .status(400)
        .json({ message: [{ key: "error", value: "records must be an array" }] });
    }
    if (batchId && !okId(batchId)) {
      return res
        .status(400)
        .json({ message: [{ key: "error", value: "Invalid batchId" }] });
    }

    const course = await CourseStructure.findById(courseId)
      .select("batchAndParticipants institution clientId")
      .lean();
    if (!course) {
      return res
        .status(404)
        .json({ message: [{ key: "error", value: "Course not found" }] });
    }

    const batch = batchId
      ? (course.batchAndParticipants || []).find(
          (b) => String(b._id) === String(batchId)
        )
      : null;
    if (batchId && !batch) {
      return res
        .status(400)
        .json({ message: [{ key: "error", value: "Batch not found on this course" }] });
    }

    // Non-admins mark only batches they are enrolled in. With a batchId that
    // means THAT batch; without one (legacy callers) membership in any batch
    // of the course is enough.
    const admin = await isAdminUser(req.user);
    if (!admin) {
      const uid = req.user?._id;
      const allowed = batch
        ? memberOfBatch(batch, uid)
        : (course.batchAndParticipants || []).some((b) => memberOfBatch(b, uid));
      if (!allowed) {
        return res.status(403).json({
          message: [{ key: "error", value: "You are not assigned to this batch" }],
        });
      }
    }

    // Training-window gate — attendance records a session that HAPPENED, so a
    // mark must land inside the batch's training window: the Program
    // Calendar's start through that batch's deviation-adjusted end. No
    // calendar means no schedule to attend. The client locks all of this in
    // the UI; this is the backstop that makes it a rule, not a suggestion.
    const window = await resolveTrainingWindow(courseId, course);
    if (!window.exists) {
      return res.status(400).json({
        message: [{
          key: "error",
          value: "Set the Program Calendar first — attendance needs a training schedule",
        }],
      });
    }
    const batchEnd = window.endFor(batchId || null);
    const todayMax = scheduleDay(new Date());
    // Once the batch's training window has CLOSED, marking closes with it —
    // "ended" must mean the same thing here as on the listing. Admins stay
    // exempt so historical corrections remain possible.
    if (!admin && batchEnd && isoDay(todayMax) > batchEnd) {
      return res.status(400).json({
        message: [{ key: "error", value: `Training ended ${batchEnd} — marking is closed` }],
      });
    }
    for (const r of records || []) {
      const day = dayUtc(r?.date);
      if (!day) continue;
      const dayIso = day.toISOString().slice(0, 10);
      if (dayIso < window.startDate) {
        return res.status(400).json({
          message: [{ key: "error", value: `Training starts ${window.startDate}` }],
        });
      }
      if (batchEnd && dayIso > batchEnd) {
        return res.status(400).json({
          message: [{ key: "error", value: `Training ended ${batchEnd}` }],
        });
      }
      if (day > todayMax) {
        return res.status(400).json({
          message: [{ key: "error", value: "Cannot mark attendance for a future date" }],
        });
      }
    }

    const markedBy = req?.user?.email || req?.user?.id || "system";

    // Partition: rows with a real status → upsert; rows with empty/null status
    // → delete (so clicking a cell twice can clear the mark).
    const upserts = [];
    const deletes = [];

    for (const r of records) {
      if (!r || !okId(r.studentId)) continue;
      const day = dayUtc(r.date);
      if (!day) continue;

      const status = (r.status || "").toUpperCase();
      // batchId is part of the record's identity — the same student can carry
      // marks under two batches of one course on the same day.
      const filter = {
        courseId,
        batchId: batchId || null,
        studentId: r.studentId,
        date: day,
        sessionId: r.sessionId || null,
      };

      if (["P", "A", "H"].includes(status)) {
        // P has no reason; A/H carry a free-text reason (client-enforced).
        const reason =
          status === "P"
            ? ""
            : typeof r.reason === "string"
            ? r.reason.trim()
            : "";
        // halfPeriod is only meaningful for H — cleared otherwise so an old
        // H record edited to P/A doesn't leak the field.
        const halfPeriod =
          status === "H" && (r.halfPeriod === "first" || r.halfPeriod === "second")
            ? r.halfPeriod
            : "";
        upserts.push({
          updateOne: {
            filter,
            update: {
              $set: {
                status,
                markedBy,
                reason,
                halfPeriod,
              },
              $setOnInsert: {
                courseId,
                batchId: batchId || null,
                studentId: r.studentId,
                date: day,
                sessionId: r.sessionId || null,
              },
            },
            upsert: true,
          },
        });
      } else {
        // Empty / cleared → remove the record.
        deletes.push({ deleteOne: { filter } });
      }
    }

    const ops = [...upserts, ...deletes];
    if (ops.length === 0) {
      return res.status(200).json({
        message: [{ key: "success", value: "No changes to save" }],
        upserted: 0,
        deleted: 0,
      });
    }

    const result = await StudentAttendance.bulkWrite(ops, { ordered: false });

    return res.status(200).json({
      message: [{ key: "success", value: "Attendance saved" }],
      upserted:
        (result.upsertedCount || 0) + (result.modifiedCount || 0),
      deleted: result.deletedCount || 0,
    });
  } catch (err) {
    console.error("bulkSaveAttendance error:", err);
    return res
      .status(500)
      .json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};

// ── RESET ──────────────────────────────────────────────────────────────────
exports.resetAttendance = async (req, res) => {
  try {
    const { courseId } = req.params;
    const { from, to, batchId } = req.query;

    if (!okId(courseId)) {
      return res
        .status(400)
        .json({ message: [{ key: "error", value: "Invalid courseId" }] });
    }

    // Reset destroys records, so it is gated at least as hard as save:
    // admins may clear anything; staff only batches they belong to (a
    // request without a batchId is scoped to their member batches, not the
    // whole course — the Reset-day button sends no batchId); students never,
    // enrolment notwithstanding.
    const course = await CourseStructure.findById(courseId)
      .select("batchAndParticipants")
      .lean();
    if (!course) {
      return res
        .status(404)
        .json({ message: [{ key: "error", value: "Course not found" }] });
    }

    const filter = { courseId };
    const admin = await isAdminUser(req.user);
    if (!admin) {
      if (await isStudentUser(req.user)) {
        return res.status(403).json({
          message: [{ key: "error", value: "You are not allowed to reset attendance" }],
        });
      }
      const uid = req.user?._id;
      const mine = (course.batchAndParticipants || []).filter((b) =>
        memberOfBatch(b, uid)
      );
      if (mine.length === 0) {
        return res.status(403).json({
          message: [{ key: "error", value: "You are not assigned to this course" }],
        });
      }
      if (batchId && okId(batchId)) {
        if (!mine.some((b) => String(b._id) === String(batchId))) {
          return res.status(403).json({
            message: [{ key: "error", value: "You are not assigned to this batch" }],
          });
        }
        filter.batchId = batchId;
      } else {
        filter.batchId = { $in: mine.map((b) => b._id) };
      }
    } else if (batchId && okId(batchId)) {
      filter.batchId = batchId;
    }
    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = dayUtc(from);
      if (to) filter.date.$lte = dayUtc(to);
    }

    const result = await StudentAttendance.deleteMany(filter);

    return res.status(200).json({
      message: [{ key: "success", value: "Attendance reset" }],
      deleted: result.deletedCount || 0,
    });
  } catch (err) {
    console.error("resetAttendance error:", err);
    return res
      .status(500)
      .json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};

// ── WINDOW — the batch's training window, resolved for the marking UI ──────
// GET /attendance/window/:courseId?batchId=… → { exists, startDate, endDate }.
// The SAME resolver bulkSaveAttendance enforces with, exposed so the client
// can lock honestly instead of discovering the rule on save.
exports.getAttendanceWindow = async (req, res) => {
  try {
    const { courseId } = req.params;
    const { batchId } = req.query;
    if (!okId(courseId)) {
      return res
        .status(400)
        .json({ message: [{ key: "error", value: "Invalid courseId" }] });
    }
    if (!scopeHasCourse(req.pocScope, courseId)) {
      return res
        .status(403)
        .json({ message: [{ key: "error", value: "Not authorized for this course" }] });
    }
    const course = await CourseStructure.findById(courseId)
      .select("institution clientId")
      .lean();
    if (!course) {
      return res
        .status(404)
        .json({ message: [{ key: "error", value: "Course not found" }] });
    }
    const window = await resolveTrainingWindow(courseId, course);
    if (!window.exists) {
      return res.status(200).json({
        message: [{ key: "success", value: "No training schedule" }],
        data: { exists: false },
      });
    }
    return res.status(200).json({
      message: [{ key: "success", value: "Training window" }],
      data: {
        exists: true,
        startDate: window.startDate,
        endDate: window.endFor(batchId && okId(batchId) ? batchId : null),
      },
    });
  } catch (err) {
    console.error("getAttendanceWindow error:", err);
    return res
      .status(500)
      .json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};

// ── SUMMARY — the Report and Analytics aggregates, without the records ─────
//
// Both pages fetched every attendance record for the range and then built a
// student×day grid in the browser to derive their totals, bands, at-risk
// count, trend and best day. Records grow as students × marked days — 150 rows
// today for the busiest course, but a 100-student cohort over 200 working days
// is 20,000 — so the aggregates are computed here instead and the browser
// keeps one small summary row per student.
//
// The one structural fact that makes this exact rather than approximate: a day
// that carries ANY mark is always a working day (weekdays always count;
// weekends count precisely when marked). So a student's P/A/H counts over the
// date range ARE their counts over the working days, and the unmarked count is
// `workingDays - (p + a + h)`. No cell-by-cell grid is needed to get there.
//
// The page's own definitions are preserved exactly:
//   · working days = weekdays in range + any weekend day carrying a mark
//   · attendance %  = (present + ½ × half-days) ÷ working days × 100
//   · the status filter keeps a student who has at least one matching cell,
//     where "N" means at least one working day with no mark at all
//
// Every date here is midnight UTC, which is how the records are stored and how
// the page's own toDayKey/isWeekend read them — so there is no timezone seam.
exports.getAttendanceSummary = async (req, res) => {
  try {
    const { courseId } = req.params;
    const { from, to, batchId, student, status } = req.query;

    if (!okId(courseId)) {
      return res
        .status(400)
        .json({ message: [{ key: "error", value: "Invalid courseId" }] });
    }

    if (!scopeHasCourse(req.pocScope, courseId)) {
      return res
        .status(403)
        .json({ message: [{ key: "error", value: "Not authorized for this course" }] });
    }

    // WHICH SESSIONS HAPPENED — course, batch and date range. Deliberately not
    // narrowed by student: see the two-match note below.
    const dayMatch = { courseId: new mongoose.Types.ObjectId(courseId) };
    if (batchId && okId(batchId)) dayMatch.batchId = new mongoose.Types.ObjectId(batchId);

    // WHOSE MARKS TO COUNT. A single `student` wins, exactly as on
    // /attendance/get; absent both, nothing is narrowed and callers that send
    // neither are untouched.
    //
    // The pages need the SET form because their charts count STUDENTS, not
    // records: a day's "Not Marked" figure is (students on the roster) minus
    // (students marked that day). A course can carry records for people who
    // are no longer in any of its batches — SUN-BTB-SK-001 has five such
    // holders against a five-student roster, 75 of its 150 records — so
    // course-wide day counts against a roster-sized denominator drive the
    // Analytics bar negative and push the Report page's "Best Day" over 100%.
    // Scoping to the roster keeps both sides of those sums talking about one
    // population.
    let studentMatch = null;
    if (student && student !== "all" && okId(student)) {
      studentMatch = new mongoose.Types.ObjectId(student);
    }
    const idList = String(req.query.studentIds || "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s && okId(s));
    if (idList.length && !studentMatch) {
      studentMatch = { $in: idList.map((s) => new mongoose.Types.ObjectId(s)) };
    }

    const fromDay = dayUtc(from);
    const toDay = dayUtc(to);
    if (fromDay || toDay) {
      dayMatch.date = {};
      if (fromDay) dayMatch.date.$gte = fromDay;
      if (toDay) dayMatch.date.$lte = toDay;
    }
    const match = studentMatch ? { ...dayMatch, studentId: studentMatch } : dayMatch;

    const dayKey = { $dateToString: { date: "$date", format: "%Y-%m-%d", timezone: "UTC" } };

    // Two matches, not one. `markedDays` answers "did a session happen on this
    // date" — a property of the CLASS — and it is what turns a Saturday into a
    // working day for the Report page's denominator. Deriving it from the
    // student-scoped rows makes that denominator move with the filter: pick one
    // student and a Saturday nobody marked THEM on stops being a working day,
    // so the same student reads a higher percentage under the filter than in
    // the full table; send a roster and a session attended only by since-removed
    // students disappears from the range. Both are wrong for the same reason,
    // and the fix is to let the day list see every row in the window while the
    // tallies and the per-day series stay scoped.
    //
    // Verified against the pre-server-aggregation page by
    // scripts/verifyAttendanceReport.js (--break=days_scoped restores the
    // narrowing and the run goes red).
    const scopeStage = studentMatch ? [{ $match: { studentId: studentMatch } }] : [];
    const [agg] = await StudentAttendance.aggregate([
      { $match: dayMatch },
      {
        $facet: {
          markedDays: [{ $group: { _id: dayKey } }, { $sort: { _id: 1 } }],
          perStudent: [
            ...scopeStage,
            {
              $group: {
                _id: "$studentId",
                p: { $sum: { $cond: [{ $eq: ["$status", "P"] }, 1, 0] } },
                a: { $sum: { $cond: [{ $eq: ["$status", "A"] }, 1, 0] } },
                h: { $sum: { $cond: [{ $eq: ["$status", "H"] }, 1, 0] } },
              },
            },
          ],
          total: [...scopeStage, { $count: "n" }],
        },
      },
    ]);

    const markedDays = (agg?.markedDays || []).map((d) => d._id);
    const markedSet = new Set(markedDays);

    // Working days across the requested range — the page's rule, server-side.
    const workingDayKeys = [];
    if (fromDay && toDay) {
      for (let t = fromDay.getTime(); t <= toDay.getTime(); t += 24 * 60 * 60 * 1000) {
        const d = new Date(t);
        const k = d.toISOString().slice(0, 10);
        const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
        if (!weekend || markedSet.has(k)) workingDayKeys.push(k);
      }
    }
    const workingDays = workingDayKeys.length;

    // The status filter, as a predicate over the tallies. A student passes on
    // "N" when some working day carries no mark at all — which includes every
    // roster student holding no records, so the page still adds those itself.
    const passes = (s) => {
      if (!status || status === "all") return true;
      if (status === "P") return s.p > 0;
      if (status === "A") return s.a > 0;
      if (status === "H") return s.h > 0;
      if (status === "N") return s.p + s.a + s.h < workingDays;
      return true;
    };

    // Every student holding records, WITHOUT the status filter applied.
    //
    // Filtering here looked right and was not: a roster student missing from
    // this list would be ambiguous — either they hold no records at all (and
    // on "N" they should pass, every working day being unmarked) or the server
    // dropped them. The page cannot tell those apart, so it would re-admit the
    // dropped ones. The tallies come back whole and the page applies its own
    // predicate to them, which is also the only copy of that rule.
    const students = (agg?.perStudent || [])
      .map((s) => ({ studentId: String(s._id), p: s.p, a: s.a, h: s.h }));

    // The trend and best-day series, over exactly the students that survived
    // the filter. Students with no records at all contribute nothing to any
    // day's counts, so leaving them out here changes none of these numbers —
    // only the denominators the page applies from its own roster.
    const keepIds = students.filter(passes).map((s) => new mongoose.Types.ObjectId(s.studentId));
    const perDayRows = keepIds.length
      ? await StudentAttendance.aggregate([
          { $match: { ...match, studentId: { $in: keepIds } } },
          {
            $group: {
              _id: dayKey,
              P: { $sum: { $cond: [{ $eq: ["$status", "P"] }, 1, 0] } },
              A: { $sum: { $cond: [{ $eq: ["$status", "A"] }, 1, 0] } },
              H: { $sum: { $cond: [{ $eq: ["$status", "H"] }, 1, 0] } },
            },
          },
          { $sort: { _id: 1 } },
        ])
      : [];

    return res.status(200).json({
      message: [{ key: "success", value: "Attendance summary retrieved" }],
      data: {
        markedDays,
        workingDayKeys,
        workingDays,
        students,
        perDay: perDayRows.map((d) => ({ key: d._id, P: d.P, A: d.A, H: d.H })),
        totalRecords: agg?.total?.[0]?.n || 0,
      },
    });
  } catch (err) {
    console.error("getAttendanceSummary error:", err);
    return res
      .status(500)
      .json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};

// ── OVERVIEW — the Attendance Management listing, in one request ───────────
// Replaces the client's old N+1 (one full course fetch per row just to count
// students). Returns every course the REQUESTER may mark: admins get all,
// everyone else only courses where they sit inside a batch — and only those
// batches. ?date=YYYY-MM-DD is the requester's local day, used for the
// per-batch "marked today" flags.
exports.getAttendanceOverview = async (req, res) => {
  try {
    const day = dayUtc(req.query.date) || dayUtc(new Date());
    const admin = await isAdminUser(req.user);
    // Read-only widening: L&D Head / Sub Head see every course here (they do
    // not get marking rights — those still check isAdminUser in save/reset).
    const viewer = admin || (await isManagerViewer(req.user));
    // A POC is a read-only viewer too, but of ITS OWN courses only — it is not
    // in the institution-wide `viewer` tier.
    const pocViewer = !!req.pocScope?.isPoc;
    const uid = String(req.user?._id || "");

    // `institution` was missing entirely here: this listing used to return
    // every course in the DATABASE, across all institutions, to any admin or
    // manager-tier viewer. Adding it closes a cross-tenant leak that predates
    // POC scoping; the POC branch narrows further to its enrolled courses.
    const courses = await CourseStructure.find(
      pocViewer
        ? { institution: req.user.institution, _id: { $in: req.pocScope.courseIds } }
        : { institution: req.user.institution }
    )
      .select(
        "courseName courseCode category serviceModal clientName coursePath institution clientId batchAndParticipants"
      )
      .lean();

    // Student counting needs each member's role. Two flat lookups (users →
    // roles) instead of a populate per course keep this one round of queries.
    const allUserIds = new Set();
    courses.forEach((c) =>
      (c.batchAndParticipants || []).forEach((b) =>
        (b.users || []).forEach((u) => {
          const id = u?.user?._id || u?.user;
          if (id) allUserIds.add(String(id));
        })
      )
    );
    const users = allUserIds.size
      ? await User.find({ _id: { $in: [...allUserIds] } }).select("role").lean()
      : [];
    // Legacy users carry the role NAME as a string; newer ones a Role id.
    const roleIds = new Set(
      users
        .map((u) => String(u.role || ""))
        .filter((v) => v && mongoose.Types.ObjectId.isValid(v))
    );
    const roles = roleIds.size
      ? await Role.find({ _id: { $in: [...roleIds] } })
          .select("originalRole renameRole")
          .lean()
      : [];
    const roleNameById = new Map(
      roles.map((r) => [
        String(r._id),
        String(r.originalRole || r.renameRole || "").toLowerCase(),
      ])
    );
    const roleOfUser = new Map(
      users.map((u) => {
        const raw = String(u.role || "");
        const name =
          roleNameById.get(raw) ||
          (raw && !mongoose.Types.ObjectId.isValid(raw) ? raw.toLowerCase() : "");
        return [String(u._id), name];
      })
    );
    const isStudentId = (id) => roleOfUser.get(String(id)) === "student";

    // Today's marks, grouped per course+batch in one aggregation. Legacy rows
    // (batchId null) group under "" and flag the course rather than a batch.
    const counts = await StudentAttendance.aggregate([
      { $match: { date: day, courseId: { $in: courses.map((c) => c._id) } } },
      { $group: { _id: { c: "$courseId", b: "$batchId" }, n: { $sum: 1 } } },
    ]);
    const marked = new Map(
      counts.map((x) => [`${x._id.c}::${x._id.b || ""}`, x.n])
    );

    // Training windows for every course, in three bulk queries: calendars,
    // pedagogy hour totals, holiday calendars. Same computeWindow the marking
    // gate uses, so the listing's "active" can never disagree with the law.
    const calendars = await ProgramCalendar.find({
      courseId: { $in: courses.map((c) => c._id) },
    }).lean();
    const calendarByCourse = new Map(calendars.map((cal) => [String(cal.courseId), cal]));
    const hourTotalsAgg = await PedagogyView.aggregate([
      { $match: { courses: { $in: courses.map((c) => c._id) } } },
      { $unwind: "$pedagogies" },
      {
        $project: {
          courses: 1,
          t: {
            $add: [
              pedagogyDurationsOf("$pedagogies.iDo"),
              pedagogyDurationsOf("$pedagogies.weDo"),
              pedagogyDurationsOf("$pedagogies.youDo"),
            ],
          },
        },
      },
      { $group: { _id: "$courses", total: { $sum: "$t" } } },
    ]);
    const hoursTotalByCourse = new Map(
      hourTotalsAgg.map((h) => [String(h._id), h.total || 0])
    );
    const scopeIds = new Set();
    courses.forEach((c) => {
      const inst = String(c.institution || "");
      if (!inst) return;
      scopeIds.add(inst);
      if (c.clientId) scopeIds.add(`${inst}__client__${c.clientId}`);
    });
    const allHolidayDocs = scopeIds.size
      ? await InstituteHolidayCalendar.find({ instituteId: { $in: [...scopeIds] } }).lean()
      : [];
    const holidayDocsByScope = new Map(
      allHolidayDocs.map((d) => [String(d.instituteId), d])
    );

    const data = [];
    for (const c of courses) {
      const inst = String(c.institution || "");
      const scopeDocs = [];
      if (holidayDocsByScope.has(inst)) scopeDocs.push(holidayDocsByScope.get(inst));
      const clientScope = c.clientId ? `${inst}__client__${c.clientId}` : "";
      if (clientScope && holidayDocsByScope.has(clientScope))
        scopeDocs.push(holidayDocsByScope.get(clientScope));
      const w = computeWindow(
        calendarByCourse.get(String(c._id)) || null,
        hoursTotalByCourse.get(String(c._id)) || 0,
        holidayMapOf(scopeDocs)
      );

      let batches = (c.batchAndParticipants || []).map((b) => ({
        _id: b._id,
        batchName: b.batchName || "",
        studentCount: (b.users || []).filter((u) =>
          isStudentId(u?.user?._id || u?.user)
        ).length,
        markedToday: (marked.get(`${c._id}::${b._id}`) || 0) > 0,
        mine: memberOfBatch(b, uid),
        // This batch's training end — deviations scoped to it extend it.
        trainingEnd: w.exists ? w.endFor(String(b._id)) || "" : "",
      }));

      // A POC skips the batch narrowing: the COURSE is its unit of scope, and
      // the course list above is already restricted to the ones it is enrolled
      // in. Filtering to `mine` on top would hide the other batches of a course
      // the POC legitimately oversees — a trainer serves one batch, a point of
      // contact answers for the whole engagement.
      if (!viewer && !pocViewer) {
        batches = batches.filter((b) => b.mine);
        // Not in any batch of this course → the course does not exist for
        // this user's attendance world.
        if (batches.length === 0) continue;
      }

      // The course-level end: the latest end among the batches this REQUESTER
      // sees (a trainer's view reflects their batches), falling back to the
      // shared end when no batch carries one.
      const batchEnds = batches.map((b) => b.trainingEnd).filter(Boolean).sort();
      data.push({
        _id: c._id,
        courseName: c.courseName || "",
        courseCode: c.courseCode || "",
        category: c.category || "",
        serviceModal: c.serviceModal || "",
        clientName: c.clientName || "",
        coursePath: c.coursePath || "",
        // The TRAINING window — what "active" means for attendance. No
        // schedule ⇒ nothing to attend, and the listing says so.
        hasSchedule: w.exists,
        trainingStart: w.exists ? w.startDate : "",
        trainingEnd: w.exists
          ? batchEnds[batchEnds.length - 1] || w.endFor(null) || ""
          : "",
        batches,
        totalStudents: batches.reduce((n, b) => n + b.studentCount, 0),
        // Pre-batch marks for today (backfill covers history; this covers a
        // just-written legacy record) — counts as "the course was marked".
        legacyMarkedToday: (marked.get(`${c._id}::`) || 0) > 0,
      });
    }

    return res.status(200).json({
      message: [{ key: "success", value: "Attendance overview" }],
      // Three tiers: admin (marks everything), viewer (read-only — L&D Head /
      // Sub Head institution-wide, POC over its own courses), staff (own
      // batches). A POC reports as "viewer" because that is the read-only
      // contract the client already renders; what differs is the row set it
      // was given, not what it may do with it.
      role: admin ? "admin" : viewer || pocViewer ? "viewer" : "staff",
      data,
    });
  } catch (err) {
    console.error("getAttendanceOverview error:", err);
    return res
      .status(500)
      .json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};
