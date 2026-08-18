// ─── Live Screens REST controller ───────────────────────────────────────────
// Seeds the coordinator's Live Screens grid (who is enrolled / sharing / how
// many warnings) and powers the per-student violation history in the zoom view.
// Live media + real-time presence come over the socket (liveScreenSocket.js);
// these endpoints provide the initial snapshot + persisted violation log.
//
// Mirrors the data-access patterns in liveDashboard.js.

const Module1 = require("../../../models/Courses/moduleStructure/moduleModal");
const SubModule1 = require("../../../models/Courses/moduleStructure/subModuleModal");
const Topic1 = require("../../../models/Courses/moduleStructure/topicModal");
const SubTopic1 = require("../../../models/Courses/moduleStructure/subTopicModal");
const CourseStructure = require("../../../models/Courses/courseStructureModal");
const User = require("../../../models/UserModel");
const ExamSession = require("../../../models/Courses/moduleStructure/ExamSessionModel");
const ScreenViolation = require("../../../models/Courses/moduleStructure/ScreenViolationModel");

// Resources by Batch — an assessment may live in the shared You_Do or in a
// batch's own container; this merges both for _id-keyed lookups.
const { mergeSectionAcrossBatches } = require("../../../utils/pedagogyScope");

const MODEL_BY_TYPE = {
  module: Module1, modules: Module1,
  submodule: SubModule1, submodules: SubModule1,
  topic: Topic1, topics: Topic1,
  subtopic: SubTopic1, subtopics: SubTopic1,
};

function sectionEntries(section) {
  if (!section) return [];
  if (section instanceof Map) return Array.from(section.entries());
  if (typeof section === "object") return Object.entries(section);
  return [];
}

// Light resolve (fast path only) just to label the assessment. Avoids the
// expensive full-tree scan in liveDashboard.js since the name is non-critical.
async function resolveAssessmentName(assessmentId, nodeType, nodeId) {
  try {
    if (nodeType && nodeId && MODEL_BY_TYPE[nodeType]) {
      const doc = await MODEL_BY_TYPE[nodeType]
        .findById(nodeId)
        .select("pedagogy.You_Do batchPedagogy")
        .lean();
      // Resources by Batch — look in the shared You_Do and every batch's own.
      // Lookup is by `_id`, so the owning batch is irrelevant to the answer;
      // without this a batch-wise assessment just falls back to the generic
      // "Assessment" label.
      for (const [, exercises] of mergeSectionAcrossBatches(doc, "You_Do")) {
        const arr = Array.isArray(exercises) ? exercises : exercises && exercises._id ? [exercises] : [];
        const ex = arr.find((e) => e && e._id && e._id.toString() === assessmentId.toString());
        if (ex) return ex?.exerciseInformation?.exerciseName || "Assessment";
      }
    }
  } catch (e) {
    /* non-fatal */
  }
  return "Assessment";
}

function fmtActivity(d) {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleString("en-GB", {
      day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

// ─── GET /api/assessment/live-screens ────────────────────────────────────────
exports.getLiveScreens = async (req, res) => {
  try {
    const { assessmentId, courseId, nodeId, nodeType } = req.query;
    if (!assessmentId) {
      return res.status(400).json({ message: [{ key: "error", value: "assessmentId is required" }] });
    }
    if (!courseId) {
      return res.status(400).json({ message: [{ key: "error", value: "courseId is required" }] });
    }

    const assessmentName = await resolveAssessmentName(assessmentId, nodeType, nodeId);

    // Enrolled students = the course's participants.
    const course = await CourseStructure.findById(courseId)
      .select("batchAndParticipants")
      .populate({ path: "batchAndParticipants.users.user", select: "_id email firstName lastName" })
      .lean();

    const flatUsers = (course?.batchAndParticipants || [])
      .flatMap((batch) => batch.users || [])
      .map((p) => p.user)
      .filter((u) => u && u._id);
    // A user may sit in several batches — list them once only.
    const participants = Array.from(
      new Map(flatUsers.map((u) => [u._id.toString(), u])).values()
    );

    const sessions = await ExamSession.find({ assessmentId }).lean();
    const sessionByStudent = new Map(sessions.map((s) => [s.studentId.toString(), s]));

    const students = participants.map((u) => {
      const id = u._id.toString();
      const name = `${u.firstName || ""} ${u.lastName || ""}`.trim() || u.email || "Student";
      const session = sessionByStudent.get(id);

      // status: sharing > online (in session, not sharing) > offline (no session)
      let status = "offline";
      if (session) status = session.isSharingScreen ? "sharing" : session.isOnline ? "online" : "offline";

      return {
        id,
        studentName: name,
        email: u.email || "",
        // No dedicated register-number field exists — surface email as the
        // secondary identifier (product decision).
        registerNumber: u.email || "",
        isSharingScreen: !!session?.isSharingScreen,
        warningCount: session?.warningCount || 0,
        status,
        startedAt: session?.joinedAt ? new Date(session.joinedAt).toISOString() : null,
        lastActivity: fmtActivity(session?.lastActivityAt),
        submitted: !!session?.submittedAt,
      };
    });

    return res.status(200).json({
      assessmentName,
      totalStudents: students.length,
      students,
    });
  } catch (err) {
    console.error("getLiveScreens error:", err);
    return res.status(500).json({ message: [{ key: "error", value: `Internal server error: ${err.message}` }] });
  }
};

// ─── GET /api/assessment/screen-violations ───────────────────────────────────
exports.getScreenViolations = async (req, res) => {
  try {
    const { assessmentId, studentId } = req.query;
    if (!assessmentId || !studentId) {
      return res.status(400).json({ message: [{ key: "error", value: "assessmentId and studentId are required" }] });
    }

    const student = await User.findById(studentId).select("firstName lastName email").lean().catch(() => null);
    const studentName = student
      ? `${student.firstName || ""} ${student.lastName || ""}`.trim() || student.email
      : "Student";

    const session = await ExamSession.findOne({ assessmentId, studentId }).lean();
    const violations = await ScreenViolation.find({ assessmentId, studentId })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    return res.status(200).json({
      studentName,
      email: student?.email || "",
      registerNumber: student?.email || "",
      isSharingScreen: !!session?.isSharingScreen,
      warningCount: session?.warningCount || 0,
      startedAt: session?.joinedAt ? new Date(session.joinedAt).toISOString() : null,
      submitted: !!session?.submittedAt,
      lastActivity: fmtActivity(session?.lastActivityAt),
      violations: violations.map((v) => ({
        id: v._id.toString(),
        type: v.type,
        detail: v.detail || "",
        at: v.createdAt ? new Date(v.createdAt).toISOString() : null,
      })),
    });
  } catch (err) {
    console.error("getScreenViolations error:", err);
    return res.status(500).json({ message: [{ key: "error", value: `Internal server error: ${err.message}` }] });
  }
};
