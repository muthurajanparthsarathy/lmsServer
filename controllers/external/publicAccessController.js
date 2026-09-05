// Public (unauthenticated) external-assessment access, by invitation token.
//
// These three routes are the ONLY way an external participant reaches the
// system. There is no `userAuth` on them — the token is the credential — so
// every handler must re-run the full gate rather than trusting a previous
// call: a participant who saw the landing screen while the window was open
// can still POST /start a minute after it closed.
//
// The gate itself lives in utils/external/assessmentAccess.js so all three
// agree by construction.

const ExternalParticipant = require("../../models/external/ExternalParticipantModel");
const ExternalInvitation = require("../../models/external/ExternalInvitationModel");
const ExternalAttempt = require("../../models/external/ExternalAttemptModel");
const {
  ACCESS,
  resolveToken,
  evaluateWindow,
  attemptDeadline,
  publicAssessmentView,
  sanitizeQuestion,
  shuffle,
} = require("../../utils/external/assessmentAccess");
const { gradeAttempt } = require("../../utils/external/grading");

// Human-readable copy per verdict. Sent alongside the machine-readable
// `state` so the client can render a screen without duplicating this wording.
const MESSAGES = {
  [ACCESS.INVALID_TOKEN]: "This assessment link is not valid.",
  [ACCESS.REVOKED]: "This assessment link has been withdrawn.",
  [ACCESS.NOT_PUBLISHED]: "This assessment is not open yet.",
  [ACCESS.NOT_SCHEDULED]: "This assessment has not been scheduled yet.",
  [ACCESS.NOT_STARTED]: "This assessment has not started yet.",
  [ACCESS.EXPIRED]: "This assessment has ended.",
  [ACCESS.ALREADY_SUBMITTED]: "You have already submitted this assessment.",
  [ACCESS.NO_QUESTIONS]: "This assessment has no questions yet.",
};

// The participant-safe identity echo — first name and email only, enough for
// "Welcome, Priya" without exposing the rest of the record.
const participantView = (p) => ({
  firstName: p.firstName,
  lastName: p.lastName,
  email: p.email,
});

