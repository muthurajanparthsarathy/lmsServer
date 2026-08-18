// utils/cascadeDeleteCourses.js
//
// One cascade engine for the two destructive flows:
//   - deleting a single course        → cascadeDeleteCourses([courseId], { clearMappingBackPointer: true })
//   - deleting a service mapping      → collectMappingCourseIds(mapping) → cascadeDeleteCourses(ids)
//                                       → detachUsersFromMapping(mapping._id)
//
// Before this existed, both deletes were SHALLOW: deleteMapping removed only the
// mapping doc, deleteCourseStructure only the course doc + its Supabase image.
// Every dependent collection — the whole module/topic tree, pedagogy views,
// level views, exam sessions and answers, proctoring logs, live questions and
// responses, retest requests, program calendars, schedules, attendance, groups,
// feedback, activity logs, code workspaces, per-user submissions and progress —
// was orphaned forever. This file deletes all of it, in an order that never
// strands a child whose only route to the course runs through a parent that is
// already gone.
//
// KEEP / UNSET boundaries (deliberate, do not "complete" them):
//   - LMS-User accounts SURVIVE. Only their linkage is cleaned: embedded
//     courses[] entries (answers + progress) are pulled per deleted course, and
//     serviceMappingId/serviceModel/phase are unset on mapping delete.
//   - Institution/client master data survives: QuestionBank, holiday calendars,
//     Degree/Department catalog, pedagogy vocabulary, dynamic course catalog,
//     ClientManagement (its derived services[] is resynced by the CALLER via
//     syncClientServices — that call is mandatory after a mapping delete, or
//     migrateLegacyServices resurrects the mapping from the stale snapshot).
//   - PptCache is a global URL-keyed conversion cache shared across courses.
//
// Field-type traps this file honors (verified against the schemas):
//   - Course-Structure.mappingId and ServiceMapping.courseId are STRINGS.
//   - ExamSession/StudentQuestionActivity/ScreenViolation/ProctorMessage key on
//     assessmentId = STRING of an exercise _id EMBEDDED in a node's pedagogy
//     maps; QuestionDraft.exerciseId likewise. None carry a courseId, so those
//     ids MUST be harvested before the node docs are deleted.
//   - StudentWorkspace.courseId is a STRING ('default' = course-agnostic, kept).

const mongoose = require("mongoose");

// Register every model the cascade touches, then resolve by NAME — the same
// idiom courseStructure.js uses. require() is idempotent; mongoose caches.
require("../models/Courses/courseStructureModal");
require("../models/Courses/moduleStructureModal");
require("../models/Courses/moduleStructure/moduleModal");
require("../models/Courses/moduleStructure/subModuleModal");
require("../models/Courses/moduleStructure/topicModal");
require("../models/Courses/moduleStructure/subTopicModal");
require("../models/Courses/moduleStructure/levelModel");
require("../models/Courses/moduleStructure/pedagogyViewModal");
require("../models/Courses/moduleStructure/ExamSessionModel");
require("../models/Courses/moduleStructure/StudentQuestionActivityModel");
require("../models/Courses/moduleStructure/ScreenViolationModel");
require("../models/Courses/moduleStructure/ProctorMessageModel");
require("../models/Courses/moduleStructure/LiveQuestionModal");
require("../models/Courses/moduleStructure/StudentResponseSchema");
require("../models/Courses/RetestRequestModel");
require("../models/Courses/ProgramCalendarModel");
require("../models/Courses/CalendarScheduleModel");
require("../models/Courses/StudentAttendanceModel");
require("../models/Courses/GroupParticipantsModal");
require("../models/QuestionDraftModel");
require("../models/StudentWorkspaceModel");
require("../models/ActivityLog");
require("../models/FeedbackModal");
require("../models/CompilerModel");
require("../models/UserModel");
require("../models/ServiceMappingModel");

const M = (name) => mongoose.model(name);

// Harvest the STRING _ids of every exercise embedded in a node's pedagogy maps
// (I_Do / We_Do / You_Do). After .lean(), Mongoose Maps arrive as plain
// objects whose values are exercise arrays (We_Do), exercise-shaped Mixed
// arrays (You_Do) or content buckets (I_Do). Over-collecting a non-exercise
// _id is harmless — it matches nothing downstream — so the walk is generous:
// arrays at the top, one and two object-levels down.
const collectExerciseIdStrings = (nodeDocs) => {
  const out = new Set();
  const addFromArray = (arr) => {
    if (!Array.isArray(arr)) return;
    arr.forEach((item) => {
      if (item && item._id) out.add(String(item._id));
    });
  };
  const addFrom = (val) => {
    if (!val || typeof val !== "object") return;
    if (Array.isArray(val)) return addFromArray(val);
    Object.values(val).forEach((v) => {
      if (Array.isArray(v)) addFromArray(v);
      else if (v && typeof v === "object") {
        Object.values(v).forEach((vv) => addFromArray(vv));
      }
    });
  };
  nodeDocs.forEach((doc) => {
    const ped = (doc && doc.pedagogy) || {};
    ["I_Do", "We_Do", "You_Do"].forEach((cat) => addFrom(ped[cat]));
  });
  return [...out];
};

