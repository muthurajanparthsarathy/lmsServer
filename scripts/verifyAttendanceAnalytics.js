// Attendance Analytics — equivalence harness for the server-side summary.
//
//     node scripts/verifyAttendanceAnalytics.js
//     node scripts/verifyAttendanceAnalytics.js --verbose
//     node scripts/verifyAttendanceAnalytics.js --break=<name>   (see BREAKERS)
//
// Reads only. Nothing is written to any database.
//
// AttendanceAnalyticsPage.tsx used to pull every attendance record in the
// selected range and build a studentId → dayKey → status grid in the browser
// purely to total it. This asserts that the page's SEVEN derived outputs come
// out identical when they are read off GET /attendance/summary instead:
//
//     perStudent   p / a / h / n / attendance % per roster row
//     totals       P / A / H / N, totalCells, avgAttendance
//     highLow      the Highest / Lowest attendance cards
//     topPerformers the ordered top-5 table (order included — ties are
//                  positional, so a stable-sort drift is a real failure)
//     trend        the line chart, daily AND cumulative
//     byDay        the stacked bar chart, by-count AND by-percentage
//
// Both sides run against the REAL controllers (getAttendance for the old
// whole-range read, getAttendanceSummary for the new one) over the live
// database, so this compares implementations rather than two transcriptions.
//
// ── The rule that shapes the client code ────────────────────────────────────
// The Analytics page's denominator is every CALENDAR day in the range, not the
// Report page's working days: `attPct = (p + h/2) / days.length`. So it needs
// no markedDays / workingDays at all, and a student's unmarked count is simply
// `days.length - (p + a + h)` — a day carrying a mark is always inside the
// range, so their marks in range ARE their marks over those days.
//
// ── Why the summary request is scoped to the roster ─────────────────────────
// The charts count STUDENTS, not records: each day's "Not Marked" bar is
// (roster students) minus (students marked that day). A course can carry
// records for people who are in none of its batches — live, SUN-BTB-SK-001 has
// five such holders against a five-student roster, 75 of its 150 records — and
// the page has always ignored them, because it walks the roster and looks each
// student up in the grid. A course-wide per-day count against a roster-sized
// denominator drives that subtraction NEGATIVE (5 - 10 = -5 stacked below the
// axis, and percentages over 200%). So the page sends its roster as
// `studentIds` and both sides of the subtraction describe one population.
// SCOPED_OFF below is the same run with that scoping removed — it is expected
// to FAIL, and is what makes the argument above a measurement.
//
// ── Coverage ────────────────────────────────────────────────────────────────
// Live: every course carrying records × ranges (full span, halves, single
// marked day, a range with no marks at all, weekend-only, from > to) × student
// filter ("all", each holder, a roster student with no records).
//
// Synthetic fixtures cover what live data has none of — verified absent by
// scripts/../probes: duplicate (student, day) records across two batches,
// a student sitting in two batches of one course, record holders off the
// roster, an empty roster, a zero-day range. Their summaries come from a
// reference generator that is itself asserted field-for-field against the real
// controller on every live case first, so the fixtures inherit that trust.
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");

require("../models/RoleModel");
require("../models/UserModel");
const CourseStructure = require("../models/Courses/courseStructureModal");
const StudentAttendance = require("../models/Courses/StudentAttendanceModel");
const {
  getAttendance,
  getAttendanceSummary,
} = require("../controllers/courses/attendance");

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : fallback;
};
const VERBOSE = process.argv.includes("--verbose");
const BREAK = arg("break", "");

// ─── Deliberate breakages ────────────────────────────────────────────────────
// A harness that passes proves nothing until it has been shown to fail. Each
// of these is a mistake that looks correct in a diff; --break=<name> injects it
// into the NEW derivation (or the request) and the run must go red.
const BREAKERS = {
  // Unmarked days over WORKING days — the Report page's rule, which is the
  // wrong denominator for this page.
  working_days: "count unmarked against working days instead of calendar days",
  // Off-by-one the other way: forget that `n` is a remainder and use the
  // marked-day count.
  marked_days: "use markedDays.length as the denominator",
  // Drop the roster scoping — the live orphan-holder case above.
  scoped_off: "send no studentIds, letting off-roster holders into the charts",
  // Join tallies by array position instead of by studentId.
  positional_join: "join tallies to the roster positionally",
  // Zero-fill mistake: treat a day missing from perDay as absent rather than
  // unmarked.
  missing_day_absent: "score days missing from perDay as absent",
  // Sort the top-5 without the secondary key.
  no_tiebreak: "rank top performers on percentage alone",
  // Cumulative trend that resets each day.
  no_cumulative: "leave the cumulative series non-cumulative",
  // The N series clamped away entirely.
  no_unmarked: "drop the Not Marked series from the by-day chart",
  // Half-days counted whole.
  half_whole: "count a half-day as a full present day",
  // Ask for the summary before the roster has arrived. `studentIds=` empty is
  // NOT "match nobody" — like the sibling list endpoint, an empty list is no
  // scope at all, so the whole course comes back and lands in a chart whose
  // denominator is zero students. This harness found that; the page's
  // `enabled` gate is the fix and this keeps it honest.
  no_gate: "request the summary with an empty roster",
};
if (BREAK && !BREAKERS[BREAK]) {
  console.error(`unknown --break=${BREAK}\nknown: ${Object.keys(BREAKERS).join(", ")}`);
  process.exit(2);
}
const broken = (name) => BREAK === name;

