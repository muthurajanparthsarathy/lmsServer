// ─── Live Dashboard socket handlers ─────────────────────────────────────────
// Attached to the EXISTING io instance (see server.js). Never creates a new
// socket server. All teacher views for one assessment share the room
// `assessment_{assessmentId}_teachers`, so multiple teachers stay in sync.

const ExamSession = require("../models/Courses/moduleStructure/ExamSessionModel");
const StudentQuestionActivity = require("../models/Courses/moduleStructure/StudentQuestionActivityModel");
const User = require("../models/UserModel");

const room = (assessmentId) => `assessment_${assessmentId}_teachers`;

// Pending "went offline" timers, so a quick reconnect cancels the offline mark.
const offlineTimers = new Map(); // key: `${assessmentId}:${studentId}` → Timeout

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

// Stash the (assessmentId, studentId) this socket represents, so the native
// `disconnect` handler can run the same offline-cleanup as the cooperative
// `student:disconnected` event when the tab is killed without a clean emit.
function rememberStudent(socket, assessmentId, studentId) {
  if (!socket || !assessmentId || !studentId) return;
  socket.data = socket.data || {};
  socket.data.studentContext = { assessmentId, studentId };
}

// Mark the student offline and schedule the 30s grace before flipping
// inProgress → false. Shared by `student:disconnected` and the native
// `disconnect` handler so both paths self-heal identically.
async function scheduleOfflineFlip(io, assessmentId, studentId) {
  if (!assessmentId || !studentId) return;
  await ExamSession.updateOne(
    { assessmentId, studentId },
    { $set: { isOnline: false, lastActivityAt: new Date() } }
  );

  const key = `${assessmentId}:${studentId}`;
  if (offlineTimers.has(key)) clearTimeout(offlineTimers.get(key));
  const timer = setTimeout(async () => {
    offlineTimers.delete(key);
    const session = await ExamSession.findOne({ assessmentId, studentId });
    if (session && !session.isOnline && !session.submittedAt) {
      session.inProgress = false;
      await session.save();
      io.to(room(assessmentId)).emit("dashboard:student_update", {
        studentId, inProgress: false, lastActivity: fmtActivity(session.lastActivityAt),
      });
    }
  }, 30000);
  offlineTimers.set(key, timer);
}

async function getOrCreateSession(assessmentId, studentId, patch = {}) {
  let session = await ExamSession.findOne({ assessmentId, studentId });
  if (!session) {
    session = new ExamSession({ assessmentId, studentId, joinedAt: new Date(), ...patch });
  } else {
    Object.assign(session, patch);
  }
  await session.save();
  return session;
}

// Recompute completed/notAttempted from per-question activity, persist, broadcast.
async function recomputeAndBroadcast(io, assessmentId, studentId, extra = {}) {
  const session = await ExamSession.findOne({ assessmentId, studentId });
  if (!session) return;

  const completed = await StudentQuestionActivity.countDocuments({ assessmentId, studentId, status: "submitted" });
  const touched = await StudentQuestionActivity.countDocuments({ assessmentId, studentId, status: { $ne: "pending" } });
  const total = session.totalQuestions || 0;

  session.completedCount = completed;
  session.notAttemptedCount = Math.max(0, total - touched);
  await session.save();

  io.to(room(assessmentId)).emit("dashboard:student_update", {
    studentId,
    completed,
    yetToComplete: Math.max(0, total - completed),
    notAttempted: session.notAttemptedCount,
    completionPercent: total ? Math.round((completed / total) * 100) : 0,
    inProgress: session.inProgress,
    lastActivity: fmtActivity(session.lastActivityAt),
    ...extra,
  });
}

