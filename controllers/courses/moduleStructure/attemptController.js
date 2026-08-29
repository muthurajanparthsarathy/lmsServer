// ─── Assessment Attempt Lifecycle ──────────────────────────────────────────
// Endpoints that own the "one attempt per (student, exercise)" contract for
// the Recovery & Resume feature.
//
// TIMER MODEL — ELAPSED-TIME (freeze at last submit)
//   `remainingSeconds = totalDurationSeconds - max(0, (lastSubmittedAt || startedAt) - startedAt)`
//   The clock freezes at the moment of the last question submission. Time the
//   student was away doesn't count against them. Matches product spec:
//     Start 10:00 · last submit 10:08 · resume anytime → 22 min remaining.
//
// PERMISSION GATE
//   Any /start on an existing attempt whose `resumeState !== 'approved_for_resume'`
//   returns `{ requiresApproval: true }` INSTEAD of resuming. The student clicks
//   Request Resume → trainer clicks Approve on the dashboard → state flips to
//   `approved_for_resume`. The next /start returns the resumable attempt and
//   flips state back to `active`. Auto-resume is gone.
//
//   The gate arms itself:
//   - the moment the socket flips isOnline=false after the 30s grace, OR
//   - immediately when the student pauses / navigates away.
//
// Endpoints:
//   POST  /courses/attempt/start              — idempotent; may return requiresApproval
//   GET   /courses/attempt/state              — full resume payload (answers, timer, position)
//   PATCH /courses/attempt/current-question   — debounced position tracking
//   POST  /courses/attempt/submit             — terminal, idempotent
//   POST  /courses/attempt/request-resume     — student asks for permission
//   POST  /courses/attempt/approve-resume     — trainer approves (from dashboard)
//   POST  /courses/attempt/reject-resume      — trainer rejects
//
// This controller intentionally does NOT compute scores. Actual answer
// persistence still flows through submitAnswer / submitMultipleFiles.

const mongoose = require('mongoose');
const ExamSession = require('../../../models/Courses/moduleStructure/ExamSessionModel');
const StudentQuestionActivity = require('../../../models/Courses/moduleStructure/StudentQuestionActivityModel');
const User = require('../../../models/UserModel');
const socketIO = require('../../../utils/socket');

const Module1 = mongoose.model('Module1');
const SubModule1 = mongoose.model('SubModule1');
const Topic1 = mongoose.model('Topic1');
const SubTopic1 = mongoose.model('SubTopic1');

const entityModelByType = {
  modules: Module1,
  submodules: SubModule1,
  topics: Topic1,
  subtopics: SubTopic1,
};

// Sanity cap on any client-provided timer hint.
const MAX_DURATION_MINUTES = 24 * 60;

// ─── Helpers ────────────────────────────────────────────────────────────────

async function resolveExerciseDuration({ exerciseId, nodeId, nodeType, subcategory, category }) {
  const Model = entityModelByType[nodeType];
  if (!Model || !nodeId || !exerciseId || !subcategory) return null;
  const entity = await Model.findById(nodeId);
  if (!entity) return null;
  const containers = [];
  if (entity.pedagogy) containers.push(entity.pedagogy);
  const bp = entity.batchPedagogy;
  if (bp) {
    const ids = typeof bp.keys === 'function' ? Array.from(bp.keys()) : Object.keys(bp);
    for (const id of ids) {
      const bucket = typeof bp.get === 'function' ? bp.get(id) : bp[id];
      if (bucket) containers.push(bucket);
    }
  }
  const target = String(exerciseId);
  const cat = category || 'You_Do';
  for (const c of containers) {
    const section = c?.[cat];
    if (!section) continue;
    const list = typeof section.get === 'function' ? section.get(subcategory) : section[subcategory];
    if (!Array.isArray(list)) continue;
    const found = list.find((e) => e && String(e._id) === target);
    if (found) {
      const raw = found?.exerciseInformation?.totalDuration;
      const mins = Number(raw);
      if (Number.isFinite(mins) && mins > 0 && mins <= MAX_DURATION_MINUTES) return mins;
      return null;
    }
  }
  return null;
}