// ─── Controller plumbing ─────────────────────────────────────────────────────
const callController = (fn, req) =>
  new Promise((resolve, reject) => {
    const res = {
      _status: 200,
      status(code) {
        this._status = code;
        return this;
      },
      json(body) {
        resolve({ status: this._status, body });
        return this;
      },
    };
    Promise.resolve(fn(req, res)).catch(reject);
  });

const fetchRecords = async (courseId, from, to) => {
  const { status, body } = await callController(getAttendance, {
    params: { courseId },
    query: { from, to },
  });
  if (status !== 200) throw new Error(`getAttendance ${status}`);
  return body.data;
};

const fetchSummary = async (courseId, from, to, scope = {}) => {
  const query = { from, to };
  if (scope.student && scope.student !== "all") query.student = scope.student;
  if (scope.studentIds && scope.studentIds.length) query.studentIds = scope.studentIds.join(",");
  const { status, body } = await callController(getAttendanceSummary, {
    params: { courseId },
    query,
  });
  if (status !== 200) throw new Error(`getAttendanceSummary ${status}`);
  return body.data;
};

// ─── client/src/queries/attendance.ts — the roster, as the page sees it ──────
// `?roster=1` populates batchAndParticipants[].users[].user with its role;
// toBatchGroups keeps role === "student" and flatMap preserves batch-then-user
// order. A student enrolled in two batches DOES appear twice — the page has
// never de-duplicated, and neither does this.
const isStudent = (user) => {
  const role =
    typeof user?.role === "string"
      ? user.role
      : user?.role?.renameRole || user?.role?.name || "";
  return String(role).toLowerCase() === "student";
};

const rosterOf = async (courseId) => {
  const course = await CourseStructure.findById(courseId)
    .populate({
      path: "batchAndParticipants.users.user",
      select: "firstName lastName email userId employeeId role",
      populate: { path: "role", model: "Role", select: "renameRole originalRole roleValue name" },
    })
    .lean();
  if (!course) return null;
  return (course.batchAndParticipants || [])
    .map((b) => ({
      students: (b?.users || [])
        .map((e) => e?.user || e)
        .filter(isStudent)
        .map((u) => ({
          _id: String(u._id || u.id),
          firstName: u.firstName || "",
          lastName: u.lastName || "",
          email: u.email || "",
          userId: u.userId || u.employeeId || "",
        })),
    }))
    .flatMap((g) => g.students);
};

// ─── Date helpers, transcribed from the page ─────────────────────────────────
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const toDayKey = (d) => {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const parseKey = (k) => {
  const [y, m, d] = String(k).split("-").map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
};

const fmtWeekday = (d) => d.toLocaleString("en-GB", { weekday: "short", timeZone: "UTC" });
const fmtLabel = (d) =>
  d.toLocaleString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });

const daysOf = (from, to) => {
  const start = parseKey(from);
  const end = parseKey(to);
  const out = [];
  for (let t = start.getTime(); t <= end.getTime(); t += MS_PER_DAY) out.push(new Date(t));
  return out;
};

// ─── OLD: AttendanceAnalyticsPage.tsx before the change ──────────────────────
// Transcribed from the `grid` / `visibleStudents` / `perStudent` / `totals` /
// `highLow` / `topPerformers` / `trend` / `byDay` memos. This is the only
// remaining record of the derivation being replaced.
const deriveOld = (students, records, from, to, appliedStudent) => {
  const days = daysOf(from, to);

  // studentId → dateKey → status. A second record for the same cell overwrites
  // the first, which is why the fixtures below sort exactly as the endpoint
  // does (date asc, studentId asc).
  const grid = new Map();
  for (const r of records) {
    const sid = String(r.studentId);
    const dk = toDayKey(new Date(r.date));
    if (!grid.has(sid)) grid.set(sid, new Map());
    grid.get(sid).set(dk, r.status);
  }

  const visibleStudents =
    appliedStudent === "all" ? students : students.filter((s) => s._id === appliedStudent);

  const perStudent = visibleStudents.map((s) => {
    let p = 0,
      a = 0,
      h = 0,
      n = 0;
    const row = grid.get(s._id);
    for (const d of days) {
      const st = row?.get(toDayKey(d));
      if (st === "P") p++;
      else if (st === "A") a++;
      else if (st === "H") h++;
      else n++;
    }
    const attPct = days.length > 0 ? ((p + h * 0.5) / days.length) * 100 : 0;
    return { student: s, p, a, h, n, attPct };
  });

  return { days, visibleStudents, perStudent, ...tail(perStudent, visibleStudents, days, byDayOld(days, visibleStudents, grid), trendOld(days, visibleStudents, grid), "old") };
};