function registerLiveDashboardHandlers(io, socket) {
  // ── Teacher rooms ──────────────────────────────────────────────────────────
  socket.on("teacher:join_dashboard", ({ assessmentId }) => {
    if (!assessmentId) return;
    socket.join(room(assessmentId));
  });

  socket.on("teacher:leave_dashboard", ({ assessmentId }) => {
    if (!assessmentId) return;
    socket.leave(room(assessmentId));
  });

  // ── Student joined ───────────────────────────────────────────────────────────
  socket.on("student:joined", async ({ assessmentId, studentId, totalQuestions }) => {
    try {
      if (!assessmentId || !studentId) return;
      rememberStudent(socket, assessmentId, studentId);
      // totalQuestions may arrive from a single section (smaller) or the whole
      // assessment (larger) — keep the largest so % is computed against the full set.
      const existing = await ExamSession.findOne({ assessmentId, studentId }).lean();
      const total = Math.max(
        existing?.totalQuestions || 0,
        typeof totalQuestions === "number" ? totalQuestions : 0
      );
      const session = await getOrCreateSession(assessmentId, studentId, {
        isOnline: true,
        inProgress: true,
        lastActivityAt: new Date(),
        ...(total > 0 ? { totalQuestions: total } : {}),
      });

      const user = await User.findById(studentId).select("firstName lastName email").lean().catch(() => null);
      const name = user ? `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email : "Student";
      const completed = session.completedCount || 0;

      io.to(room(assessmentId)).emit("dashboard:student_joined", {
        id: studentId,
        studentName: name,
        email: user?.email || "",
        totalQuestions: total,
        completed,
        yetToComplete: Math.max(0, total - completed),
        notAttempted: session.notAttemptedCount ?? Math.max(0, total - completed),
        inProgress: session.inProgress,
        completionPercent: total ? Math.round((completed / total) * 100) : 0,
        lastActivity: fmtActivity(session.lastActivityAt),
        submitted: !!session.submittedAt,
      });
    } catch (e) {
      console.error("student:joined error:", e.message);
    }
  });

  // ── Answer saved ─────────────────────────────────────────────────────────────
  socket.on("student:answer_saved", async ({ assessmentId, studentId, questionId, answer, timeTakenSeconds }) => {
    try {
      if (!assessmentId || !studentId || !questionId) return;
      rememberStudent(socket, assessmentId, studentId);
      const session = await getOrCreateSession(assessmentId, studentId, { isOnline: true, inProgress: true, lastActivityAt: new Date() });

      const submittedAt = new Date();
      await StudentQuestionActivity.findOneAndUpdate(
        { examSessionId: session._id, questionId },
        {
          $set: {
            examSessionId: session._id,
            assessmentId, studentId, questionId,
            status: "submitted",
            answer: answer != null ? String(answer).slice(0, 5000) : null,
            submittedAt,
            timeTakenSeconds: timeTakenSeconds || 0,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      await recomputeAndBroadcast(io, assessmentId, studentId);

      // Details view: this question is now submitted.
      io.to(room(assessmentId)).emit("student:question_update", {
        studentId, questionId, status: "submitted",
        submittedAt: submittedAt.toISOString(),
        timeTakenSeconds: timeTakenSeconds || 0,
      });
    } catch (e) {
      console.error("student:answer_saved error:", e.message);
    }
  });

  // ── Question changed (navigation) ────────────────────────────────────────────
  socket.on("student:question_changed", async ({ assessmentId, studentId, toQuestionId }) => {
    try {
      if (!assessmentId || !studentId) return;
      rememberStudent(socket, assessmentId, studentId);
      const session = await getOrCreateSession(assessmentId, studentId, {
        isOnline: true, inProgress: true, lastActivityAt: new Date(), currentQuestionId: toQuestionId || null,
      });

      // Mark the question the student moved TO as in-progress (unless already submitted).
      if (toQuestionId) {
        const existing = await StudentQuestionActivity.findOne({ examSessionId: session._id, questionId: toQuestionId });
        if (!existing) {
          await StudentQuestionActivity.create({
            examSessionId: session._id, assessmentId, studentId, questionId: toQuestionId, status: "answered",
          });
        }
        if (!existing || existing.status !== "submitted") {
          io.to(room(assessmentId)).emit("student:question_update", {
            studentId, questionId: toQuestionId, status: "in_progress",
            submittedAt: null, timeTakenSeconds: existing?.timeTakenSeconds || 0,
          });
        }
      }

      io.to(room(assessmentId)).emit("dashboard:student_update", {
        studentId, inProgress: true, lastActivity: fmtActivity(session.lastActivityAt),
      });
    } catch (e) {
      console.error("student:question_changed error:", e.message);
    }
  });

  // ── Submitted (guard duplicates) ─────────────────────────────────────────────
  socket.on("student:submitted", async ({ assessmentId, studentId }) => {
    try {
      if (!assessmentId || !studentId) return;
      const session = await ExamSession.findOne({ assessmentId, studentId });
      if (session && session.submittedAt) return; // already submitted → ignore

      const submittedSession = await getOrCreateSession(assessmentId, studentId, {
        submittedAt: new Date(), inProgress: false, isOnline: true, lastActivityAt: new Date(),
      });

      // Duration = submit − start, so the dashboard "Time Duration" fills in the
      // moment a student submits (rather than only after a full refetch).
      let durationSeconds = null;
      if (submittedSession?.joinedAt && submittedSession?.submittedAt) {
        const sec = Math.round(
          (new Date(submittedSession.submittedAt).getTime() - new Date(submittedSession.joinedAt).getTime()) / 1000
        );
        if (Number.isFinite(sec) && sec >= 0) durationSeconds = sec;
      }

      // Recompute every count from the per-question activity and broadcast them
      // together, so Completed / Yet To Complete / Not Attempted / % always agree.
      await recomputeAndBroadcast(io, assessmentId, studentId, { inProgress: false, submitted: true, durationSeconds });
    } catch (e) {
      console.error("student:submitted error:", e.message);
    }
  });

  // ── Disconnected (cooperative emit) → 30s grace, then mark not-in-progress ──
  socket.on("student:disconnected", async ({ assessmentId, studentId }) => {
    try {
      await scheduleOfflineFlip(io, assessmentId, studentId);
    } catch (e) {
      console.error("student:disconnected error:", e.message);
    }
  });

  // ── Native disconnect (hard tab close, network drop, browser kill) ─────────
  // The client can't always emit `student:disconnected` before the socket
  // tears down. The native `disconnect` event always fires, so we run the
  // same 30s offline-flip using the (assessmentId, studentId) we stashed on
  // the socket during earlier student events. If we never saw a student
  // event on this socket (it was a teacher socket, or never joined an
  // assessment), `studentContext` is undefined and the helper no-ops.
  socket.on("disconnect", async () => {
    try {
      const ctx = socket.data && socket.data.studentContext;
      if (!ctx) return;
      await scheduleOfflineFlip(io, ctx.assessmentId, ctx.studentId);
    } catch (e) {
      console.error("socket disconnect cleanup error:", e.message);
    }
  });

  // ── Reconnected → cancel offline timer, back online ─────────────────────────
  socket.on("student:reconnected", async ({ assessmentId, studentId }) => {
    try {
      if (!assessmentId || !studentId) return;
      rememberStudent(socket, assessmentId, studentId);
      const key = `${assessmentId}:${studentId}`;
      if (offlineTimers.has(key)) { clearTimeout(offlineTimers.get(key)); offlineTimers.delete(key); }

      const session = await ExamSession.findOne({ assessmentId, studentId });
      if (!session) return;
      session.isOnline = true;
      if (!session.submittedAt) session.inProgress = true;
      session.lastActivityAt = new Date();
      await session.save();

      io.to(room(assessmentId)).emit("dashboard:student_update", {
        studentId, inProgress: session.inProgress, lastActivity: fmtActivity(session.lastActivityAt),
      });
    } catch (e) {
      console.error("student:reconnected error:", e.message);
    }
  });
}

module.exports = { registerLiveDashboardHandlers };