// Elapsed-time remaining computation (product spec, freeze-at-last-submit).
//   Session with no timer → returns null.
//   Session with timer but never submitted a question → remaining = full duration.
//   Otherwise → duration - (lastSubmittedAt - startedAt), floored at 0.
function computeRemainingSeconds(session) {
  const total = Number(session?.totalDurationSeconds);
  if (!Number.isFinite(total) || total <= 0) return null;
  if (!session.startedAt) return total;
  const anchor = session.lastSubmittedAt || session.startedAt;
  const elapsedMs = Math.max(0, new Date(anchor).getTime() - new Date(session.startedAt).getTime());
  const elapsedSec = Math.floor(elapsedMs / 1000);
  return Math.max(0, total - elapsedSec);
}

// Shape returned to the client on /start and /state. Includes the elapsed
// timer values so the client never has to compute them itself.
function serialiseAttempt(session) {
  if (!session) return null;
  const now = new Date();
  const remaining = computeRemainingSeconds(session);
  const total = Number.isFinite(Number(session.totalDurationSeconds))
    ? Number(session.totalDurationSeconds) : null;
  return {
    id: String(session._id),
    exerciseId: session.assessmentId,
    studentId: session.studentId,
    startedAt: session.startedAt || session.joinedAt,
    lastSubmittedAt: session.lastSubmittedAt || null,
    totalDurationSeconds: total,
    remainingSeconds: remaining,
    // Legacy wall-clock fallback for old rows / clients that still read it.
    // Computed from remainingSeconds so it always agrees with the new model.
    serverExpiresAt: remaining != null ? new Date(now.getTime() + remaining * 1000) : null,
    status: session.status || 'active',
    terminationReason: session.terminationReason || null,
    currentQuestionId: session.currentQuestionId || null,
    submittedAt: session.submittedAt || null,
    resumeState: session.resumeState || 'active',
    resumeRequestedAt: session.resumeRequestedAt || null,
    resumeApprovedAt: session.resumeApprovedAt || null,
  };
}

async function loadPersistedAnswers({ userId, courseId, exerciseId, category, subcategory }) {
  const user = await User.findById(userId).select('courses').lean();
  if (!user || !Array.isArray(user.courses)) return [];
  const course = user.courses.find((c) => c.courseId && String(c.courseId) === String(courseId));
  if (!course || !course.answers || !course.answers[category]) return [];
  const map = course.answers[category];
  const key = (category === 'We_Do' || category === 'You_Do') ? subcategory : String(exerciseId);
  const list = (map instanceof Map ? map.get(key) : map[key]) || [];
  const exProgress = list.find((e) => e && String(e.exerciseId) === String(exerciseId));
  if (!exProgress || !Array.isArray(exProgress.questions)) return [];
  return exProgress.questions.map((q) => ({
    questionId: String(q.questionId),
    code: q.code || '',
    language: q.language || '',
    othersFiles: Array.isArray(q.othersFiles) ? q.othersFiles : undefined,
    notionPages: Array.isArray(q.notionPages) ? q.notionPages : undefined,
    selectedProgrammingLanguage: q.selectedProgrammingLanguage || undefined,
    score: typeof q.score === 'number' ? q.score : undefined,
    status: q.status || 'attempted',
    submittedAt: q.submittedAt || null,
    attempts: q.attempts || 0,
  }));
}

// Fire-and-forget broadcast to the teacher room. Best-effort — a socket
// outage never blocks a lifecycle write.
function broadcastResumeStateChange(session, extra = {}) {
  try {
    const io = socketIO.getIO && socketIO.getIO();
    if (!io || !session) return;
    io.to(`assessment_${session.assessmentId}_teachers`).emit('dashboard:student_update', {
      studentId: session.studentId,
      resumeState: session.resumeState,
      resumeRequestedAt: session.resumeRequestedAt || null,
      resumeApprovedAt: session.resumeApprovedAt || null,
      attemptStatus: session.status || 'active',
      inProgress: !!session.inProgress,
      isOnline: !!session.isOnline,
      ...extra,
    });
    // Also nudge the student's own socket-room so their waiting screen
    // updates without polling. Convention: `assessment_<id>_student_<studentId>`.
    io.to(`assessment_${session.assessmentId}_student_${session.studentId}`).emit('attempt:resume_state', {
      resumeState: session.resumeState,
      resumeApprovedAt: session.resumeApprovedAt || null,
    });
  } catch { /* ignore */ }
}

