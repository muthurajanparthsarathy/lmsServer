const mongoose = require("mongoose");
const Role = require("../models/RoleModel");
const CourseStructure = require("../models/Courses/courseStructureModal");
const ClientManagement = require("../models/ClientManagementModel");
const ServiceMapping = require("../models/ServiceMappingModel");

// ── POC (Point of Contact) data scope ────────────────────────────────────────
//
// A POC is a client-bound role: it may only ever see the courses an admin has
// enrolled it into, and everything reachable from those courses.
//
//   POC user (always req.user — never an id from the request)
//     └─ enrolled courses  (batchAndParticipants[].users[].user == poc._id)
//          ├─ clients   = distinct course.clientId, ∩ real client docs
//          ├─ services  = ServiceMapping where client ∈ clients
//          └─ attendance= StudentAttendance where courseId ∈ courses
//
// Enrolment is the ONLY scope source, and specifically the course roster —
// NOT `User.courses[]`. That array looks equivalent but is written by
// `progressController.recordNodeVisit`, which auto-creates an entry for any
// (userId, courseId) pair and sits on an UNAUTHENTICATED route. Treating it as
// an authorization input would let an anonymous caller grant a POC access to
// any course, and through `clientId`, that course's entire client. The admin
// enrolment path (`batchAddParticipants`) writes only the roster, so the roster
// is both the correct source and the safe one.

const normalizeRoleName = (name) =>
  String(name || "").toLowerCase().replace(/[\s_-]+/g, "_");

// `user.role` comes in three shapes: a populated Role doc (userAuthOptional), a
// raw ObjectId (userAuth, the common case), or a plain role-name string on
// legacy accounts. Mirrors the resolution in middlewares/userRole.js and
// controllers/courses/attendance.js:43.
const roleNamesOf = async (user) => {
  const role = user?.role;
  if (!role) return [];

  if (typeof role === "object" && (role.roleValue || role.originalRole || role.renameRole)) {
    return [role.roleValue, role.renameRole, role.originalRole].filter(Boolean);
  }

  const raw = String(role);
  if (!mongoose.Types.ObjectId.isValid(raw)) return [raw];

  const doc = await Role.findById(raw)
    .select("originalRole renameRole roleValue")
    .lean();
  return doc ? [doc.roleValue, doc.renameRole, doc.originalRole].filter(Boolean) : [];
};

const isPocUser = async (user) =>
  (await roleNamesOf(user)).map(normalizeRoleName).includes("poc");

const EMPTY_SCOPE = Object.freeze({
  isPoc: false,
  institution: null,
  courseIds: [],
  clientIds: [],
  mappingIds: [],
});

// Resolves what a POC may see. Non-POC callers get `{ isPoc: false }` and every
// filter builder below then contributes nothing, so no existing role's queries
// change shape.
//
// An empty scope stays EMPTY — `{ _id: { $in: [] } }` matches zero documents.
// That is deliberate and load-bearing: a POC enrolled in nothing must see
// nothing, never the institution-wide list. Do not "optimise" the empty array
// away with an `if (ids.length)` guard; that reintroduces exactly the
// fall-through-to-global bug this module exists to prevent. Today no POC is on
// any roster, so this is the common path, not an edge case.
const resolvePocScope = async (user) => {
  if (!user || !(await isPocUser(user))) return EMPTY_SCOPE;

  const institution = user.institution;
  if (!institution) return { ...EMPTY_SCOPE, isPoc: true };

  // One query does three jobs: finds the roster memberships, confines them to
  // the caller's institution, and — because it matches on live documents —
  // drops any course that no longer exists.
  const courses = await CourseStructure.find({
    institution,
    "batchAndParticipants.users.user": user._id,
  })
    .select("_id clientId")
    .lean();

  const courseIds = courses.map((c) => c._id);
  if (!courseIds.length) {
    return { isPoc: true, institution, courseIds: [], clientIds: [], mappingIds: [] };
  }

  // Live data carries courses whose clientId matches no client document (6 of
  // 19 distinct values at time of writing), so candidates are intersected
  // against real clients before they become "My Clients".
  const candidateClientIds = [
    ...new Map(
      courses.filter((c) => c.clientId).map((c) => [String(c.clientId), c.clientId])
    ).values(),
  ];

  const clientIds = candidateClientIds.length
    ? await ClientManagement.find({
        _id: { $in: candidateClientIds },
        institution,
      }).distinct("_id")
    : [];

  // Course → service is a String `mappingId` with no ref, so services are
  // reached through the client edge instead.
  const mappingIds = clientIds.length
    ? await ServiceMapping.find({ institution, client: { $in: clientIds } }).distinct("_id")
    : [];

  return { isPoc: true, institution, courseIds, clientIds, mappingIds };
};

// ── Filter builders ─────────────────────────────────────────────────────────
// Controllers must go through these rather than hand-rolling `$in`, so that
// every query in a family is scoped the same way. Each returns `{}` for a
// non-POC, making it safe to spread unconditionally into an existing filter.

const pocCourseFilter = (scope, field = "_id") =>
  scope?.isPoc ? { [field]: { $in: scope.courseIds } } : {};

const pocClientFilter = (scope, field = "_id") =>
  scope?.isPoc ? { [field]: { $in: scope.clientIds } } : {};

const pocMappingFilter = (scope, field = "_id") =>
  scope?.isPoc ? { [field]: { $in: scope.mappingIds } } : {};

// Membership tests for by-id handlers. Spreading a filter into a query that
// already pins the same key (`{ _id: id, ..., _id: {$in} }`) silently drops one
// of them, so by-id routes test membership instead of merging filters.
const inScope = (ids, id) => ids.some((x) => String(x) === String(id));

const scopeHasCourse = (scope, id) => !scope?.isPoc || inScope(scope.courseIds, id);
const scopeHasClient = (scope, id) => !scope?.isPoc || inScope(scope.clientIds, id);
const scopeHasMapping = (scope, id) => !scope?.isPoc || inScope(scope.mappingIds, id);

module.exports = {
  isPocUser,
  resolvePocScope,
  pocCourseFilter,
  pocClientFilter,
  pocMappingFilter,
  scopeHasCourse,
  scopeHasClient,
  scopeHasMapping,
  EMPTY_SCOPE,
};