const trendOld = (days, visibleStudents, grid) => {
  let cumP = 0,
    cumA = 0,
    cumH = 0;
  return days.map((d) => {
    const dk = toDayKey(d);
    let P = 0,
      A = 0,
      H = 0;
    for (const s of visibleStudents) {
      const st = grid.get(s._id)?.get(dk);
      if (st === "P") P++;
      else if (st === "A") A++;
      else if (st === "H") H++;
    }
    cumP += P;
    cumA += A;
    cumH += H;
    return { label: fmtLabel(d), weekday: fmtWeekday(d), daily: { P, A, H }, cumulative: { P: cumP, A: cumA, H: cumH } };
  });
};

const byDayOld = (days, visibleStudents, grid) =>
  days.map((d) => {
    const dk = toDayKey(d);
    let P = 0,
      A = 0,
      H = 0,
      N = 0;
    for (const s of visibleStudents) {
      const st = grid.get(s._id)?.get(dk);
      if (st === "P") P++;
      else if (st === "A") A++;
      else if (st === "H") H++;
      else N++;
    }
    return { label: fmtLabel(d), weekday: fmtWeekday(d), ...shapeByDay(P, A, H, N) };
  });

// Both modes of the by-day chart, from one set of counts — `dayMode` is a
// client-only toggle over the same numbers.
const shapeByDay = (P, A, H, N) => {
  const tot = P + A + H + N || 1;
  return {
    count: { Present: P, Absent: A, "Half-day": H, "Not Marked": N },
    percent: {
      Present: +((P / tot) * 100).toFixed(1),
      Absent: +((A / tot) * 100).toFixed(1),
      "Half-day": +((H / tot) * 100).toFixed(1),
      "Not Marked": +((N / tot) * 100).toFixed(1),
    },
  };
};

// totals / highLow / topPerformers are identical functions of perStudent, and
// the page's memos for them are untouched by this change — only their input
// moves from a grid walk to a tally lookup. So they are written once and fed
// whichever perStudent. `side` exists only so a breaker can damage the NEW
// side alone: damaging a shared path damages both, which is a harness that
// cannot fail.
const tail = (perStudent, visibleStudents, days, byDay, trend, side) => {
  let P = 0,
    A = 0,
    H = 0,
    N = 0;
  for (const rs of perStudent) {
    P += rs.p;
    A += rs.a;
    H += rs.h;
    N += rs.n;
  }
  const totalCells = P + A + H + N;
  const totals = {
    P,
    A,
    H,
    N,
    totalCells,
    avgAttendance: totalCells > 0 ? ((P + H * 0.5) / totalCells) * 100 : 0,
  };

  const sorted = [...perStudent].sort((a, b) => b.attPct - a.attPct);
  const highLow =
    perStudent.length === 0
      ? { hi: null, lo: null }
      : { hi: sorted[0], lo: sorted[sorted.length - 1] };

  const topPerformers = [...perStudent]
    .sort((a, b) =>
      side === "new" && broken("no_tiebreak")
        ? b.attPct - a.attPct
        : b.attPct - a.attPct || b.p - a.p
    )
    .slice(0, 5);

  return { totals, highLow, topPerformers, trend, byDay };
};

