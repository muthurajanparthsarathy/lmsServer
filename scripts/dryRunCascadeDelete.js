// scripts/dryRunCascadeDelete.js
//
// READ-ONLY preview of the service-mapping cascade delete. Counts what WOULD
// be deleted for a mapping without touching anything. No --apply mode exists
// on purpose — the real delete runs through the API (deleteMapping), which is
// the only place the cascade + user-detach + client resync happen together.
//
//   node scripts/dryRunCascadeDelete.js <mappingId>
//   node scripts/dryRunCascadeDelete.js --all          (every mapping, summary line each)
//
// Uses MONGOURI from server/.env, same as the backfill scripts.

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const mongoose = require("mongoose");

const {
  collectMappingCourseIds,
  collectExerciseIdStrings,
} = require("../utils/cascadeDeleteCourses");
require("../models/ServiceMappingModel");

const M = (name) => mongoose.model(name);

// Mirrors cascadeDeleteCourses' collection phase, but only counts.
async function previewCourses(courseIdsIn) {
  const courseIds = courseIdsIn.map((id) => new mongoose.Types.ObjectId(String(id)));
  const courseIdStrings = courseIds.map(String);
  const out = {};
  if (!courseIds.length) return out;

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
  // Same harvest the live cascade does (shared from the util).
  const exerciseIds = collectExerciseIdStrings(nodeDocs);

  const liveQuestionIds = await M("LiveQuestion")
    .find({ courses: { $in: courseIds } })
    .distinct("_id");

  const count = async (label, name, filter) => {
    out[label] = await M(name).countDocuments(filter);
  };

  await count("courses", "Course-Structure", { _id: { $in: courseIds } });
  await count("legacyModuleTrees", "Module-Structure-demo", { courses: { $in: courseIds } });
  await count("modules", "Module1", { courses: { $in: courseIds } });
  await count("subModules", "SubModule1", { $or: [{ courses: { $in: courseIds } }, { moduleId: { $in: moduleIds } }] });
  await count("topics", "Topic1", { $or: [{ courses: { $in: courseIds } }, { moduleId: { $in: moduleIds } }, { subModuleId: { $in: subModuleIds } }] });
  await count("subTopics", "SubTopic1", { $or: [{ courses: { $in: courseIds } }, { topicId: { $in: topicIds } }] });
  await count("levelViews", "level-view", { courses: { $in: courseIds } });
  await count("pedagogyViews", "pedagogy-view", { courses: { $in: courseIds } });
  if (exerciseIds.length) {
    await count("examSessions", "ExamSession", { assessmentId: { $in: exerciseIds } });
    await count("questionActivities", "StudentQuestionActivity", { assessmentId: { $in: exerciseIds } });
    await count("screenViolations", "ScreenViolation", { assessmentId: { $in: exerciseIds } });
    await count("proctorMessages", "ProctorMessage", { assessmentId: { $in: exerciseIds } });
    await count("questionDrafts", "QuestionDraft", { exerciseId: { $in: exerciseIds } });
  }
  if (liveQuestionIds.length) {
    await count("liveResponses", "StudentResponse", { liveQuestion: { $in: liveQuestionIds } });
    await count("liveQuestions", "LiveQuestion", { _id: { $in: liveQuestionIds } });
  }
  await count("retestRequests", "RetestRequest", { courseId: { $in: courseIds } });
  await count("programCalendars", "Program-Calendar", { courseId: { $in: courseIds } });
  await count("calendarSchedules", "CalendarSchedule", { courseId: { $in: courseIds } });
  await count("attendanceRecords", "StudentAttendance", { courseId: { $in: courseIds } });
  await count("groups", "Course-Group", { course: { $in: courseIds } });
  await count("activityLogs", "ActivityLog", { courseId: { $in: courseIds } });
  await count("feedbackForms", "Feedback", { courseId: { $in: courseIds } });
  await count("codeWorkspaces", "StudentWorkspace", { courseId: { $in: courseIdStrings } });
  out.usersToUnenrol = await M("LMS-User").countDocuments({ "courses.courseId": { $in: courseIds } });
  out.compilerDocsToPrune = await M("Compiler12").countDocuments({ "courses.courseId": { $in: courseIds } });
  return out;
}

async function previewMapping(mapping) {
  const courseIds = await collectMappingCourseIds(mapping);
  const counts = await previewCourses(courseIds);
  counts.usersToDetach = await M("LMS-User").countDocuments({ serviceMappingId: mapping._id });
  return { courseIds, counts };
}

(async () => {
  const arg = process.argv[2];
  if (!arg) {
    console.log("Usage: node scripts/dryRunCascadeDelete.js <mappingId> | --all");
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGOURI);
  try {
    const ServiceMapping = M("LMS-ServiceMapping");
    if (arg === "--all") {
      const mappings = await ServiceMapping.find({}).lean();
      for (const m of mappings) {
        const { courseIds, counts } = await previewMapping(m);
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        console.log(
          `${m._id}  ${m.serviceCode || "(no code)"}  ${m.service || ""}: ` +
          `${courseIds.length} course(s), ${total} related docs → ` +
          JSON.stringify(counts)
        );
      }
    } else {
      if (!mongoose.Types.ObjectId.isValid(arg)) {
        console.error("Not a valid ObjectId:", arg);
        process.exit(1);
      }
      const m = await ServiceMapping.findById(arg).lean();
      if (!m) {
        console.error("No mapping with id", arg);
        process.exit(1);
      }
      const { courseIds, counts } = await previewMapping(m);
      console.log(`Mapping ${m._id} (${m.serviceCode || "no code"} · ${m.service || ""})`);
      console.log(`Courses that would be deleted (${courseIds.length}):`, courseIds);
      console.log("Would delete / clean:");
      console.log(JSON.stringify(counts, null, 2));
    }
  } finally {
    await mongoose.disconnect();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
