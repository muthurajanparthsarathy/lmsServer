/**
 * updateTrainersTN.js — follow-up to seedTamilNaduBatchData.js (2026-08-04):
 * split the 10 TN-* courses across THREE trainers instead of one.
 *
 *   Ravi Shankar  (existing)  -> TN-PY-101, TN-PY-102, TN-PY-103, TN-PY-104
 *   Deepa Venkatesan (new)    -> TN-PY-105, TN-JV-201, TN-WD-202
 *   Mohan Raj (new)           -> TN-DB-203, TN-SS-204, TN-CL-205
 *
 * Also: feedback forms of TN-PY-105 / TN-DB-203 re-attributed to their new
 * trainer, and bt.s14's TN-DB-203 evaluation re-issued by Mohan.
 * All through the REST APIs with the state file's tokens. Idempotent-ish:
 * add-participants tolerates re-adds; unenrol of an absent user 404s (ignored).
 *
 * Usage: SEED_STATE_FILE=<path outside server/> node scripts/updateTrainersTN.js
 */
const fs = require("fs");
const path = require("path");

const BASE = "http://localhost:5533";
const ROLE_TRAINER = "6a4f8d93aeb945453e9bc06d";
const STATE_FILE = process.env.SEED_STATE_FILE ||
  path.join(require("os").tmpdir(), "seed-tn-state.json");
const ADMIN_TOKEN_FILE = process.env.ADMIN_TOKEN_FILE;

const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const NEW_TRAINERS = [
  { key: "trainer2", email: "trainer.deepa@batchdemo.in", firstName: "Deepa", lastName: "Venkatesan", phone: "9840010002", password: "Trainer@123" },
  { key: "trainer3", email: "trainer.mohan@batchdemo.in", firstName: "Mohan", lastName: "Raj", phone: "9840010003", password: "Trainer@123" },
];
// courseCode -> trainer userKey (Ravi = 'trainer')
const COURSE_TRAINER = {
  "TN-PY-101": "trainer", "TN-PY-102": "trainer", "TN-PY-103": "trainer", "TN-PY-104": "trainer",
  "TN-PY-105": "trainer2", "TN-JV-201": "trainer2", "TN-WD-202": "trainer2",
  "TN-DB-203": "trainer3", "TN-SS-204": "trainer3", "TN-CL-205": "trainer3",
};
const ENROLMENT_BATCHES = {
  "TN-PY-101": ["Batch A", "Batch B"], "TN-PY-102": ["Default"], "TN-PY-103": ["Batch 1"],
  "TN-PY-104": ["Default"], "TN-PY-105": ["Batch A"], "TN-JV-201": ["Default"],
  "TN-WD-202": ["Batch 1", "Batch 2"], "TN-DB-203": ["Default"], "TN-SS-204": ["Batch A"],
  "TN-CL-205": ["Batch 1"],
};
const TRAINER_PERMS = [
  { permissionName: "Staff Dashboard", permissionKey: "dashboard", permissionFunctionality: ["view_users", "add_users", "edit_users", "delete_users"], icon: "Home", color: "green", isActive: true, order: 0 },
  { permissionName: "Course", permissionKey: "courses", permissionFunctionality: [], icon: "BookOpen", color: "red", isActive: true, order: 1 },
  { permissionName: "Notifications", permissionKey: "notifications", permissionFunctionality: [], icon: "Bell", color: "gray", isActive: true, order: 2 },
  { permissionName: "Grades", permissionKey: "grades", permissionFunctionality: [], icon: "GraduationCap", color: "green", isActive: true, order: 3 },
  { permissionName: "profile", permissionKey: "profile", permissionFunctionality: [], icon: "GraduationCap", color: "green", isActive: true, order: 4 },
  { permissionName: "Attendance Management", permissionKey: "attendancemanagement", permissionFunctionality: [], icon: "UserCheck", color: "purple", isActive: true, order: 5 },
];

async function api(method, p, body, token, okExtra = []) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(BASE + p, {
        method,
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      if (attempt >= 4) throw new Error(`${method} ${p} -> network failure: ${e.message}`);
      await new Promise(r => setTimeout(r, 3000));
      continue;
    }
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok && !okExtra.includes(res.status)) {
      const msg = json ? JSON.stringify(json).slice(0, 400) : res.statusText;
      throw new Error(`${method} ${p} -> ${res.status}: ${msg}`);
    }
    return { status: res.status, json };
  }
}