// ─── NEW: the derivation the page will run off the summary ───────────────────
const deriveNew = (students, summary, from, to, appliedStudent) => {
  const days = daysOf(from, to);

  // studentId → P/A/H. A roster student the summary never mentions holds no
  // records — the tallies are not status-filtered, so absence is unambiguous.
  const tallyById = new Map();
  for (const t of summary.students || []) tallyById.set(t.studentId, { p: t.p, a: t.a, h: t.h });

  const visibleStudents =
    appliedStudent === "all" ? students : students.filter((s) => s._id === appliedStudent);

  // The denominator each unmarked count is taken from.
  let span = days.length;
  if (broken("working_days")) span = (summary.workingDayKeys || []).length;
  if (broken("marked_days")) span = (summary.markedDays || []).length;

  const perStudent = visibleStudents.map((s, i) => {
    const t = broken("positional_join")
      ? (summary.students || [])[i] || { p: 0, a: 0, h: 0 }
      : tallyById.get(s._id) || { p: 0, a: 0, h: 0 };
    const p = t.p,
      a = t.a,
      h = t.h;
    const n = Math.max(0, span - (p + a + h));
    const weight = broken("half_whole") ? 1 : 0.5;
    const attPct = days.length > 0 ? ((p + h * weight) / days.length) * 100 : 0;
    return { student: s, p, a, h, n, attPct };
  });

  const perDayMap = new Map();
  for (const d of summary.perDay || []) perDayMap.set(d.key, { P: d.P, A: d.A, H: d.H });

  let cumP = 0,
    cumA = 0,
    cumH = 0;
  const trend = days.map((d) => {
    const c = perDayMap.get(toDayKey(d));
    const P = c?.P || 0;
    const A = broken("missing_day_absent") && !c ? visibleStudents.length : c?.A || 0;
    const H = c?.H || 0;
    cumP += P;
    cumA += A;
    cumH += H;
    return {
      label: fmtLabel(d),
      weekday: fmtWeekday(d),
      daily: { P, A, H },
      cumulative: broken("no_cumulative") ? { P, A, H } : { P: cumP, A: cumA, H: cumH },
    };
  });

  const byDay = days.map((d) => {
    const c = perDayMap.get(toDayKey(d));
    const P = c?.P || 0;
    const A = c?.A || 0;
    const H = c?.H || 0;
    // Every student on the roster that carries no mark that day. Clamped
    // because a student sitting in two batches can hold two marks for one day
    // (the unique index is per batch), which no page denominator anticipates.
    const N = broken("no_unmarked") ? 0 : Math.max(0, visibleStudents.length - (P + A + H));
    return { label: fmtLabel(d), weekday: fmtWeekday(d), ...shapeByDay(P, A, H, N) };
  });

  return { days, visibleStudents, perStudent, ...tail(perStudent, visibleStudents, days, byDay, trend, "new") };
};

// ─── Reference summary — the endpoint's contract, for synthetic fixtures ─────
// Asserted field-for-field against the real controller on every live case.
const referenceSummary = (records, from, to, scope = {}) => {
  const fromDay = from ? parseKey(from) : null;
  const toDay = to ? parseKey(to) : null;

  // Every row in the window, whoever it belongs to — the endpoint's `dayMatch`.
  const dayRows = records.filter((r) => {
    const t = new Date(r.date).getTime();
    if (fromDay && t < fromDay.getTime()) return false;
    if (toDay && t > toDay.getTime()) return false;
    return true;
  });

  // ...then narrowed to whose marks the caller asked to count.
  let rows = dayRows;
  if (scope.student && scope.student !== "all") {
    rows = rows.filter((r) => String(r.studentId) === scope.student);
  } else if (scope.studentIds && scope.studentIds.length) {
    const set = new Set(scope.studentIds.map(String));
    rows = rows.filter((r) => set.has(String(r.studentId)));
  }

  // `markedDays` answers "did a session happen on this date", which is a
  // property of the CLASS and not of the filter, so it reads dayRows. This
  // page never touches it — its denominator is calendar days — but the
  // contract assertions below do, and the Report page's working-day rule
  // depends on it. See getAttendanceSummary's two-match note and
  // scripts/verifyAttendanceReport.js.
  const markedDays = [...new Set(dayRows.map((r) => toDayKey(new Date(r.date))))].sort();
  const markedSet = new Set(markedDays);

  const workingDayKeys = [];
  if (fromDay && toDay) {
    for (let t = fromDay.getTime(); t <= toDay.getTime(); t += MS_PER_DAY) {
      const d = new Date(t);
      const k = toDayKey(d);
      const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
      if (!weekend || markedSet.has(k)) workingDayKeys.push(k);
    }
  }

  const perStudent = new Map();
  for (const r of rows) {
    const sid = String(r.studentId);
    if (!perStudent.has(sid)) perStudent.set(sid, { studentId: sid, p: 0, a: 0, h: 0 });
    const t = perStudent.get(sid);
    if (r.status === "P") t.p++;
    else if (r.status === "A") t.a++;
    else if (r.status === "H") t.h++;
  }

  const perDay = new Map();
  for (const r of rows) {
    const k = toDayKey(new Date(r.date));
    if (!perDay.has(k)) perDay.set(k, { key: k, P: 0, A: 0, H: 0 });
    const c = perDay.get(k);
    if (r.status === "P") c.P++;
    else if (r.status === "A") c.A++;
    else if (r.status === "H") c.H++;
  }

  return {
    markedDays,
    workingDayKeys,
    workingDays: workingDayKeys.length,
    students: [...perStudent.values()],
    perDay: [...perDay.values()].sort((x, y) => (x.key < y.key ? -1 : 1)),
    totalRecords: rows.length,
  };
};

// What `useAttendanceSummaryQuery` holds while it is disabled — the page reads
// an undefined summary as empty, and with no roster there is nothing to count.
const EMPTY_SUMMARY = {
  markedDays: [],
  workingDayKeys: [],
  workingDays: 0,
  students: [],
  perDay: [],
  totalRecords: 0,
};
const summaryEnabled = (rosterIds) => rosterIds.length > 0 || broken("no_gate");

// ─── Assertions ──────────────────────────────────────────────────────────────
let checks = 0;
let failures = [];
let currentCase = "";

