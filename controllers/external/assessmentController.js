// External Assessment — admin CRUD + question management.
//
// Response shape is { success, message, data }, matching the newest LMS
// controllers (retest.js, attemptController.js). Auth is `userAuth`, applied
// at the route layer; `req.user` is the full LMS user document.

const ExternalAssessment = require("../../models/external/ExternalAssessmentModel");
const ExternalParticipant = require("../../models/external/ExternalParticipantModel");
const ExternalAttempt = require("../../models/external/ExternalAttemptModel");
const ExternalInvitation = require("../../models/external/ExternalInvitationModel");

// Fields an admin may write. Whitelisted rather than spreading req.body so a
// client cannot set counters (participantCount), ownership (createdBy) or the
// denormalised window (startAt/endAt, which the model's pre-save owns).
const WRITABLE = [
  "assessmentName",
  "description",
  "instructions",
  "startDate",
  "endDate",
  "startTime",
  "endTime",
  "durationMinutes",
  "totalMarks",
  "passingMarks",
  "status",
  // Step 1 — Exercise Details
  "testType",
  "exerciseType",
  "exerciseLevel",
  "selectedModule",
  "selectedLanguages",
  "isSectionBased",
  "sectionBasedDuration",
  "sections",
  // Steps 2–3
  "questionSource",
  "questionSources",
  "totalMarksMCQ",
  "totalMarksProgramming",
  // Wizard progress
  "stepsSaved",
];

// Nested groups are MERGED rather than replaced, so the wizard's per-step save
// (which sends only the step it is on) cannot blank a group the author filled
// in on a different step. `settings` behaved this way already; the six groups
// added for the full wizard need the same treatment or Step 5 would wipe
// Step 2's configuration on every Next.
const MERGE_GROUPS = [
  "settings",
  "questionConfiguration",
  "programmingConfig",
  "othersConfig",
  "evaluationMethod",
  "customDistribution",
  "securitySettings",
  "notificationSettings",
  "gradeSettings",
  "scheduleExtras",
  "additionalOptions",
];

// A Mongoose subdocument needs .toObject() before spreading; a plain object
// (or undefined) does not.
const plain = (v) => (v && typeof v.toObject === "function" ? v.toObject() : v || {});

const applyWritable = (doc, body) => {
  for (const key of WRITABLE) {
    if (body[key] === undefined) continue;
    doc[key] = body[key];
  }
  for (const key of MERGE_GROUPS) {
    if (body[key] === undefined || typeof body[key] !== "object" || body[key] === null) continue;
    doc[key] = { ...plain(doc[key]), ...body[key] };
  }
};

// "HH:mm", 24-hour. Empty is allowed — a draft may have no window yet.
const isValidTime = (t) => t === "" || t === undefined || t === null || /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t));

/**
 * Reject a schedule that cannot be satisfied. Runs on create and update, and
 * is the reason the access gate can trust startAt < endAt without re-checking.
 */
const scheduleError = (doc) => {
  if (!isValidTime(doc.startTime)) return "startTime must be in HH:mm 24-hour format";
  if (!isValidTime(doc.endTime)) return "endTime must be in HH:mm 24-hour format";

  const start = ExternalAssessment.combineDateAndTime(doc.startDate, doc.startTime);
  const end = ExternalAssessment.combineDateAndTime(doc.endDate, doc.endTime);
  if (start && end && end.getTime() <= start.getTime()) {
    return "The assessment end must be after its start";
  }
  // Publishing is the point of no return for scheduling: a published
  // assessment's link is live, so it must have a real window.
  if (doc.status === "published") {
    if (!start || !end) return "A published assessment needs a start and end date/time";
    if (!Array.isArray(doc.questions) || doc.questions.length === 0) {
      return "A published assessment needs at least one question";
    }
  }
  return null;
};