// The course ids a mapping owns. Forward pointer: Course-Structure.mappingId
// (STRING of the mapping _id — legacy docs hold "", so the exact-id match can
// never sweep unmapped courses). Union the mapping's own back-pointer: an older
// mapping can point at its auto-created course while that course still carries
// mappingId: "".
async function collectMappingCourseIds(mapping) {
  const ids = new Set(
    (
      await M("Course-Structure")
        .find({ mappingId: String(mapping._id) }, { _id: 1 })
        .lean()
    ).map((c) => String(c._id))
  );
  if (mapping.courseId && mongoose.Types.ObjectId.isValid(mapping.courseId)) {
    ids.add(String(mapping.courseId));
  }
  return [...ids];
}

// Accounts survive a mapping delete; only the linkage dies. serviceModel and
// phase are name snapshots copied FROM the mapping at user creation, so they
// go with it — but the match key is serviceMappingId alone (names are
// ambiguous when a client runs two mappings with the same model name).
async function detachUsersFromMapping(mappingId) {
  const res = await M("LMS-User").updateMany(
    { serviceMappingId: mappingId },
    { $unset: { serviceMappingId: "", serviceModel: "", phase: "" } }
  );
  return res.modifiedCount || 0;
}

// Best-effort Supabase image cleanup, mirroring deleteCourseStructure's own
// rules (skip defaults, never fail the delete over a storage error).
async function deleteCourseImages(courseDocs) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  if (!supabaseUrl || !supabaseKey) return;
  try {
    const { createClient } = require("@supabase/supabase-js");
    const supabase = createClient(supabaseUrl, supabaseKey);
    const paths = courseDocs
      .filter((c) => c.courseImage && !c.courseImage.includes("default_profile_image"))
      .map((c) => `course/image/${c.courseImage.split("/").pop()}`);
    if (paths.length) {
      const { error } = await supabase.storage.from("smartlms").remove(paths);
      if (error) console.error("Cascade: error deleting course images:", error);
    }
  } catch (err) {
    console.error("Cascade: image cleanup skipped:", err.message);
  }
}

/**
 * Delete the given courses and EVERYTHING that hangs off them.
 * Returns a per-collection { name: deletedCount } summary.
 *
 * options.clearMappingBackPointer — set on the single-course flow: the mapping
 *   survives, so its courseId/courseCode back-pointer is blanked. The mapping
 *   flow leaves it false (the mapping doc is about to die anyway).
 * options.deleteImages — default true; the single-course controller already
 *   does its own image cleanup and passes false.
 */
