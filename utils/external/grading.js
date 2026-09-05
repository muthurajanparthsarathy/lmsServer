// Auto-grading for external assessment responses.
//
// Self-contained on purpose: the LMS grader is keyed to the pedagogy tree's
// question shape and its code-execution pipeline, neither of which applies to
// an external MCQ-style paper. This handles the ten objective question types
// and returns `null` (not 0) for the two that need a human — essay and short
// answer — so an ungraded paper is visibly "needs review" rather than silently
// scored zero.

/** Case/whitespace-insensitive compare for free-text option matching. */
const norm = (v) => String(v ?? "").trim().toLowerCase();

/** Set equality over normalised strings — order must not matter. */
const sameSet = (a, b) => {
  const A = new Set((Array.isArray(a) ? a : [a]).map(norm).filter(Boolean));
  const B = new Set((Array.isArray(b) ? b : [b]).map(norm).filter(Boolean));
  if (A.size !== B.size) return false;
  for (const v of A) if (!B.has(v)) return false;
  return true;
};

/** The correct answers for a question, as an array of option-text strings. */
function correctAnswersFor(question) {
  if (Array.isArray(question.mcqQuestionCorrectAnswers) && question.mcqQuestionCorrectAnswers.length) {
    return question.mcqQuestionCorrectAnswers;
  }
  // Fall back to the options' own isCorrect flags when the denormalised
  // array was never written (a question authored before that field existed).
  return (question.mcqQuestionOptions || [])
    .filter((o) => o.isCorrect)
    .map((o) => o.text);
}

/**
 * Grade ONE response.
 *
 * @returns {{ isCorrect: boolean|null, score: number, maxScore: number }}
 *          isCorrect === null means "not auto-gradable — needs manual review".
 */
function gradeResponse(question, answer) {
  const maxScore = Number(question.mcqQuestionScore) || 0;
  const type = question.mcqQuestionType;

  // Unanswered is wrong, never "needs review" — an empty essay is still a
  // zero, and treating blanks as pending would hold every paper open.
  const blank =
    answer === null ||
    answer === undefined ||
    (typeof answer === "string" && !answer.trim()) ||
    (Array.isArray(answer) && answer.length === 0);

  switch (type) {
    case "essay":
    case "short_answer": {
      // Human-graded. A blank one is a definite zero; anything written waits.
      if (blank) return { isCorrect: false, score: 0, maxScore };
      return { isCorrect: null, score: 0, maxScore };
    }

    case "multiple_choice":
    case "dropdown": {
      if (blank) return { isCorrect: false, score: 0, maxScore };
      const correct = correctAnswersFor(question);
      const ok = correct.some((c) => norm(c) === norm(answer));
      return { isCorrect: ok, score: ok ? maxScore : 0, maxScore };
    }

    case "multiple_select":
    case "checkboxes": {
      if (blank) return { isCorrect: false, score: 0, maxScore };
      // All-or-nothing: every correct option and no incorrect one. Partial
      // credit is deliberately not offered — the authoring UI has no way to
      // express how it should be split.
      const ok = sameSet(answer, correctAnswersFor(question));
      return { isCorrect: ok, score: ok ? maxScore : 0, maxScore };
    }

    case "true_false": {
      if (answer === null || answer === undefined) {
        return { isCorrect: false, score: 0, maxScore };
      }
      const given = answer === true || norm(answer) === "true";
      const ok = given === !!question.trueFalseAnswer;
      return { isCorrect: ok, score: ok ? maxScore : 0, maxScore };
    }

    case "numeric": {
      if (blank) return { isCorrect: false, score: 0, maxScore };
      const given = Number(answer);
      const expected = Number(question.numericAnswer);
      if (!Number.isFinite(given) || !Number.isFinite(expected)) {
        return { isCorrect: false, score: 0, maxScore };
      }
      // Tolerance is absolute; 0/absent means exact.
      const tol = Math.abs(Number(question.numericTolerance) || 0);
      const ok = Math.abs(given - expected) <= tol;
      return { isCorrect: ok, score: ok ? maxScore : 0, maxScore };
    }

    case "matching": {
      if (blank) return { isCorrect: false, score: 0, maxScore };
      // answer: [{ left, right }] — every stored pair must be matched.
      const expected = new Map(
        (question.matchingPairs || []).map((p) => [norm(p.left), norm(p.right)])
      );
      const given = new Map(
        (Array.isArray(answer) ? answer : []).map((p) => [norm(p?.left), norm(p?.right)])
      );
      if (expected.size === 0) return { isCorrect: false, score: 0, maxScore };
      let ok = given.size === expected.size;
      if (ok) {
        for (const [left, right] of expected) {
          if (given.get(left) !== right) { ok = false; break; }
        }
      }
      return { isCorrect: ok, score: ok ? maxScore : 0, maxScore };
    }

    case "ordering": {
      if (blank) return { isCorrect: false, score: 0, maxScore };
      // answer: string[] in the participant's chosen order.
      const expected = [...(question.orderingItems || [])]
        .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
        .map((i) => norm(i.text));
      const given = (Array.isArray(answer) ? answer : []).map(norm);
      const ok =
        expected.length > 0 &&
        expected.length === given.length &&
        expected.every((v, i) => v === given[i]);
      return { isCorrect: ok, score: ok ? maxScore : 0, maxScore };
    }

    default:
      // Unknown type — never guess a score, flag for review.
      return { isCorrect: null, score: 0, maxScore };
  }
}