// ─── POST /courses/attempt/start ───────────────────────────────────────────
// Body: { exerciseId, courseId, nodeId, nodeType, subcategory, category?='You_Do',
//         totalQuestions?, durationMinutesHint? }
exports.startAttempt = async (req, res) => {
  try {
    const userId = String(req.user?._id || '');
    const {
      exerciseId, courseId, nodeId, nodeType, subcategory,
      category = 'You_Do', totalQuestions = 0, durationMinutesHint,
    } = req.body || {};

    if (!userId) return res.status(401).json({ success: false, message: 'Unauthenticated' });
    if (!exerciseId) return res.status(400).json({ success: false, message: 'exerciseId is required' });
    if (!courseId) return res.status(400).json({ success: false, message: 'courseId is required' });

    const now = new Date();
    const existing = await ExamSession.findOne({ assessmentId: String(exerciseId), studentId: userId });

    // ── Resume path ─────────────────────────────────────────────────────────
    if (existing) {
      // Late backfill for pre-existing rows.
      if (!existing.startedAt) existing.startedAt = existing.joinedAt || now;
      if (!existing.status) existing.status = existing.submittedAt ? 'submitted' : 'active';
      if (existing.resumeState == null) existing.resumeState = 'active';
      // Backfill totalDurationSeconds from the exercise for older rows so the
      // elapsed-time model has something to compute against.
      if (!existing.totalDurationSeconds) {
        const mins = await resolveExerciseDuration({ exerciseId, nodeId, nodeType, subcategory, category });
        const fromHint = Number(durationMinutesHint);
        const useMins = mins || (Number.isFinite(fromHint) && fromHint > 0 && fromHint <= MAX_DURATION_MINUTES ? fromHint : null);
        if (useMins) existing.totalDurationSeconds = useMins * 60;
      }

      // ── Terminal ────────────────────────────────────────────────────────
      // Submitted / terminated attempts never re-enter the exam. Return the
      // record so the client renders the completed state.
      if (existing.status !== 'active') {
        await existing.save();
        return res.json({
          success: true,
          attempt: serialiseAttempt(existing),
          canResume: false,
          requiresApproval: false,
          serverNow: now,
        });
      }

      // ── Permission gate ─────────────────────────────────────────────────
      // Fresh-in-flight attempt (resumeState='active') → auto-resume.
      // Any other resumeState → the gate blocks entry until approval.
      if (existing.resumeState === 'active') {
        existing.isOnline = true;
        existing.lastActivityAt = now;
        existing.inProgress = true;
        await existing.save();
        return res.json({
          success: true,
          attempt: serialiseAttempt(existing),
          canResume: true,
          requiresApproval: false,
          serverNow: now,
        });
      }

      if (existing.resumeState === 'approved_for_resume') {
        // Consume the approval — one approval = one re-entry. Flip back to
        // 'active' so the next disconnect starts a fresh gate cycle.
        existing.resumeState = 'active';
        existing.isOnline = true;
        existing.lastActivityAt = now;
        existing.inProgress = true;
        await existing.save();
        broadcastResumeStateChange(existing);
        return res.json({
          success: true,
          attempt: serialiseAttempt(existing),
          canResume: true,
          requiresApproval: false,
          serverNow: now,
        });
      }

      // resumeState is 'awaiting_approval' or 'rejected' → student cannot
      // enter until they request + trainer approves.
      return res.json({
        success: true,
        attempt: serialiseAttempt(existing),
        canResume: false,
        requiresApproval: true,
        serverNow: now,
      });
    }

    // ── First-time start ────────────────────────────────────────────────────
    let durationMinutes = await resolveExerciseDuration({ exerciseId, nodeId, nodeType, subcategory, category });
    if (durationMinutes == null) {
      const hint = Number(durationMinutesHint);
      if (Number.isFinite(hint) && hint > 0 && hint <= MAX_DURATION_MINUTES) durationMinutes = hint;
    }
    const totalDurationSeconds = durationMinutes ? durationMinutes * 60 : null;

    const created = await ExamSession.create({
      assessmentId: String(exerciseId),
      studentId: userId,
      joinedAt: now,
      startedAt: now,
      totalDurationSeconds,
      // Legacy wall-clock field kept in sync only for old readers.
      serverExpiresAt: totalDurationSeconds ? new Date(now.getTime() + totalDurationSeconds * 1000) : null,
      status: 'active',
      resumeState: 'active',
      terminationReason: null,
      isOnline: true,
      lastActivityAt: now,
      totalQuestions: Number(totalQuestions) || 0,
      inProgress: true,
    });

    return res.json({
      success: true,
      attempt: serialiseAttempt(created),
      canResume: false,
      requiresApproval: false,
      serverNow: now,
    });
  } catch (err) {
    if (err && err.code === 11000) {
      try {
        const winner = await ExamSession.findOne({
          assessmentId: String(req.body?.exerciseId || ''),
          studentId: String(req.user?._id || ''),
        });
        if (winner) {
          return res.json({
            success: true,
            attempt: serialiseAttempt(winner),
            canResume: winner.status === 'active' && winner.resumeState === 'active',
            requiresApproval: winner.status === 'active' && winner.resumeState !== 'active' && winner.resumeState !== 'approved_for_resume',
            serverNow: new Date(),
          });
        }
      } catch { /* fall through */ }
    }
    console.error('[attempt.start] error:', err);
    return res.status(500).json({ success: false, message: 'Failed to start attempt' });
  }
};

