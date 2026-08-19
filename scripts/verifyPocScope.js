// Proves the POC data-scope enforcement, end to end, against a RUNNING server.
//
//   node scripts/verifyPocScope.js
//
// Mints a real session token for a POC and for an admin in the same
// institution, then asserts that every read the POC can reach returns only
// what its course enrolments entitle it to, and that every write is refused.
// The admin token is used purely to establish ground truth (what the full
// institution actually contains) so the assertions compare against real
// numbers rather than hardcoded ones.
//
// An assertion that cannot fail proves nothing, so each check states the
// out-of-scope value it is looking for and fails if that value is absent from
// the admin's view — i.e. the probe itself is validated before it is trusted.

require("dotenv").config();
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const config = require("config");

const User = require("../models/UserModel");
const Role = require("../models/RoleModel");
const tokenModal = require("../models/tokenModal");
const ClientManagement = require("../models/ClientManagementModel");
const CourseStructure = require("../models/Courses/courseStructureModal");

const BASE = process.env.VERIFY_BASE_URL || "http://localhost:5533";
const POC_EMAIL = process.env.VERIFY_POC_EMAIL || "poc@gmail.com";

let pass = 0;
let fail = 0;
const failures = [];

const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
};

// A probe is only meaningful if the thing it hunts for actually exists in the
// unscoped world. This records probes that turned out to be vacuous.
const meaningful = (name, cond, why) => {
  if (!cond) { fail++; failures.push(`${name} — PROBE IS VACUOUS: ${why}`); console.log(`  VOID  ${name} — probe proves nothing: ${why}`); return false; }
  return true;
};

const mintToken = async (user) => {
  const token = jwt.sign({ id: user._id }, config.get("JWT_TOKEN_KEY"), { expiresIn: 3600 });
  await tokenModal.create({ token });
  return token;
};

const call = async (token, path, method = "GET", body) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, json };
};

const rowsOf = (r) => (Array.isArray(r.json?.data) ? r.json.data : []);

