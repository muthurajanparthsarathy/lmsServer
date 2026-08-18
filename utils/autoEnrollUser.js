const mongoose = require("mongoose");
const CourseStructure = require("../models/Courses/courseStructureModal");
const Role = require("../models/RoleModel");

// batch.createdBy / updatedBy are ObjectId refs, NOT strings. Passing an email
// or a label like "backfill-script" makes the whole course.save() throw a cast
// error — which, because enrolment is wrapped in a try/catch, would surface as a
// silent "0 enrolled" rather than an obvious failure. Anything that is not a
// real id is dropped instead, leaving the field unset.
const asObjectId = (v) =>
  v && mongoose.Types.ObjectId.isValid(v) ? new mongoose.Types.ObjectId(String(v)) : undefined;

// Auto-enrolment: put a newly created student into every course their
// client ▸ degree ▸ department ▸ [section] already maps to.
//
// Service Mapping is where an institution states "this client's B.E ▸ CSE ▸ A
// runs these courses". Until now that knowledge was only ever used in the PULL
// direction — someone opened a course and ran EnrollUsersModal to find the
// students who matched. A student added AFTERWARDS did not appear anywhere
// until somebody remembered to go back and pull them in, which is exactly the
// gap this closes.
//
// The match is deliberately the SAME one EnrollUsersModal uses, so the push and
// pull directions can never disagree about who belongs where:
//     role is student AND clientId matches AND degree AND department AND section
//
// BATCH POLICY — first matching batch. batchSchema carries no hierarchy of its
// own (only the users inside a batch record degree/department/section), so
// "matching" resolves to the course's first batch. A course running parallel
// batches therefore sends every auto-enrolled student to the first one, and
// rebalancing is a deliberate manual act.
//
// NOTHING here may throw into the caller. Enrolment is a convenience layered on
// top of user creation; if it fails, the user must still exist — otherwise an
// admin loses the record they just typed in because of a course they have never
// heard of. Every path resolves to a report instead of raising.

const norm = (v) => String(v ?? "").trim().toLowerCase();
const eq = (a, b) => norm(a) === norm(b);

// A blank section on EITHER side means "not scoped by section" and matches.
// A course configured without sections must still accept a student who carries
// one, and a student without a section still belongs to their department's
// course. Only two non-empty values that differ are a real mismatch.
const sectionMatches = (courseSection, userSection) =>
  !norm(courseSection) || !norm(userSection) || eq(courseSection, userSection);

// Role is an ObjectId ref, so the name has to be looked up. The field it lives
// under varies across this codebase's role records (the client reads
// `renameRole`), so all three spellings are checked rather than assuming one.
const isStudent = async (roleId) => {
  if (!roleId) return false;
  try {
    const role = await Role.findById(roleId).lean();
    if (!role) return false;
    return [role.renameRole, role.originalRole, role.roleName, role.name]
      .some((n) => norm(n) === "student");
  } catch {
    return false;
  }
};

// Same separator the wizard and Course Setup write paths with.
const PATH_SEP = " ▸ ";

// Prefix match on a path — never a split. Names can contain anything, so parsing
// a path back apart is a bug waiting to happen; this mirrors isUnder() in the
// wizard's scope.ts, which is this codebase's sanctioned way to ask "does this
// node sit under that one". "Civil" must not match "Civil2", hence the explicit
// separator rather than a bare startsWith.
const isUnder = (path, prefix) =>
  path === prefix || path.startsWith(prefix + PATH_SEP);