// GET /api/admin/external/assessments
exports.listAssessments = async (req, res) => {
  try {
    const { search = "", status = "", page = 1, limit = 50 } = req.query;

    const filter = { isDeleted: false };
    if (req.user?.institution) filter.institution = req.user.institution;
    if (status && ["draft", "published", "archived"].includes(status)) filter.status = status;
    if (search.trim()) {
      // Escape regex metacharacters — an admin searching "C++" must not blow
      // up on the quantifier.
      const safe = search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.assessmentName = { $regex: safe, $options: "i" };
    }

    const pageNum = Math.max(1, Number(page) || 1);
    const perPage = Math.min(200, Math.max(1, Number(limit) || 50));

    const [assessments, total] = await Promise.all([
      ExternalAssessment.find(filter)
        // The paper itself is never needed by the list — excluding it keeps a
        // 200-question assessment from bloating every page response.
        .select("-questions")
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * perPage)
        .limit(perPage)
        .lean(),
      ExternalAssessment.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      data: { assessments, total, page: pageNum, limit: perPage },
    });
  } catch (error) {
    console.error("listAssessments error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/admin/external/assessments/:id
exports.getAssessment = async (req, res) => {
  try {
    const assessment = await ExternalAssessment.findOne({
      _id: req.params.id,
      isDeleted: false,
    }).lean();
    if (!assessment) {
      return res.status(404).json({ success: false, message: "Assessment not found" });
    }
    return res.status(200).json({ success: true, data: assessment });
  } catch (error) {
    console.error("getAssessment error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/admin/external/assessments
exports.createAssessment = async (req, res) => {
  try {
    if (!req.body?.assessmentName?.trim()) {
      return res.status(400).json({ success: false, message: "Assessment name is required" });
    }

    const assessment = new ExternalAssessment({
      institution: req.user?.institution,
      createdBy: req.user?._id,
      updatedBy: req.user?._id,
    });
    applyWritable(assessment, req.body);

    const err = scheduleError(assessment);
    if (err) return res.status(400).json({ success: false, message: err });

    await assessment.save();
    return res.status(201).json({
      success: true,
      message: "Assessment created successfully",
      data: assessment,
    });
  } catch (error) {
    console.error("createAssessment error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// PUT /api/admin/external/assessments/:id
exports.updateAssessment = async (req, res) => {
  try {
    const assessment = await ExternalAssessment.findOne({
      _id: req.params.id,
      isDeleted: false,
    });
    if (!assessment) {
      return res.status(404).json({ success: false, message: "Assessment not found" });
    }

    applyWritable(assessment, req.body);
    assessment.updatedBy = req.user?._id;

    const err = scheduleError(assessment);
    if (err) return res.status(400).json({ success: false, message: err });

    await assessment.save();
    return res.status(200).json({
      success: true,
      message: "Assessment updated successfully",
      data: assessment,
    });
  } catch (error) {
    console.error("updateAssessment error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// DELETE /api/admin/external/assessments/:id
// Soft delete. Participants and attempts are left in place so a mistaken
// delete is recoverable and so submitted results are never destroyed; the
// invitations are revoked immediately, which is what actually closes access.
exports.deleteAssessment = async (req, res) => {
  try {
    const assessment = await ExternalAssessment.findOne({
      _id: req.params.id,
      isDeleted: false,
    });
    if (!assessment) {
      return res.status(404).json({ success: false, message: "Assessment not found" });
    }

    assessment.isDeleted = true;
    assessment.updatedBy = req.user?._id;
    await assessment.save();

    await ExternalInvitation.updateMany(
      { assessment: assessment._id, revokedAt: null },
      { $set: { revokedAt: new Date() } }
    );

    return res.status(200).json({ success: true, message: "Assessment deleted successfully" });
  } catch (error) {
    console.error("deleteAssessment error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─── Questions ────────────────────────────────────────────────────────────
// Questions are embedded on the assessment, so these are subdocument writes
// rather than their own collection — mirroring how LMS exercises hold theirs.

// GET /api/admin/external/assessments/:id/questions
exports.listQuestions = async (req, res) => {
  try {
    const assessment = await ExternalAssessment.findOne(
      { _id: req.params.id, isDeleted: false },
      "questions totalMarks totalQuestions assessmentName"
    ).lean();
    if (!assessment) {
      return res.status(404).json({ success: false, message: "Assessment not found" });
    }
    const questions = [...(assessment.questions || [])].sort(
      (a, b) => (Number(a.sequence) || 0) - (Number(b.sequence) || 0)
    );
    return res.status(200).json({
      success: true,
      data: {
        questions,
        totalMarks: assessment.totalMarks,
        totalQuestions: assessment.totalQuestions,
        assessmentName: assessment.assessmentName,
      },
    });
  } catch (error) {
    console.error("listQuestions error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Validate one question against its own type's rules. Returns an error string
// or null. Runs on both add and update so a question can never be edited into
// an ungradable state.
/**
 * Plain text out of a rich-text value.
 *
 * The MCQ editor sends question text as a string, an HTML string, or a node
 * tree. Checking only for a non-empty string rejected questions whose text was
 * present but structured — "Question title is required" on a filled-in field.
 */
const richText = (v, depth = 0) => {
  if (v == null || depth > 6) return "";
  if (typeof v === "string") {
    return v.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    return v.map((x) => richText(x, depth + 1)).filter(Boolean).join(" ").trim();
  }
  if (typeof v === "object") {
    if (typeof v.text === "string") return richText(v.text, depth + 1);
    if (v.content) return richText(v.content, depth + 1);
    if (typeof v.html === "string") return richText(v.html, depth + 1);
    if (typeof v.value === "string") return richText(v.value, depth + 1);
  }
  return "";
};

/** A question's text, from whichever field the sending form used. */
const questionText = (q) =>
  richText(q?.mcqQuestionTitle) ||
  richText(q?.questionText) ||
  richText(q?.questionContent) ||
  richText(q?.title) ||
  richText(q?.questionTitle) ||
  "";

const questionError = (q) => {
  if (!q || typeof q !== "object") return "Question payload is required";

  // ── Programming questions ──
  // A different shape entirely: title + description + a solution, judged by
  // test cases rather than an answer key.
  if (q.questionKind === "programming") {
    if (!questionText(q)) return "Problem title is required";
    if (!richText(q.description)) return "Problem description is required";
    if (Number(q.mcqQuestionScore) <= 0) return "Question marks must be greater than 0";
    const cases = Array.isArray(q.testCases) ? q.testCases : [];
    // Test-case judged questions need something to judge against. AI-graded
    // ones may legitimately ship without cases, so this is not a blanket rule
    // — but a question with neither cases nor a solution cannot be marked at
    // all, which is worth refusing at the point of authoring.
    if (!cases.length && !String(q.solutionCode || "").trim()) {
      return "Add at least one test case, or a solution the grader can compare against";
    }
    if (cases.some((c) => !String(c?.input ?? "").trim() && !String(c?.expectedOutput ?? "").trim())) {
      return "Every test case needs an input or an expected output";
    }
    return null;
  }

  // ── Objective (MCQ-family) questions ──
  if (!questionText(q)) return "Question title is required";

  const type = q.mcqQuestionType || "multiple_choice";
  const optionTypes = ["multiple_choice", "multiple_select", "dropdown", "checkboxes"];

  if (optionTypes.includes(type)) {
    const options = Array.isArray(q.mcqQuestionOptions) ? q.mcqQuestionOptions : [];
    if (options.length < 2) return "At least two options are required";
    if (options.some((o) => !richText(o?.text ?? o))) return "Every option needs text";
    // The correct answer may arrive either as the denormalised array or as
    // isCorrect flags — require at least one of the two, or the question is
    // unmarkable.
    const flagged = options.filter((o) => o.isCorrect).length;
    const listed = Array.isArray(q.mcqQuestionCorrectAnswers)
      ? q.mcqQuestionCorrectAnswers.filter((a) => String(a || "").trim()).length
      : 0;
    if (flagged === 0 && listed === 0) return "Mark at least one correct answer";
    const single = type === "multiple_choice" || type === "dropdown";
    if (single && Math.max(flagged, listed) > 1) {
      return "This question type allows only one correct answer";
    }
  }

  if (type === "true_false" && typeof q.trueFalseAnswer !== "boolean") {
    return "Select True or False as the correct answer";
  }
  if (type === "numeric" && !Number.isFinite(Number(q.numericAnswer))) {
    return "A numeric answer is required";
  }
  if (type === "matching") {
    const pairs = Array.isArray(q.matchingPairs) ? q.matchingPairs : [];
    if (pairs.length < 2) return "At least two matching pairs are required";
    if (pairs.some((p) => !String(p?.left || "").trim() || !String(p?.right || "").trim())) {
      return "Every matching pair needs both sides filled in";
    }
  }
  if (type === "ordering") {
    const items = Array.isArray(q.orderingItems) ? q.orderingItems : [];
    if (items.length < 2) return "At least two items are required to order";
    if (items.some((i) => !String(i?.text || "").trim())) return "Every item needs text";
  }
  if (Number(q.mcqQuestionScore) <= 0) return "Question marks must be greater than 0";
  return null;
};

/**
 * Coerce a question's `source` onto the schema enum.
 *
 * Clients send compound provenance tags — `scratch-manual`, `scratch-bank`,
 * `thirdParty` — which Mongoose rejects outright:
 *
 *   questions.4.source: `scratch-manual` is not a valid enum value
 *
 * That surfaced to the author as a failed save on a question they had just
 * finished writing. Normalising here means the API accepts any reasonable tag
 * and stores the canonical one; the client normalises too, but the server is
 * the guarantee.
 */
const normaliseSource = (raw) => {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return "scratch";
  // `bank` before the generic `scratch` test: `scratch-bank` is a bank pick,
  // and reading it as manual would bill it to the wrong quota column.
  if (s.includes("bank")) return "bank";
  if (s.includes("document") || s.includes("upload") || s.includes("doc")) return "document";
  if (s.includes("thirdparty") || s.includes("other")) return "thirdParty";
  if (s === "ai" || s.startsWith("ai") || s.includes("generate")) return "ai";
  if (s.startsWith("scratch") || s === "manual") return "scratch";
  // Unknown tag: keep the question, lose only its provenance.
  return "scratch";
};

/** Question kinds the schema accepts. Anything else is an objective question. */
const normaliseKind = (raw) => (String(raw ?? "") === "programming" ? "programming" : "mcq");

// Keep mcqQuestionCorrectAnswers in step with the options' isCorrect flags, so
// the grader has one reliable source regardless of which the client sent.
const syncCorrectAnswers = (q) => {
  const options = Array.isArray(q.mcqQuestionOptions) ? q.mcqQuestionOptions : [];
  const flagged = options.filter((o) => o.isCorrect).map((o) => o.text);
  if (flagged.length) {
    q.mcqQuestionCorrectAnswers = flagged;
  } else if (Array.isArray(q.mcqQuestionCorrectAnswers) && q.mcqQuestionCorrectAnswers.length) {
    const correct = new Set(q.mcqQuestionCorrectAnswers.map((a) => String(a).trim().toLowerCase()));
    q.mcqQuestionOptions = options.map((o) => ({
      ...o,
      isCorrect: correct.has(String(o.text || "").trim().toLowerCase()),
    }));
  }
  return q;
};

// How many questions this assessment is configured to hold, summed across the
// halves its exercise type uses. 0 means "no quota configured".
const configuredQuestionCount = (doc) => {
  const type = doc.exerciseType || "MCQ";

  const codeCount = (cfg) => {
    if (!cfg) return 0;
    if ((cfg.questionConfigType || "general") === "general") {
      return Number(cfg.generalQuestionCount || 0);
    }
    const counts =
      (cfg.questionConfigType === "selectionLevel"
        ? cfg.selectionLevelCounts
        : cfg.levelBasedCounts) || {};
    return ["easy", "medium", "hard"].reduce((s, l) => s + Number(counts[l] || 0), 0);
  };

  let total = 0;
  if (type === "MCQ" || type === "Combined") {
    total += Number(doc.questionConfiguration?.totalQuestions || 0);
  }
  if (type === "Programming" || type === "Combined") total += codeCount(doc.programmingConfig);
  if (type === "Other") total += codeCount(doc.othersConfig);
  return total;
};

// POST /api/admin/external/assessments/:id/questions
exports.addQuestion = async (req, res) => {
  try {
    const assessment = await ExternalAssessment.findOne({ _id: req.params.id, isDeleted: false });
    if (!assessment) {
      return res.status(404).json({ success: false, message: "Assessment not found" });
    }

    // Enforce the configured quota HERE, not only in the UI. The shared
    // authoring form keeps its own idea of what is left and will happily post
    // a sixth question against a five-question paper — which is how one
    // reached 6/5 questions and 120/100 marks. The server owns this rule.
    //
    // A quota of 0 means the author never said how many questions the paper
    // holds, which is "unconstrained", not "full".
    const quota = configuredQuestionCount(assessment);
    const existing = assessment.questions?.length || 0;
    if (quota > 0 && existing >= quota) {
      return res.status(409).json({
        success: false,
        message: `This assessment is configured for ${quota} question${quota === 1 ? "" : "s"} and already has ${existing}. Raise the count in Question Configuration to add more.`,
      });
    }

    const err = questionError(req.body);
    if (err) return res.status(400).json({ success: false, message: err });

    const resolvedTitle = questionText(req.body);
    const question = syncCorrectAnswers({
      ...req.body,
      source: normaliseSource(req.body.source),
      questionKind: normaliseKind(req.body.questionKind),
      // Persist the resolved text under BOTH names so the list and the
      // grader read a plain string regardless of which field it arrived in.
      mcqQuestionTitle: resolvedTitle,
      ...(normaliseKind(req.body.questionKind) === "programming" ? { title: resolvedTitle } : {}),
    });
    // Append at the end unless the client pinned a sequence.
    if (!Number.isFinite(Number(question.sequence))) {
      question.sequence = (assessment.questions?.length || 0) + 1;
    }
    assessment.questions.push(question);
    assessment.updatedBy = req.user?._id;
    await assessment.save();

    const saved = assessment.questions[assessment.questions.length - 1];
    return res.status(201).json({
      success: true,
      message: "Question added successfully",
      data: { question: saved, totalQuestions: assessment.totalQuestions, totalMarks: assessment.totalMarks },
    });
  } catch (error) {
    console.error("addQuestion error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// PUT /api/admin/external/assessments/:id/questions/:questionId
exports.updateQuestion = async (req, res) => {
  try {
    const assessment = await ExternalAssessment.findOne({ _id: req.params.id, isDeleted: false });
    if (!assessment) {
      return res.status(404).json({ success: false, message: "Assessment not found" });
    }
    const question = assessment.questions.id(req.params.questionId);
    if (!question) {
      return res.status(404).json({ success: false, message: "Question not found" });
    }

    // Validate the MERGED result, not the patch — a partial update that leaves
    // the question invalid must be refused just as a bad create would be.
    const mergedRaw = { ...question.toObject(), ...req.body };
    const resolvedTitle = questionText(mergedRaw);
    const merged = {
      ...mergedRaw,
      source: normaliseSource(req.body.source ?? question.source),
      questionKind: normaliseKind(req.body.questionKind ?? question.questionKind),
      mcqQuestionTitle: resolvedTitle,
      ...(normaliseKind(req.body.questionKind ?? question.questionKind) === "programming"
        ? { title: resolvedTitle } : {}),
    };
    const err = questionError(merged);
    if (err) return res.status(400).json({ success: false, message: err });

    const next = syncCorrectAnswers(merged);
    for (const [key, value] of Object.entries(next)) {
      if (key === "_id") continue;
      question[key] = value;
    }
    assessment.updatedBy = req.user?._id;
    await assessment.save();

    return res.status(200).json({
      success: true,
      message: "Question updated successfully",
      data: { question, totalQuestions: assessment.totalQuestions, totalMarks: assessment.totalMarks },
    });
  } catch (error) {
    console.error("updateQuestion error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// DELETE /api/admin/external/assessments/:id/questions/:questionId
exports.deleteQuestion = async (req, res) => {
  try {
    const assessment = await ExternalAssessment.findOne({ _id: req.params.id, isDeleted: false });
    if (!assessment) {
      return res.status(404).json({ success: false, message: "Assessment not found" });
    }
    const question = assessment.questions.id(req.params.questionId);
    if (!question) {
      return res.status(404).json({ success: false, message: "Question not found" });
    }
    question.deleteOne();
    assessment.updatedBy = req.user?._id;
    await assessment.save();

    return res.status(200).json({
      success: true,
      message: "Question deleted successfully",
      data: { totalQuestions: assessment.totalQuestions, totalMarks: assessment.totalMarks },
    });
  } catch (error) {
    console.error("deleteQuestion error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/admin/external/assessments/:id/results
// Every participant with their attempt outcome — the admin-side results view.
exports.getResults = async (req, res) => {
  try {
    const assessmentId = req.params.id;
    const [participants, attempts] = await Promise.all([
      ExternalParticipant.find({ assessment: assessmentId }).sort({ createdAt: -1 }).lean(),
      ExternalAttempt.find({ assessment: assessmentId }).lean(),
    ]);

    const byParticipant = new Map(attempts.map((a) => [String(a.participant), a]));
    const rows = participants.map((p) => {
      const attempt = byParticipant.get(String(p._id)) || null;
      return {
        ...p,
        attempt: attempt
          ? {
              status: attempt.status,
              startedAt: attempt.startedAt,
              submittedAt: attempt.submittedAt,
              totalScore: attempt.totalScore,
              maxScore: attempt.maxScore,
              percentage: attempt.percentage,
              isPassed: attempt.isPassed,
              needsManualReview: attempt.needsManualReview,
            }
          : null,
      };
    });

    return res.status(200).json({ success: true, data: { results: rows, total: rows.length } });
  } catch (error) {
    console.error("getResults error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