// GET /api/external/assessment/access/:token
// The landing screen: who this is, what the assessment is, and whether it may
// be started right now.
exports.getAccess = async (req, res) => {
  try {
    const resolved = await resolveToken(req.params.token);
    if (resolved.error) {
      return res.status(200).json({
        success: true,
        data: { state: resolved.error, message: MESSAGES[resolved.error] },
      });
    }

    const { invitation, participant, assessment } = resolved;

    // Best-effort access telemetry — must never fail the request.
    ExternalInvitation.updateOne(
      { _id: invitation._id },
      {
        $set: { lastAccessedAt: new Date() },
        $inc: { accessCount: 1 },
        ...(invitation.firstAccessedAt ? {} : { $setOnInsert: {} }),
      }
    ).catch((e) => console.error("invitation access stamp failed:", e.message));
    if (!invitation.firstAccessedAt) {
      ExternalInvitation.updateOne(
        { _id: invitation._id, firstAccessedAt: null },
        { $set: { firstAccessedAt: new Date() } }
      ).catch(() => {});
    }

    const window = evaluateWindow(assessment);
    const existing = await ExternalAttempt.findOne({
      assessment: assessment._id,
      participant: participant._id,
    }).lean();

    // A submitted attempt closes the door even mid-window, unless the
    // assessment allows more than one sitting.
    const maxAttempts = Number(assessment.settings?.maxAttempts) || 1;
    const usedAttempts = existing ? existing.attemptNumber : 0;
    if (existing?.status === "submitted" && usedAttempts >= maxAttempts) {
      return res.status(200).json({
        success: true,
        data: {
          state: ACCESS.ALREADY_SUBMITTED,
          message: MESSAGES[ACCESS.ALREADY_SUBMITTED],
          assessment: publicAssessmentView(assessment),
          participant: participantView(participant),
          submittedAt: existing.submittedAt,
          // Score is shown back only when the organiser opted in.
          result: assessment.settings?.showResultToParticipant
            ? {
                totalScore: existing.totalScore,
                maxScore: existing.maxScore,
                percentage: existing.percentage,
                isPassed: existing.isPassed,
              }
            : null,
        },
      });
    }

    if (window.state === ACCESS.OK && !(assessment.questions || []).length) {
      return res.status(200).json({
        success: true,
        data: {
          state: ACCESS.NO_QUESTIONS,
          message: MESSAGES[ACCESS.NO_QUESTIONS],
          assessment: publicAssessmentView(assessment),
          participant: participantView(participant),
        },
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        state: window.state,
        message: MESSAGES[window.state] || "",
        assessment: publicAssessmentView(assessment),
        participant: participantView(participant),
        // Lets the client count down to the opening without trusting the
        // device clock, and show "resume" when a sitting is already running.
        serverNow: new Date().toISOString(),
        inProgress: existing?.status === "in_progress" || false,
      },
    });
  } catch (error) {
    console.error("getAccess error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/external/assessment/start/:token
// Begin (or resume) the sitting and hand over the paper, answers stripped.
exports.startAttempt = async (req, res) => {
  try {
    const resolved = await resolveToken(req.params.token);
    if (resolved.error) {
      return res.status(403).json({
        success: false,
        message: MESSAGES[resolved.error],
        data: { state: resolved.error },
      });
    }

    const { invitation, participant, assessment } = resolved;

    // Re-check the window here. This is the call that actually matters: the
    // landing screen's verdict is a render hint, this one is enforcement.
    const window = evaluateWindow(assessment);
    if (window.state !== ACCESS.OK) {
      return res.status(403).json({
        success: false,
        message: MESSAGES[window.state],
        data: { state: window.state, assessment: publicAssessmentView(assessment) },
      });
    }

    const questions = assessment.questions || [];
    if (!questions.length) {
      return res.status(409).json({
        success: false,
        message: MESSAGES[ACCESS.NO_QUESTIONS],
        data: { state: ACCESS.NO_QUESTIONS },
      });
    }

    const maxAttempts = Number(assessment.settings?.maxAttempts) || 1;
    let attempt = await ExternalAttempt.findOne({
      assessment: assessment._id,
      participant: participant._id,
    }).sort({ attemptNumber: -1 });

    if (attempt?.status === "submitted") {
      if (attempt.attemptNumber >= maxAttempts) {
        return res.status(409).json({
          success: false,
          message: MESSAGES[ACCESS.ALREADY_SUBMITTED],
          data: { state: ACCESS.ALREADY_SUBMITTED, submittedAt: attempt.submittedAt },
        });
      }
      attempt = null; // a further sitting is allowed — fall through and create
    }

    const now = new Date();

    // Resuming: an in-flight attempt whose deadline has passed is closed out
    // rather than handed back, so a participant cannot park a tab past the end.
    if (attempt?.status === "in_progress" && attempt.expiresAt && attempt.expiresAt <= now) {
      attempt.status = "expired";
      attempt.terminationReason = "timer";
      await attempt.save();
      await ExternalParticipant.updateOne(
        { _id: participant._id },
        { $set: { attemptStatus: "expired" } }
      );
      return res.status(409).json({
        success: false,
        message: "Your time for this assessment has run out.",
        data: { state: ACCESS.EXPIRED },
      });
    }

    if (!attempt || attempt.status !== "in_progress") {
      const previous = attempt?.attemptNumber || 0;
      attempt = await ExternalAttempt.create({
        assessment: assessment._id,
        participant: participant._id,
        invitation: invitation._id,
        attemptNumber: previous + 1,
        startedAt: now,
        expiresAt: attemptDeadline(assessment, now),
        status: "in_progress",
      });
      await ExternalParticipant.updateOne(
        { _id: participant._id },
        {
          $set: { attemptStatus: "in_progress", lastAttemptAt: now },
          $inc: { attemptCount: 1 },
        }
      );
    }

    // Strip every correct answer before the paper leaves the server.
    let paper = questions
      .slice()
      .sort((a, b) => (Number(a.sequence) || 0) - (Number(b.sequence) || 0))
      .map(sanitizeQuestion);
    if (assessment.settings?.shuffleQuestions) paper = shuffle(paper);
    if (assessment.settings?.shuffleOptions) {
      paper = paper.map((q) => ({ ...q, mcqQuestionOptions: shuffle(q.mcqQuestionOptions || []) }));
    }

    return res.status(200).json({
      success: true,
      message: "Assessment started",
      data: {
        attemptId: attempt._id,
        questions: paper,
        assessment: publicAssessmentView(assessment),
        participant: participantView(participant),
        // The client counts down from these two. serverNow lets it correct for
        // a skewed device clock instead of trusting Date.now().
        expiresAt: attempt.expiresAt,
        serverNow: new Date().toISOString(),
        settings: {
          autoSubmitOnTimeout: assessment.settings?.autoSubmitOnTimeout !== false,
        },
      },
    });
  } catch (error) {
    // Two tabs racing /start both pass the "no attempt yet" check; the unique
    // (assessment, participant, attemptNumber) index lets exactly one create it.
    if (error?.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "This assessment is already open in another tab.",
      });
    }
    console.error("startAttempt error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/external/assessment/submit/:token
// Grade and close the sitting. Body: { responses: [{ questionId, answer }] }
exports.submitAttempt = async (req, res) => {
  try {
    const resolved = await resolveToken(req.params.token);
    if (resolved.error) {
      return res.status(403).json({
        success: false,
        message: MESSAGES[resolved.error],
        data: { state: resolved.error },
      });
    }

    const { participant, assessment } = resolved;
    const attempt = await ExternalAttempt.findOne({
      assessment: assessment._id,
      participant: participant._id,
    }).sort({ attemptNumber: -1 });

    if (!attempt) {
      return res.status(409).json({ success: false, message: "You have not started this assessment." });
    }
    if (attempt.status === "submitted") {
      // Idempotent: a double-submit (network retry, or auto-submit racing the
      // button) returns the existing result rather than erroring or regrading.
      return res.status(200).json({
        success: true,
        message: "This assessment was already submitted.",
        data: {
          submittedAt: attempt.submittedAt,
          result: assessment.settings?.showResultToParticipant
            ? {
                totalScore: attempt.totalScore,
                maxScore: attempt.maxScore,
                percentage: attempt.percentage,
                isPassed: attempt.isPassed,
              }
            : null,
        },
      });
    }

    const now = new Date();
    // A late submit is still GRADED — the participant's work is not thrown
    // away because their last answer landed a few seconds after the deadline —
    // but it is recorded as timer-terminated rather than a clean submit.
    const late = attempt.expiresAt && now > attempt.expiresAt;

    const graded = gradeAttempt(assessment, req.body?.responses || []);

    attempt.responses = graded.responses;
    attempt.totalScore = graded.totalScore;
    attempt.maxScore = graded.maxScore;
    attempt.percentage = graded.percentage;
    attempt.isPassed = graded.isPassed;
    attempt.needsManualReview = graded.needsManualReview;
    attempt.status = "submitted";
    attempt.submittedAt = now;
    attempt.terminationReason = late || req.body?.auto ? "timer" : "submit";
    await attempt.save();

    await ExternalParticipant.updateOne(
      { _id: participant._id },
      {
        $set: {
          attemptStatus: "submitted",
          lastAttemptAt: now,
          score: graded.totalScore,
          maxScore: graded.maxScore,
          isPassed: graded.isPassed,
        },
      }
    );

    return res.status(200).json({
      success: true,
      message: "Assessment submitted successfully",
      data: {
        submittedAt: now,
        needsManualReview: graded.needsManualReview,
        // Withheld unless the organiser chose to show it.
        result: assessment.settings?.showResultToParticipant
          ? {
              totalScore: graded.totalScore,
              maxScore: graded.maxScore,
              percentage: graded.percentage,
              isPassed: graded.isPassed,
            }
          : null,
      },
    });
  } catch (error) {
    console.error("submitAttempt error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