const eq = (label, a, b) => {
  checks++;
  const same = Object.is(a, b) || (typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 1e-9);
  if (!same) failures.push(`${currentCase} :: ${label} — old=${JSON.stringify(a)} new=${JSON.stringify(b)}`);
  return same;
};

const eqDeep = (label, a, b) => {
  checks++;
  const A = JSON.stringify(a);
  const B = JSON.stringify(b);
  if (A !== B) failures.push(`${currentCase} :: ${label}\n      old=${A}\n      new=${B}`);
  return A === B;
};

// Every output the page renders, compared field by field.
const compare = (label, oldD, newD) => {
  currentCase = label;

  eq("perStudent.length", oldD.perStudent.length, newD.perStudent.length);
  const rows = Math.min(oldD.perStudent.length, newD.perStudent.length);
  for (let i = 0; i < rows; i++) {
    const o = oldD.perStudent[i];
    const n = newD.perStudent[i];
    eq(`perStudent[${i}].id`, o.student._id, n.student._id);
    eq(`perStudent[${i}].p`, o.p, n.p);
    eq(`perStudent[${i}].a`, o.a, n.a);
    eq(`perStudent[${i}].h`, o.h, n.h);
    eq(`perStudent[${i}].n`, o.n, n.n);
    eq(`perStudent[${i}].attPct`, o.attPct, n.attPct);
    // The table paints the value it formats, and the colour band it falls in.
    eq(`perStudent[${i}].attPct.toFixed`, o.attPct.toFixed(2), n.attPct.toFixed(2));
    const band = (v) => (v >= 75 ? "green" : v >= 50 ? "amber" : "red");
    eq(`perStudent[${i}].band`, band(o.attPct), band(n.attPct));
  }

  for (const k of ["P", "A", "H", "N", "totalCells", "avgAttendance"]) {
    eq(`totals.${k}`, oldD.totals[k], newD.totals[k]);
  }
  eq("totals.avgAttendance.toFixed", oldD.totals.avgAttendance.toFixed(2), newD.totals.avgAttendance.toFixed(2));
  // The distribution card's four percentages.
  for (const k of ["P", "A", "H", "N"]) {
    const pct = (t) => (t.totalCells > 0 ? (t[k] / t.totalCells) * 100 : 0);
    eq(`dist.${k}%`, pct(oldD.totals).toFixed(2), pct(newD.totals).toFixed(2));
  }

  eq("highLow.hi.id", oldD.highLow.hi?.student._id ?? null, newD.highLow.hi?.student._id ?? null);
  eq("highLow.hi.pct", oldD.highLow.hi?.attPct ?? null, newD.highLow.hi?.attPct ?? null);
  eq("highLow.lo.id", oldD.highLow.lo?.student._id ?? null, newD.highLow.lo?.student._id ?? null);
  eq("highLow.lo.pct", oldD.highLow.lo?.attPct ?? null, newD.highLow.lo?.attPct ?? null);

  eqDeep(
    "topPerformers",
    oldD.topPerformers.map((r) => [r.student._id, r.attPct.toFixed(2), r.p, r.a, r.h]),
    newD.topPerformers.map((r) => [r.student._id, r.attPct.toFixed(2), r.p, r.a, r.h])
  );

  eq("trend.length", oldD.trend.length, newD.trend.length);
  const tn = Math.min(oldD.trend.length, newD.trend.length);
  for (let i = 0; i < tn; i++) {
    eq(`trend[${i}].label`, oldD.trend[i].label, newD.trend[i].label);
    eq(`trend[${i}].weekday`, oldD.trend[i].weekday, newD.trend[i].weekday);
    eqDeep(`trend[${i}].daily`, oldD.trend[i].daily, newD.trend[i].daily);
    eqDeep(`trend[${i}].cumulative`, oldD.trend[i].cumulative, newD.trend[i].cumulative);
  }

  eq("byDay.length", oldD.byDay.length, newD.byDay.length);
  const bn = Math.min(oldD.byDay.length, newD.byDay.length);
  for (let i = 0; i < bn; i++) {
    eq(`byDay[${i}].label`, oldD.byDay[i].label, newD.byDay[i].label);
    eqDeep(`byDay[${i}].count`, oldD.byDay[i].count, newD.byDay[i].count);
    eqDeep(`byDay[${i}].percent`, oldD.byDay[i].percent, newD.byDay[i].percent);
  }
};

// The Excel / PDF exports read the same memos, so they need no separate
// comparison — but the two cells that are FORMATTED rather than copied do.
const compareExports = (label, oldD, newD) => {
  currentCase = `${label} :: export`;
  const line = (rs) =>
    rs ? `${rs.attPct.toFixed(2)}% — ${rs.student.firstName} ${rs.student.lastName}`.trim() : "—";
  eq("export.highest", line(oldD.highLow.hi), line(newD.highLow.hi));
  eq("export.lowest", line(oldD.highLow.lo), line(newD.highLow.lo));
  eqDeep(
    "export.byDaySheet",
    oldD.byDay.map((r) => [r.label, r.weekday, r.count.Present, r.count.Absent, r.count["Half-day"], r.count["Not Marked"]]),
    newD.byDay.map((r) => [r.label, r.weekday, r.count.Present, r.count.Absent, r.count["Half-day"], r.count["Not Marked"]])
  );
};