// Does this course serve the student?
//
// coursePath is AUTHORITATIVE. The model states Course Setup's identity is
// clientId + mappingId + coursePath + courseName, and the path spells the whole
// chain out in order: "BE ▸ Civil ▸ a ▸ 1" is degree ▸ department ▸ section ▸
// semester. Building the student's prefix and asking whether the course sits
// under it makes both of the rules fall out for free, with no special-casing:
//
//   student BE / Civil / a  -> prefix "BE ▸ Civil ▸ a" -> matches "BE ▸ Civil ▸ a ▸ 1"   ✓
//                                                     -> and every semester under it     ✓
//   student BE / Civil      -> prefix "BE ▸ Civil"     -> matches every section of Civil  ✓
//   student BE / Mechanical -> prefix "BE ▸ Mechanical"-> never matches Civil's courses   ✓
//
// That last line is the one that matters: matching on degree + departmentSections
// alone (what this did before) could not tell Civil ▸ a apart from Mechanical ▸ a
// once both ran the same course name, and would have enrolled a Civil student
// into Mechanical's copy of "Mean Development".
const servesUser = (course, user) => {
  const coursePath = String(course.coursePath || "").trim();

  if (coursePath) {
    const parts = [user.degree, user.department, user.section]
      .map((p) => String(p ?? "").trim())
      .filter(Boolean);
    // Degree + department is the floor; a lone degree would sweep in every
    // department's courses.
    if (parts.length < 2) return false;
    return isUnder(norm(coursePath), norm(parts.join(PATH_SEP)));
  }

  // ── Fallback: courses saved before coursePath existed ────────────────────
  // Coarser by nature — it cannot distinguish two departments running the same
  // course name — but it is the only signal those records carry.
  const ds = Array.isArray(course.departmentSections) ? course.departmentSections : [];

  // A course with NO path, NO degree and NO departmentSections says nothing at
  // all about who it serves. Treating that silence as "serves everyone" is what
  // an earlier version did, and on real data it was badly wrong: this client
  // owns six such courses (Python Development, selenium testing, Mern
  // Development …) that have nothing to do with any degree hierarchy, and every
  // student would have been enrolled into all of them. Unknown means NO.
  if (!norm(course.degree) && !ds.length) return false;

  if (norm(course.degree) && !eq(course.degree, user.degree)) return false;
  if (!ds.length) return true;

  return ds.some((d) => {
    if (!eq(d.department, user.department)) return false;
    const sections = Array.isArray(d.sections) ? d.sections.filter(Boolean) : [];
    if (!sections.length || !norm(user.section)) return true;
    return sections.some((s) => sectionMatches(s, user.section));
  });
};

// Placement Training runs on a different axis from the degree flow: there is no
// degree ▸ department ▸ section, so coursePath is empty and servesUser above has
// nothing to match on. A placement course is instead identified by its
// serviceModal, and tied to its service by mappingId.
const isPlacement = (user) => /placement/i.test(String(user && user.serviceModel || ""));

// Does this course belong to the placement service the user was added under?
//
// serviceMappingId pins it to the ONE service the user picked — a client can run
// several "placement training" services with different courses, and without this
// the user would land in all of them. When the user carries no mapping id (older
// records, or a client with a single placement service), any of the client's
// placement courses is taken; the client filter already scoped the query.
//
// Phase handling: in Placement Training a phase IS a course — the phase's name is
// the course name (masterData Phase = ["java","python"], one course each). So a
// user who picked a phase enrols into exactly that one course; a user with no
// phase (a phase-less placement service) enrols into all the service's courses.
const servesPlacementUser = (course, user) => {
  if (!/placement/i.test(String(course.serviceModal || ""))) return false;
  // Pin to the exact service the user was added under, when we know it.
  if (norm(user.serviceMappingId) && norm(course.mappingId)) {
    if (!eq(user.serviceMappingId, course.mappingId)) return false;
  }
  // A chosen phase names one course — match it and nothing else.
  if (norm(user.phase)) {
    return eq(course.courseName, user.phase) || eq(course.coursePath, user.phase);
  }
  return true;
};

/**
 * @param {object} user     The freshly created/updated user document.
 * @param {*}      institutionId
 * @param {string} actorId  Who triggered it, recorded on any batch it creates.
 * @returns {Promise<{enrolled: Array, skipped: Array, error: string|null}>}
 *          Never rejects.
 */