async function cascadeDeleteCourses(courseIdsIn, options = {}) {
  const counts = {};
  const courseIds = (courseIdsIn || [])
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(String(id)));
  if (!courseIds.length) return counts;
  const courseIdStrings = courseIds.map(String);

  // ── 1. Collect, while everything still exists ─────────────────────────────
  // The exam family and drafts key on embedded-exercise STRING ids; live
  // responses key on live-question ids. After the node/question docs are gone
  // these children are unreachable forever, so harvest comes first.
  const courseDocs = await M("Course-Structure")
    .find({ _id: { $in: courseIds } }, { courseImage: 1, groups: 1 })
    .lean();

  const [moduleIds, subModuleIds, topicIds] = await Promise.all([
    M("Module1").find({ courses: { $in: courseIds } }).distinct("_id"),
    M("SubModule1").find({ courses: { $in: courseIds } }).distinct("_id"),
    M("Topic1").find({ courses: { $in: courseIds } }).distinct("_id"),
  ]);

  const nodeDocs = (
    await Promise.all(
      ["Module1", "SubModule1", "Topic1", "SubTopic1"].map((name) =>
        M(name).find({ courses: { $in: courseIds } }, { pedagogy: 1 }).lean()
      )
    )
  ).flat();
  const exerciseIds = collectExerciseIdStrings(nodeDocs);

  const liveQuestionIds = await M("LiveQuestion")
    .find({ courses: { $in: courseIds } })
    .distinct("_id");
  const groupIds = await M("Course-Group")
    .find({ course: { $in: courseIds } })
    .distinct("_id");

  const del = async (label, name, filter) => {
    const res = await M(name).deleteMany(filter);
    counts[label] = res.deletedCount || 0;
  };

  // ── 2. Exam / answer family (children of harvested ids) ───────────────────
  if (exerciseIds.length) {
    await del("examSessions", "ExamSession", { assessmentId: { $in: exerciseIds } });
    await del("questionActivities", "StudentQuestionActivity", { assessmentId: { $in: exerciseIds } });
    await del("screenViolations", "ScreenViolation", { assessmentId: { $in: exerciseIds } });
    await del("proctorMessages", "ProctorMessage", { assessmentId: { $in: exerciseIds } });
    await del("questionDrafts", "QuestionDraft", { exerciseId: { $in: exerciseIds } });
  }
  if (liveQuestionIds.length) {
    // Child first: StudentResponse reaches its course ONLY through liveQuestion.
    await del("liveResponses", "StudentResponse", { liveQuestion: { $in: liveQuestionIds } });
    await del("liveQuestions", "LiveQuestion", { _id: { $in: liveQuestionIds } });
  }
  await del("retestRequests", "RetestRequest", { courseId: { $in: courseIds } });

  // ── 3. Content hierarchy (both systems) + per-course views ────────────────
  // The $or orphan sweeps are belt-and-suspenders: `courses` is required on
  // every node, but no controller validates a child's `courses` matches its
  // parent's, so a mis-filed child is still caught through its parent id.
  await del("legacyModuleTrees", "Module-Structure-demo", { courses: { $in: courseIds } });
  await del("modules", "Module1", { courses: { $in: courseIds } });
  await del("subModules", "SubModule1", {
    $or: [{ courses: { $in: courseIds } }, { moduleId: { $in: moduleIds } }],
  });
  await del("topics", "Topic1", {
    $or: [
      { courses: { $in: courseIds } },
      { moduleId: { $in: moduleIds } },
      { subModuleId: { $in: subModuleIds } },
    ],
  });
  await del("subTopics", "SubTopic1", {
    $or: [{ courses: { $in: courseIds } }, { topicId: { $in: topicIds } }],
  });
  await del("levelViews", "level-view", { courses: { $in: courseIds } });
  await del("pedagogyViews", "pedagogy-view", { courses: { $in: courseIds } });

  // ── 4. Scheduling / operations ────────────────────────────────────────────
  await del("programCalendars", "Program-Calendar", { courseId: { $in: courseIds } });
  await del("calendarSchedules", "CalendarSchedule", { courseId: { $in: courseIds } });
  await del("attendanceRecords", "StudentAttendance", { courseId: { $in: courseIds } });
  await del("groups", "Course-Group", { course: { $in: courseIds } });
  await del("activityLogs", "ActivityLog", { courseId: { $in: courseIds } });
  await del("feedbackForms", "Feedback", { courseId: { $in: courseIds } });
  // STRING courseId — ObjectIds in $in would match nothing; 'default'
  // (course-agnostic) workspaces are untouched by construction.
  await del("codeWorkspaces", "StudentWorkspace", { courseId: { $in: courseIdStrings } });

  // ── 5. People: accounts survive, linkage dies ─────────────────────────────
  const pulledCourses = await M("LMS-User").updateMany(
    { "courses.courseId": { $in: courseIds } },
    { $pull: { courses: { courseId: { $in: courseIds } } } }
  );
  counts.usersUnenrolled = pulledCourses.modifiedCount || 0;

  const pulledSubmissions = await M("Compiler12").updateMany(
    { "courses.courseId": { $in: courseIds } },
    { $pull: { courses: { courseId: { $in: courseIds } } } }
  );
  counts.compilerEntriesPruned = pulledSubmissions.modifiedCount || 0;

  // Best-effort cosmetic cleanup: relatedEntityId holds a groupId for group
  // events and a courseId for enrolment events; stale ones are only noise.
  const staleEntityIds = [...courseIds, ...groupIds];
  if (staleEntityIds.length) {
    await M("LMS-User").updateMany(
      { "notifications.relatedEntityId": { $in: staleEntityIds } },
      { $pull: { notifications: { relatedEntityId: { $in: staleEntityIds } } } }
    );
  }

  // ── 6. Mapping back-pointer (single-course flow only) ─────────────────────
  if (options.clearMappingBackPointer) {
    await M("LMS-ServiceMapping").updateMany(
      { courseId: { $in: courseIdStrings } },
      { $set: { courseId: "", courseCode: "" } }
    );
  }

  // ── 7. Storage, then the course docs LAST ─────────────────────────────────
  // Last on purpose: if anything above throws, the courses still exist and the
  // whole cascade is safely re-runnable.
  if (options.deleteImages !== false) {
    await deleteCourseImages(courseDocs);
  }
  const removed = await M("Course-Structure").deleteMany({ _id: { $in: courseIds } });
  counts.courses = removed.deletedCount || 0;

  return counts;
}

module.exports = {
  cascadeDeleteCourses,
  collectMappingCourseIds,
  detachUsersFromMapping,
  // Exported for the read-only preview script (scripts/dryRunCascadeDelete.js),
  // so its counts come from the exact same harvest the live cascade uses.
  collectExerciseIdStrings,
};