// ─── Live cases ──────────────────────────────────────────────────────────────
const addDaysKey = (key, n) => toDayKey(new Date(parseKey(key).getTime() + n * MS_PER_DAY));

const rangesFor = (markedKeys) => {
  const first = markedKeys[0];
  const last = markedKeys[markedKeys.length - 1];
  const mid = markedKeys[Math.floor(markedKeys.length / 2)];
  const out = [
    ["full span", first, last],
    ["span + a week either side", addDaysKey(first, -7), addDaysKey(last, 7)],
    ["first half", first, mid],
    ["second half", mid, last],
    ["single marked day", first, first],
    ["single unmarked day", addDaysKey(first, -1), addDaysKey(first, -1)],
    ["range with no marks", addDaysKey(last, 30), addDaysKey(last, 60)],
    ["from > to (empty)", last, first],
    ["one long range", addDaysKey(first, -45), addDaysKey(last, 45)],
  ];
  // A weekend-only window, where "a marked Saturday is a working day" would
  // matter if this page used working days — it must NOT.
  const sat = markedKeys.find((k) => {
    const d = parseKey(k);
    return d.getUTCDay() === 6 || d.getUTCDay() === 0;
  });
  if (sat) out.push(["marked weekend day only", sat, sat]);
  return out.filter(([, f, t]) => f && t);
};

const runLive = async () => {
  const courseIds = await StudentAttendance.distinct("courseId");
  const report = [];

  for (const cid of courseIds) {
    const courseId = String(cid);
    const roster = await rosterOf(courseId);
    if (!roster) {
      report.push(`  ${courseId}: course document missing — skipped (unreachable from the picker)`);
      continue;
    }
    const course = await CourseStructure.findById(courseId).select("courseCode courseName").lean();
    const name = course.courseCode || course.courseName || courseId;

    const markedKeys = (
      await StudentAttendance.aggregate([
        { $match: { courseId: cid } },
        { $group: { _id: { $dateToString: { date: "$date", format: "%Y-%m-%d", timezone: "UTC" } } } },
        { $sort: { _id: 1 } },
      ])
    ).map((r) => r._id);

    const holders = (await StudentAttendance.distinct("studentId", { courseId: cid })).map(String);
    const rosterIds = [...new Set(roster.map((s) => s._id))];
    const orphans = holders.filter((h) => !rosterIds.includes(h));
    const noRecordStudents = rosterIds.filter((r) => !holders.includes(r));

    // "all", every roster student that holds records, and one that holds none.
    const studentFilters = ["all", ...rosterIds.filter((r) => holders.includes(r))];
    if (noRecordStudents.length) studentFilters.push(noRecordStudents[0]);

    let cases = 0;
    for (const [rangeName, from, to] of rangesFor(markedKeys)) {
      const records = await fetchRecords(courseId, from, to);
      for (const student of studentFilters) {
        const scope = { student, studentIds: broken("scoped_off") ? [] : rosterIds };
        const summary = summaryEnabled(rosterIds)
          ? await fetchSummary(courseId, from, to, scope)
          : EMPTY_SUMMARY;

        // The reference generator earns the synthetic fixtures' trust here.
        currentCase = `${name} / ${rangeName} / student=${student.slice(-6)} :: summary contract`;
        const ref = referenceSummary(records, from, to, scope);
        eqDeep("summary.markedDays", ref.markedDays, summary.markedDays);
        eqDeep("summary.workingDayKeys", ref.workingDayKeys, summary.workingDayKeys);
        eq("summary.workingDays", ref.workingDays, summary.workingDays);
        eq("summary.totalRecords", ref.totalRecords, summary.totalRecords);
        eqDeep(
          "summary.students",
          [...ref.students].sort((a, b) => (a.studentId < b.studentId ? -1 : 1)),
          [...(summary.students || [])].sort((a, b) => (a.studentId < b.studentId ? -1 : 1))
        );
        eqDeep("summary.perDay", ref.perDay, summary.perDay);

        const label = `${name} / ${rangeName} / student=${student === "all" ? "all" : student.slice(-6)}`;
        const oldD = deriveOld(roster, records, from, to, student);
        const newD = deriveNew(roster, summary, from, to, student);
        compare(label, oldD, newD);
        compareExports(label, oldD, newD);
        cases++;
      }
    }
    report.push(
      `  ${name}  roster=${roster.length} (distinct ${rosterIds.length})  holders=${holders.length}` +
        `  off-roster=${orphans.length}  no-records=${noRecordStudents.length}` +
        `  markedDays=${markedKeys.length}  cases=${cases}`
    );
  }
  return report;
};

