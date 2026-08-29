const mongoose = require("mongoose");

const Module1 = require("../../../models/Courses/moduleStructure/moduleModal");
const SubModule1 = require("../../../models/Courses/moduleStructure/subModuleModal");
const Topic1 = require("../../../models/Courses/moduleStructure/topicModal");
const SubTopic1 = require("../../../models/Courses/moduleStructure/subTopicModal");
const CourseStructure = require("../../../models/Courses/courseStructureModal");
const User = require("../../../models/UserModel");
const ExamSession = require("../../../models/Courses/moduleStructure/ExamSessionModel");
const ActivityLog = require("../../../models/ActivityLog");
const StudentQuestionActivity = require("../../../models/Courses/moduleStructure/StudentQuestionActivityModel");
const ProctorMessage = require("../../../models/Courses/moduleStructure/ProctorMessageModel");

const MODEL_BY_TYPE = {
  module: Module1, modules: Module1,
  submodule: SubModule1, submodules: SubModule1,
  topic: Topic1, topics: Topic1,
  subtopic: SubTopic1, subtopics: SubTopic1,
};
// Resources by Batch — an assessment may live in the shared You_Do or in a
// batch's own container; this merges both for _id-keyed lookups.
const { mergeSectionAcrossBatches } = require("../../../utils/pedagogyScope");

const ALL_MODELS = [Module1, SubModule1, Topic1, SubTopic1];

// Normalise a pedagogy section (Map or plain object) into [subcategory, exercises[]] pairs
function sectionEntries(section) {
  if (!section) return [];
  if (section instanceof Map) return Array.from(section.entries());
  if (typeof section === "object") return Object.entries(section);
  return [];
}

// Find the embedded assessment (exercise) by id, scanning pedagogy.You_Do.
// Returns { exercise, subcategory } or null.
async function resolveExercise(exerciseId, nodeType, nodeId) {
  const tryDoc = (doc) => {
    // Resources by Batch — search the shared You_Do AND every batch's own.
    // This resolves an assessment from its `_id`, which is unique, so the
    // owning batch does not change the answer; what matters is that a
    // batch-wise assessment is visible here at all. A plain
    // `doc.pedagogy.You_Do` would miss it and the live dashboard would report
    // the assessment as not found.
    for (const [subcategory, exercises] of mergeSectionAcrossBatches(doc, "You_Do")) {
      const arr = Array.isArray(exercises) ? exercises : (exercises && exercises._id ? [exercises] : []);
      const ex = arr.find((e) => e && e._id && e._id.toString() === exerciseId.toString());
      if (ex) return { exercise: ex, subcategory };
    }
    return null;
  };

  // Fast path: caller told us where it lives.
  if (nodeType && nodeId && MODEL_BY_TYPE[nodeType]) {
    const doc = await MODEL_BY_TYPE[nodeType]
      .findById(nodeId)
      .select("title pedagogy.You_Do batchPedagogy")
      .lean();
    const hit = doc && tryDoc(doc);
    if (hit) return hit;
  }

  // Fallback: scan every node type for a doc containing this exercise.
  // The filter needs `batchPedagogy` too: a node whose You_Do is entirely
  // batch-wise has no `pedagogy.You_Do` at all, so the original $exists check
  // would skip it and the scan would come back empty.
  for (const Model of ALL_MODELS) {
    const docs = await Model.find({
      $or: [
        { "pedagogy.You_Do": { $exists: true } },
        { batchPedagogy: { $exists: true, $ne: null } },
      ],
    })
      .select("title pedagogy.You_Do batchPedagogy")
      .lean();
    for (const doc of docs) {
      const hit = tryDoc(doc);
      if (hit) return hit;
    }
  }
  return null;
}

// Titles may be stored as content-block arrays/objects ([{ id, type, value }])
// or HTML strings. Flatten to a plain string so the client can render it safely.
function plainText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (Array.isArray(v)) return v.map(plainText).filter(Boolean).join(" ").trim();
  if (typeof v === "object") return plainText(v.value ?? v.text ?? "");
  return String(v);
}

// Build lightweight question metadata from an exercise's questions[].
function questionMeta(exercise) {
  const qs = Array.isArray(exercise?.questions) ? exercise.questions : [];
  return qs.map((q, i) => {
    const title =
      plainText(q.mcqQuestionTitle) ||
      plainText(q.title) ||
      plainText(q.programmingQuestionTitle) ||
      `Question ${i + 1}`;
    return {
      id: (q._id || q.id || "").toString(),
      questionNo: `Q${i + 1}`,
      questionTitle: title,
      questionType: (q.questionType || (q.mcqQuestionType ? "mcq" : "") || "").toString(),
      marks: q.mcqQuestionScore ?? q.score ?? q.points ?? 0,
    };
  });
}