const autoEnrollUser = async (user, institutionId, actorId = "system") => {
  const report = { enrolled: [], skipped: [], error: null };
  try {
    if (!user || !user._id) return report;

    // Only students are auto-enrolled. Staff belong to courses through their
    // own assignment flows, and sweeping them in here would quietly add
    // trainers as participants of every course in their department.
    if (!(await isStudent(user.role))) {
      report.skipped.push({ reason: "not a student role" });
      return report;
    }

    // A client is always required — enrolment is scoped to the client's courses.
    // Beyond that the two flows ask for different things: a degree student needs
    // degree + department (a lone degree would sweep in every department); a
    // placement student has neither, and is matched by their placement service.
    const placement = isPlacement(user);
    if (!user.clientId) {
      report.skipped.push({ reason: "no clientId on the user" });
      return report;
    }
    if (!placement && (!norm(user.degree) || !norm(user.department))) {
      report.skipped.push({ reason: "no degree / department on the user (degree flow)" });
      return report;
    }

    const courses = await CourseStructure.find({
      institution: institutionId,
      clientId: user.clientId,
    }).select("_id courseName degree departmentSections coursePath batchAndParticipants serviceModal mappingId");

    for (const course of courses) {
      const serves = placement ? servesPlacementUser(course, user) : servesUser(course, user);
      if (!serves) continue;

      if (!Array.isArray(course.batchAndParticipants)) course.batchAndParticipants = [];
      const batches = course.batchAndParticipants;

      // Batches are NOT a gate on enrolment. The cohort is decided by
      // section — or by department when the degree has no sections — and a
      // course that happens to have no batch configured yet must still take its
      // students, otherwise auto-enrolment silently covers only the courses
      // somebody already got round to setting batches up on.
      //
      // batchAndParticipants is the only participant store, and it is what
      // /courses/:courseId/batches reads, so a container still has to exist to
      // write into. When there is none, one is created named after the node the
      // students actually belong to — the section, or the department when there
      // is no section — so the batch that appears is a truthful label for the
      // cohort rather than a meaningless "Default".
      if (!batches.length) {
        const newBatch = {
          batchName: (user.section || user.department || "All students").trim(),
          batchDescription: "Created automatically to hold auto-enrolled students",
          batchStartDate: null,
          batchEndDate: null,
          users: [],
          status: "active",
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        const actor = asObjectId(actorId);
        if (actor) {
          newBatch.createdBy = actor;
          newBatch.updatedBy = actor;
        }
        batches.push(newBatch);
      }

      const batch = batches[0];
      if (!Array.isArray(batch.users)) batch.users = [];

      // Idempotent: re-running (a re-save, a hierarchy edit) must not enrol the
      // same student twice into the same batch.
      const already = batch.users.some((u) => String(u.user) === String(user._id));
      if (already) {
        report.skipped.push({ course: course.courseName, reason: "already enrolled" });
        continue;
      }

      batch.users.push({
        user: user._id,
        status: "active",
        // The hierarchy node they were enrolled AT, recorded exactly as the
        // manual path records it so both look identical in the participants list.
        degree: user.degree || "",
        department: user.department || "",
        section: user.section || "",
        semester: "",
        joinedAt: new Date(),
        updatedAt: new Date(),
      });
      batch.updatedAt = new Date();
      const actorRef = asObjectId(actorId);
      if (actorRef) batch.updatedBy = actorRef;

      await course.save();

      // The course must ALSO land on the user's own `courses[]`. Analytics and
      // review screens skip batch participants that have no matching entry
      // there, so without this the student is enrolled but invisible to them.
      if (!Array.isArray(user.courses)) user.courses = [];
      const linked = user.courses.some((c) => String(c.courseId) === String(course._id));
      if (!linked) user.courses.push({ courseId: course._id });

      report.enrolled.push({
        courseId: String(course._id),
        course: course.courseName,
        batch: batch.batchName,
      });
    }

    if (report.enrolled.length && typeof user.save === "function") {
      await user.save();
    }
    return report;
  } catch (err) {
    // Swallowed by design — see the header note. The caller logs it; the user
    // creation that triggered this still stands.
    report.error = err.message;
    return report;
  }
};

module.exports = { autoEnrollUser };