// ─── Synthetic fixtures ──────────────────────────────────────────────────────
const oid = (n) => String(n).padStart(24, "0");
const mkStudent = (n) => ({ _id: oid(n), firstName: `S${n}`, lastName: "T", email: "", userId: `R${n}` });
// The list endpoint sorts date asc, studentId asc — the fixtures must too,
// because the old grid's last-write-wins depends on that order.
const sortLikeEndpoint = (recs) =>
  [...recs].sort((a, b) => a.date - b.date || (String(a.studentId) < String(b.studentId) ? -1 : 1));
const rec = (sid, key, status) => ({ studentId: oid(sid), date: parseKey(key), status });

const FIXTURES = [
  {
    name: "plain week, every student marked every day",
    from: "2026-03-02",
    to: "2026-03-06",
    roster: [1, 2, 3].map(mkStudent),
    records: ["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06"].flatMap((k) => [
      rec(1, k, "P"),
      rec(2, k, "A"),
      rec(3, k, "H"),
    ]),
  },
  {
    name: "roster student holding no records at all",
    from: "2026-03-02",
    to: "2026-03-04",
    roster: [1, 2, 3].map(mkStudent),
    records: [rec(1, "2026-03-02", "P"), rec(1, "2026-03-03", "H")],
  },
  {
    name: "off-roster holders (the live SUN-BTB-SK-001 shape)",
    from: "2026-03-02",
    to: "2026-03-04",
    roster: [1, 2].map(mkStudent),
    records: [
      rec(1, "2026-03-02", "P"),
      rec(2, "2026-03-02", "A"),
      rec(8, "2026-03-02", "P"),
      rec(9, "2026-03-02", "P"),
      rec(8, "2026-03-03", "H"),
      rec(9, "2026-03-04", "A"),
    ],
  },
  {
    name: "marked weekend inside the range",
    from: "2026-03-06",
    to: "2026-03-09",
    roster: [1, 2].map(mkStudent),
    records: [
      rec(1, "2026-03-07", "P"),
      rec(2, "2026-03-07", "A"),
      rec(1, "2026-03-09", "P"),
    ],
  },
  {
    name: "single day range",
    from: "2026-03-03",
    to: "2026-03-03",
    roster: [1, 2].map(mkStudent),
    records: [rec(1, "2026-03-03", "H"), rec(2, "2026-03-03", "P")],
  },
  {
    name: "empty roster",
    from: "2026-03-02",
    to: "2026-03-06",
    roster: [],
    records: [rec(1, "2026-03-02", "P")],
  },
  {
    name: "zero-day range (from > to)",
    from: "2026-03-06",
    to: "2026-03-02",
    roster: [1, 2].map(mkStudent),
    records: [rec(1, "2026-03-03", "P")],
  },
  {
    name: "no records anywhere in range",
    from: "2026-04-06",
    to: "2026-04-10",
    roster: [1, 2, 3].map(mkStudent),
    records: [rec(1, "2026-03-03", "P")],
  },
  {
    name: "six students, ties on every percentage (top-5 cut and order)",
    from: "2026-03-02",
    to: "2026-03-03",
    roster: [1, 2, 3, 4, 5, 6].map(mkStudent),
    records: [1, 2, 3, 4, 5, 6].flatMap((s) => [rec(s, "2026-03-02", "P"), rec(s, "2026-03-03", "A")]),
  },
  {
    name: "equal percentages, different routes (top-5 order needs the p tiebreak)",
    from: "2026-03-02",
    to: "2026-03-05",
    // 1 present ties 2 half-days at 25%, but ranks above it on presents.
    roster: [1, 2, 3, 4, 5, 6].map(mkStudent),
    records: [
      rec(1, "2026-03-02", "H"),
      rec(1, "2026-03-03", "H"),
      rec(2, "2026-03-02", "P"),
      rec(3, "2026-03-02", "H"),
      rec(3, "2026-03-03", "H"),
      rec(4, "2026-03-02", "P"),
      rec(5, "2026-03-02", "H"),
      rec(5, "2026-03-03", "H"),
      rec(6, "2026-03-02", "P"),
    ],
  },
  {
    name: "half-days only — the ½ weighting",
    from: "2026-03-02",
    to: "2026-03-05",
    roster: [1, 2].map(mkStudent),
    records: [rec(1, "2026-03-02", "H"), rec(1, "2026-03-03", "H"), rec(2, "2026-03-02", "H")],
  },
];

