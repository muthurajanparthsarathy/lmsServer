// Attendance Report — equivalence harness for the server-side summary.
//
//     node scripts/verifyAttendanceReport.js
//     node scripts/verifyAttendanceReport.js --verbose
//     node scripts/verifyAttendanceReport.js --break=<name>   (see BREAKERS)
//
// Reads only. Nothing is written to any database.
//
// Sibling of scripts/verifyAttendanceAnalytics.js, and deliberately NOT a
// parameterisation of it: the two pages share an endpoint and share almost no
// derivation.
//
//     Analytics                        Report
//     ─────────────────────────────    ─────────────────────────────────────
//     denominator = CALENDAR days      denominator = WORKING days
//                                      (weekdays + any weekend day with marks)
//     no status filter                 status filter all / P / A / H / N,
//                                      which the SERVER also applies to perDay
//     charts over every day in range   charts over the working days only
//     no pagination                    5 rows a page, off the filtered list
//     no bands                         5-band performance scale, at-risk count,
//                                      top / bottom performer, best day
//
// AttendanceReportPage.tsx used to pull every attendance record in the range
// and build a studentId -> dayKey -> status grid in the browser purely to
// total it. The OLD derivation below is transcribed from that version, which
// still exists at backup/client/src/features/attendancemanagement/
// AttendanceReportPage.tsx — it is the ground truth this compares against:
//
//     workingDayList   the day columns, and every denominator on the page
//     filteredStudents the table's rows AND their order (pagination slices it)
//     rowStats         p / a / h / n / effPresent / attendance % / band per row
//     totals           P/A/H/N, totalCells, the four percentages, avgAttendance,
//                      bandCounts, top, low, atRisk
//     bestDay          the "Best Day" insight card
//     trend            the attendance-trend line chart
//     exports          the Excel sheet, its Summary & Insights sheet, and the
//                      PDF insight + body rows
//
// Both sides run against the REAL controllers (getAttendance for the old
// whole-range read, getAttendanceSummary for the new one) over the live
// database, so this compares implementations rather than two transcriptions.
//
// ── Why the summary request is scoped to the roster ─────────────────────────
// The page mixes two populations. `trend` and `bestDay` read `summary.perDay`,
// which counts RECORDS; `bestDay` then divides by `filteredStudents.length`,
// which counts ROSTER rows. Live, course SUN-BTB-SK-001 holds 150 records for
// 10 students while only 5 of those holders sit in any of its batches — the
// other 5 are Students dropped from the roster after being marked. So perDay
// reports ~10 marks a day against a 5-row denominator and "Best Day" reads
// 180% present. The endpoint's `studentIds=` param is what closes that gap:
// the page sends its roster and both sides of the division describe one
// population. SCOPED_OFF below is the same run with that scoping removed —
// i.e. the page exactly as it shipped — and it is expected to FAIL, on 526
// assertions, 35 of them a Best Day above 100%. That is what makes the
// paragraph above a measurement rather than an argument.
//
// ── ...and why the DAY list is not ─────────────────────────────────────────
// Scoping the whole summary to the roster would have taken the working-day
// list with it, and that list is a different kind of fact: `markedDays`
// answers "did a session happen on this date", which is a property of the
// CLASS, while the tallies and perDay answer "whose marks do we count". Tie
// them together and the page's denominator moves with its own filters — pick
// one student and a Saturday nobody marked THEM on stops being a working day,
// so the same student reads a higher percentage filtered than in the full
// table. getAttendanceSummary therefore matches twice: the day list sees every
// row in the window, the tallies and perDay stay scoped. --break=days_scoped
// reunites them and this run goes red.
//
// ── Coverage ────────────────────────────────────────────────────────────────
// Live: every course carrying records x ranges (full span, halves, single
// marked day, an unmarked day, a range with no marks, weekend-only, from > to,
// wide) x student filter ("all", each holder, a roster student with no records)
// x ALL FIVE status filters. The status filter is not decoration here: the
// server scopes perDay by it, so trend and bestDay change shape under it.
//
// Synthetic fixtures cover what live data has none of — verified absent by a
// probe over all 212 records and 5 courses: an empty roster, a zero-day range,
// off-roster holders outnumbering the roster, band boundaries landing exactly
// on 90 / 75 / 60 / 40, a weekend session attended only by since-removed
// students, and a Saturday one student was not marked on. Their summaries come
// from a reference generator that is itself asserted field-for-field against
// the real controller on every live case first, so the fixtures inherit that
// trust.
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
// A harness that passes proves nothing until it has been shown to fail. Each of
// these is a mistake that looks correct in a diff; --break=<name> injects it
// into the NEW derivation (or the request) and the run must go red.
const BREAKERS = {
  // THE one this harness was written for: drop the roster scoping and let
  // off-roster record holders back into perDay. This is the page as it
  // shipped, and it is why "Best Day" can read over 100%.
  scoped_off: "send no studentIds, letting off-roster holders into trend/bestDay",
  // Ask for the summary before the roster has arrived. `studentIds=` empty is
  // NOT "match nobody" — like the sibling list endpoint, an empty list is no
  // scope at all, so the whole course comes back.
  no_gate: "request the summary with an empty roster",
  // The Analytics page's denominator, pasted into this one.
  calendar_days: "count unmarked days against calendar days, not working days",
  // Off-by-one the other way: the marked days alone.
  marked_days: "use markedDays.length as the denominator",
  // Forget that a marked weekend day is a working day.
  weekend_never: "drop marked weekend days from the working-day list",
  // The trap the endpoint's own comment warns about: `summary.students` is
  // deliberately NOT status-filtered, because a roster student missing from it
  // is ambiguous — no records at all, or filtered out? Reading it as filtered
  // re-admits the students the server dropped.
  tallies_prefiltered: "treat summary.students as already status-filtered",
  // Status "N" as "holds no marks" rather than "has an unmarked working day".
  status_n_no_marks: "read status=N as holding no marks at all",
  // Half-days counted whole in the per-row percentage.
  half_whole: "count a half-day as a full present day",
  // Best Day against the whole roster instead of the filtered rows — the two
  // populations swapped the other way round.
  bestday_roster: "divide Best Day by the roster instead of the filtered rows",
  // Best Day counting a half-day as a whole one.
  bestday_half_whole: "count a half-day as fully present in Best Day",
  // Zero-fill mistake: a day missing from perDay is unmarked, not absent.
  missing_day_absent: "score days missing from perDay as absent",
  // Trend over every calendar day rather than the working days.
  trend_all_days: "draw the trend over calendar days",
  // Join tallies by array position instead of by studentId.
  positional_join: "join tallies to the roster positionally",
  // At-risk is strictly below 75.
  atrisk_inclusive: "count exactly 75% as at risk",
  // Undo the endpoint's two-match split: derive the working-day list from the
  // STUDENT-SCOPED rows, so the denominator moves with the filter.
  days_scoped: "derive markedDays from the scoped rows, narrowing the denominator",
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
  if (scope.status && scope.status !== "all") query.status = scope.status;
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
// never de-duplicated its table, and neither does this.
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

const fmt = (d) => {
  const day = d.getUTCDate();
  const mon = d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
  return `${String(day).padStart(2, "0")}-${mon}-${d.getUTCFullYear()}`;
};
const fmtWeekday = (d) => d.toLocaleString("en-GB", { weekday: "short", timeZone: "UTC" });
const fmtLabel = (d) =>
  d.toLocaleString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
const fmtNum = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
const isWeekend = (d) => d.getUTCDay() === 0 || d.getUTCDay() === 6;

const daysOf = (from, to) => {
  const start = parseKey(from);
  const end = parseKey(to);
  const out = [];
  for (let t = start.getTime(); t <= end.getTime(); t += MS_PER_DAY) out.push(new Date(t));
  return out;
};

// ─── The performance scale, transcribed from the page ────────────────────────
const BANDS = [
  { key: "excellent", label: "Excellent", min: 90, range: "90–100%" },
  { key: "good", label: "Good", min: 75, range: "75–89%" },
  { key: "average", label: "Average", min: 60, range: "60–74%" },
  { key: "poor", label: "Poor", min: 40, range: "40–59%" },
  { key: "critical", label: "Critical", min: 0, range: "Below 40%" },
];
const bandOf = (pct) => BANDS.find((b) => pct >= b.min) || BANDS[BANDS.length - 1];

const PAGE_SIZE = 5; // AttendanceReportPage.tsx: `const pageSize = 5`

// `totals` is one function of the rows on both sides — the page's memo is
// untouched by the change, only its input moves from a grid walk to a tally
// lookup. `side` exists so a breaker can damage the NEW side alone: damaging a
// shared path damages both, which is a harness that cannot fail.
const totalsOf = (filteredStudents, rowStats, side) => {
  let P = 0,
    A = 0,
    H = 0,
    N = 0;
  const perStudent = [];
  filteredStudents.forEach((s, i) => {
    const rs = rowStats(s._id, i);
    P += rs.p;
    A += rs.a;
    H += rs.h;
    N += rs.n;
    perStudent.push({ s, attPct: rs.attPct, effPresent: rs.effPresent });
  });
  const totalCells = P + A + H + N;
  const totalMarked = P + A + H;
  const bandCounts = BANDS.map((band) => ({
    band,
    count: perStudent.filter((x) => bandOf(x.attPct).key === band.key).length,
  }));
  const sorted = [...perStudent].sort((x, y) => y.attPct - x.attPct);
  const atRiskAt =
    side === "new" && broken("atrisk_inclusive") ? (v) => v <= 75 : (v) => v < 75;
  return {
    P,
    A,
    H,
    N,
    totalCells,
    totalMarked,
    pPct: totalMarked > 0 ? (P / totalMarked) * 100 : 0,
    aPct: totalMarked > 0 ? (A / totalMarked) * 100 : 0,
    hPct: totalMarked > 0 ? (H / totalMarked) * 100 : 0,
    nPct: totalCells > 0 ? (N / totalCells) * 100 : 0,
    avgAttendance: totalCells > 0 ? ((P + H * 0.5) / totalCells) * 100 : 0,
    bandCounts,
    top: sorted[0],
    low: sorted.length > 0 ? sorted[sorted.length - 1] : undefined,
    atRisk: perStudent.filter((x) => atRiskAt(x.attPct)).length,
  };
};

// ─── OLD: AttendanceReportPage.tsx before the change ─────────────────────────
// Transcribed from backup/client/src/features/attendancemanagement/
// AttendanceReportPage.tsx — the `grid` / `markedDayKeys` / `workingDayList` /
// `rowStats` / `visibleStudents` / `filteredStudents` / `totals` / `bestDay` /
// `trend` memos. `records` there is the WHOLE course's rows for the range
// (attendanceApi.list(courseId, from, to), no student scoping at all), which is
// why markedDayKeys below is course-wide.
const deriveOld = (students, records, from, to, appliedStudent, appliedStatus) => {
  const days = daysOf(from, to);

  // studentId -> dateKey -> status. A second record for the same cell
  // overwrites the first, which is why the fixtures below sort exactly as the
  // endpoint does (date asc, studentId asc).
  const grid = new Map();
  for (const r of records) {
    const sid = String(r.studentId);
    const dk = toDayKey(new Date(r.date));
    if (!grid.has(sid)) grid.set(sid, new Map());
    grid.get(sid).set(dk, r.status);
  }

  const markedDayKeys = new Set(records.map((r) => toDayKey(new Date(r.date))));
  const workingDayList = days.filter((d) => !isWeekend(d) || markedDayKeys.has(toDayKey(d)));
  const workingDays = workingDayList.length;

  const rowStats = (sid) => {
    let p = 0,
      a = 0,
      h = 0,
      n = 0;
    const row = grid.get(sid);
    for (const d of workingDayList) {
      const s = row?.get(toDayKey(d));
      if (s === "P") p++;
      else if (s === "A") a++;
      else if (s === "H") h++;
      else n++;
    }
    const effPresent = p + h * 0.5;
    const attPct = workingDays > 0 ? (effPresent / workingDays) * 100 : 0;
    return { p, a, h, n, effPresent, attPct, band: bandOf(attPct) };
  };

  const visibleStudents =
    appliedStudent === "all" ? students : students.filter((s) => s._id === appliedStudent);

  const filteredStudents =
    appliedStatus === "all"
      ? visibleStudents
      : visibleStudents.filter((s) => {
          const row = grid.get(s._id);
          return workingDayList.some((d) => {
            const st = row?.get(toDayKey(d));
            if (appliedStatus === "N") return !st;
            return st === appliedStatus;
          });
        });

  let bestDay = null;
  for (const d of workingDayList) {
    const dk = toDayKey(d);
    let present = 0;
    for (const s of filteredStudents) {
      const st = grid.get(s._id)?.get(dk);
      if (st === "P") present++;
      else if (st === "H") present += 0.5;
    }
    const pct = filteredStudents.length > 0 ? (present / filteredStudents.length) * 100 : 0;
    if (present > 0 && (!bestDay || pct > bestDay.pct)) bestDay = { d, pct };
  }

  const trend = workingDayList.map((d) => {
    const dk = toDayKey(d);
    let P = 0,
      A = 0,
      H = 0;
    for (const s of filteredStudents) {
      const st = grid.get(s._id)?.get(dk);
      if (st === "P") P++;
      else if (st === "A") A++;
      else if (st === "H") H++;
    }
    return { label: fmtLabel(d), Present: P, Absent: A, "Half-day": H };
  });

  return {
    days,
    workingDayList,
    workingDays,
    visibleStudents,
    filteredStudents,
    rows: filteredStudents.map((s) => ({ s, ...rowStats(s._id) })),
    totals: totalsOf(filteredStudents, rowStats, "old"),
    bestDay,
    trend,
  };
};

// ─── NEW: the derivation the page runs off the summary ───────────────────────
const deriveNew = (students, summary, from, to, appliedStudent, appliedStatus) => {
  const days = daysOf(from, to);

  const markedDayKeys = new Set(summary.markedDays || []);
  const workingDayList = days.filter(
    (d) => !isWeekend(d) || (broken("weekend_never") ? false : markedDayKeys.has(toDayKey(d)))
  );
  // The denominator every row, band and export cell is taken from.
  let workingDays = workingDayList.length;
  if (broken("calendar_days")) workingDays = days.length;
  if (broken("marked_days")) workingDays = (summary.markedDays || []).length;

  // studentId -> P/A/H. The tallies are NOT status-filtered — a roster student
  // the summary never mentions holds no records at all, which is the only way
  // the "N" rule below can admit them.
  const tallyById = new Map();
  for (const t of summary.students || []) tallyById.set(t.studentId, { p: t.p, a: t.a, h: t.h });

  // `i` is the row's position, which is all `positional_join` needs to be the
  // mistake it imitates: joining the tally array to the roster by index.
  const tallyAt = (sid, i) =>
    broken("positional_join")
      ? (summary.students || [])[i] || { p: 0, a: 0, h: 0 }
      : tallyById.get(sid) || { p: 0, a: 0, h: 0 };

  const rowStats = (sid, i) => {
    const t = tallyAt(sid, i);
    const p = t.p,
      a = t.a,
      h = t.h;
    const n = Math.max(0, workingDays - (p + a + h));
    const effPresent = p + h * (broken("half_whole") ? 1 : 0.5);
    const attPct = workingDays > 0 ? (effPresent / workingDays) * 100 : 0;
    return { p, a, h, n, effPresent, attPct, band: bandOf(attPct) };
  };

  const visibleStudents =
    appliedStudent === "all" ? students : students.filter((s) => s._id === appliedStudent);

  const filteredStudents =
    appliedStatus === "all"
      ? visibleStudents
      : visibleStudents.filter((s, i) => {
          if (broken("tallies_prefiltered") && !tallyById.has(s._id)) return false;
          const t = tallyAt(s._id, i);
          if (appliedStatus === "P") return t.p > 0;
          if (appliedStatus === "A") return t.a > 0;
          if (appliedStatus === "H") return t.h > 0;
          if (appliedStatus === "N") {
            return broken("status_n_no_marks")
              ? t.p + t.a + t.h === 0
              : workingDays - (t.p + t.a + t.h) > 0;
          }
          return true;
        });

  const perDayMap = new Map();
  for (const d of summary.perDay || []) perDayMap.set(d.key, { P: d.P, A: d.A, H: d.H });

  let bestDay = null;
  for (const d of workingDayList) {
    const c = perDayMap.get(toDayKey(d));
    const present = (c?.P || 0) + (c?.H || 0) * (broken("bestday_half_whole") ? 1 : 0.5);
    const denom = broken("bestday_roster") ? students.length : filteredStudents.length;
    const pct = denom > 0 ? (present / denom) * 100 : 0;
    if (present > 0 && (!bestDay || pct > bestDay.pct)) bestDay = { d, pct };
  }

  const trend = (broken("trend_all_days") ? days : workingDayList).map((d) => {
    const c = perDayMap.get(toDayKey(d));
    return {
      label: fmtLabel(d),
      Present: c?.P || 0,
      Absent: broken("missing_day_absent") && !c ? filteredStudents.length : c?.A || 0,
      "Half-day": c?.H || 0,
    };
  });

  return {
    days,
    workingDayList,
    workingDays,
    visibleStudents,
    filteredStudents,
    rows: filteredStudents.map((s, i) => ({ s, ...rowStats(s._id, i) })),
    totals: totalsOf(filteredStudents, rowStats, "new"),
    bestDay,
    trend,
  };
};

// ─── Reference summary — the endpoint's contract, for synthetic fixtures ─────
// Asserted field-for-field against the real controller on every live case.
const referenceSummary = (records, from, to, scope = {}, opts = {}) => {
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

  // `markedDays` asks whether a session happened, which is a property of the
  // class rather than of the filter — so it reads dayRows. opts.daysFromScopedRows
  // reproduces the older contract, where it read the scoped rows instead.
  const daySource = opts.daysFromScopedRows ? rows : dayRows;
  const markedDays = [...new Set(daySource.map((r) => toDayKey(new Date(r.date))))].sort();
  const markedSet = new Set(markedDays);

  const workingDayKeys = [];
  if (fromDay && toDay) {
    for (let t = fromDay.getTime(); t <= toDay.getTime(); t += MS_PER_DAY) {
      const d = new Date(t);
      const k = toDayKey(d);
      if (!isWeekend(d) || markedSet.has(k)) workingDayKeys.push(k);
    }
  }
  const workingDays = workingDayKeys.length;

  const perStudent = new Map();
  for (const r of rows) {
    const sid = String(r.studentId);
    if (!perStudent.has(sid)) perStudent.set(sid, { studentId: sid, p: 0, a: 0, h: 0 });
    const t = perStudent.get(sid);
    if (r.status === "P") t.p++;
    else if (r.status === "A") t.a++;
    else if (r.status === "H") t.h++;
  }

  // The status filter, as the server applies it: over the tallies, and only to
  // decide which students the per-day series is summed over. The tallies
  // themselves come back whole.
  const status = scope.status;
  const passes = (s) => {
    if (!status || status === "all") return true;
    if (status === "P") return s.p > 0;
    if (status === "A") return s.a > 0;
    if (status === "H") return s.h > 0;
    if (status === "N") return s.p + s.a + s.h < workingDays;
    return true;
  };
  const keep = new Set([...perStudent.values()].filter(passes).map((s) => s.studentId));

  const perDay = new Map();
  for (const r of rows) {
    if (!keep.has(String(r.studentId))) continue;
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
    workingDays,
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

// --break=days_scoped: hand the page a summary whose day list was derived from
// the student-scoped rows — the endpoint before its two-match split. Applied
// AFTER the contract assertions, so the breaker damages the page's derivation
// rather than making the controller look like it disagrees with the reference.
const narrowDays = (summary, records, from, to, scope) => {
  if (!broken("days_scoped")) return summary;
  const pre = referenceSummary(records, from, to, scope, { daysFromScopedRows: true });
  return {
    ...summary,
    markedDays: pre.markedDays,
    workingDayKeys: pre.workingDayKeys,
    workingDays: pre.workingDays,
  };
};

// ─── Assertions ──────────────────────────────────────────────────────────────
let checks = 0;
let failures = [];
let currentCase = "";

const eq = (label, a, b) => {
  checks++;
  const same =
    Object.is(a, b) ||
    (typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 1e-9);
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

  // The day columns and the denominator printed beside every percentage.
  eq("workingDays", oldD.workingDays, newD.workingDays);
  eqDeep("workingDayList", oldD.workingDayList.map(toDayKey), newD.workingDayList.map(toDayKey));

  // The table's rows AND their order — pagination slices this list.
  eqDeep(
    "filteredStudents",
    oldD.filteredStudents.map((s) => s._id),
    newD.filteredStudents.map((s) => s._id)
  );
  eq("filteredStudents.length", oldD.filteredStudents.length, newD.filteredStudents.length);
  eqDeep(
    "visibleStudents",
    oldD.visibleStudents.map((s) => s._id),
    newD.visibleStudents.map((s) => s._id)
  );

  const rows = Math.min(oldD.rows.length, newD.rows.length);
  for (let i = 0; i < rows; i++) {
    const o = oldD.rows[i];
    const n = newD.rows[i];
    eq(`row[${i}].id`, o.s._id, n.s._id);
    eq(`row[${i}].p`, o.p, n.p);
    eq(`row[${i}].a`, o.a, n.a);
    eq(`row[${i}].h`, o.h, n.h);
    eq(`row[${i}].n`, o.n, n.n);
    eq(`row[${i}].effPresent`, o.effPresent, n.effPresent);
    eq(`row[${i}].attPct`, o.attPct, n.attPct);
    // What the cell actually paints, and the colour band behind it.
    eq(`row[${i}].attPct.toFixed`, o.attPct.toFixed(2), n.attPct.toFixed(2));
    eq(`row[${i}].band`, o.band.key, n.band.key);
    eq(
      `row[${i}].fraction`,
      `${fmtNum(o.effPresent)}/${oldD.workingDays} days`,
      `${fmtNum(n.effPresent)}/${newD.workingDays} days`
    );
  }

  for (const k of ["P", "A", "H", "N", "totalCells", "totalMarked", "avgAttendance", "atRisk"]) {
    eq(`totals.${k}`, oldD.totals[k], newD.totals[k]);
  }
  for (const k of ["pPct", "aPct", "hPct", "nPct", "avgAttendance"]) {
    eq(`totals.${k}.toFixed`, oldD.totals[k].toFixed(2), newD.totals[k].toFixed(2));
  }
  eq(
    "totals.avgAttendance.band",
    bandOf(oldD.totals.avgAttendance).label,
    bandOf(newD.totals.avgAttendance).label
  );
  eqDeep(
    "totals.bandCounts",
    oldD.totals.bandCounts.map((b) => [b.band.key, b.count]),
    newD.totals.bandCounts.map((b) => [b.band.key, b.count])
  );
  // The distribution bar's width per band.
  const bandBars = (d) =>
    d.totals.bandCounts.map((b) =>
      d.filteredStudents.length > 0
        ? ((b.count / d.filteredStudents.length) * 100).toFixed(1)
        : "0.0"
    );
  eqDeep("bandCounts.barWidths", bandBars(oldD), bandBars(newD));

  const card = (x, wd) =>
    x
      ? `${x.s.firstName} ${x.s.lastName}`.trim() +
        ` — ${x.attPct.toFixed(1)}% (${fmtNum(x.effPresent)}/${wd} days)`
      : "—";
  eq("totals.top", card(oldD.totals.top, oldD.workingDays), card(newD.totals.top, newD.workingDays));
  eq("totals.low", card(oldD.totals.low, oldD.workingDays), card(newD.totals.low, newD.workingDays));
  eq("totals.top.id", oldD.totals.top?.s._id ?? null, newD.totals.top?.s._id ?? null);
  eq("totals.low.id", oldD.totals.low?.s._id ?? null, newD.totals.low?.s._id ?? null);

  // The Best Day card — the insight the roster scoping exists for.
  eq(
    "bestDay.day",
    oldD.bestDay ? toDayKey(oldD.bestDay.d) : null,
    newD.bestDay ? toDayKey(newD.bestDay.d) : null
  );
  eq("bestDay.pct", oldD.bestDay?.pct ?? null, newD.bestDay?.pct ?? null);
  eq(
    "bestDay.rendered",
    oldD.bestDay
      ? `${fmt(oldD.bestDay.d)} (${fmtWeekday(oldD.bestDay.d)}) — ${oldD.bestDay.pct.toFixed(1)}% present`
      : "—",
    newD.bestDay
      ? `${fmt(newD.bestDay.d)} (${fmtWeekday(newD.bestDay.d)}) — ${newD.bestDay.pct.toFixed(1)}% present`
      : "—"
  );
  // A present ratio over 100% is the visible symptom of the two populations
  // disagreeing. Asserted directly, so the harness names the bug rather than
  // only noticing that two numbers differ.
  checks++;
  if (newD.bestDay && newD.bestDay.pct > 100 + 1e-9) {
    failures.push(`${currentCase} :: bestDay.pct exceeds 100% — ${newD.bestDay.pct.toFixed(1)}%`);
  }

  eq("trend.length", oldD.trend.length, newD.trend.length);
  const tn = Math.min(oldD.trend.length, newD.trend.length);
  for (let i = 0; i < tn; i++) eqDeep(`trend[${i}]`, oldD.trend[i], newD.trend[i]);

  // Pagination — the page slices filteredStudents five at a time.
  const totalPages = (d) => Math.max(1, Math.ceil(d.filteredStudents.length / PAGE_SIZE));
  eq("totalPages", totalPages(oldD), totalPages(newD));
  for (let pg = 1; pg <= Math.min(totalPages(oldD), totalPages(newD)); pg++) {
    eqDeep(
      `page[${pg}].ids`,
      oldD.filteredStudents.slice((pg - 1) * PAGE_SIZE, pg * PAGE_SIZE).map((s) => s._id),
      newD.filteredStudents.slice((pg - 1) * PAGE_SIZE, pg * PAGE_SIZE).map((s) => s._id)
    );
  }
};

// The exports read the same memos, so most cells need no separate comparison —
// but the ones that are FORMATTED rather than copied do, and the Excel sheet
// has one column per working day.
const compareExports = (label, oldD, newD) => {
  currentCase = `${label} :: export`;

  const header = (d) => [
    "#",
    "Student Name",
    "Roll No.",
    "Email",
    ...d.workingDayList.map((x) => `${fmt(x)} (${fmtWeekday(x)})`),
    "Working Days",
    "Days Present",
    "Absent",
    "Half-day",
    "Not Marked",
    "Attendance %",
    "Performance",
  ];
  eqDeep("xlsx.header", header(oldD), header(newD));

  // The per-student rows, minus the day cells — those come from the records the
  // export re-fetches, which this change does not touch.
  const body = (d) =>
    d.rows.map((r, i) => [
      i + 1,
      `${r.s.firstName} ${r.s.lastName}`.trim() || "—",
      r.s.userId || "",
      r.s.email || "",
      d.workingDays,
      r.p,
      r.a,
      r.h,
      r.n,
      `${r.attPct.toFixed(2)}% (${fmtNum(r.effPresent)}/${d.workingDays})`,
      r.band.label,
    ]);
  eqDeep("xlsx.body", body(oldD), body(newD));

  const insights = (d) => [
    ["Total Working Days", d.workingDays],
    ["Total Students", d.filteredStudents.length],
    [
      "Class Average Attendance",
      `${d.totals.avgAttendance.toFixed(2)}% (${bandOf(d.totals.avgAttendance).label})`,
    ],
    ["Total Present Marks", d.totals.P],
    ["Total Absent Marks", d.totals.A],
    ["Total Half-day Marks", d.totals.H],
    ["Not Marked Cells", d.totals.N],
    ["Students At Risk (< 75%)", d.totals.atRisk],
    [
      "Top Performer",
      d.totals.top
        ? `${d.totals.top.s.firstName} ${d.totals.top.s.lastName}`.trim() +
          ` — ${d.totals.top.attPct.toFixed(1)}% (${fmtNum(d.totals.top.effPresent)}/${d.workingDays} days)`
        : "—",
    ],
    [
      "Needs Attention",
      d.totals.low
        ? `${d.totals.low.s.firstName} ${d.totals.low.s.lastName}`.trim() +
          ` — ${d.totals.low.attPct.toFixed(1)}% (${fmtNum(d.totals.low.effPresent)}/${d.workingDays} days)`
        : "—",
    ],
    [
      "Best Day",
      d.bestDay
        ? `${fmt(d.bestDay.d)} (${fmtWeekday(d.bestDay.d)}) — ${d.bestDay.pct.toFixed(1)}% present`
        : "—",
    ],
    ...d.totals.bandCounts.map(({ band, count }) => [
      `${band.label} (${band.range})`,
      `${count} student${count === 1 ? "" : "s"}`,
    ]),
  ];
  eqDeep("xlsx.summarySheet", insights(oldD), insights(newD));

  const pdfInsights = (d) => [
    String(d.workingDays),
    String(d.filteredStudents.length),
    `${d.totals.avgAttendance.toFixed(2)}% (${bandOf(d.totals.avgAttendance).label})`,
    String(d.totals.atRisk),
    d.totals.top
      ? `${d.totals.top.s.firstName} ${d.totals.top.s.lastName}`.trim() +
        ` — ${d.totals.top.attPct.toFixed(1)}%`
      : "—",
    d.totals.low
      ? `${d.totals.low.s.firstName} ${d.totals.low.s.lastName}`.trim() +
        ` — ${d.totals.low.attPct.toFixed(1)}%`
      : "—",
    d.bestDay ? `${fmt(d.bestDay.d)} — ${d.bestDay.pct.toFixed(1)}%` : "—",
  ];
  eqDeep("pdf.insights", pdfInsights(oldD), pdfInsights(newD));

  const pdfBody = (d) =>
    d.rows.map((r, i) => [
      i + 1,
      r.s.userId || "",
      `${r.s.firstName} ${r.s.lastName}`.trim() || "—",
      d.workingDays,
      r.p,
      r.a,
      r.h,
      r.n,
      `${r.attPct.toFixed(2)}%  (${fmtNum(r.effPresent)}/${d.workingDays})`,
      r.band.label,
    ]);
  eqDeep("pdf.body", pdfBody(oldD), pdfBody(newD));
};

// ─── Live cases ──────────────────────────────────────────────────────────────
const STATUSES = ["all", "P", "A", "H", "N"];
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
  // A weekend window — this page's working-day rule turns on exactly this.
  const sat = markedKeys.find((k) => isWeekend(parseKey(k)));
  if (sat) {
    out.push(["marked weekend day only", sat, sat]);
    // The marked weekend day beside an unmarked one: the denominator must be
    // 1 and not 2.
    out.push(["marked weekend + its neighbour", addDaysKey(sat, -1), sat]);
  }
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
        for (const status of STATUSES) {
          const scope = { student, status, studentIds: broken("scoped_off") ? [] : rosterIds };
          const summary = summaryEnabled(rosterIds)
            ? await fetchSummary(courseId, from, to, scope)
            : EMPTY_SUMMARY;

          // The reference generator earns the synthetic fixtures' trust here.
          const short = student === "all" ? "all" : student.slice(-6);
          currentCase = `${name} / ${rangeName} / student=${short} / status=${status} :: summary contract`;
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

          const label = `${name} / ${rangeName} / student=${short} / status=${status}`;
          const oldD = deriveOld(roster, records, from, to, student, status);
          const newD = deriveNew(
            roster,
            narrowDays(summary, records, from, to, scope),
            from,
            to,
            student,
            status
          );
          compare(label, oldD, newD);
          compareExports(label, oldD, newD);
          cases++;
        }
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
const mkStudent = (n) => ({
  _id: oid(n),
  firstName: `S${n}`,
  lastName: "T",
  email: `s${n}@x.io`,
  userId: `R${n}`,
});
// The list endpoint sorts date asc, studentId asc — the fixtures must too,
// because the old grid's last-write-wins depends on that order.
const sortLikeEndpoint = (recs) =>
  [...recs].sort((a, b) => a.date - b.date || (String(a.studentId) < String(b.studentId) ? -1 : 1));
const rec = (sid, key, status) => ({ studentId: oid(sid), date: parseKey(key), status });

// 2026-03-02 is a Monday; 03-07/03-08 and 03-14/03-15 are the weekends.
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
    name: "off-roster holders on the same days (the live SUN-BTB-SK-001 shape)",
    from: "2026-03-02",
    to: "2026-03-04",
    roster: [1, 2].map(mkStudent),
    records: [
      rec(1, "2026-03-02", "P"),
      rec(2, "2026-03-02", "A"),
      rec(8, "2026-03-02", "P"),
      rec(9, "2026-03-02", "P"),
      rec(1, "2026-03-03", "P"),
      rec(8, "2026-03-03", "H"),
      rec(2, "2026-03-04", "H"),
      rec(9, "2026-03-04", "A"),
    ],
  },
  {
    name: "off-roster holders outnumbering the roster 3:1",
    from: "2026-03-02",
    to: "2026-03-03",
    roster: [1].map(mkStudent),
    records: [
      rec(1, "2026-03-02", "P"),
      rec(7, "2026-03-02", "P"),
      rec(8, "2026-03-02", "P"),
      rec(9, "2026-03-02", "P"),
      rec(1, "2026-03-03", "H"),
      rec(7, "2026-03-03", "H"),
    ],
  },
  {
    name: "marked weekend inside the range (the working-day rule)",
    from: "2026-03-06",
    to: "2026-03-09",
    roster: [1, 2].map(mkStudent),
    records: [rec(1, "2026-03-07", "P"), rec(2, "2026-03-07", "A"), rec(1, "2026-03-09", "P")],
  },
  {
    name: "both weekend days marked, a later one not",
    from: "2026-03-06",
    to: "2026-03-16",
    roster: [1, 2, 3].map(mkStudent),
    records: [
      rec(1, "2026-03-07", "P"),
      rec(2, "2026-03-08", "H"),
      rec(3, "2026-03-09", "A"),
      rec(1, "2026-03-14", "P"),
      rec(2, "2026-03-16", "P"),
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
    name: "half-days only — the half weighting",
    from: "2026-03-02",
    to: "2026-03-05",
    roster: [1, 2].map(mkStudent),
    records: [rec(1, "2026-03-02", "H"), rec(1, "2026-03-03", "H"), rec(2, "2026-03-02", "H")],
  },
  {
    name: "a full house — everyone present every working day",
    from: "2026-03-02",
    to: "2026-03-04",
    roster: [1, 2].map(mkStudent),
    records: ["2026-03-02", "2026-03-03", "2026-03-04"].flatMap((k) => [
      rec(1, k, "P"),
      rec(2, k, "P"),
    ]),
  },
  {
    name: "band boundaries — 90 / 75 / 60 / 40 exactly, over ten working days",
    from: "2026-03-02",
    to: "2026-03-13",
    roster: [1, 2, 3, 4, 5].map(mkStudent),
    records: (() => {
      const wd = [
        "2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06",
        "2026-03-09", "2026-03-10", "2026-03-11", "2026-03-12", "2026-03-13",
      ];
      const give = (sid, presents) => wd.slice(0, presents).map((k) => rec(sid, k, "P"));
      // 9/10 = 90 · 7P+1H = 7.5/10 = 75 · 6/10 = 60 · 4/10 = 40 · 3/10 = 30.
      return [
        ...give(1, 9),
        ...give(2, 7),
        rec(2, wd[7], "H"),
        ...give(3, 6),
        ...give(4, 4),
        ...give(5, 3),
      ];
    })(),
  },
  {
    name: "seven students, more than one page (pagination slice)",
    from: "2026-03-02",
    to: "2026-03-04",
    roster: [1, 2, 3, 4, 5, 6, 7].map(mkStudent),
    records: [1, 2, 3, 4, 5, 6, 7].flatMap((s) => [
      rec(s, "2026-03-02", s % 3 === 0 ? "A" : s % 3 === 1 ? "P" : "H"),
      rec(s, "2026-03-03", s % 2 === 0 ? "P" : "A"),
    ]),
  },
  {
    name: "one student per status, so every status filter keeps a different row",
    from: "2026-03-02",
    to: "2026-03-03",
    roster: [1, 2, 3, 4].map(mkStudent),
    // 4 holds nothing: only status=N keeps it.
    records: [
      rec(1, "2026-03-02", "P"), rec(1, "2026-03-03", "P"),
      rec(2, "2026-03-02", "A"), rec(2, "2026-03-03", "A"),
      rec(3, "2026-03-02", "H"), rec(3, "2026-03-03", "H"),
    ],
  },
  {
    name: "weekend session attended only by since-removed students",
    from: "2026-03-06",
    to: "2026-03-09",
    roster: [1, 2].map(mkStudent),
    records: [
      rec(1, "2026-03-06", "P"),
      rec(2, "2026-03-06", "P"),
      rec(8, "2026-03-07", "P"), // Saturday, an off-roster holder only
      rec(1, "2026-03-09", "P"),
      rec(2, "2026-03-09", "P"),
    ],
    // The session happened, so the Saturday is a working day for the roster
    // too — and everyone on it goes down as unmarked. Scoping the day list to
    // the roster would drop the day and quietly raise everybody's percentage.
  },
  {
    name: "a Saturday one student was not marked on (denominator vs student filter)",
    from: "2026-03-06",
    to: "2026-03-09",
    roster: [1, 2].map(mkStudent),
    records: [
      rec(1, "2026-03-07", "P"), // Saturday: student 1 only
      rec(1, "2026-03-09", "P"),
      rec(2, "2026-03-09", "P"),
    ],
    // Selecting student 2 must not shrink the class's working days. The
    // fixture runner sweeps every student filter, so this asserts that the
    // same student reads the same percentage filtered and unfiltered.
  },
  {
    name: "fully-marked students — status=N must keep nobody",
    from: "2026-03-02",
    to: "2026-03-03",
    roster: [1, 2].map(mkStudent),
    records: [
      rec(1, "2026-03-02", "P"), rec(1, "2026-03-03", "A"),
      rec(2, "2026-03-02", "H"), rec(2, "2026-03-03", "P"),
    ],
  },
];

// Fixtures whose two sides are KNOWN to differ, with the difference asserted
// rather than waved at. Both come from one thing — the unique index is per
// BATCH, so a student sitting in two batches of one course is two roster rows
// that can carry two marks for a single day — and both are unreachable in the
// live database, where a probe over all 212 records and 5 courses found 0
// duplicate (student, day) pairs and 0 duplicate roster entries. They are
// written down here so a future reader meets the behaviour as a decision
// rather than as a surprise.
const DIVERGENT = [
  {
    name: "two marks for one student-day, one per batch",
    from: "2026-03-02",
    to: "2026-03-03",
    roster: [mkStudent(1), mkStudent(2)],
    records: [rec(1, "2026-03-02", "P"), rec(1, "2026-03-02", "A"), rec(2, "2026-03-02", "P")],
    // The unique index is per BATCH, so a student in two batches of one course
    // can carry two marks for a day. The old grid kept the last write for the
    // cell; the tally counts both records.
    expect: (oldD, newD) => [
      ["old grid keeps one mark for the cell", oldD.rows[0].p + oldD.rows[0].a === 1],
      ["new tally counts both records", newD.rows[0].p + newD.rows[0].a === 2],
      ["new unmarked count stays non-negative", newD.rows[0].n >= 0],
      ["new percentage stays inside 100%", newD.rows[0].attPct <= 100],
    ],
  },
  {
    name: "student enrolled in two batches (duplicate roster entry)",
    from: "2026-03-02",
    to: "2026-03-03",
    roster: [mkStudent(1), mkStudent(2), mkStudent(1)],
    records: [rec(1, "2026-03-02", "P"), rec(2, "2026-03-02", "A")],
    // The table walks the roster and looks each entry up, so both sides list
    // the duplicate twice and their totals agree. The charts read per-day
    // counts, which count the RECORD once — so the old trend shows 2 Present
    // and the new one 1.
    expect: (oldD, newD) => [
      ["both list three rows", oldD.rows.length === 3 && newD.rows.length === 3],
      ["totals agree", oldD.totals.totalCells === newD.totals.totalCells],
      ["old trend double-counts the duplicate", oldD.trend[0].Present === 2],
      ["new trend counts the record once", newD.trend[0].Present === 1],
      ["neither Best Day exceeds 100%", (oldD.bestDay?.pct ?? 0) <= 100 && (newD.bestDay?.pct ?? 0) <= 100],
    ],
  },
];

const runSynthetic = () => {
  for (const f of FIXTURES) {
    const records = sortLikeEndpoint(f.records);
    const rosterIds = [...new Set(f.roster.map((s) => s._id))];
    const filters = ["all", ...rosterIds];
    for (const student of filters) {
      for (const status of STATUSES) {
        const scope = { student, status, studentIds: broken("scoped_off") ? [] : rosterIds };
        const summary = summaryEnabled(rosterIds)
          ? referenceSummary(records, f.from, f.to, scope)
          : EMPTY_SUMMARY;
        const label =
          `fixture: ${f.name} / student=${student === "all" ? "all" : student.slice(-2)}` +
          ` / status=${status}`;
        const oldD = deriveOld(f.roster, records, f.from, f.to, student, status);
        const newD = deriveNew(
          f.roster,
          narrowDays(summary, records, f.from, f.to, scope),
          f.from,
          f.to,
          student,
          status
        );
        compare(label, oldD, newD);
        compareExports(label, oldD, newD);
      }
    }
  }
};

const runDivergent = () => {
  const notes = [];
  for (const f of DIVERGENT) {
    const records = sortLikeEndpoint(f.records);
    const rosterIds = [...new Set(f.roster.map((s) => s._id))];
    const student = f.student || "all";
    const scope = { student, status: "all", studentIds: rosterIds };
    const summary = referenceSummary(records, f.from, f.to, scope);
    const oldD = deriveOld(f.roster, records, f.from, f.to, student, "all");
    const newD = deriveNew(f.roster, summary, f.from, f.to, student, "all");
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
  console.log("Attendance Report — summary equivalence harness");
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
  // NOT process.exit(): it drops buffered stdout when the run is piped, which
  // silently truncates the failure list this whole script exists to print.
  process.exitCode = failures.length ? 1 : 0;
})().catch((e) => {
  console.error(e);
  process.exitCode = 2;
});