// ─── GET /courses/attempt/state ────────────────────────────────────────────
exports.getAttemptState = async (req, res) => {
  try {
    const userId = String(req.user?._id || '');
    const { exerciseId, courseId, category = 'You_Do', subcategory } = req.query || {};
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthenticated' });
    if (!exerciseId) return res.status(400).json({ success: false, message: 'exerciseId is required' });

    const session = await ExamSession.findOne({ assessmentId: String(exerciseId), studentId: userId });
    if (!session) {
      return res.json({
        success: true, attempt: null, savedAnswers: [], questionStatuses: [],
        canResume: false, requiresApproval: false, serverNow: new Date(),
      });
    }

    const activities = await StudentQuestionActivity.find({ examSessionId: session._id }).lean();
    const questionStatuses = activities.map((a) => ({
      questionId: String(a.questionId),
      status: a.status || 'pending',
      lastActivityAt: a.lastActivityAt || null,
      submittedAt: a.submittedAt || null,
      timeTakenSeconds: a.timeTakenSeconds || 0,
    }));

    let savedAnswers = [];
    if (courseId && subcategory) {
      savedAnswers = await loadPersistedAnswers({ userId, courseId, exerciseId, category, subcategory });
    }

    return res.json({
      success: true,
      attempt: serialiseAttempt(session),
      savedAnswers,
      questionStatuses,
      canResume: session.status === 'active' && session.resumeState === 'active',
      requiresApproval: session.status === 'active'
        && session.resumeState !== 'active'
        && session.resumeState !== 'approved_for_resume',
      serverNow: new Date(),
    });
  } catch (err) {
    console.error('[attempt.state] error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load attempt state' });
  }
};