// Fixtures whose two sides are KNOWN to differ, with the difference asserted
// rather than waved at. Both are unreachable in the live database (0 of 212
// records, 0 of 72 courses) and both come from one thing: the unique index is
// per BATCH, so a student sitting in two batches of one course is two roster
// entries that can carry two marks for one day.
const DIVERGENT = [
  {
    name: "student enrolled in two batches (duplicate roster entry)",
    from: "2026-03-02",
    to: "2026-03-03",
    roster: [mkStudent(1), mkStudent(2), mkStudent(1)],
    records: [rec(1, "2026-03-02", "P"), rec(2, "2026-03-02", "A")],
    // The cards and the table walk the roster and look each entry up, so both
    // sides count the duplicate twice. The charts read per-day counts, which
    // count the RECORD once — so the old chart shows 2 Present and the new one
    // 1 Present plus 1 Not Marked.
    expect: (oldD, newD) => [
      ["perStudent rows match", oldD.perStudent.length === 3 && newD.perStudent.length === 3],
      ["totals match", JSON.stringify(oldD.totals) === JSON.stringify(newD.totals)],
      ["old chart double-counts the duplicate", oldD.byDay[0].count.Present === 2],
      ["new chart counts the record once", newD.byDay[0].count.Present === 1],
      ["new chart books the second entry as unmarked", newD.byDay[0].count["Not Marked"] === 1],
      ["neither goes negative", oldD.byDay[0].count["Not Marked"] >= 0 && newD.byDay[0].count["Not Marked"] >= 0],
    ],
  },
  {
    name: "two marks for one student-day, one per batch",
    from: "2026-03-02",
    to: "2026-03-03",
    roster: [mkStudent(1), mkStudent(2)],
    records: [rec(1, "2026-03-02", "P"), rec(1, "2026-03-02", "A"), rec(2, "2026-03-02", "P")],
    // The old grid keeps the last write for the cell; the tally counts both
    // records. Same property the Report page's tallies already have.
    expect: (oldD, newD) => [
      ["old grid keeps one mark for the cell", oldD.perStudent[0].p + oldD.perStudent[0].a === 1],
      ["new tally counts both records", newD.perStudent[0].p + newD.perStudent[0].a === 2],
      ["new unmarked count stays non-negative", newD.perStudent[0].n >= 0],
      ["new by-day Not Marked stays non-negative", newD.byDay[0].count["Not Marked"] >= 0],
    ],
  },
];

const runSynthetic = () => {
  for (const f of FIXTURES) {
    const records = sortLikeEndpoint(f.records);
    const rosterIds = [...new Set(f.roster.map((s) => s._id))];
    const filters = ["all", ...rosterIds];
    for (const student of filters) {
      const scope = { student, studentIds: broken("scoped_off") ? [] : rosterIds };
      const summary = summaryEnabled(rosterIds)
        ? referenceSummary(records, f.from, f.to, scope)
        : EMPTY_SUMMARY;
      const label = `fixture: ${f.name} / student=${student === "all" ? "all" : student.slice(-2)}`;
      const oldD = deriveOld(f.roster, records, f.from, f.to, student);
      const newD = deriveNew(f.roster, summary, f.from, f.to, student);
      compare(label, oldD, newD);
      compareExports(label, oldD, newD);
    }
  }
};

const runDivergent = () => {
  const notes = [];
  for (const f of DIVERGENT) {
    const records = sortLikeEndpoint(f.records);
    const rosterIds = [...new Set(f.roster.map((s) => s._id))];
    const summary = referenceSummary(records, f.from, f.to, { student: "all", studentIds: rosterIds });
    const oldD = deriveOld(f.roster, records, f.from, f.to, "all");
    const newD = deriveNew(f.roster, summary, f.from, f.to, "all");
    currentCase = `divergent: ${f.name}`;
    for (const [what, ok] of f.expect(oldD, newD)) {
      checks++;
      if (!ok) failures.push(`${currentCase} :: documented behaviour not observed — ${what}`);
    }
    notes.push(`  ${f.name}`);
  }
  return notes;
};

// ─── Main ────────────────────────────────────────────────────────────────────
(async () => {
  await mongoose.connect(process.env.MONGOURI);
  console.log("Attendance Analytics — summary equivalence harness");
  if (BREAK) console.log(`\n!! --break=${BREAK}: ${BREAKERS[BREAK]}\n   this run is EXPECTED to fail.`);

  console.log("\nLive courses");
  const report = await runLive();
  report.forEach((r) => console.log(r));

  console.log("\nSynthetic fixtures");
  runSynthetic();
  FIXTURES.forEach((f) => console.log(`  ${f.name}`));

  console.log("\nDocumented divergences (unreachable in live data)");
  runDivergent().forEach((n) => console.log(n));

  console.log(`\n${checks} assertions, ${failures.length} failed`);
  if (failures.length) {
    const show = VERBOSE ? failures : failures.slice(0, 25);
    show.forEach((f) => console.log(`  ✗ ${f}`));
    if (failures.length > show.length) console.log(`  … ${failures.length - show.length} more (--verbose)`);
  } else {
    console.log("  ✓ every derived value identical");
  }
  await mongoose.disconnect();
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