function totalQuestionsOf(exercise) {
  if (Array.isArray(exercise?.questions) && exercise.questions.length) return exercise.questions.length;
  return exercise?.exerciseInformation?.totalQuestions || 0;
}

// Scan a user's stored answers for this exercise (across all You_Do subcategories).
function findPersistedExerciseEntry(user, courseId, exerciseId) {
  const courseEntry = (user.courses || []).find(
    (c) => c.courseId && c.courseId.toString() === courseId.toString()
  );
  if (!courseEntry || !courseEntry.answers) return null;
  const youdo = courseEntry.answers.You_Do;
  for (const [, exercises] of sectionEntries(youdo)) {
    const arr = Array.isArray(exercises) ? exercises : [];
    const entry = arr.find((e) => e.exerciseId && e.exerciseId.toString() === exerciseId.toString());
    if (entry) return entry;
  }
  return null;
}

// Seed a student's progress from persisted answers (best-known state before live events).
function seedProgressFromAnswers(entry, totalQuestions) {
  if (!entry) {
    return {
      completed: 0,
      yetToComplete: totalQuestions,
      notAttempted: totalQuestions,
      inProgress: false,
      completionPercent: 0,
      lastActivity: null,
      submitted: false,
    };
  }
  const answered = Array.isArray(entry.questions) ? entry.questions.length : 0;
  const completed = Math.min(answered, totalQuestions);
  const submitted = entry.status === "completed" || (entry.testSubmissions || 0) > 0;
  return {
    completed,
    yetToComplete: Math.max(0, totalQuestions - completed),
    notAttempted: Math.max(0, totalQuestions - completed),
    // No live ExamSession ⇒ student is not actively attending. Even if they
    // have saved answers from an earlier session, "Started" must mean a live
    // session is open right now (matches the frontend rule in StudentRow).
    inProgress: false,
    completionPercent: totalQuestions ? Math.round((completed / totalQuestions) * 100) : 0,
    lastActivity: entry.updatedAt || entry.createdAt || null,
    submitted,
  };
}