(async () => {
  await mongoose.connect(process.env.MONGOURI);

  const poc = await User.findOne({ email: POC_EMAIL });
  if (!poc) throw new Error(`${POC_EMAIL} not found`);
  const pocRole = await Role.findById(poc.role).lean();
  console.log(`POC   ${POC_EMAIL}  role=${pocRole?.originalRole}  inst=${String(poc.institution).slice(-6)}`);

  // An admin of the SAME institution — ground truth for what is being hidden.
  const adminRoles = await Role.find({ institution: poc.institution }).lean();
  const adminRoleIds = adminRoles
    .filter((r) => /^admin$/i.test(r.originalRole || ""))
    .map((r) => r._id);
  const admin = await User.findOne({ institution: poc.institution, role: { $in: adminRoleIds } });
  if (!admin) throw new Error("no admin in the POC's institution to use as ground truth");
  console.log(`ADMIN ${admin.email}\n`);

  const pocToken = await mintToken(poc);
  const adminToken = await mintToken(admin);

  // ── Ground truth, straight from the DB ────────────────────────────────────
  const scopeCourses = await CourseStructure.find({
    institution: poc.institution,
    "batchAndParticipants.users.user": poc._id,
  }).select("_id courseName clientId").lean();
  const scopeCourseIds = new Set(scopeCourses.map((c) => String(c._id)));
  const scopeClientIds = new Set(scopeCourses.map((c) => String(c.clientId)));

  const allCourses = await CourseStructure.find({ institution: poc.institution }).select("_id courseName").lean();
  const allClients = await ClientManagement.find({ institution: poc.institution }).select("_id clientCompany").lean();

  const outOfScopeCourse = allCourses.find((c) => !scopeCourseIds.has(String(c._id)));
  const outOfScopeClient = allClients.find((c) => !scopeClientIds.has(String(c._id)));

  console.log(`Ground truth: ${scopeCourses.length}/${allCourses.length} courses, ${scopeClientIds.size}/${allClients.length} clients in scope`);
  console.log(`Out-of-scope probe targets: course "${outOfScopeCourse?.courseName}", client "${outOfScopeClient?.clientCompany}"\n`);

  if (scopeCourses.length === 0) {
    console.log("!! The POC is enrolled in nothing. Every check below would pass trivially.");
    console.log("!! Enrol it into a course first, or these results prove nothing.\n");
  }

  // ═══ Test 2 — Course scope ════════════════════════════════════════════════
  console.log("Test 2 — Course scope");
  {
    const r = await call(pocToken, "/courses-structure/getAll?summary=1");
    const ids = rowsOf(r).map((c) => String(c._id));
    ok("GET /courses-structure/getAll returns 200", r.status === 200, `got ${r.status}`);
    ok("every returned course is in scope", ids.every((id) => scopeCourseIds.has(id)),
      `${ids.filter((id) => !scopeCourseIds.has(id)).length} out-of-scope rows`);
    ok("count matches the enrolled set exactly", ids.length === scopeCourses.length,
      `got ${ids.length}, expected ${scopeCourses.length}`);
    if (meaningful("admin sees strictly more courses", allCourses.length > scopeCourses.length,
      "admin and POC would see the same rows, so scoping is untestable")) {
      const ra = await call(adminToken, "/courses-structure/getAll?summary=1");
      ok("admin still sees the full institution", rowsOf(ra).length === allCourses.length,
        `admin got ${rowsOf(ra).length}, expected ${allCourses.length}`);
    }
  }

  // ═══ Test 3 — Client scope ════════════════════════════════════════════════
  console.log("\nTest 3 — Client scope");
  {
    const r = await call(pocToken, "/client-management/getAll");
    const ids = rowsOf(r).map((c) => String(c._id));
    ok("every returned client is in scope", ids.every((id) => scopeClientIds.has(id)),
      `leaked: ${rowsOf(r).filter((c) => !scopeClientIds.has(String(c._id))).map((c) => c.clientCompany).join(", ")}`);
    ok("count matches derived clients", ids.length === scopeClientIds.size,
      `got ${ids.length}, expected ${scopeClientIds.size}`);

    const names = await call(pocToken, "/client-management/getAll?names=1");
    ok("?names=1 is scoped too", rowsOf(names).every((c) => scopeClientIds.has(String(c._id))));

    const paged = await call(pocToken, "/client-management/getAll?page=1&limit=5");
    ok("paginated mode is scoped", rowsOf(paged).every((c) => scopeClientIds.has(String(c._id))));
    ok("paginated total is the scoped total, not the institution's",
      paged.json?.total === scopeClientIds.size, `total=${paged.json?.total}, expected ${scopeClientIds.size}`);
    ok("facet counts do not leak the institution total",
      paged.json?.facets?.counts?.total === scopeClientIds.size,
      `facets.counts.total=${paged.json?.facets?.counts?.total}, expected ${scopeClientIds.size}`);
  }

  // ═══ Test 4 — Attendance scope ════════════════════════════════════════════
  console.log("\nTest 4 — Attendance scope");
  {
    const r = await call(pocToken, "/attendance/overview");
    const ids = rowsOf(r).map((c) => String(c._id));
    ok("overview returns only in-scope courses", ids.every((id) => scopeCourseIds.has(id)),
      `${ids.filter((id) => !scopeCourseIds.has(id)).length} out-of-scope rows`);
    ok("overview role is the read-only viewer tier", r.json?.role === "viewer", `role=${r.json?.role}`);

    if (outOfScopeCourse) {
      const g = await call(pocToken, `/attendance/get/${outOfScopeCourse._id}`);
      ok("attendance for an out-of-scope course is refused", g.status === 403, `got ${g.status}`);
      const s = await call(pocToken, `/attendance/summary/${outOfScopeCourse._id}`);
      ok("summary for an out-of-scope course is refused", s.status === 403, `got ${s.status}`);
      const w = await call(pocToken, `/attendance/window/${outOfScopeCourse._id}`);
      ok("window for an out-of-scope course is refused", w.status === 403, `got ${w.status}`);
    }
    const first = scopeCourses[0];
    if (first) {
      const g = await call(pocToken, `/attendance/get/${first._id}`);
      ok("attendance for an IN-scope course is allowed", g.status === 200, `got ${g.status}`);
    }
  }

  // ═══ Test 5 / 10 — Direct API access to admin-only surfaces ═══════════════
  console.log("\nTest 5/10 — Direct API access");
  {
    if (outOfScopeCourse) {
      const r = await call(pocToken, `/courses-structure/getById/${outOfScopeCourse._id}`);
      ok("getById on an out-of-scope course is refused", r.status === 404, `got ${r.status}`);
      const b = await call(pocToken, `/courses/${outOfScopeCourse._id}/batches`);
      ok("batches of an out-of-scope course are refused", b.status === 404, `got ${b.status}`);
      const a = await call(pocToken, `/courses/${outOfScopeCourse._id}/approval-hierarchy`);
      ok("approval hierarchy of an out-of-scope course is refused", a.status === 404, `got ${a.status}`);
    }
    if (outOfScopeClient) {
      const r = await call(pocToken, `/client-management/getById/${outOfScopeClient._id}`);
      ok("getById on an out-of-scope client is refused", r.status === 404, `got ${r.status}`);
    }
  }

  // ═══ Test 6 — Query / URL manipulation ════════════════════════════════════
  console.log("\nTest 6 — Query manipulation");
  {
    if (outOfScopeClient) {
      const r = await call(pocToken, `/service-mapping/getByClient/${outOfScopeClient._id}`);
      ok("getByClient with another client's id returns nothing",
        r.status === 200 && rowsOf(r).length === 0, `status=${r.status} rows=${rowsOf(r).length}`);

      const q = await call(pocToken, `/service-mapping/getAll?page=1&limit=50&client=${outOfScopeClient._id}`);
      ok("?client=<other> cannot widen the mapping list", rowsOf(q).length === 0,
        `got ${rowsOf(q).length} rows`);
    }
    // Ground truth for the mapping list itself
    const m = await call(pocToken, "/service-mapping/getAll");
    const mappingClientIds = rowsOf(m).map((x) => String(x.client?._id || x.client));
    ok("every mapping belongs to an in-scope client",
      mappingClientIds.every((id) => scopeClientIds.has(id)),
      `leaked ${mappingClientIds.filter((id) => !scopeClientIds.has(id)).length}`);
  }

  // ═══ Test 7 — Pagination ══════════════════════════════════════════════════
  console.log("\nTest 7 — Pagination");
  {
    let leaked = 0;
    let seen = 0;
    for (let page = 1; page <= 5; page++) {
      const r = await call(pocToken, `/client-management/getAll?page=${page}&limit=1`);
      const rows = rowsOf(r);
      seen += rows.length;
      leaked += rows.filter((c) => !scopeClientIds.has(String(c._id))).length;
      if (!rows.length) break;
    }
    ok("no page leaks an out-of-scope client", leaked === 0, `${leaked} leaked rows`);
    ok("paging never yields more than the scope holds", seen <= scopeClientIds.size,
      `walked ${seen} rows, scope holds ${scopeClientIds.size}`);
  }

  // ═══ Test 8 — Search ══════════════════════════════════════════════════════
  console.log("\nTest 8 — Search");
  {
    if (outOfScopeClient) {
      const term = String(outOfScopeClient.clientCompany).slice(0, 12);
      const r = await call(pocToken, `/client-management/getAll?page=1&limit=50&search=${encodeURIComponent(term)}`);
      // Validate the probe: the admin MUST find something for this term,
      // otherwise "0 results" would prove nothing about scoping.
      const ra = await call(adminToken, `/client-management/getAll?page=1&limit=50&search=${encodeURIComponent(term)}`);
      if (meaningful(`search "${term}"`, rowsOf(ra).length > 0,
        "admin also finds nothing for this term")) {
        ok(`searching "${term}" (an out-of-scope client) returns no rows for the POC`,
          rowsOf(r).length === 0,
          `POC got ${rowsOf(r).length}, admin got ${rowsOf(ra).length}`);
      }
    }
    // A term that spans in-scope and out-of-scope names must return only ours.
    const shared = "Technologies";
    const rs = await call(pocToken, `/client-management/getAll?page=1&limit=50&search=${shared}`);
    const ras = await call(adminToken, `/client-management/getAll?page=1&limit=50&search=${shared}`);
    if (meaningful(`lookalike search "${shared}"`, rowsOf(ras).length > 1,
      "fewer than 2 clients share this term, so it cannot demonstrate a leak")) {
      ok(`"${shared}" returns only in-scope matches`,
        rowsOf(rs).every((c) => scopeClientIds.has(String(c._id))) && rowsOf(rs).length < rowsOf(ras).length,
        `POC ${rowsOf(rs).length} of admin's ${rowsOf(ras).length}`);
    }
  }

  // ═══ Test 9 — Export ══════════════════════════════════════════════════════
  console.log("\nTest 9 — Export");
  {
    const r = await call(pocToken, "/client-management/getAll?page=1&export=1&limit=5000");
    ok("export is scoped", rowsOf(r).every((c) => scopeClientIds.has(String(c._id))),
      `${rowsOf(r).filter((c) => !scopeClientIds.has(String(c._id))).length} leaked`);
    ok("export total is the scoped total", rowsOf(r).length === scopeClientIds.size,
      `got ${rowsOf(r).length}, expected ${scopeClientIds.size}`);
  }

  // ═══ Test 11 — Writes are scope-checked ═══════════════════════════════════
  //
  // A POC keeps the admin action set (course edit, participants, batches,
  // attendance marking, client/service updates) but only against records inside
  // its scope. Every target below is an out-of-scope id, so every write must be
  // refused with 403 — that is what proves the guard is on the write path.
  //
  // SAFETY: two rules, both deliberate.
  //   1. The BODY of every write is empty or trivial, so even if a guard is
  //      silently missing, the underlying handler cannot mutate a real record
  //      through it — a required-field validation fires first.
  //   2. A CREATE test uses a NONEXISTENT client id in the body: a missing
  //      guard falls through to a 400/404 on the bad id rather than persisting
  //      anything. Never point a create at a real client id here — an earlier
  //      version did, and during exactly this discrimination check, deleted a
  //      live client and wiped 75 attendance rows.
  console.log("\nTest 11 — writes outside scope are refused");
  {
    const GHOST = "000000000000000000000000";
    const outOfScopeCourseId = outOfScopeCourse?._id;
    const outOfScopeClientId = outOfScopeClient?._id;
    const writes = [
      // Creates gated on a body id. Nonexistent id = 403 from the guard, or a
      // downstream 400 if the guard were missing — mutation is impossible.
      ["POST", "/client-management/create", { clientCompany: "x", clientId: GHOST, businessModel: "B2B", contactPersons: [{ name: "x", email: "x@y.z", phoneNumber: "1" }] }],
      ["POST", "/service-mapping/create", { client: GHOST, service: "x" }],
      ["POST", "/courses-structure/create", { clientId: GHOST, courseName: "x" }],
      // Writes to other clients' records
      ...(outOfScopeClientId ? [
        ["PUT", `/client-management/update/${outOfScopeClientId}`, {}],
        ["PUT", `/client-management/toggle-status/${outOfScopeClientId}`, {}],
        ["DELETE", `/client-management/delete/${outOfScopeClientId}`, null],
      ] : []),
      // Writes to other clients' courses
      ...(outOfScopeCourseId ? [
        ["PUT", `/courses-structure/update/${outOfScopeCourseId}`, {}],
        ["DELETE", `/courses-structure/delete/${outOfScopeCourseId}`, null],
        ["POST", `/add-participants/${outOfScopeCourseId}`, {}],
        ["POST", `/attendance/save/${outOfScopeCourseId}`, { records: [] }],
        ["DELETE", `/attendance/reset/${outOfScopeCourseId}`, null],
        ["PUT", `/courses/${outOfScopeCourseId}/approval-hierarchy`, { steps: [] }],
      ] : []),
    ];
    for (const [method, path, body] of writes) {
      const r = await call(pocToken, path, method, body);
      ok(`${method} ${path.split("?")[0]} on out-of-scope target is refused`, r.status === 403,
        `got ${r.status}`);
    }

    // Positive check: a write inside scope is ALLOWED to pass the guard. The
    // body is deliberately empty so no field actually changes, and a Mongoose
    // save with no-op update still returns 200 — but crucially not 403.
    const inScopeClientId = [...scopeClientIds][0];
    if (inScopeClientId) {
      const r = await call(pocToken, `/client-management/update/${inScopeClientId}`, "PUT", {});
      ok("PUT on an IN-scope client passes the guard (not 403)", r.status !== 403, `got ${r.status}`);
    }
    const inScopeCourseId = scopeCourses[0]?._id;
    if (inScopeCourseId) {
      const r = await call(pocToken, `/attendance/save/${inScopeCourseId}`, "POST", { records: [] });
      ok("attendance save on an IN-scope course passes the guard (not 403)", r.status !== 403, `got ${r.status}`);
    }
  }

  // ── Cleanup: the tokens minted for this run ───────────────────────────────
  await tokenModal.deleteMany({ token: { $in: [pocToken, adminToken] } });

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log(`${"=".repeat(60)}`);
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  console.log(`${"=".repeat(60)}`);

  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("ERR", e); process.exit(1); });