// ─── PATCH /courses/attempt/current-question ───────────────────────────────
exports.setCurrentQuestion = async (req, res) => {
  try {
    const userId = String(req.user?._id || '');
    const { exerciseId, questionId } = req.body || {};
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthenticated' });
    if (!exerciseId || !questionId) {
      return res.status(400).json({ success: false, message: 'exerciseId and questionId are required' });
    }
    const session = await ExamSession.findOne({ assessmentId: String(exerciseId), studentId: userId });
    if (!session) return res.json({ success: true, ignored: 'no attempt' });
    if (session.status !== 'active') return res.json({ success: true, ignored: 'terminal' });
    session.currentQuestionId = String(questionId);
    session.lastActivityAt = new Date();
    await session.save();
    return res.json({ success: true });
  } catch (err) {
    console.error('[attempt.setCurrentQuestion] error:', err);
    return res.status(500).json({ success: false, message: 'Failed to save current question' });
  }
};

// ─── POST /courses/attempt/submit ──────────────────────────────────────────
exports.finaliseAttempt = async (req, res) => {
  try {
    const userId = String(req.user?._id || '');
    const { exerciseId, terminationReason = 'submit' } = req.body || {};
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthenticated' });
    if (!exerciseId) return res.status(400).json({ success: false, message: 'exerciseId is required' });

    const session = await ExamSession.findOne({ assessmentId: String(exerciseId), studentId: userId });
    if (!session) return res.status(404).json({ success: false, message: 'No attempt to submit' });

    if (session.status !== 'active') {
      return res.json({ success: true, attempt: serialiseAttempt(session), alreadyFinal: true });
    }

    const now = new Date();
    session.status = 'submitted';
    session.terminationReason = terminationReason === 'timer' ? 'timer'
      : terminationReason === 'security' ? 'security'
      : 'submit';
    session.submittedAt = now;
    session.inProgress = false;
    session.lastActivityAt = now;
    // Stamp lastSubmittedAt here too so the frozen-clock computation shows
    // the final elapsed time correctly (matching the "assessment start →
    // final submit" duration the student saw).
    session.lastSubmittedAt = now;
    await session.save();

    return res.json({ success: true, attempt: serialiseAttempt(session), alreadyFinal: false });
  } catch (err) {
    console.error('[attempt.finalise] error:', err);
    return res.status(500).json({ success: false, message: 'Failed to submit attempt' });
  }
};

// ─── POST /courses/attempt/request-resume ──────────────────────────────────
// Student asks the trainer for permission to resume. Idempotent: if the
// student is already in `awaiting_approval` this is a no-op. Once approved
// or the attempt has terminated, the endpoint refuses.
exports.requestResume = async (req, res) => {
  try {
    const userId = String(req.user?._id || '');
    const { exerciseId } = req.body || {};
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthenticated' });
    if (!exerciseId) return res.status(400).json({ success: false, message: 'exerciseId is required' });

    const session = await ExamSession.findOne({ assessmentId: String(exerciseId), studentId: userId });
    if (!session) return res.status(404).json({ success: false, message: 'No attempt to resume' });
    if (session.status !== 'active') {
      return res.status(410).json({
        success: false,
        message: 'Attempt is already complete',
        attemptStatus: session.status,
      });
    }
    if (session.resumeState === 'approved_for_resume') {
      // Already approved — student can just proceed.
      return res.json({ success: true, attempt: serialiseAttempt(session), alreadyApproved: true });
    }

    session.resumeState = 'awaiting_approval';
    session.resumeRequestedAt = new Date();
    session.resumeApprovedAt = null;
    session.resumeApprovedBy = null;
    await session.save();
    broadcastResumeStateChange(session);

    return res.json({ success: true, attempt: serialiseAttempt(session) });
  } catch (err) {
    console.error('[attempt.requestResume] error:', err);
    return res.status(500).json({ success: false, message: 'Failed to request resume' });
  }
};