// Duration (seconds) a student spent on the assessment = submit − start.
// Prefer the live ExamSession (joinedAt → submittedAt); fall back to the
// authoritative closed `exercise_start` ActivityLog (details.duration); last
// resort, the persisted answer entry timestamps. Returns null when unknown.
function computeDurationSeconds({ session, activityDuration, entry }) {
  if (session && session.submittedAt && session.joinedAt) {
    const sec = Math.round(
      (new Date(session.submittedAt).getTime() - new Date(session.joinedAt).getTime()) / 1000
    );
    if (Number.isFinite(sec) && sec >= 0) return sec;
  }
  if (activityDuration != null && Number.isFinite(activityDuration)) {
    return Math.max(0, Math.round(activityDuration));
  }
  if (entry && entry.lastTestSubmittedAt && entry.createdAt) {
    const sec = Math.round(
      (new Date(entry.lastTestSubmittedAt).getTime() - new Date(entry.createdAt).getTime()) / 1000
    );
    if (Number.isFinite(sec) && sec >= 0) return sec;
  }
  return null;
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

// ─── GET /api/assessment/live-dashboard ──────────────────────────────────────
exports.getLiveDashboard = async (req, res) => {
  try {
    const { assessmentId, courseId, nodeId, nodeType } = req.query;
    if (!assessmentId) {
      return res.status(400).json({ message: [{ key: "error", value: "assessmentId is required" }] });
    }
    if (!courseId) {
      return res.status(400).json({ message: [{ key: "error", value: "courseId is required" }] });
    }

    const resolved = await resolveExercise(assessmentId, nodeType, nodeId);
    const exercise = resolved?.exercise || null;
    const totalQuestions = totalQuestionsOf(exercise);
    const assessmentName = exercise?.exerciseInformation?.exerciseName || "Assessment";
    const startDate = exercise?.availabilityPeriod?.startDate || null;
    const endDate = exercise?.availabilityPeriod?.endDate || null;

    // Enrolled students = the course's participants.
    const course = await CourseStructure.findById(courseId)
      .select("courseName batchAndParticipants")
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

    // Live sessions for this assessment, keyed by studentId.
    const sessions = await ExamSession.find({ assessmentId }).lean();

    // ── Self-heal stale sessions ────────────────────────────────────────────
    // A student who closed their tab abruptly (no clean disconnect, no socket
    // event) can leave a session row with inProgress: true forever. Anything
    // that hasn't reported activity in 60s and hasn't submitted is treated as
    // offline + not-in-progress. We persist the flip so the next read agrees
    // and patch the in-memory copy so this response reflects it immediately.
    const STALE_MS = 60 * 1000;
    const staleCutoff = Date.now() - STALE_MS;
    const staleIds = [];
    for (const s of sessions) {
      const lastTs = s.lastActivityAt ? new Date(s.lastActivityAt).getTime() : 0;
      if (s.inProgress && !s.submittedAt && lastTs < staleCutoff) {
        s.inProgress = false;
        s.isOnline = false;
        staleIds.push(s._id);
      }
    }
    if (staleIds.length) {
      await ExamSession.updateMany(
        { _id: { $in: staleIds } },
        { $set: { inProgress: false, isOnline: false } }
      );
    }

    const sessionByStudent = new Map(sessions.map((s) => [s.studentId.toString(), s]));

    // For seeding from persisted answers we need the full user docs.
    const userIds = participants.map((u) => u._id);
    const users = await User.find({ _id: { $in: userIds } }).select("courses").lean();
    const userById = new Map(users.map((u) => [u._id.toString(), u]));

    // Authoritative per-attempt duration from the closed `exercise_start` logs
    // (set on test submit by trackAssignmentDuration). Keyed by studentId, most
    // recent closed log wins. Used as the duration source / fallback below.
    const durationLogs = await ActivityLog.find({
      userId: { $in: userIds },
      action: "exercise_start",
      "details.exerciseId": String(assessmentId),
      "details.duration": { $ne: null },
    })
      .select("userId details.duration createdAt")
      .sort({ createdAt: -1 })
      .lean();
    const durationByStudent = new Map();
    for (const log of durationLogs) {
      const sid = log.userId.toString();
      if (!durationByStudent.has(sid)) durationByStudent.set(sid, log.details?.duration);
    }

    const students = participants.map((u) => {
      const id = u._id.toString();
      const name = `${u.firstName || ""} ${u.lastName || ""}`.trim() || u.email || "Student";
      const session = sessionByStudent.get(id);

      if (session) {
        // Live state wins when a session exists.
        const completed = session.completedCount || 0;
        return {
          id,
          studentName: name,
          email: u.email || "",
          totalQuestions: session.totalQuestions || totalQuestions,
          completed,
          yetToComplete: Math.max(0, (session.totalQuestions || totalQuestions) - completed),
          notAttempted: session.notAttemptedCount ?? Math.max(0, (session.totalQuestions || totalQuestions) - completed),
          inProgress: !!session.inProgress,
          completionPercent: (session.totalQuestions || totalQuestions)
            ? Math.round((completed / (session.totalQuestions || totalQuestions)) * 100)
            : 0,
          lastActivity: fmtActivity(session.lastActivityAt),
          submitted: !!session.submittedAt,
          durationSeconds: computeDurationSeconds({ session, activityDuration: durationByStudent.get(id) }),
          // Recovery & Resume — carry lifecycle fields on the initial fetch
          // so the dashboard row renders the correct pill immediately
          // (before any socket update lands).
          isOnline: !!session.isOnline,
          attemptStatus: session.status || (session.submittedAt ? 'submitted' : 'active'),
          terminationReason: session.terminationReason || null,
        };
      }

      // Otherwise seed from persisted answers.
      const entry = findPersistedExerciseEntry(userById.get(id) || {}, courseId, assessmentId);
      const seed = seedProgressFromAnswers(entry, totalQuestions);
      return {
        id,
        studentName: name,
        email: u.email || "",
        totalQuestions,
        completed: seed.completed,
        yetToComplete: seed.yetToComplete,
        notAttempted: seed.notAttempted,
        inProgress: seed.inProgress,
        completionPercent: seed.completionPercent,
        lastActivity: fmtActivity(seed.lastActivity),
        submitted: seed.submitted,
        durationSeconds: computeDurationSeconds({ activityDuration: durationByStudent.get(id), entry }),
      };
    });

    return res.status(200).json({
      assessmentName,
      courseName: course?.courseName || "",
      startDate,
      endDate,
      totalStudents: students.length,
      students,
    });
  } catch (err) {
    console.error("getLiveDashboard error:", err);
    return res.status(500).json({ message: [{ key: "error", value: `Internal server error: ${err.message}` }] });
  }
};

// ─── GET /api/assessment/student-details ─────────────────────────────────────
exports.getStudentDetails = async (req, res) => {
  try {
    const { assessmentId, studentId, nodeId, nodeType } = req.query;
    if (!assessmentId || !studentId) {
      return res.status(400).json({ message: [{ key: "error", value: "assessmentId and studentId are required" }] });
    }

    const resolved = await resolveExercise(assessmentId, nodeType, nodeId);
    const exercise = resolved?.exercise || null;
    const meta = questionMeta(exercise);
    const totalQuestions = meta.length || totalQuestionsOf(exercise);
    const assessmentName = exercise?.exerciseInformation?.exerciseName || "Assessment";

    const student = await User.findById(studentId).select("firstName lastName email courses").lean();
    const studentName = student
      ? `${student.firstName || ""} ${student.lastName || ""}`.trim() || student.email
      : "Student";

    // Live per-question activity (preferred), keyed by questionId.
    const activities = await StudentQuestionActivity.find({ assessmentId, studentId }).lean();
    const actByQ = new Map(activities.map((a) => [a.questionId.toString(), a]));

    // Persisted answers fallback (per-question status).
    const entry = student ? findPersistedExerciseEntry(student, exercise && resolved ? (req.query.courseId || "") : "", assessmentId) : null;
    const persistedByQ = new Map(
      (entry?.questions || []).map((q) => [q.questionId?.toString(), q])
    );

    const questions = meta.map((m) => {
      const live = actByQ.get(m.id);
      if (live) {
        return {
          id: m.id,
          questionNo: m.questionNo,
          questionTitle: m.questionTitle,
          questionType: m.questionType,
          marks: m.marks,
          status: live.status === "submitted" ? "submitted" : live.status === "answered" ? "in_progress" : "pending",
          submittedAt: live.submittedAt ? new Date(live.submittedAt).toISOString() : null,
          timeTakenSeconds: live.timeTakenSeconds || 0,
        };
      }
      const p = persistedByQ.get(m.id);
      const answered = !!p;
      return {
        id: m.id,
        questionNo: m.questionNo,
        questionTitle: m.questionTitle,
        questionType: m.questionType,
        marks: m.marks,
        status: answered ? "submitted" : "pending",
        submittedAt: p?.submittedAt ? new Date(p.submittedAt).toISOString() : null,
        timeTakenSeconds: 0,
      };
    });

    const completed = questions.filter((q) => q.status === "submitted").length;

    return res.status(200).json({
      studentName,
      email: student?.email || "",
      assessmentName,
      totalQuestions,
      completed,
      yetToComplete: Math.max(0, totalQuestions - completed),
      completionPercent: totalQuestions ? Math.round((completed / totalQuestions) * 100) : 0,
      questions,
    });
  } catch (err) {
    console.error("getStudentDetails error:", err);
    return res.status(500).json({ message: [{ key: "error", value: `Internal server error: ${err.message}` }] });
  }
};

// ─── Proctor ↔ Student messages ─────────────────────────────────────────────
// Chat history for one (assessment, student) thread. A student loads their own
// thread (studentId defaults to the authed user); a proctor may pass any
// studentId to read that thread.
exports.getMessages = async (req, res) => {
  try {
    const { assessmentId } = req.query;
    const studentId = req.query.studentId || String(req.user._id);
    if (!assessmentId) {
      return res.status(400).json({ success: false, message: "assessmentId is required" });
    }
    const messages = await ProctorMessage.find({
      assessmentId: String(assessmentId),
      studentId: String(studentId),
    })
      .sort({ createdAt: 1 })
      .lean();

    const unread = messages.reduce((n, m) => n + (m.read ? 0 : 1), 0);
    return res.status(200).json({ success: true, messages, unread });
  } catch (err) {
    console.error("getMessages error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// Mark a student's thread as read (called when they open the chat panel).
exports.markMessagesRead = async (req, res) => {
  try {
    const { assessmentId } = req.body || {};
    const studentId = (req.body && req.body.studentId) || String(req.user._id);
    if (!assessmentId) {
      return res.status(400).json({ success: false, message: "assessmentId is required" });
    }
    await ProctorMessage.updateMany(
      { assessmentId: String(assessmentId), studentId: String(studentId), read: false },
      { $set: { read: true } }
    );
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("markMessagesRead error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};