async function login(email, password) {
  for (let i = 0; i < 3; i++) {
    const r = await api("POST", "/user/login", { email, password }, null, [400, 401, 403, 404, 500]);
    if (r.status === 201 && r.json?.token) return r.json.token;
    await new Promise(r2 => setTimeout(r2, 1500));
  }
  throw new Error(`login failed for ${email}`);
}

(async () => {
  const admin = fs.readFileSync(ADMIN_TOKEN_FILE, "utf8").trim();

  // 1 ─ create the two new trainers (+permissions +login)
  for (const t of NEW_TRAINERS) {
    if (!state.users[t.key]?.id) {
      const r = await api("POST", "/add/users", {
        email: t.email, firstName: t.firstName, lastName: t.lastName,
        password: t.password, phone: t.phone, role: ROLE_TRAINER, gender: "", status: "active",
      }, admin, [403]);
      if (r.status === 403) throw new Error(`${t.email} already exists but not in state — resolve manually`);
      state.users[t.key] = { id: r.json.user._id, email: t.email, password: t.password, name: `${t.firstName} ${t.lastName}`, client: null, role: "Trainer" };
      log(`trainer created: ${t.email} (${r.json.user.userId})`);
      save();
    } else log(`trainer exists: ${t.email}`);
  }
  await api("PUT", "/user-permission/bulk-update", {
    userPermissions: NEW_TRAINERS.map(t => ({ userId: state.users[t.key].id, permissions: TRAINER_PERMS })),
  }, admin);
  log("permissions set for new trainers");
  for (const t of NEW_TRAINERS) {
    state.tokens[t.key] = await login(t.email, t.password);
    log(`login ok: ${t.email}`);
  }
  save();

  // 2 ─ enrol the new trainer into every batch of their courses, then remove Ravi
  for (const [code, tKey] of Object.entries(COURSE_TRAINER)) {
    if (tKey === "trainer") continue; // Ravi keeps these
    const sc = state.courses[code];
    for (const batchName of ENROLMENT_BATCHES[code]) {
      const r = await api("POST", `/add-participants/${sc.id}`, { batchName, participantIds: [state.users[tKey].id] }, admin);
      const d = r.json.data;
      log(`${code}/${batchName}: +${state.users[tKey].name} (added=${d.totalAdded}, already=${(d.alreadyEnrolled || []).length})`);
    }
    // remove Ravi from ALL batches of this course (no batchId query = all)
    const del = await api("DELETE", `/delete/participant/${sc.id}/${state.users.trainer.id}`, undefined, admin, [404]);
    log(`${code}: Ravi removed (${del.status})`);
    sc.trainer = tKey;
    save();
  }
  for (const code of Object.keys(COURSE_TRAINER)) state.courses[code].trainer = COURSE_TRAINER[code];
  save();

  // 3 ─ re-attribute feedback forms of reassigned ended courses
  for (const code of ["TN-PY-105", "TN-DB-203"]) {
    const tKey = COURSE_TRAINER[code];
    const t = state.users[tKey];
    await api("PUT", `/update/feedback/${state.feedback[code].id}`, {
      trainerId: t.id, trainerName: t.name, trainerEmail: t.email,
    });
    log(`feedback ${code}: trainer -> ${t.name}`);
  }

  // 4 ─ re-issue bt.s14's TN-DB-203 evaluation as Mohan (course's trainer now)
  {
    const ex = state.exercises["TN-DB-203"].A1;
    const q = ex.questions[0];
    await api("POST", "/users/update/submission-score", {
      courseId: state.courses["TN-DB-203"].id, exerciseId: ex.exerciseId, questionId: q.questionId,
      participantId: state.users["bt.s14"].id, score: 85, totalScore: 100,
      feedback: "Well done. Revise the HAVING clause once more.", status: "evaluated",
      category: ex.tab, subcategory: ex.subcat, exerciseName: ex.name, questionTitle: q.title || "Question 1",
    }, state.tokens.trainer3);
    log("evaluation re-issued by Mohan: bt.s14 TN-DB-203/A1 -> 85");
  }

  log("TRAINER UPDATE COMPLETE");
})().then(() => process.exit(0)).catch(e => { console.error("FAILED:", e.message); save(); process.exit(1); });