// ─── POST /courses/attempt/approve-resume ──────────────────────────────────
// Trainer/admin action. Body: { exerciseId, studentId }.
// Flips `resumeState` to `approved_for_resume`. Broadcasts to the student's
// waiting screen. The next /start from that student consumes the approval.
exports.approveResume = async (req, res) => {
  try {
    const approverId = String(req.user?._id || '');
    const { exerciseId, studentId } = req.body || {};
    if (!approverId) return res.status(401).json({ success: false, message: 'Unauthenticated' });
    if (!exerciseId || !studentId) {
      return res.status(400).json({ success: false, message: 'exerciseId and studentId are required' });
    }

    const session = await ExamSession.findOne({ assessmentId: String(exerciseId), studentId: String(studentId) });
    if (!session) return res.status(404).json({ success: false, message: 'No attempt found' });
    if (session.status !== 'active') {
      return res.status(410).json({ success: false, message: 'Attempt is already complete' });
    }
    // Approving anything other than an in-flight request is fine — trainer
    // can pre-approve, or approve a rejected request retroactively.
    session.resumeState = 'approved_for_resume';
    session.resumeApprovedAt = new Date();
    session.resumeApprovedBy = approverId;
    await session.save();
    broadcastResumeStateChange(session);

    return res.json({ success: true, attempt: serialiseAttempt(session) });
  } catch (err) {
    console.error('[attempt.approveResume] error:', err);
    return res.status(500).json({ success: false, message: 'Failed to approve resume' });
  }
};

// ─── POST /courses/attempt/reject-resume ───────────────────────────────────
// Trainer/admin action. Body: { exerciseId, studentId, terminate?: boolean }.
// Default flips `resumeState = 'rejected'` (student can re-request later).
// `terminate: true` also flips the attempt to `status='terminated'` with
// reason 'security' — the student can no longer resume ever.
exports.rejectResume = async (req, res) => {
  try {
    const approverId = String(req.user?._id || '');
    const { exerciseId, studentId, terminate = false } = req.body || {};
    if (!approverId) return res.status(401).json({ success: false, message: 'Unauthenticated' });
    if (!exerciseId || !studentId) {
      return res.status(400).json({ success: false, message: 'exerciseId and studentId are required' });
    }

    const session = await ExamSession.findOne({ assessmentId: String(exerciseId), studentId: String(studentId) });
    if (!session) return res.status(404).json({ success: false, message: 'No attempt found' });

    session.resumeState = 'rejected';
    session.resumeApprovedAt = null;
    session.resumeApprovedBy = approverId;
    if (terminate) {
      const now = new Date();
      session.status = 'terminated';
      session.terminationReason = 'security';
      session.submittedAt = now;
      session.inProgress = false;
      session.isOnline = false;
      session.lastActivityAt = now;
    }
    await session.save();
    broadcastResumeStateChange(session);

    return res.json({ success: true, attempt: serialiseAttempt(session), terminated: !!terminate });
  } catch (err) {
    console.error('[attempt.rejectResume] error:', err);
    return res.status(500).json({ success: false, message: 'Failed to reject resume' });
  }
};

// Exported for the socket layer to call directly when the offline-grace timer
// flips a student to isOnline=false — arms the permission gate immediately.
exports.armResumeGateOnDisconnect = async (assessmentId, studentId) => {
  try {
    const session = await ExamSession.findOne({ assessmentId: String(assessmentId), studentId: String(studentId) });
    if (!session) return;
    if (session.status !== 'active') return;
    if (session.resumeState === 'awaiting_approval' || session.resumeState === 'approved_for_resume') return;
    session.resumeState = 'awaiting_approval';
    session.resumeRequestedAt = null;
    session.resumeApprovedAt = null;
    session.resumeApprovedBy = null;
    await session.save();
    broadcastResumeStateChange(session);
  } catch (err) {
    console.error('[attempt.armResumeGateOnDisconnect] error:', err);
  }
};

// Also exported: the socket layer's per-question submit hook calls this to
// stamp lastSubmittedAt on the session (drives the elapsed-time clock).
exports.stampLastSubmittedAt = async (assessmentId, studentId, when = new Date()) => {
  try {
    await ExamSession.updateOne(
      { assessmentId: String(assessmentId), studentId: String(studentId) },
      { $set: { lastSubmittedAt: when, lastActivityAt: when } },
    );
  } catch (err) {
    console.error('[attempt.stampLastSubmittedAt] error:', err);
  }
};
