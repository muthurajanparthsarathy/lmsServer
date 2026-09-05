// The access gate for an external participant's assessment link.
//
// ONE definition of "may this person sit this assessment right now", used by
// every public route (/access, /start, /submit). Splitting the rule across
// three handlers is how a participant ends up blocked on the landing screen
// but able to POST /start directly — so the resolution and the verdict live
// here and the handlers only render what they are told.

const ExternalAssessment = require("../../models/external/ExternalAssessmentModel");
const ExternalParticipant = require("../../models/external/ExternalParticipantModel");
const ExternalInvitation = require("../../models/external/ExternalInvitationModel");

// Verdicts the client renders as distinct screens. Kept as constants because
// the frontend switches on these exact strings.
const ACCESS = {
  OK: "available",
  NOT_STARTED: "not_started",
  EXPIRED: "expired",
  INVALID_TOKEN: "invalid_token",
  REVOKED: "revoked",
  NOT_PUBLISHED: "not_published",
  NOT_SCHEDULED: "not_scheduled",
  ALREADY_SUBMITTED: "already_submitted",
  NO_QUESTIONS: "no_questions",
};

/**
 * Resolve an invitation token to { invitation, participant, assessment }.
 *
 * Returns `{ error }` with an ACCESS code instead of throwing, because every
 * caller renders the failure rather than 500ing — a bad link is a normal
 * outcome, not an exception.
 */
async function resolveToken(token) {
  if (!token || typeof token !== "string" || token.length < 16) {
    return { error: ACCESS.INVALID_TOKEN };
  }

  const invitation = await ExternalInvitation.findOne({ token }).lean();
  if (!invitation) return { error: ACCESS.INVALID_TOKEN };
  if (invitation.revokedAt) return { error: ACCESS.REVOKED };

  // A hard token expiry independent of the assessment window. Reported as
  // EXPIRED (not INVALID) so the participant still sees when it closed.
  if (invitation.expiresAt && new Date(invitation.expiresAt).getTime() < Date.now()) {
    return { error: ACCESS.EXPIRED, invitation };
  }

  const [participant, assessment] = await Promise.all([
    ExternalParticipant.findById(invitation.participant).lean(),
    ExternalAssessment.findById(invitation.assessment).lean(),
  ]);

  // A deleted participant or assessment invalidates the link outright — do
  // NOT leak which of the two is missing.
  if (!participant || !assessment || assessment.isDeleted) {
    return { error: ACCESS.INVALID_TOKEN };
  }

  return { invitation, participant, assessment };
}

/**
 * The timing/state verdict for an already-resolved assessment.
 *
 * `now` is injectable so the unit of time is testable and so a single request
 * evaluates every check against ONE instant — reading Date.now() three times
 * inside one gate is how an assessment ends between two of its own checks.
 */
function evaluateWindow(assessment, now = new Date()) {
  const t = now.getTime();

  if (assessment.status !== "published") {
    // draft or archived — never openable, regardless of the window.
    return { state: ACCESS.NOT_PUBLISHED };
  }

  const startAt = assessment.startAt ? new Date(assessment.startAt) : null;
  const endAt = assessment.endAt ? new Date(assessment.endAt) : null;

  // Published with no window is a misconfiguration, not an open door.
  if (!startAt || !endAt) return { state: ACCESS.NOT_SCHEDULED };

  if (t < startAt.getTime()) {
    return { state: ACCESS.NOT_STARTED, startAt, endAt };
  }
  if (t > endAt.getTime()) {
    return { state: ACCESS.EXPIRED, startAt, endAt };
  }
  return { state: ACCESS.OK, startAt, endAt };
}

/**
 * How long this sitting may run, in ms: the assessment duration, clamped so it
 * can never outlive the assessment's own end instant. Without the clamp a
 * participant starting a 60-minute paper five minutes before the window closes
 * would hold a deadline an hour past the close.
 */
function attemptDeadline(assessment, startedAt = new Date()) {
  const durationMs = (Number(assessment.durationMinutes) || 0) * 60 * 1000;
  const byDuration = new Date(startedAt.getTime() + durationMs);
  const endAt = assessment.endAt ? new Date(assessment.endAt) : null;
  if (!endAt) return byDuration;
  return byDuration.getTime() < endAt.getTime() ? byDuration : endAt;
}

/**
 * The participant-safe view of an assessment — everything the landing screen
 * needs and NOTHING that would leak the paper. Questions are excluded here on
 * purpose: they are only ever returned by /start, after the window check.
 */
function publicAssessmentView(assessment) {
  return {
    assessmentName: assessment.assessmentName,
    description: assessment.description,
    instructions: assessment.instructions,
    startDate: assessment.startDate,
    endDate: assessment.endDate,
    startTime: assessment.startTime,
    endTime: assessment.endTime,
    startAt: assessment.startAt,
    endAt: assessment.endAt,
    durationMinutes: assessment.durationMinutes,
    totalMarks: assessment.totalMarks,
    passingMarks: assessment.passingMarks,
    totalQuestions: assessment.totalQuestions,
  };
}

/**
 * Strip answers from a question before sending it to a participant.
 *
 * Every correct-answer field is dropped — not overwritten, dropped — so the
 * paper cannot be read out of the network tab. This is the single chokepoint
 * for that; no handler should build a question payload by hand.
 */
function sanitizeQuestion(q) {
  const options = Array.isArray(q.mcqQuestionOptions)
    ? q.mcqQuestionOptions.map((o) => ({
        _id: o._id,
        text: o.text,
        imageUrl: o.imageUrl,
      }))
    : [];

  return {
    _id: q._id,
    mcqQuestionType: q.mcqQuestionType,
    mcqQuestionTitle: q.mcqQuestionTitle,
    mcqQuestionDescription: q.mcqQuestionDescription,
    mcqQuestionLevel: q.mcqQuestionLevel,
    mcqQuestionScore: q.mcqQuestionScore,
    mcqQuestionOptions: options,
    // Matching: send only the left column plus a SHUFFLED right column, so the
    // pairing itself is not handed over in index order.
    matchingPairs: Array.isArray(q.matchingPairs)
      ? q.matchingPairs.map((p) => ({ _id: p._id, left: p.left }))
      : [],
    matchingOptions: Array.isArray(q.matchingPairs)
      ? shuffle(q.matchingPairs.map((p) => p.right))
      : [],
    // Ordering: the items, shuffled — the stored `order` IS the answer.
    orderingItems: Array.isArray(q.orderingItems)
      ? shuffle(q.orderingItems.map((i) => ({ _id: i._id, text: i.text })))
      : [],
    sequence: q.sequence,
  };
}

/** Fisher-Yates on a copy. */
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

module.exports = {
  ACCESS,
  resolveToken,
  evaluateWindow,
  attemptDeadline,
  publicAssessmentView,
  sanitizeQuestion,
  shuffle,
};