/**
 * Grade a whole submission.
 *
 * @param assessment  the ExternalAssessment (needs questions, settings, passingMarks)
 * @param responses   [{ questionId, answer }]
 */
function gradeAttempt(assessment, responses) {
  const byId = new Map(
    (assessment.questions || []).map((q) => [String(q._id), q])
  );
  const answerFor = new Map(
    (responses || []).map((r) => [String(r.questionId), r.answer])
  );

  const negative = !!assessment.settings?.negativeMarking;
  const penalty = Math.abs(Number(assessment.settings?.negativeMarkPerWrong) || 0);

  const graded = [];
  let totalScore = 0;
  let maxScore = 0;
  let needsManualReview = false;

  // Iterate the QUESTIONS, not the responses, so a skipped question is scored
  // (as zero) and a response for a question that no longer exists is ignored.
  for (const q of assessment.questions || []) {
    const answer = answerFor.has(String(q._id)) ? answerFor.get(String(q._id)) : null;
    const result = gradeResponse(q, answer);

    let score = result.score;
    // Negative marking applies only to a definitely-wrong ANSWERED question —
    // never to a blank, and never to one awaiting manual review.
    const answered = !(answer === null || answer === undefined || (Array.isArray(answer) && !answer.length) || (typeof answer === "string" && !answer.trim()));
    if (negative && result.isCorrect === false && answered) {
      score -= penalty;
    }

    if (result.isCorrect === null) needsManualReview = true;

    totalScore += score;
    maxScore += result.maxScore;
    graded.push({
      questionId: q._id,
      answer,
      isCorrect: result.isCorrect,
      score,
      maxScore: result.maxScore,
      answeredAt: new Date(),
    });
  }

  // Negative marking can drive a paper below zero; report 0 rather than a
  // negative total, which no grade scale here can express.
  totalScore = Math.max(0, totalScore);
  const denominator = maxScore || Number(assessment.totalMarks) || 0;
  const percentage = denominator > 0 ? Math.round((totalScore / denominator) * 10000) / 100 : 0;

  // Pass/fail is withheld until a human has graded the open questions —
  // declaring a fail on a paper with an unmarked essay would be wrong.
  const passingMarks = Number(assessment.passingMarks) || 0;
  const isPassed = needsManualReview ? null : passingMarks > 0 ? totalScore >= passingMarks : null;

  return { responses: graded, totalScore, maxScore: denominator, percentage, isPassed, needsManualReview };
}

module.exports = { gradeAttempt, gradeResponse, correctAnswersFor };
