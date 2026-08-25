const User = require('../../../models/UserModel');
const mongoose = require('mongoose');
const ActivityLog = require('../../../models/ActivityLog');
// Resources by Batch — the two lookups below resolve an exercise from its own
// `_id` in order to name it / check its deadline. That id is unique, so the
// owning batch does not change the answer; what matters is that a batch-wise
// exercise is visible at all. `mergeSectionAcrossBatches` walks the shared
// container AND every batch's, which a plain `doc.pedagogy[category]` cannot.
const { mergeSectionAcrossBatches, locateExerciseContainer } = require('../../../utils/pedagogyScope');
// Server-authoritative code judge. When a programming submission arrives, the
// server re-runs the student's code against the trainer's stored testCases
// (including hidden ones) and computes score + breakdown here — the client
// score is treated as an untrusted hint and overwritten. See
// server/services/codeJudge.js for the loop, driverInjector.js for the
// LeetCode-style bare-function auto-driver, and questionResolver.js for the
// authoritative testCases lookup.
const { judge: judgeCode } = require('../../../services/codeJudge');
const { loadForJudge } = require('../../../services/questionResolver');

// ── We Do / You Do duration tracking (assignments & assessments) ───────────────
// Start = first answer interaction (a non-test save opens an 'exercise_start' log).
// End   = test submit (closes the open log with duration = submit − start).
// Started-but-not-submitted logs stay open (duration === null) and are ignored.
// Each test submit closes the current cycle, so the next save starts a fresh one.
// `method` is the pedagogy category: 'We_Do' (assignment) or 'You_Do' (assessment).
async function trackAssignmentDuration({ user, courseId, exerciseId, exerciseName, subcategory, method, nodeId, nodeName, nodeType, isTestSubmit }) {
  try {
    const fallbackName = method === 'You_Do' ? 'Assessment' : 'Assignment';
    const openMatch = {
      userId: user._id,
      action: 'exercise_start',
      'details.method': method,
      'details.exerciseId': exerciseId ? String(exerciseId) : null,
      'details.activity': subcategory || null,
      'details.duration': null, // still open (not yet submitted)
    };

    // Build a new start-log doc, resolving the real name + parent node once.
    const buildDoc = async () => {
      const info = await resolveExerciseInfo({ nodeId, category: method, subcategory, exerciseId });
      // Title = real exercise name (structure) → body exerciseName → body nodeName
      //         (some components send the exercise name here) → subcategory.
      const finalName = info.exerciseName || exerciseName || nodeName || subcategory || fallbackName;
      return {
        userId: user._id,
        userName: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
        userEmail: user.email || '',
        courseId: courseId || null,
        action: 'exercise_start',
        details: {
          exerciseId: exerciseId ? String(exerciseId) : null,
          exerciseName: finalName,
          method: method,
          activity: subcategory || null,
          // Parent node resolved from the structure (the topic/subtopic it lives under)
          nodeName: info.nodeName || null,
          nodeType: info.nodeType || null,
        },
      };
    };

    if (!isTestSubmit) {
      // First answer interaction → open a start log if one isn't already open
      const existing = await ActivityLog.findOne(openMatch).select('_id').lean();
      if (!existing) {
        const doc = await buildDoc();
        doc.details.status = 'in-progress';
        await ActivityLog.create(doc);
      }
      return;
    }

    // Test submit → close the open start log with a duration
    const now = new Date();
    const open = await ActivityLog.findOne(openMatch).sort({ createdAt: -1 });
    if (open) {
      const durationSec = Math.max(0, Math.round((now.getTime() - new Date(open.createdAt).getTime()) / 1000));
      open.details.duration = durationSec;
      open.details.closedAt = now;
      open.details.status = 'submitted';
      open.markModified('details');
      await open.save();
    } else {
      // Submitted with no prior save — record a completed cycle with 0 duration
      const doc = await buildDoc();
      doc.details.status = 'submitted';
      doc.details.duration = 0;
      doc.details.closedAt = now;
      await ActivityLog.create(doc);
    }
  } catch (e) { /* best effort — never block submission */ }
}

const Module1 = mongoose.model('Module1');
const SubModule1 = mongoose.model('SubModule1');
const Topic1 = mongoose.model('Topic1');
const SubTopic1 = mongoose.model('SubTopic1');
const CourseStructure = mongoose.model('Course-Structure');

// Resolve, from the course structure, the real exercise/assignment/assessment NAME
// and the PARENT node (its title + level) using the reliable nodeId. The submitted
// nodeName/nodeType can't be trusted (some components send the exercise's own
// name/type, e.g. nodeType 'mcq'), so we find the node by id across all node models.
// Returns { exerciseName, nodeName, nodeType } (any field may be null).
async function resolveExerciseInfo({ nodeId, category, subcategory, exerciseId }) {
  const empty = { exerciseName: null, nodeName: null, nodeType: null };
  try {
    if (!nodeId || !category) return empty;
    const models = [['module', Module1], ['submodule', SubModule1], ['topic', Topic1], ['subtopic', SubTopic1]];
    for (const [typeLabel, Model] of models) {
      let doc;
      try { doc = await Model.findById(nodeId).select(`title pedagogy.${category} batchPedagogy`).lean(); }
      catch { doc = null; }
      if (!doc) continue;

      const nodeName = doc.title || null;
      const nodeType = typeLabel;

      // Walk the category subtree to find the exercise by _id (shape varies).
      // Entries come from the shared container and every batch's, as a flat
      // list — batches reuse subcategory names, so merging them into an object
      // would drop all but the last.
      let exerciseName = null;
      const categoryEntries = mergeSectionAcrossBatches(doc, category);
      if (categoryEntries.length && exerciseId) {
        const idStr = String(exerciseId);
        const findInArray = (arr) => Array.isArray(arr) ? arr.find(ex => ex && String(ex._id) === idStr) : null;
        let exercise = null;
        {
          // Prefer the caller's subcategory, then fall back to any of them.
          for (const [k, v] of categoryEntries) {
            if (subcategory && k === subcategory) { const f = findInArray(v); if (f) { exercise = f; break; } }
          }
          if (!exercise) {
            for (const [, v] of categoryEntries) {
              const found = findInArray(v);
              if (found) { exercise = found; break; }
            }
          }
        }
        if (exercise) exerciseName = exercise.exerciseInformation?.exerciseName || exercise.exerciseName || exercise.name || null;
      }
      return { exerciseName, nodeName, nodeType };
    }
    return empty;
  } catch {
    return empty;
  }
}

// Returns true if the submission is happening after endDate but inside the cutoff window.
// Server-authoritative — fetches the exercise doc from the node so client cannot fake it.
// Walks the WHOLE pedagogy.<category> subtree because subcategory shape varies (We_Do.practical,
// I_Do.<various keys>, etc.) — we just find the exercise by _id wherever it lives.
async function isLateSubmissionForExercise({ nodeId, nodeType, category, subcategory, exerciseId }) {
  try {
    if (!nodeId || !nodeType || !category || !exerciseId) {
      console.log('[lateCheck] missing input:', { nodeId, nodeType, category, exerciseId });
      return false;
    }
    const modelMap = {
      module: Module1, submodule: SubModule1, topic: Topic1, subtopic: SubTopic1,
    };
    const Model = modelMap[String(nodeType).toLowerCase()];
    if (!Model) {
      console.log('[lateCheck] unknown nodeType:', nodeType);
      return false;
    }

    // Fetch the whole category subtree — covers any subcategory shape, and
    // (Resources by Batch) both the shared container and every batch's own.
    // A batch-wise exercise is invisible to `doc.pedagogy[category]`, and this
    // check FAILS OPEN — not finding the exercise returns false, i.e. "not
    // late", so a missed lookup would silently accept every late submission.
    const doc = await Model.findById(nodeId)
      .select(`pedagogy.${category} batchPedagogy`)
      .lean();
    const categoryEntries = mergeSectionAcrossBatches(doc, category);
    if (!categoryEntries.length) {
      console.log('[lateCheck] no category in node:', { nodeId, category });
      return false;
    }

    const exerciseIdStr = String(exerciseId);
    const findInArray = (arr) =>
      Array.isArray(arr) ? arr.find(ex => ex && String(ex._id) === exerciseIdStr) : null;

    let exercise = null;
    // Try the requested subcategory first, then every other one.
    if (subcategory) {
      for (const [k, v] of categoryEntries) {
        if (k !== subcategory) continue;
        const found = findInArray(v);
        if (found) { exercise = found; break; }
      }
    }
    if (!exercise) {
      for (const [, v] of categoryEntries) {
        const found = findInArray(v);
        if (found) { exercise = found; break; }
      }
    }

    if (!exercise) {
      console.log('[lateCheck] exercise not found in pedagogy:', { nodeId, category, subcategory, exerciseId });
      return false;
    }

    const ap = exercise.availabilityPeriod;
    if (!ap) {
      console.log('[lateCheck] no availabilityPeriod on exercise');
      return false;
    }
    if (!ap.cutOffEnabled) {
      console.log('[lateCheck] cutOffEnabled is false');
      return false;
    }
    if (!ap.endDate) {
      console.log('[lateCheck] no endDate');
      return false;
    }
    const endTime = new Date(ap.endDate).getTime();
    if (Number.isNaN(endTime)) return false;
    const isLate = Date.now() > endTime;
    console.log('[lateCheck] result:', {
      exerciseId, endDate: ap.endDate, cutOffDate: ap.cutOffDate, now: new Date().toISOString(), isLate,
    });
    return isLate;
  } catch (err) {
    console.warn('isLateSubmissionForExercise error:', err?.message || err);
    return false;
  }
}


exports.submitAnswer = async (req, res) => {
  try {
    const userId = req.user._id;
    const {
      courseId,
      exerciseId,
      questionId,
      category,
      subcategory,
      selectedProgrammingLanguage,
      nodeId = "",
      nodeName = "",
      nodeType = "",
      code = "",
      score: clientScore = 0,
      language = "",
      status: clientStatus = "attempted",
      othersFiles: rawOthersFiles,
      attemptLimitEnabled,
      maxAttempts,
      isTestSubmission,  // ← KEY FLAG: only true when Submit Test or last question
      submitType,        // 'USER' (manual) | 'AUTO' (system auto-submit on violation/timeout)
      autoSubmitReason,  // human-readable reason when submitType === 'AUTO'
      // Per-question evaluation breakdown — populated by the client at Submit
      // time based on the exercise's evaluationMethod. See UserModel.js.
      // Not set for 'manual' submissions.
      evaluationBreakdown: rawEvaluationBreakdown,
    } = req.body;

    // Parse isTestSubmission properly from FormData string
    const isTestSubmit = isTestSubmission === 'true' || isTestSubmission === true;

    // Normalize submit type + reason (only meaningful on a full test submission).
    // Anything other than an explicit 'AUTO' is treated as a manual USER submit.
    const finalSubmitType = submitType === 'AUTO' ? 'AUTO' : 'USER';
    const finalAutoSubmitReason = finalSubmitType === 'AUTO'
      ? String(autoSubmitReason || '').slice(0, 300)
      : '';

    let othersFiles = [];
    if (rawOthersFiles) {
      try {
        const parsed = typeof rawOthersFiles === 'string' 
          ? JSON.parse(rawOthersFiles) 
          : rawOthersFiles;
        if (Array.isArray(parsed)) othersFiles = parsed;
      } catch (e) {}
    }

    let notionPages = null;
    if (code && typeof code === 'string' && code.startsWith('{')) {
      try {
        const parsed = JSON.parse(code);
        if (parsed.type === 'notionPages' && Array.isArray(parsed.pages)) {
          notionPages = parsed.pages;
        }
      } catch (e) {}
    }

    if (!courseId || !exerciseId || !questionId) {
      return res.status(400).json({
        success: false,
        message: "courseId, exerciseId, and questionId are required"
      });
    }

    const validCategories = ['I_Do', 'We_Do', 'You_Do'];
    if (!validCategories.includes(category)) {
      return res.status(400).json({
        success: false,
        message: "Category must be one of: I_Do, We_Do, You_Do"
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    // We Do / You Do duration tracking (start = first save, end = test submit)
    if (category === 'We_Do' || category === 'You_Do') {
      trackAssignmentDuration({ user, courseId, exerciseId, exerciseName: req.body.exerciseName, subcategory, method: category, nodeId: req.body.nodeId, nodeName: req.body.nodeName, nodeType: req.body.nodeType, isTestSubmit });
    }

    // ── Find or create course entry ──
    let courseIndex = user.courses.findIndex(c =>
      c.courseId && c.courseId.toString() === courseId
    );

    if (courseIndex === -1) {
      user.courses.push({
        courseId: new mongoose.Types.ObjectId(courseId),
        answers: { I_Do: new Map(), We_Do: new Map(), You_Do: new Map() },
        lastAccessed: new Date(),
      });
      courseIndex = user.courses.length - 1;
    } else {
      user.courses[courseIndex].lastAccessed = new Date();
    }

    if (!user.courses[courseIndex].answers) {
      user.courses[courseIndex].answers = {
        I_Do: new Map(), We_Do: new Map(), You_Do: new Map()
      };
    }

    if (!user.courses[courseIndex].answers[category]) {
      user.courses[courseIndex].answers[category] = new Map();
    }

    const exerciseKey = (category === 'We_Do' || category === 'You_Do')
      ? subcategory
      : exerciseId.toString();

    let exerciseArray = user.courses[courseIndex].answers[category].get(exerciseKey) || [];

    let exerciseIndex = exerciseArray.findIndex(
      ex => ex.exerciseId && ex.exerciseId.toString() === exerciseId
    );

    // ── Attempt limit check — only on full test submission ──
    const limitEnabled = attemptLimitEnabled === 'true' || attemptLimitEnabled === true;
    const maxAtt = parseInt(maxAttempts) || 1;

    if (limitEnabled && isTestSubmit && exerciseIndex !== -1) {
      const currentUserAttempts = exerciseArray[exerciseIndex].userAttempts || 0;
      if (currentUserAttempts >= maxAtt) {
        return res.status(403).json({
          success: false,
          message: [{ 
            key: 'error', 
            value: `Maximum attempts reached (${currentUserAttempts}/${maxAtt}). You cannot submit again.` 
          }]
        });
      }
    }

    // FormData strings JSON-encode complex objects — the multipart submitter
    // stringifies evaluationBreakdown before appending. Parse back here.
    //
    // Sanitisation is done inline because Mongoose enum validation doesn't fire
    // for schemas nested through Map + array (answers[category].get(key)[i]),
    // so an invalid method / criterion key would silently persist without this.
    const ALLOWED_METHOD = new Set(['manual', 'testcase', 'ai']);
    const ALLOWED_CRIT = new Set(['correctness','codeQuality','efficiency','readability','edgeCases','bestPractices']);
    const sanitizeBreakdown = (raw) => {
      const b = (typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw);
      if (!b || typeof b !== 'object') return null;
      if (!ALLOWED_METHOD.has(b.method)) return null; // reject unknown method outright
      const out = { method: b.method };
      if (b.method === 'testcase' && b.testcase && typeof b.testcase === 'object') {
        // Per-case rows (which case failed + input/expected/got) — capped at
        // 50 rows / 2000-char strings like the AI test-case list, so the
        // answer doc stays bounded. Older clients that only send counts still
        // sanitize fine (cases → []).
        const tcCases = Array.isArray(b.testcase.cases) ? b.testcase.cases : [];
        out.testcase = {
          passed: Number(b.testcase.passed) || 0,
          total: Number(b.testcase.total) || 0,
          cases: tcCases.slice(0, 50).map((t, i) => ({
            index: Number(t?.index) === Number(t?.index) ? Number(t.index) : i,
            passed: !!t?.passed,
            hidden: !!t?.hidden,
            input: typeof t?.input === 'string' ? t.input.slice(0, 2000) : '',
            expectedOutput: typeof t?.expectedOutput === 'string' ? t.expectedOutput.slice(0, 2000) : '',
            actualOutput: typeof t?.actualOutput === 'string' ? t.actualOutput.slice(0, 2000) : '',
          })),
        };
      }
      if (b.method === 'ai' && b.ai && typeof b.ai === 'object') {
        const criteria = Array.isArray(b.ai.criteria) ? b.ai.criteria : [];
        const testCases = Array.isArray(b.ai.testCases) ? b.ai.testCases : [];
        out.ai = {
          perCriterionMax: Number(b.ai.perCriterionMax) || 0,
          criteria: criteria
            .filter(c => c && ALLOWED_CRIT.has(c.key))
            .map(c => ({
              key: c.key,
              percentage: Math.max(0, Math.min(100, Number(c.percentage) || 0)),
              score: Math.max(0, Number(c.score) || 0),
              comment: typeof c.comment === 'string' ? c.comment.slice(0, 500) : '',
            })),
          // AI-judged test cases — capped at 50 rows to keep the answer doc bounded.
          testCases: testCases.slice(0, 50).map((t, i) => ({
            index: Number(t?.index) === Number(t?.index) ? Number(t.index) : i,
            source: t?.source === 'ai' ? 'ai' : 'question',
            input: typeof t?.input === 'string' ? t.input.slice(0, 2000) : '',
            expectedOutput: typeof t?.expectedOutput === 'string' ? t.expectedOutput.slice(0, 2000) : '',
            passed: !!t?.passed,
            comment: typeof t?.comment === 'string' ? t.comment.slice(0, 500) : '',
          })),
          passedTestCases: Math.max(0, Number(b.ai.passedTestCases) || 0),
          totalTestCases: Math.max(0, Number(b.ai.totalTestCases) || 0),
          criteriaPortion: Math.max(0, Number(b.ai.criteriaPortion) || 0),
          testCasePortion: Math.max(0, Number(b.ai.testCasePortion) || 0),
          model: typeof b.ai.model === 'string' ? b.ai.model.slice(0, 100) : '',
          failed: !!b.ai.failed,
        };
      }
      return out;
    };
    let evaluationBreakdown = sanitizeBreakdown(rawEvaluationBreakdown);
    let score = clientScore;
    let status = clientStatus;

    // ─── Server-authoritative judge (Phase 1 P0) ─────────────────────────
    // For any submission that carries programming code, re-run the code
    // against the trainer's stored testCases and OVERWRITE the score,
    // status, and evaluationBreakdown coming from the client. This closes
    // the tamper hole where a student could POST `score: 10, status:
    // "solved"` from the browser and be marked complete without ever
    // running the code.
    //
    // Gated on:
    //   • non-empty `code`
    //   • a resolvable `selectedProgrammingLanguage`
    //   • notionPages absent (Notion journals aren't programming answers)
    //
    // If the question can't be resolved (deleted from tree, wrong
    // nodeType, etc.) we fall through and keep the client values so we
    // don't lose the submission — a log line surfaces the gap.
    const canJudge =
      !!code &&
      typeof code === 'string' &&
      !notionPages &&
      !!selectedProgrammingLanguage;
    if (canJudge) {
      try {
        const q = await loadForJudge({
          nodeType, nodeId, category, subcategory, exerciseId, questionId,
        });
        if (q && Array.isArray(q.testCases) && q.testCases.length > 0) {
          const judged = await judgeCode({
            language: selectedProgrammingLanguage || language,
            files: [{ path: 'main', content: code, isEntryPoint: true }],
            testCases: q.testCases,
            functionName: q.functionName,
            maxMarks: q.maxMarks,
          });
          score = judged.score;
          status = judged.status;
          evaluationBreakdown = {
            method: 'testcase',
            testcase: {
              passed: judged.passed,
              total: judged.total,
              cases: judged.perCase.map((c) => ({
                index: c.index,
                passed: c.passed,
                hidden: c.hidden,
                // Blank trainer-authored fields (input + expected) on hidden
                // cases, but KEEP the student's own actualOutput — that's
                // their own code's output, not a trainer secret. Students
                // need it to debug format mismatches ("I returned 'true'
                // but expected 'Even' — different type").
                input: c.hidden ? '' : c.input,
                expectedOutput: c.hidden ? '' : c.expectedOutput,
                actualOutput: c.actualOutput,
              })),
            },
          };
        } else if (q) {
          console.warn(
            `[judge] question ${questionId} has 0 testCases — keeping client-computed score`,
          );
        } else {
          console.warn(
            `[judge] could not resolve question ${questionId} under ${nodeType}/${nodeId} ${category}/${subcategory}/${exerciseId} — keeping client-computed score`,
          );
        }
      } catch (e) {
        // Never fail the submission because judging failed — the code is
        // still saved with the client-computed score, and the trainer can
        // re-run judgment from the rerun flow.
        console.error('[judge] error during server-side judge, keeping client score:', e?.message || e);
      }
    }

    const questionAnswer = {
      questionId: new mongoose.Types.ObjectId(questionId),
      codeAnswer: code,
      language,
      score,
      status,
      isCorrect: status === 'solved' || score >= 70,
      attempts: 1,
      submittedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...(othersFiles.length > 0 ? { othersFiles } : {}),
      ...(notionPages ? { notionPages } : {}),
      // Only include when the client actually provided a breakdown, so Manual
      // submissions don't stamp an empty object onto the answer.
      ...(evaluationBreakdown ? { evaluationBreakdown } : {}),
    };

    // ── Late submission detection (server-authoritative) ──
    // Only meaningful when isTestSubmit; cheap no-op otherwise.
    const isLate = isTestSubmit
      ? await isLateSubmissionForExercise({ nodeId, nodeType, category, subcategory, exerciseId })
      : false;

    if (exerciseIndex === -1) {
      // ── Create new exercise entry ──
      const newExercise = {
        exerciseId: new mongoose.Types.ObjectId(exerciseId),
        questions: [questionAnswer],
        nodeId,
        nodeName,
        nodeType,
        selectedProgrammingLanguage,
        subcategory: (category === 'We_Do' || category === 'You_Do')
          ? subcategory
          : undefined,
        userAttempts: isTestSubmit ? 1 : 0,
        testSubmissions: isTestSubmit ? 1 : 0,
        lastTestSubmittedAt: isTestSubmit ? new Date() : null,
        lateSubmission: isTestSubmit ? isLate : false,
        submitType: isTestSubmit ? finalSubmitType : 'USER',
        autoSubmitReason: isTestSubmit ? finalAutoSubmitReason : '',
        createdAt: new Date(),
        updatedAt: new Date()
      };
      exerciseArray.push(newExercise);

    } else {
      // ── Update existing exercise ──
      const existingExercise = exerciseArray[exerciseIndex];
      const existingQuestionIndex = existingExercise.questions.findIndex(
        q => q.questionId && q.questionId.toString() === questionId
      );

      if (existingQuestionIndex === -1) {
        existingExercise.questions.push(questionAnswer);
      } else {
        const existingQuestion = existingExercise.questions[existingQuestionIndex];
        // A navigation/skip save ('attempted'/'skipped') must never downgrade an
        // already-earned score or a 'solved' status. Preserve the prior score and
        // keep a solved question solved, while still saving the latest code.
        const isNavSave = status === 'attempted' || status === 'skipped';
        const preservedScore = isNavSave
          ? Math.max(Number(existingQuestion.score) || 0, Number(score) || 0)
          : score;
        const preservedStatus = isNavSave && existingQuestion.status === 'solved'
          ? 'solved'
          : status;
        existingExercise.questions[existingQuestionIndex] = {
          ...questionAnswer,
          score: preservedScore,
          status: preservedStatus,
          isCorrect: preservedStatus === 'solved' || preservedScore >= 70,
          attempts: (existingQuestion.attempts || 0) + 1,
          createdAt: existingQuestion.createdAt || new Date(),
          updatedAt: new Date(),
          // On nav-saves the client doesn't send a fresh breakdown — preserve
          // the last one so a Manual "moved to next question" nav doesn't
          // clobber the AI or Test Case breakdown from an earlier real Submit.
          evaluationBreakdown: evaluationBreakdown || existingQuestion.evaluationBreakdown || null,
        };
      }

      existingExercise.updatedAt = new Date();
      if (nodeId) existingExercise.nodeId = nodeId;
      if (nodeName) existingExercise.nodeName = nodeName;
      if (nodeType) existingExercise.nodeType = nodeType;
      if (selectedProgrammingLanguage) {
        existingExercise.selectedProgrammingLanguage = selectedProgrammingLanguage;
      }
      if ((category === 'We_Do' || category === 'You_Do') && subcategory) {
        existingExercise.subcategory = subcategory;
      }

      // ── ONLY increment userAttempts on full test submission ──
      // Guard: ignore duplicate requests within 10 seconds (double-click protection)
      if (isTestSubmit) {
        const now = Date.now();
        const lastAt = existingExercise.lastTestSubmittedAt
          ? new Date(existingExercise.lastTestSubmittedAt).getTime()
          : 0;
        if (now - lastAt > 10000) {
          existingExercise.userAttempts = (existingExercise.userAttempts || 0) + 1;
          existingExercise.testSubmissions = (existingExercise.testSubmissions || 0) + 1;
          existingExercise.lastTestSubmittedAt = new Date();
          existingExercise.lateSubmission = isLate;
          existingExercise.submitType = finalSubmitType;
          existingExercise.autoSubmitReason = finalAutoSubmitReason;
        }
      }
      // ── Individual question submits do NOT touch userAttempts ──
    }

    user.courses[courseIndex].answers[category].set(exerciseKey, exerciseArray);
    user.markModified(`courses.${courseIndex}.answers.${category}`);

    // ── Mark exercise completed only on full test submission ──
    if (isTestSubmit) {
      const exerciseArray2 = user.courses[courseIndex].answers[category].get(exerciseKey);
      const exEntry = exerciseArray2?.find(
        ex => ex.exerciseId && ex.exerciseId.toString() === exerciseId
      );

      if (exEntry) {
        exEntry.status = 'completed';
        user.markModified(`courses.${courseIndex}.answers.${category}`);

        const submissionsUsed = exEntry.testSubmissions || 1;
        if (!limitEnabled || submissionsUsed >= maxAtt) {
          if (!user.courses[courseIndex].progress) {
            user.courses[courseIndex].progress = {
              visitedNodes: [], 
              openedResources: [], 
              completedExercises: []
            };
          }
          const exerciseIdStr = exerciseId.toString();
          if (!user.courses[courseIndex].progress.completedExercises.includes(exerciseIdStr)) {
            user.courses[courseIndex].progress.completedExercises.push(exerciseIdStr);
            user.markModified(`courses.${courseIndex}.progress`);
          }
        }
      }
    }

    await user.save();

    // ── Read back final counts ──
    const savedExerciseArray = user.courses[courseIndex].answers[category].get(exerciseKey);
    const savedExercise = savedExerciseArray?.find(
      ex => ex.exerciseId && ex.exerciseId.toString() === exerciseId
    );

    res.status(200).json({
      success: true,
      message: "Answer submitted successfully",
      // ── Return userAttempts so frontend can sync ──
      userAttempts: savedExercise?.userAttempts || 0,
      testSubmissions: savedExercise?.testSubmissions || 0,
      lateSubmission: savedExercise?.lateSubmission || false,
      submitType: savedExercise?.submitType || 'USER',
      autoSubmitReason: savedExercise?.autoSubmitReason || '',
      data: {
        courseId,
        exerciseId,
        questionId,
        category,
        subcategory: (category === 'We_Do' || category === 'You_Do')
          ? subcategory
          : undefined,
        status,
        score,
        // Echo the server-authored breakdown so the single-file editor
        // terminal can render per-case results after Submit without
        // running any code client-side.
        evaluationBreakdown,
        isCorrect: questionAnswer.isCorrect,
        user: {
          id: user._id,
          name: `${user.firstName} ${user.lastName || ''}`,
          email: user.email
        }
      }
    });

  } catch (error) {
    console.error("❌ Submit answer error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};
exports.getAllUsers = async (req, res) => {
  try {
    const { courseId } = req.params;
    const { institutionId, status, roleId, search } = req.query;

    if (!courseId) {
      return res.status(400).json({
        success: false,
        message: "courseId parameter is required"
      });
    }

    // 1. Get course with populated participants
    const course = await CourseStructure.findById(courseId)
      .select('courseName courseCode description startDate endDate batchAndParticipants')
      .populate({
        path: "batchAndParticipants.users.user",
        select: '_id email firstName lastName status'
      })
      .lean();

    if (!course) {
      return res.status(404).json({
        success: false,
        message: "Course not found"
      });
    }

    // 2. Extract user IDs from participants across all batches (deduped)
    const participantUserIds = [...new Set(
      (course.batchAndParticipants || [])
        .flatMap(batch => batch.users || [])
        .filter(participant => participant.user && participant.user._id)
        .map(participant => participant.user._id.toString())
    )];

    if (participantUserIds.length === 0) {
      return res.status(200).json({
        success: true,
        message: "No participants found in this course",
        data: {
          course: {
            _id: course._id,
            courseName: course.courseName,
            courseCode: course.courseCode,
            description: course.description,
            startDate: course.startDate,
            endDate: course.endDate,
            totalParticipants: 0
          },
          users: []
        }
      });
    }

    // 3. Build user filter
    let filter = { _id: { $in: participantUserIds } };
    
    // Search filter
    if (search) {
      filter.$or = [
        { firstName: { $regex: search, $options: 'i' } },
        { lastName: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } }
      ];
    }
    
    if (institutionId && institutionId !== 'all') {
      filter.institution = institutionId;
    }
    
    if (status && ['active', 'inactive'].includes(status)) {
      filter.status = status;
    }
    
    if (roleId && roleId !== 'all') {
      filter.role = roleId;
    }

    // 4. Get users with required fields
    const users = await User.find(filter)
      .populate({
        path: 'institution',
        select: 'inst_id inst_name inst_owner phone address basedOn'
      })
      .populate({
        path: 'role',
        select: 'originalRole renameRole roleValue'
      })
      .populate({
        path: 'courses.courseId',
        select: 'courseName courseCode',
        match: { _id: courseId },
        model: 'Course-Structure'
      })
      .select('-password -tokens -__v')
      .sort({ firstName: 1, lastName: 1 })
      .lean();

    if (!users || users.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No users found matching the criteria"
      });
    }

    // 5. Model mapping for fetching exercise details
    const modelMap = {
      'module': mongoose.model('Module1'),
      'submodule': mongoose.model('SubModule1'),
      'topic': mongoose.model('Topic1'),
      'subtopic': mongoose.model('SubTopic1')
    };

    // 6. Enrich each user with course progress data
    const enrichedUsers = await Promise.all(users.map(async (user) => {
      const formattedUser = {
        _id: user._id,
        institution: user.institution,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        phone: user.phone,
        gender: user.gender,
        profile: user.profile,
        role: user.role,
        status: user.status,
        createdAt: user.createdAt,
        createdBy: user.createdBy,
        updatedAt: user.updatedAt,
        permissions: user.permissions,
        courses: []
      };

      // Find the specific course in user's courses
      const userCourse = user.courses?.find(c => 
        c.courseId && c.courseId._id.toString() === courseId
      );

      if (userCourse) {
        const courseProgress = {
          courseId: userCourse.courseId?._id,
          courseName: userCourse.courseId?.courseName,
          courseCode: userCourse.courseId?.courseCode,
          lastAccessed: userCourse.lastAccessed,
          exercises: []
        };

        // Process We_Do exercises
        if (userCourse.answers?.We_Do?.practical) {
          const exercises = await Promise.all(
            userCourse.answers.We_Do.practical.map(async (practice) => {
              const exerciseData = {
                exerciseId: practice.exerciseId,
                nodeId: practice.nodeId,
                nodeName: practice.nodeName,
                nodeType: practice.nodeType,
                selectedProgrammingLanguage: practice.selectedProgrammingLanguage,
                subcategory: practice.subcategory || 'practical',
                createdAt: practice.createdAt,
                updatedAt: practice.updatedAt,
                exerciseDetails: null,
                questions: []
              };

              // Fetch exercise details WITHOUT storing allExerciseQuestions
              if (practice.nodeId && practice.nodeType) {
                try {
                  const nodeType = practice.nodeType.toLowerCase();
                  const Model = modelMap[nodeType];
                  
                  if (Model) {
                    // Resources by Batch — this used a positional `$`
                    // projection pinned to `pedagogy.We_Do.practical`, which
                    // cannot reach a batch-wise exercise (its path contains the
                    // batch id). Fetch the node and resolve by _id across the
                    // shared container and every batch instead; the id is
                    // unique, so the owning batch does not change the result.
                    const documentData = await Model.findById(practice.nodeId)
                      .select('title pedagogy.We_Do batchPedagogy')
                      .lean();

                    const exercise = mergeSectionAcrossBatches(documentData, 'We_Do')
                      .flatMap(([, v]) => (Array.isArray(v) ? v : v ? [v] : []))
                      .find(ex => ex && String(ex._id) === String(practice.exerciseId));

                    if (exercise) {

                      // Add exercise details only
                      exerciseData.exerciseDetails = {
                        exerciseName: exercise.exerciseInformation?.exerciseName,
                        description: exercise.exerciseInformation?.description,
                        exerciseLevel: exercise.exerciseInformation?.exerciseLevel,
                        totalQuestions: exercise.exerciseInformation?.totalQuestions,
                        totalPoints: exercise.exerciseInformation?.totalPoints,
                        estimatedTime: exercise.exerciseInformation?.estimatedTime
                      };

                      // Create a map of question details for quick lookup
                      const questionDetailsMap = new Map();
                      if (exercise.questions && Array.isArray(exercise.questions)) {
                        exercise.questions.forEach(q => {
                          questionDetailsMap.set(q._id.toString(), {
                            title: q.title,
                            description: q.description,
                            difficulty: q.difficulty,
                            score: q.score,
                            sampleInput: q.sampleInput,
                            sampleOutput: q.sampleOutput,
                            constraints: q.constraints || [],
                            hints: q.hints || [],
                            testCases: q.testCases || [],
                            solutions: q.solutions || {},
                            timeLimit: q.timeLimit,
                            memoryLimit: q.memoryLimit
                          });
                        });
                      }

                      // Process user's questions
                      if (practice.questions && Array.isArray(practice.questions)) {
                        exerciseData.questions = practice.questions.map(userQuestion => {
                          const questionData = {
                            questionId: userQuestion.questionId,
                            codeAnswer: userQuestion.codeAnswer,
                            language: userQuestion.language,
                            isCorrect: userQuestion.isCorrect,
                            score: userQuestion.score,
                            status: userQuestion.status,
                            attempts: userQuestion.attempts,
                            submittedAt: userQuestion.submittedAt,
                            createdAt: userQuestion.createdAt,
                            updatedAt: userQuestion.updatedAt,
                            questionDetails: null
                          };

                          // Get question details from map
                          const questionDetail = questionDetailsMap.get(userQuestion.questionId.toString());
                          if (questionDetail) {
                            questionData.questionDetails = questionDetail;
                          }

                          return questionData;
                        });
                      }
                    }
                  }
                } catch (error) {
                  console.warn(`Error fetching exercise details for user ${user._id}:`, error.message);
                }
              }

              return exerciseData;
            })
          );

          courseProgress.exercises = exercises;
        }

        formattedUser.courses = [courseProgress];
      } else {
        // User is enrolled but has no progress yet
        formattedUser.courses = [{
          courseId: course._id,
          courseName: course.courseName,
          courseCode: course.courseCode,
          lastAccessed: null,
          exercises: []
        }];
      }

      return formattedUser;
    }));

    // 7. Calculate overall statistics
    const courseStatistics = {
      totalEnrolled: participantUserIds.length,
      usersWithAccess: users.length,
      activeUsers: users.filter(u => u.status === 'active').length,
      inactiveUsers: users.filter(u => u.status === 'inactive').length,
      usersWithProgress: enrichedUsers.filter(u => 
        u.courses[0]?.exercises?.length > 0
      ).length,
      totalExercises: enrichedUsers.reduce((sum, user) => 
        sum + (user.courses[0]?.exercises?.length || 0), 0
      ),
      totalQuestionsAttempted: enrichedUsers.reduce((sum, user) => {
        const exercises = user.courses[0]?.exercises || [];
        return sum + exercises.reduce((exSum, ex) => 
          exSum + (ex.questions?.length || 0), 0);
      }, 0),
      totalQuestionsSolved: enrichedUsers.reduce((sum, user) => {
        const exercises = user.courses[0]?.exercises || [];
        return sum + exercises.reduce((exSum, ex) => 
          exSum + (ex.questions?.filter(q => q.isCorrect === true || q.status === 'solved').length || 0), 0);
      }, 0),
      averageCompletion: enrichedUsers.length > 0 ? 
        Math.round(enrichedUsers.filter(u => 
          u.courses[0]?.exercises?.length > 0
        ).length / enrichedUsers.length * 100) : 0
    };

    // 8. Return formatted response WITHOUT allExerciseQuestions
    res.status(200).json({
      success: true,
      message: `Found ${users.length} users enrolled in course "${course.courseName}"`,
      data: {
        course: {
          _id: course._id,
          courseName: course.courseName,
          courseCode: course.courseCode,
          description: course.description,
          startDate: course.startDate,
          endDate: course.endDate,
          totalParticipants: participantUserIds.length
        },
        users: enrichedUsers,
        statistics: courseStatistics,
        summary: {
          total: enrichedUsers.length,
          filters: {
            institutionId: institutionId || 'all',
            status: status || 'all',
            roleId: roleId || 'all',
            search: search || 'none'
          }
        }
      }
    });

  } catch (error) {
    console.error("Error in getAllUsers by course:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
};




exports.evaluateStudentAnswer = async (req, res) => {
  try {
    const {
      courseId,
      exerciseId,
      exerciseName,
      questionId,
      questionTitle,
      participantId,
      score,
      totalScore, // Added totalScore
      feedback,
      status = "evaluated",
      category,
      subcategory,
    } = req.body;

    // Validate required fields
    if (!courseId || !exerciseId || !questionId || !participantId) {
      return res.status(400).json({
        success: false,
        message: "courseId, exerciseId, questionId, and participantId are required"
      });
    }

    // Validate score range
    if (score === undefined || score === null) {
      return res.status(400).json({
        success: false,
        message: "Score is required"
      });
    }

    if (score < 0 || score > 100) {
      return res.status(400).json({
        success: false,
        message: "Score must be between 0 and 100"
      });
    }

    // Validate totalScore if provided
    if (totalScore !== undefined && totalScore !== null) {
      if (totalScore < 0) {
        return res.status(400).json({
          success: false,
          message: "totalScore must be a positive number"
        });
      }
    }

    // Validate category
    const validCategories = ['I_Do', 'We_Do', 'You_Do'];
    if (!validCategories.includes(category)) {
      return res.status(400).json({
        success: false,
        message: "Category must be one of: I_Do, We_Do, You_Do"
      });
    }

    // Find the course to get course name
    const Course = require("../../../models/Courses/courseStructureModal"); // Adjust the path as needed
    
    let courseName = "";
    try {
      const course = await Course.findById(courseId).select("courseName");
      if (course) {
        courseName = course.courseName;
      }
    } catch (courseError) {
      console.warn("Could not fetch course name:", courseError.message);
      // Continue without course name - it's not critical for the evaluation
    }

    // Find the student (participant)
    const student = await User.findById(participantId);
    if (!student) {
      return res.status(404).json({
        success: false,
        message: "Student not found"
      });
    }

    // Find instructor who is evaluating
    const instructor = await User.findById(req.user._id);
    if (!instructor) {
      return res.status(404).json({
        success: false,
        message: "Instructor not found"
      });
    }

    // Find the course in student's courses
    let courseIndex = student.courses.findIndex(c => 
      c.courseId && c.courseId.toString() === courseId
    );

    // If course not found, create it
    if (courseIndex === -1) {
      const newCourse = {
        courseId: new mongoose.Types.ObjectId(courseId),
        answers: {
          I_Do: new Map(),
          We_Do: new Map(),
          You_Do: new Map()
        },
        lastAccessed: new Date(),
        createdAt: new Date(),
        updatedAt: new Date()
      };
      
      student.courses.push(newCourse);
      courseIndex = student.courses.length - 1;
    } else {
      // Course exists, update last accessed
      student.courses[courseIndex].lastAccessed = new Date();
    }

    // Ensure answers structure exists
    if (!student.courses[courseIndex].answers) {
      student.courses[courseIndex].answers = {
        I_Do: new Map(),
        We_Do: new Map(),
        You_Do: new Map()
      };
    }

    let foundAndUpdated = false;
    let evaluationDetails = null;

    // Get the category map
    let categoryMap = student.courses[courseIndex].answers[category];
    if (!categoryMap) {
      categoryMap = new Map();
      student.courses[courseIndex].answers[category] = categoryMap;
    }

    // Determine the exercise key based on category
    let exerciseKey;
    if (category) {
      exerciseKey = subcategory;
    } else {
      exerciseKey = exerciseId.toString();
    }

    // Get or create the exercise array for this key
    let exerciseArray = categoryMap.get(exerciseKey);
    if (!exerciseArray) {
      exerciseArray = [];
    }

    // Find existing exercise in the array
    let exerciseIndex = exerciseArray.findIndex(
      ex => ex.exerciseId && ex.exerciseId.toString() === exerciseId
    );

    // Prepare the question answer object - INCLUDING totalScore
    const questionAnswer = {
      questionId: new mongoose.Types.ObjectId(questionId),
      questionTitle: questionTitle || "",
      codeAnswer: "", // Empty code answer as requested
      language: "", // Default language
      score: score,
      totalScore: totalScore || 0, // Store totalScore (default to 0 if not provided)
      feedback: feedback,
      status: status,
      isCorrect: score >= 70,
      attempts: 1,
      submittedAt: new Date(),
      evaluatedBy: req.user._id,
      evaluatedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date()
    };

    if (exerciseIndex !== -1) {
      // Exercise exists, find or create question
      const exercise = exerciseArray[exerciseIndex];
      
      // Update exerciseName if provided
      if (exerciseName) {
        exercise.exerciseName = exerciseName;
      }
      
      // Find the question in this exercise
      const questionIndex = exercise.questions.findIndex(
        q => q.questionId && q.questionId.toString() === questionId
      );

      if (questionIndex !== -1) {
        // Question exists, update it
        const question = exercise.questions[questionIndex];
        
        // Store previous values for response
        const previousScore = question.score;
        const previousTotalScore = question.totalScore;
        const previousFeedback = question.feedback;
        const previousStatus = question.status;
        
        // Update the question (including totalScore)
        question.score = score;
        question.totalScore = totalScore || question.totalScore; // Update totalScore
        question.questionTitle = questionTitle || question.questionTitle;
        question.feedback = feedback || question.feedback;
        question.status = status;
        question.isCorrect = score >= 70;
        question.updatedAt = new Date();
        question.evaluatedBy = req.user._id;
        question.evaluatedAt = new Date();
        question.attempts = (question.attempts || 0) + 1;
        
        foundAndUpdated = true;
        evaluationDetails = {
          action: "updated_existing",
          category,
          exercise: {
            id: exercise.exerciseId,
            name: exercise.exerciseName,
            nodeId: exercise.nodeId,
            nodeName: exercise.nodeName,
            nodeType: exercise.nodeType,
            subcategory: exercise.subcategory
          },
          question: {
            id: question.questionId,
            title: question.questionTitle,
            previousScore,
            previousTotalScore,
            previousFeedback,
            previousStatus,
            newScore: score,
            newTotalScore: totalScore || question.totalScore,
            newFeedback: feedback,
            newStatus: status,
            isCorrect: question.isCorrect,
            language: question.language,
            codeAnswer: question.codeAnswer,
            attempts: question.attempts
          }
        };
      } else {
        // Question doesn't exist, add it to existing exercise
        exercise.questions.push(questionAnswer);
        exercise.updatedAt = new Date();
        
        foundAndUpdated = true;
        evaluationDetails = {
          action: "added_to_existing_exercise",
          category,
          exercise: {
            id: exercise.exerciseId,
            name: exercise.exerciseName,
            nodeId: exercise.nodeId,
            nodeName: exercise.nodeName,
            nodeType: exercise.nodeType,
            subcategory: exercise.subcategory
          },
          question: {
            id: questionAnswer.questionId,
            title: questionAnswer.questionTitle,
            codeAnswer: questionAnswer.codeAnswer,
            score: questionAnswer.score,
            totalScore: questionAnswer.totalScore, // Include totalScore
            feedback: questionAnswer.feedback,
            status: questionAnswer.status,
            isCorrect: questionAnswer.isCorrect,
            language: questionAnswer.language,
            attempts: questionAnswer.attempts
          }
        };
      }
      
      // Update the exercise in the array
      exerciseArray[exerciseIndex] = exercise;
      
    } else {
      // Exercise doesn't exist, create new exercise with question
      const newExercise = {
        exerciseId: new mongoose.Types.ObjectId(exerciseId),
        exerciseName: exerciseName || "",
        questions: [questionAnswer],
        nodeId: "",
        nodeName: "",
        nodeType: "",
        subcategory: category ? subcategory : undefined,
        createdAt: new Date(),
        updatedAt: new Date()
      };
      
      exerciseArray.push(newExercise);
      foundAndUpdated = true;
      evaluationDetails = {
        action: "created_new_exercise",
        category,
        exercise: {
          id: newExercise.exerciseId,
          name: newExercise.exerciseName,
          nodeId: newExercise.nodeId,
          nodeName: newExercise.nodeName,
          nodeType: newExercise.nodeType,
          subcategory: newExercise.subcategory
        },
        question: {
          id: questionAnswer.questionId,
          title: questionAnswer.questionTitle,
          codeAnswer: questionAnswer.codeAnswer,
          score: questionAnswer.score,
          totalScore: questionAnswer.totalScore, // Include totalScore
          feedback: questionAnswer.feedback,
          status: questionAnswer.status,
          isCorrect: questionAnswer.isCorrect,
          language: questionAnswer.language,
          attempts: questionAnswer.attempts
        }
      };
    }

    // Update the map with modified array
    categoryMap.set(exerciseKey, exerciseArray);
    
    // Mark the modified paths for Mongoose
    student.markModified(`courses.${courseIndex}.answers.${category}`);
    
    // Update course last accessed
    student.courses[courseIndex].lastAccessed = new Date();
    student.courses[courseIndex].updatedAt = new Date();

    // **SEND NOTIFICATION TO STUDENT**
    const notificationTitle = "Answer Evaluated";
    let notificationMessage = "";
    
    // Use exerciseName and questionTitle in notification
    const exerciseDisplayName = exerciseName || "Exercise";
    const questionDisplayTitle = questionTitle || "Question";
    
    // Include totalScore in notification message
    const scoreDisplay = totalScore 
      ? `${score}/${totalScore}` 
      : `${score}/100`;
    
    if (score >= 70) {
      notificationMessage = `🎉 Excellent! Your answer for "${questionDisplayTitle}" in ${exerciseDisplayName} scored ${scoreDisplay} - Well done!`;
    } else if (score >= 50) {
      notificationMessage = `📝 Your answer for "${questionDisplayTitle}" in ${exerciseDisplayName} scored ${scoreDisplay} - Good attempt!`;
    } else {
      notificationMessage = `📋 Your answer for "${questionDisplayTitle}" in ${exerciseDisplayName} scored ${scoreDisplay} - Review the feedback for improvements.`;
    }

    if (feedback) {
      notificationMessage += ` Feedback: ${feedback}`;
    }

    // Create notification for the student
    const studentNotification = {
      title: notificationTitle,
      message: notificationMessage,
      type: score >= 70 ? 'success' : score >= 50 ? 'info' : 'warning',
      relatedEntity: 'assignment',
      relatedEntityId: questionId,
      isRead: false,
      metadata: {
        "Course Name": courseName || '',
        "Exercise Name": exerciseName || '',
        "Question Title": questionTitle || '',
        "Score": score, 
        "Total Score": totalScore || 0, // Include totalScore in metadata
        "Feedback": feedback || '',
        "Status": status,
        "Category": category,
        "Sub Category": subcategory || '',
        "Evaluated By Email": instructor.email,
        "Evaluated At": new Date().toISOString()
      },
      enrolledBy: instructor._id
    };

    // Add notification to student
    await student.addNotification(studentNotification);

    // Save the updated student document
    await student.save();

    // **SEND REAL-TIME NOTIFICATION (if using WebSocket)**
    if (global.io) {
      global.io.to(`user-${student._id}`).emit('new-notification', {
        ...studentNotification,
        _id: `eval-${Date.now()}`,
        createdAt: new Date().toISOString()
      });
    }

    // Also send notification to instructor's own record
    const instructorNotification = {
      title: "Evaluation Completed",
      message: `You evaluated ${student.firstName}'s answer for "${questionDisplayTitle}" in ${exerciseDisplayName}. Score: ${scoreDisplay}`,
      type: 'info',
      relatedEntity: 'assignment',
      relatedEntityId: questionId,
      isRead: false,
      metadata: {
        studentId: student._id,
        studentName: `${student.firstName} ${student.lastName || ''}`,
        studentEmail: student.email,
        courseId: courseId,
        courseName: courseName || '',
        exerciseId: exerciseId,
        exerciseName: exerciseName || '',
        questionId: questionId,
        questionTitle: questionTitle || '',
        score: score,
        totalScore: totalScore || 0, // Include totalScore in instructor notification
        feedback: feedback || '',
        evaluatedAt: new Date().toISOString()
      }
    };

    await instructor.addNotification(instructorNotification);
    await instructor.save();

    res.status(200).json({
      success: true,
      message: evaluationDetails.action === "updated_existing" 
        ? "Student answer evaluated successfully" 
        : "New answer entry created and evaluated",
      data: {
        student: {
          id: student._id,
          name: `${student.firstName} ${student.lastName || ''}`,
          email: student.email
        },
        instructor: {
          id: instructor._id,
          name: `${instructor.firstName} ${instructor.lastName || ''}`,
          email: instructor.email
        },
        course: {
          id: courseId,
          name: courseName || ''
        },
        exercise: {
          id: exerciseId,
          name: exerciseName || ''
        },
        question: {
          id: questionId,
          title: questionTitle || ''
        },
        score: {
          obtained: score,
          total: totalScore || 0, // Include totalScore in response
          percentage: totalScore ? ((score / totalScore) * 100).toFixed(2) : score
        },
        evaluationDetails,
        notification: {
          sentToStudent: true,
          message: notificationMessage,
          notificationId: studentNotification._id
        },
        evaluationInfo: {
          gradedBy: req?.user?._id || req.user?.email || 'instructor',
          evaluatedAt: new Date(),
          score,
          totalScore,
          feedback,
          status,
          category,
          subcategory: category ? subcategory : undefined
        }
      }
    });

  } catch (error) {
    console.error("❌ Evaluate student answer error:", error);
    res.status(500).json({
      success: false,
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};



exports.getAnswerByQuestionId = async (req, res) => {
  try {
    // Extract parameters from query string (since it's a GET request)
    const { 
      courseId, 
      exerciseId, 
      questionId, 
      category = "We_Do", 
      subcategory 
    } = req.query;
    
    const userId = req.user._id;

    // 1. Validation
    if (!courseId || !exerciseId || !questionId) {
      return res.status(400).json({ 
        success: false, 
        message: "Missing required fields: courseId, exerciseId, or questionId" 
      });
    }

    // 2. Find User
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // 3. Find Course in User's Enrolled Courses
    const course = user.courses.find(c => c.courseId && c.courseId.toString() === courseId);
    
    // If course or answers map doesn't exist, return null data (not an error, just no answer yet).
    // NOTE: do not early-return when the requested `category` bucket is missing —
    // the bucket-agnostic fallback below still needs to scan the other buckets.
    if (!course || !course.answers) {
      return res.status(200).json({ success: true, data: null });
    }

    // 4. Resolve Exercise Key
    // We_Do AND You_Do both store under `subcategory` (see submitAnswer), so the
    // previous lookup-by-exerciseId failed for You_Do → no pre-fill on retest.
    const exerciseKey = (category === 'We_Do' || category === 'You_Do') ? subcategory : exerciseId;
    
    // Helper: find this exerciseId + questionId inside one exercise array.
    const findQ = (arr) => {
      if (!Array.isArray(arr)) return null;
      const ex = arr.find(e => e.exerciseId && e.exerciseId.toString() === exerciseId);
      if (!ex || !Array.isArray(ex.questions)) return null;
      return ex.questions.find(q => q.questionId && q.questionId.toString() === questionId) || null;
    };

    // 5/6. Exact lookup first: category bucket -> exerciseKey.
    const categoryMap = course.answers.get(category);
    let questionAnswer = categoryMap ? findQ(categoryMap.get(exerciseKey)) : null;

    // Fallback: the answer may live under a different category/subcategory bucket
    // (e.g. submitted as You_Do but reopened in a section where the category prop
    // differs, so the editor queried We_Do). Scan every bucket by exerciseId +
    // questionId so retest pre-fill is bucket-agnostic — this is what made the
    // code-editor pre-fill miss while MCQ (URL-derived category) worked.
    if (!questionAnswer && typeof course.answers.forEach === 'function') {
      course.answers.forEach((catMap) => {
        if (questionAnswer || !catMap) return;
        const arrays = typeof catMap.values === 'function'
          ? Array.from(catMap.values())
          : Object.values(catMap || {});
        for (const arr of arrays) {
          const found = findQ(arr);
          if (found) { questionAnswer = found; break; }
        }
      });
    }

    if (questionAnswer) {
      return res.status(200).json({
        success: true,
        data: questionAnswer.codeAnswer,
        language: questionAnswer.language,
        status: questionAnswer.status,
        score: questionAnswer.score,
        attempts: questionAnswer.attempts || 0
      });
    }
    return res.status(200).json({ success: true, data: null });

  } catch (error) {
    console.error("Error in getAnswerByQuestionId:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};


exports.submitMultipleFiles = async (req, res) => {
  try {
    const userId = req.user._id;
    const {
      courseId,
      exerciseId,
      questionId,
      category,
      subcategory,
      selectedProgrammingLanguage,
      nodeId = "",
      nodeName = "",
      nodeType = "",
      screenRecord,
      // Files array with folder paths
      files = [],
      // Folder hierarchy
      folders = [],
      folderHierarchy = [],
      projectStructure = {},
      entryPoints = [],
      hasFolders = false,
      folderCount = 0,
      totalFiles = 0,
      status: clientStatus = "submitted",
      totalScore = 0,
      score: clientScore = 0,
      feedback = "",
      language = "multi-file",
      isMultiFile = true,
      isTestSubmission,
      submitType,        // 'USER' (manual) | 'AUTO' (system auto-submit on violation/timeout)
      autoSubmitReason,  // human-readable reason when submitType === 'AUTO'
      // Per-question breakdown (Test Case / AI). Sent as an object here (JSON
      // payload, not multipart), so no JSON.parse needed — sanitise only.
      evaluationBreakdown: rawEvaluationBreakdown,
    } = req.body;

    // Sanitise breakdown the same way submitAnswer does, so the multi-file
    // submit path never persists an invalid method / criterion key.
    const ALLOWED_METHOD_MF = new Set(['manual', 'testcase', 'ai']);
    const ALLOWED_CRIT_MF = new Set(['correctness','codeQuality','efficiency','readability','edgeCases','bestPractices']);
    const sanitizeBreakdown = (b) => {
      if (!b || typeof b !== 'object') return null;
      if (!ALLOWED_METHOD_MF.has(b.method)) return null;
      const out = { method: b.method };
      if (b.method === 'testcase' && b.testcase && typeof b.testcase === 'object') {
        // Same per-case cap as the other sanitizeBreakdown copies in this file.
        const tcCases = Array.isArray(b.testcase.cases) ? b.testcase.cases : [];
        out.testcase = {
          passed: Number(b.testcase.passed) || 0,
          total: Number(b.testcase.total) || 0,
          cases: tcCases.slice(0, 50).map((t, i) => ({
            index: Number(t?.index) === Number(t?.index) ? Number(t.index) : i,
            passed: !!t?.passed,
            hidden: !!t?.hidden,
            input: typeof t?.input === 'string' ? t.input.slice(0, 2000) : '',
            expectedOutput: typeof t?.expectedOutput === 'string' ? t.expectedOutput.slice(0, 2000) : '',
            actualOutput: typeof t?.actualOutput === 'string' ? t.actualOutput.slice(0, 2000) : '',
          })),
        };
      }
      if (b.method === 'ai' && b.ai && typeof b.ai === 'object') {
        const crit = Array.isArray(b.ai.criteria) ? b.ai.criteria : [];
        const tc = Array.isArray(b.ai.testCases) ? b.ai.testCases : [];
        out.ai = {
          perCriterionMax: Number(b.ai.perCriterionMax) || 0,
          criteria: crit.filter(c => c && ALLOWED_CRIT_MF.has(c.key)).map(c => ({
            key: c.key,
            percentage: Math.max(0, Math.min(100, Number(c.percentage) || 0)),
            score: Math.max(0, Number(c.score) || 0),
            comment: typeof c.comment === 'string' ? c.comment.slice(0, 500) : '',
          })),
          testCases: tc.slice(0, 50).map((t, i) => ({
            index: Number(t?.index) === Number(t?.index) ? Number(t.index) : i,
            source: t?.source === 'ai' ? 'ai' : 'question',
            input: typeof t?.input === 'string' ? t.input.slice(0, 2000) : '',
            expectedOutput: typeof t?.expectedOutput === 'string' ? t.expectedOutput.slice(0, 2000) : '',
            passed: !!t?.passed,
            comment: typeof t?.comment === 'string' ? t.comment.slice(0, 500) : '',
          })),
          passedTestCases: Math.max(0, Number(b.ai.passedTestCases) || 0),
          totalTestCases: Math.max(0, Number(b.ai.totalTestCases) || 0),
          criteriaPortion: Math.max(0, Number(b.ai.criteriaPortion) || 0),
          testCasePortion: Math.max(0, Number(b.ai.testCasePortion) || 0),
          model: typeof b.ai.model === 'string' ? b.ai.model.slice(0, 100) : '',
          failed: !!b.ai.failed,
        };
      }
      return out;
    };
    let evaluationBreakdown = sanitizeBreakdown(rawEvaluationBreakdown);
    let score = clientScore;
    let status = clientStatus;

    // ─── Server-authoritative judge (Phase 1 P0, multi-file path) ────────
    // Multi-file editor's client-side testcase loop is now gone; we re-run
    // the project here against the trainer's authoritative testCases so
    // students can't POST a fabricated score. See submitAnswer above for
    // the single-file mirror of this block.
    if (Array.isArray(files) && files.length > 0 && selectedProgrammingLanguage) {
      try {
        const q = await loadForJudge({
          nodeType, nodeId, category, subcategory, exerciseId, questionId,
        });
        if (q && Array.isArray(q.testCases) && q.testCases.length > 0) {
          const judgeFiles = files.map((f) => ({
            path: f.path || `/${f.filename}`,
            content: f.content || '',
            isEntryPoint: !!f.isEntryPoint,
          }));
          const judged = await judgeCode({
            language: selectedProgrammingLanguage,
            files: judgeFiles,
            testCases: q.testCases,
            functionName: q.functionName,
            maxMarks: q.maxMarks,
          });
          score = judged.score;
          status = judged.status;
          evaluationBreakdown = {
            method: 'testcase',
            testcase: {
              passed: judged.passed,
              total: judged.total,
              cases: judged.perCase.map((c) => ({
                index: c.index,
                passed: c.passed,
                hidden: c.hidden,
                input: c.hidden ? '' : c.input,
                expectedOutput: c.hidden ? '' : c.expectedOutput,
                actualOutput: c.actualOutput,
              })),
            },
          };
        } else if (!q) {
          console.warn(
            `[judge:mf] could not resolve question ${questionId} — keeping client score`,
          );
        }
      } catch (e) {
        console.error('[judge:mf] server-side judge error, keeping client score:', e?.message || e);
      }
    }

    const isTestSubmit = isTestSubmission === 'true' || isTestSubmission === true;

    // Normalize submit type + reason (only meaningful on a full test submission).
    const finalSubmitType = submitType === 'AUTO' ? 'AUTO' : 'USER';
    const finalAutoSubmitReason = finalSubmitType === 'AUTO'
      ? String(autoSubmitReason || '').slice(0, 300)
      : '';

    // Validate required fields
    if (!courseId || !exerciseId || !questionId) {
      return res.status(400).json({
        success: false,
        message: "courseId, exerciseId, and questionId are required"
      });
    }

    // Validate category
    const validCategories = ['I_Do', 'We_Do', 'You_Do'];
    if (!validCategories.includes(category)) {
      return res.status(400).json({
        success: false,
        message: "Category must be one of: I_Do, We_Do, You_Do"
      });
    }

    // Validate files array
    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one file is required"
      });
    }
 
    // Validate each file
    for (const file of files) {
      if (!file.filename || !file.content || !file.language) {
        return res.status(400).json({
          success: false,
          message: "Each file must have filename, content, and language properties"
        });
      }
     
      // Validate file extension matches language
      const ext = file.filename.split('.').pop().toLowerCase();
      const langExtMap = {
        'html': ['html', 'htm'],
        'css': ['css'],
        'javascript': ['js', 'javascript'],
        'json': ['json'],
        'text': ['txt', 'md'],
        'markdown': ['md', 'markdown'],
        'xml': ['xml'],
        'sql': ['sql']
      };
     
      if (langExtMap[file.language] && !langExtMap[file.language].includes(ext)) {
        return res.status(400).json({
          success: false,
          message: `File ${file.filename} extension does not match language ${file.language}`
        });
      }
    }
 
    // Find user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    // We Do / You Do duration tracking (start = first save, end = test submit)
    if (category === 'We_Do' || category === 'You_Do') {
      trackAssignmentDuration({ user, courseId, exerciseId, exerciseName: req.body.exerciseName, subcategory, method: category, nodeId: req.body.nodeId, nodeName: req.body.nodeName, nodeType: req.body.nodeType, isTestSubmit });
    }

    // Generate unique IDs for files and folders if not provided
    const processedFiles = files.map(file => ({
      id: file.id || `file-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      filename: file.filename,
      content: file.content,
      language: file.language,
      path: file.path || `/${file.filename}`,
      folderPath: file.folderPath || '/',
      size: Buffer.byteLength(file.content, 'utf8'),
      isEntryPoint: file.isEntryPoint,
      lastModified: file.lastModified || new Date()
    }));
 
    const processedFolders = folders.map(folder => ({
      id: folder.id || `folder-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      name: folder.name,
      path: folder.path,
      parentPath: folder.parentPath || '/',
      depth: folder.depth || 0,
      fileCount: folder.children?.length || 0,
      subfolderCount: folder.folderChildren?.length || 0
    }));
 
    // Prepare question answer with folder structure
    const questionAnswer = {
      questionId: new mongoose.Types.ObjectId(questionId),
      questionTitle: req.body.questionTitle || `Question ${questionId}`,
      files: processedFiles,
      folders: processedFolders,
      projectStructure: {
        ...projectStructure,
        folders: folderHierarchy.length > 0 ? folderHierarchy.map(f => ({
          id: f.id || `folder-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          name: f.name,
          path: f.path,
          parentPath: f.parentPath || '/',
          depth: f.depth || 0,
          fileCount: f.fileCount || 0,
          subfolderCount: f.subfolderCount || 0
        })) : processedFolders,
        folderTree: buildFolderTreeForDB(processedFolders, processedFiles),
        hasFolders: hasFolders || processedFolders.length > 0,
        totalFolders: folderCount || processedFolders.length,
        totalFiles: totalFiles || processedFiles.length,
        entryPoints: entryPoints,
        fileDistribution: {
          html: processedFiles.filter(f => f.language === 'html').length,
          css: processedFiles.filter(f => f.language === 'css').length,
          javascript: processedFiles.filter(f => f.language === 'javascript').length,
          other: processedFiles.filter(f => !['html', 'css', 'javascript', 'sql'].includes(f.language)).length,
          sql: processedFiles.filter(f => f.language === 'sql').length
        }
      },
   
      codeAnswer: `Multi-file project with ${processedFiles.length} files${processedFolders.length > 0 ? ` in ${processedFolders.length} folders` : ''}`,
      language: 'multi-file',
      totalScore: totalScore,
      score: score,
      feedback: feedback,
      status: status,
      isCorrect: status === 'solved' || status === 'evaluated' || score >= 70,
      attempts: 1,
      submittedAt: new Date(),
      fileStructure: {
        totalFiles: processedFiles.length,
        htmlFiles: processedFiles.filter(f => f.language === 'html').length,
        cssFiles: processedFiles.filter(f => f.language === 'css').length,
        jsFiles: processedFiles.filter(f => f.language === 'javascript').length,
        sqlFiles: processedFiles.filter(f => f.language === 'sql').length,
        otherFiles: processedFiles.filter(f => !['html', 'css', 'javascript', 'sql'].includes(f.language)).length,
        folders: processedFolders.length,
        folderStructure: processedFolders.map(f => ({
          name: f.name,
          path: f.path,
          fileCount: f.fileCount
        }))
      },
      // Only include when the client actually produced a breakdown, so Manual
      // submissions don't stamp an empty object onto the answer.
      ...(evaluationBreakdown ? { evaluationBreakdown } : {}),
    };
 
    // Helper function to build folder tree for DB storage
    function buildFolderTreeForDB(foldersList, filesList) {
      const tree = {};
     
      // Create folder nodes
      foldersList.forEach(folder => {
        tree[folder.path] = {
          id: folder.id,
          name: folder.name,
          path: folder.path,
          parentPath: folder.parentPath || '/',
          depth: folder.depth || 0,
          children: [],
          files: filesList
            .filter(f => f.folderPath === folder.path)
            .map(f => ({
              id: f.id,
              filename: f.filename,
              language: f.language,
              size: f.size
            }))
        };
      });
     
      // Build hierarchy
      foldersList.forEach(folder => {
        if (folder.parentPath !== '/' && tree[folder.parentPath]) {
          tree[folder.parentPath].children.push(tree[folder.path]);
        }
      });
     
      // Return root folders
      return foldersList
        .filter(folder => folder.parentPath === '/')
        .map(folder => tree[folder.path]);
    }
 
    // Find or create course entry
    let courseIndex = user.courses.findIndex(c =>
      c.courseId && c.courseId.toString() === courseId
    );
 
    if (courseIndex === -1) {
      user.courses.push({
        courseId: new mongoose.Types.ObjectId(courseId),
        answers: {
          I_Do: new Map(),
          We_Do: new Map(),
          You_Do: new Map()
        },
        lastAccessed: new Date()
      });
      courseIndex = user.courses.length - 1;
    }
 
    // Ensure answers structure exists
    if (!user.courses[courseIndex].answers) {
      user.courses[courseIndex].answers = {
        I_Do: new Map(),
        We_Do: new Map(),
        You_Do: new Map()
      };
    }
 
    // Initialize category
    if (!user.courses[courseIndex].answers[category]) {
      user.courses[courseIndex].answers[category] = new Map();
    }
 
    // Determine exercise key
    let exerciseKey;
    if (category === 'We_Do' || category === 'You_Do') {
      exerciseKey = subcategory || exerciseId.toString();
    } else {
      exerciseKey = exerciseId.toString();
    }
 
    // Get or create exercise array
    let exerciseArray = user.courses[courseIndex].answers[category].get(exerciseKey);
    if (!exerciseArray) {
      exerciseArray = [];
    }
 
    // Find or create exercise
    let exerciseIndex = exerciseArray.findIndex(
      ex => ex.exerciseId && ex.exerciseId.toString() === exerciseId
    );
 
    // ── Late submission detection (server-authoritative) ──
    const isLate = isTestSubmit
      ? await isLateSubmissionForExercise({ nodeId, nodeType, category, subcategory, exerciseId })
      : false;

    if (exerciseIndex === -1) {
      exerciseArray.push({
        exerciseId: new mongoose.Types.ObjectId(exerciseId),
        exerciseName: req.body.exerciseName || `Exercise ${exerciseId}`,
        questions: [questionAnswer],
        nodeId,
        nodeName,
        nodeType,
        selectedProgrammingLanguage,
        subcategory: (category === 'We_Do' || category === 'You_Do') ? subcategory : undefined,
        screenRecording: screenRecord,
        status: isTestSubmit ? 'completed' : 'in-progress',
        projectType: 'multi-file',
        hasFolderStructure: processedFolders.length > 0,
        folderCount: processedFolders.length,
        userAttempts: isTestSubmit ? 1 : 0,
        testSubmissions: isTestSubmit ? 1 : 0,
        lastTestSubmittedAt: isTestSubmit ? new Date() : null,
        lateSubmission: isTestSubmit ? isLate : false,
        submitType: isTestSubmit ? finalSubmitType : 'USER',
        autoSubmitReason: isTestSubmit ? finalAutoSubmitReason : '',
      });
    } else {
      // Update existing exercise
      const existingExercise = exerciseArray[exerciseIndex];

      // Find existing question
      const questionIndex = existingExercise.questions.findIndex(
        q => q.questionId && q.questionId.toString() === questionId
      );

      if (questionIndex === -1) {
        existingExercise.questions.push(questionAnswer);
      } else {
        existingExercise.questions[questionIndex] = {
          ...existingExercise.questions[questionIndex],
          ...questionAnswer,
          attempts: (existingExercise.questions[questionIndex].attempts || 0) + 1,
          updatedAt: new Date()
        };
      }

      // Update exercise metadata
      existingExercise.updatedAt = new Date();
      existingExercise.projectType = 'multi-file';
      existingExercise.hasFolderStructure = processedFolders.length > 0;
      existingExercise.folderCount = processedFolders.length;

      // ── Increment on full test submission (with 10-second double-click guard) ──
      if (isTestSubmit) {
        const now = Date.now();
        const lastAt = existingExercise.lastTestSubmittedAt
          ? new Date(existingExercise.lastTestSubmittedAt).getTime()
          : 0;
        if (now - lastAt > 10000) {
          existingExercise.userAttempts = (existingExercise.userAttempts || 0) + 1;
          existingExercise.testSubmissions = (existingExercise.testSubmissions || 0) + 1;
          existingExercise.lastTestSubmittedAt = new Date();
          existingExercise.lateSubmission = isLate;
          existingExercise.submitType = finalSubmitType;
          existingExercise.autoSubmitReason = finalAutoSubmitReason;
        }
        existingExercise.status = 'completed';
      } else {
        existingExercise.status = status === 'completed' ? 'completed' : existingExercise.status;
      }
    }
 
    // Save back to map
    user.courses[courseIndex].answers[category].set(exerciseKey, exerciseArray);
 
    // Mark modified
    user.markModified(`courses.${courseIndex}.answers.${category}`);
   
    await user.save();
 
    res.status(200).json({
      success: true,
      message: `Multi-file project submitted successfully${processedFolders.length > 0 ? ` with ${processedFolders.length} folders` : ''}`,
      data: {
        courseId,
        exerciseId,
        questionId,
        category,
        fileCount: processedFiles.length,
        folderCount: processedFolders.length,
        fileStructure: questionAnswer.fileStructure,
        submittedFiles: processedFiles.map(f => ({
          id: f.id,
          filename: f.filename,
          language: f.language,
          folderPath: f.folderPath,
          size: f.size,
          isEntryPoint: f.isEntryPoint
        })),
        folders: processedFolders.map(f => ({
          id: f.id,
          name: f.name,
          path: f.path,
          parentPath: f.parentPath,
          fileCount: f.fileCount
        })),
        entryPoints: questionAnswer.entryPoints,
        projectStructure: questionAnswer.projectStructure,
        // Echo the server-authored score and per-case breakdown back so the
        // client can paint "✓ Test #1 passed / ✗ Test #2 failed" in the
        // terminal without re-running anything. Hidden-case fields were
        // already blanked when the breakdown was assembled.
        score,
        status,
        evaluationBreakdown,
      }
    });

  } catch (error) {
    console.error("Submit multi-files error:", error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};
 exports.getPreviousSubmission = async (req, res) => {
  try {
    const userId = req.user._id;
    const { courseId, exerciseId, questionId, category } = req.query;

    // Validate required parameters
    if (!courseId || !exerciseId || !questionId || !category) {
      return res.status(400).json({
        success: false,
        message: "Missing required parameters: courseId, exerciseId, questionId, category"
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: "User not found" 
      });
    }

    const course = user.courses.find(c => c.courseId.toString() === courseId);
    if (!course) {
      return res.status(404).json({ 
        success: false, 
        message: "Course not found" 
      });
    }

    let foundQuestion = null;
    let foundExercise = null;

    // Search through the category
    if (course.answers && course.answers[category]) {
      // Handle both Map and array formats
      let exercisesArray = [];
      
      if (course.answers[category] instanceof Map) {
        // Convert Map values to array
        exercisesArray = Array.from(course.answers[category].values()).flat();
      } else if (Array.isArray(course.answers[category])) {
        exercisesArray = course.answers[category];
      }

      // Find the exercise
      for (const exercise of exercisesArray) {
        if (exercise && exercise.exerciseId && exercise.exerciseId.toString() === exerciseId) {
          foundExercise = exercise;
          
          // Find the question
          if (exercise.questions && Array.isArray(exercise.questions)) {
            const question = exercise.questions.find(q =>
              q.questionId && q.questionId.toString() === questionId
            );
            
            if (question) {
              foundQuestion = question;
              break;
            }
          }
        }
      }
    }

    if (!foundQuestion) {
      return res.status(404).json({
        success: false,
        message: "No previous submission found for this question"
      });
    }

    // Prepare response with files and folders
    const responseData = {
      success: true,
      data: {
        // Files data
        files: foundQuestion.files || [],
        
        // Folders data
        folders: foundQuestion.folders || [],
        
        // Project structure
        projectStructure: foundQuestion.projectStructure || {},
        
        // Individual code snippets (for backward compatibility)
        htmlCode: foundQuestion.files?.find(f => f.language === 'html' && f.isEntryPoint)?.content ||
                 foundQuestion.files?.find(f => f.language === 'html')?.content || "",
        cssCode: foundQuestion.files?.find(f => f.language === 'css')?.content || "",
        jsCode: foundQuestion.files?.find(f => f.language === 'javascript')?.content || "",
        sqlCode: foundQuestion.files?.find(f => f.language === 'sql')?.content || "",

        // MCQ / single-file / Others answer data (for retest pre-fill)
        codeAnswer: foundQuestion.codeAnswer || "",
        isCorrect: typeof foundQuestion.isCorrect === 'boolean' ? foundQuestion.isCorrect : null,
        language: foundQuestion.language || "",
        othersFiles: foundQuestion.othersFiles || [],
        nodeType: foundQuestion.nodeType || "",

        // Metadata
        score: foundQuestion.score || 0,
        status: foundQuestion.status || 'submitted',
        submittedAt: foundQuestion.submittedAt || foundQuestion.createdAt,
        attempts: foundQuestion.attempts || 1,
        
        // Entry points
        entryPoints: foundQuestion.entryPoints || foundQuestion.files?.filter(f => f.isEntryPoint)?.map(f => ({
          filename: f.filename,
          path: f.path,
          language: f.language
        })) || [],
        
        // File statistics
        fileCount: foundQuestion.files?.length || 0,
        folderCount: foundQuestion.folders?.length || 0
      }
    };

    // Log for debugging
    console.log("Previous submission found:", {
      courseId,
      exerciseId,
      questionId,
      category,
      fileCount: responseData.data.fileCount,
      folderCount: responseData.data.folderCount,
      hasFiles: !!foundQuestion.files,
      hasFolders: !!foundQuestion.folders
    });

    res.status(200).json(responseData);

  } catch (error) {
    console.error("Get previous submission error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Internal server error"
    });
  }
};



// exports.submitMultipleFiles = async (req, res) => {
//   try {
//     const userId = req.user._id;
//     const {
//       courseId,
//       exerciseId,
//       questionId,
//       category,
//       subcategory,
//       selectedProgrammingLanguage,
//       nodeId = "",
//       nodeName = "",
//       nodeType = "",
//       screenRecord,
//       // Files array with folder paths
//       files = [],
//       // Folder hierarchy
//       folders = [],
//       folderHierarchy = [],
//       projectStructure = {},
//       entryPoints = [],
//       hasFolders = false,
//       folderCount = 0,
//       totalFiles = 0,
//       status = "submitted",
//       totalScore = 0,
//       score = 0,
//       feedback = "",
//       language = "multi-file",
//       isMultiFile = true
//     } = req.body;

//     // Validate required fields
//     if (!courseId || !exerciseId || !questionId) {
//       return res.status(400).json({
//         success: false,
//         message: "courseId, exerciseId, and questionId are required"
//       });
//     }

//     // Validate category
//     const validCategories = ['I_Do', 'We_Do', 'You_Do'];
//     if (!validCategories.includes(category)) {
//       return res.status(400).json({
//         success: false,
//         message: "Category must be one of: I_Do, We_Do, You_Do"
//       });
//     }

//     // Validate files array
//     if (!files || !Array.isArray(files) || files.length === 0) {
//       return res.status(400).json({
//         success: false,
//         message: "At least one file is required"
//       });
//     }

//     // Validate each file
//     for (const file of files) {
//       if (!file.filename || !file.content || !file.language) {
//         return res.status(400).json({
//           success: false,
//           message: "Each file must have filename, content, and language properties"
//         });
//       }
      
//       // Validate file extension matches language
//       const ext = file.filename.split('.').pop().toLowerCase();
//       const langExtMap = {
//         'html': ['html', 'htm'],
//         'css': ['css'],
//         'javascript': ['js', 'javascript'],
//         'json': ['json'],
//         'text': ['txt', 'md'],
//         'markdown': ['md', 'markdown'],
//         'xml': ['xml'],
//         'sql': ['sql']
//       };
      
//       if (langExtMap[file.language] && !langExtMap[file.language].includes(ext)) {
//         return res.status(400).json({
//           success: false,
//           message: `File ${file.filename} extension does not match language ${file.language}`
//         });
//       }
//     }

//     // Find user
//     const user = await User.findById(userId);
//     if (!user) {
//       return res.status(404).json({
//         success: false,
//         message: "User not found"
//       });
//     }

//     // Generate unique IDs for files and folders if not provided
//     const processedFiles = files.map(file => ({
//       id: file.id || `file-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
//       filename: file.filename,
//       content: file.content,
//       language: file.language,
//       path: file.path || `/${file.filename}`,
//       folderPath: file.folderPath || '/',
//       size: Buffer.byteLength(file.content, 'utf8'),
//       isEntryPoint: file.isEntryPoint,
//       lastModified: file.lastModified || new Date()
//     }));

//     const processedFolders = folders.map(folder => ({
//       id: folder.id || `folder-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
//       name: folder.name,
//       path: folder.path,
//       parentPath: folder.parentPath || '/',
//       depth: folder.depth || 0,
//       fileCount: folder.children?.length || 0,
//       subfolderCount: folder.folderChildren?.length || 0
//     }));

//     // Prepare question answer with folder structure
//     const questionAnswer = {
//       questionId: new mongoose.Types.ObjectId(questionId),
//       questionTitle: req.body.questionTitle || `Question ${questionId}`,
//       files: processedFiles,
//       folders: processedFolders,
//       projectStructure: {
//         ...projectStructure,
//         folders: folderHierarchy.length > 0 ? folderHierarchy.map(f => ({
//           id: f.id || `folder-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
//           name: f.name,
//           path: f.path,
//           parentPath: f.parentPath || '/',
//           depth: f.depth || 0,
//           fileCount: f.fileCount || 0,
//           subfolderCount: f.subfolderCount || 0
//         })) : processedFolders,
//         folderTree: buildFolderTreeForDB(processedFolders, processedFiles),
//         hasFolders: hasFolders || processedFolders.length > 0,
//         totalFolders: folderCount || processedFolders.length,
//         totalFiles: totalFiles || processedFiles.length,
//         entryPoints: entryPoints,
//         fileDistribution: {
//           html: processedFiles.filter(f => f.language === 'html').length,
//           css: processedFiles.filter(f => f.language === 'css').length,
//           javascript: processedFiles.filter(f => f.language === 'javascript').length,
//           other: processedFiles.filter(f => !['html', 'css', 'javascript', 'sql'].includes(f.language)).length,
//           sql: processedFiles.filter(f => f.language === 'sql').length
//         }
//       },
    
//       codeAnswer: `Multi-file project with ${processedFiles.length} files${processedFolders.length > 0 ? ` in ${processedFolders.length} folders` : ''}`,
//       language: 'multi-file',
//       totalScore: totalScore,
//       score: score,
//       feedback: feedback,
//       status: status,
//       isCorrect: status === 'solved' || status === 'evaluated' || score >= 70,
//       attempts: 1,
//       submittedAt: new Date(),
//       fileStructure: {
//         totalFiles: processedFiles.length,
//         htmlFiles: processedFiles.filter(f => f.language === 'html').length,
//         cssFiles: processedFiles.filter(f => f.language === 'css').length,
//         jsFiles: processedFiles.filter(f => f.language === 'javascript').length,
//         sqlFiles: processedFiles.filter(f => f.language === 'sql').length,
//         otherFiles: processedFiles.filter(f => !['html', 'css', 'javascript', 'sql'].includes(f.language)).length,
//         folders: processedFolders.length,
//         folderStructure: processedFolders.map(f => ({
//           name: f.name,
//           path: f.path,
//           fileCount: f.fileCount
//         }))
//       }
//     };

//     // Helper function to build folder tree for DB storage
//     function buildFolderTreeForDB(foldersList, filesList) {
//       const tree = {};
      
//       // Create folder nodes
//       foldersList.forEach(folder => {
//         tree[folder.path] = {
//           id: folder.id,
//           name: folder.name,
//           path: folder.path,
//           parentPath: folder.parentPath || '/',
//           depth: folder.depth || 0,
//           children: [],
//           files: filesList
//             .filter(f => f.folderPath === folder.path)
//             .map(f => ({
//               id: f.id,
//               filename: f.filename,
//               language: f.language,
//               size: f.size
//             }))
//         };
//       });
      
//       // Build hierarchy
//       foldersList.forEach(folder => {
//         if (folder.parentPath !== '/' && tree[folder.parentPath]) {
//           tree[folder.parentPath].children.push(tree[folder.path]);
//         }
//       });
      
//       // Return root folders
//       return foldersList
//         .filter(folder => folder.parentPath === '/')
//         .map(folder => tree[folder.path]);
//     }

//     // Find or create course entry
//     let courseIndex = user.courses.findIndex(c => 
//       c.courseId && c.courseId.toString() === courseId
//     );

//     if (courseIndex === -1) {
//       user.courses.push({
//         courseId: new mongoose.Types.ObjectId(courseId),
//         answers: {
//           I_Do: new Map(),
//           We_Do: new Map(),
//           You_Do: new Map()
//         },
//         lastAccessed: new Date()
//       });
//       courseIndex = user.courses.length - 1;
//     }

//     // Ensure answers structure exists
//     if (!user.courses[courseIndex].answers) {
//       user.courses[courseIndex].answers = {
//         I_Do: new Map(),
//         We_Do: new Map(),
//         You_Do: new Map()
//       };
//     }

//     // Initialize category
//     if (!user.courses[courseIndex].answers[category]) {
//       user.courses[courseIndex].answers[category] = new Map();
//     }

//     // Determine exercise key
//     let exerciseKey;
//     if (category === 'We_Do' || category === 'You_Do') {
//       exerciseKey = subcategory || exerciseId.toString();
//     } else {
//       exerciseKey = exerciseId.toString();
//     }

//     // Get or create exercise array
//     let exerciseArray = user.courses[courseIndex].answers[category].get(exerciseKey);
//     if (!exerciseArray) {
//       exerciseArray = [];
//     }

//     // Find or create exercise
//     let exerciseIndex = exerciseArray.findIndex(
//       ex => ex.exerciseId && ex.exerciseId.toString() === exerciseId
//     );

//     if (exerciseIndex === -1) {
//       exerciseArray.push({
//         exerciseId: new mongoose.Types.ObjectId(exerciseId),
//         exerciseName: req.body.exerciseName || `Exercise ${exerciseId}`,
//         questions: [questionAnswer],
//         nodeId,
//         nodeName,
//         nodeType,
//         selectedProgrammingLanguage,
//         subcategory: (category === 'We_Do' || category === 'You_Do') ? subcategory : undefined,
//         screenRecording: screenRecord,
//         status: 'in-progress',
//         projectType: 'multi-file',
//         hasFolderStructure: processedFolders.length > 0,
//         folderCount: processedFolders.length
//       });
//     } else {
//       // Update existing exercise
//       const existingExercise = exerciseArray[exerciseIndex];
      
//       // Find existing question
//       const questionIndex = existingExercise.questions.findIndex(
//         q => q.questionId && q.questionId.toString() === questionId
//       );

//       if (questionIndex === -1) {
//         existingExercise.questions.push(questionAnswer);
//       } else {
//         existingExercise.questions[questionIndex] = {
//           ...existingExercise.questions[questionIndex],
//           ...questionAnswer,
//           attempts: (existingExercise.questions[questionIndex].attempts || 0) + 1,
//           updatedAt: new Date()
//         };
//       }

//       // Update exercise metadata
//       existingExercise.updatedAt = new Date();
//       existingExercise.projectType = 'multi-file';
//       existingExercise.hasFolderStructure = processedFolders.length > 0;
//       existingExercise.folderCount = processedFolders.length;
//       existingExercise.status = status === 'completed' ? 'completed' : existingExercise.status;
//     }

//     // Save back to map
//     user.courses[courseIndex].answers[category].set(exerciseKey, exerciseArray);

//     // Mark modified
//     user.markModified(`courses.${courseIndex}.answers.${category}`);
    
//     await user.save();

//     res.status(200).json({
//       success: true,
//       message: `Multi-file project submitted successfully${processedFolders.length > 0 ? ` with ${processedFolders.length} folders` : ''}`,
//       data: {
//         courseId,
//         exerciseId,
//         questionId,
//         category,
//         fileCount: processedFiles.length,
//         folderCount: processedFolders.length,
//         fileStructure: questionAnswer.fileStructure,
//         submittedFiles: processedFiles.map(f => ({
//           id: f.id,
//           filename: f.filename,
//           language: f.language,
//           folderPath: f.folderPath,
//           size: f.size,
//           isEntryPoint: f.isEntryPoint
//         })),
//         folders: processedFolders.map(f => ({
//           id: f.id,
//           name: f.name,
//           path: f.path,
//           parentPath: f.parentPath,
//           fileCount: f.fileCount
//         })),
//         entryPoints: questionAnswer.entryPoints,
//         projectStructure: questionAnswer.projectStructure
//       }
//     });

//   } catch (error) {
//     console.error("Submit multi-files error:", error);
//     res.status(500).json({
//       success: false,
//       message: error.message
//     });
//   }
// };

// exports.getPreviousSubmission = async (req, res) => {
//   try {
//     const userId = req.user._id;
//     const { courseId, exerciseId, questionId, category } = req.query;

//     // Validate
//     if (!courseId || !exerciseId || !questionId || !category) {
//       return res.status(400).json({
//         success: false,
//         message: "Missing required parameters"
//       });
//     }

//     const user = await User.findById(userId);
//     if (!user) {
//       return res.status(404).json({ success: false, message: "User not found" });
//     }

//     const course = user.courses.find(c => c.courseId.toString() === courseId);
//     if (!course) {
//       return res.status(404).json({ success: false, message: "Course not found" });
//     }

//     let foundQuestion = null;
//     let foundExercise = null;

//     // Search through the category
//     const categoryMap = course.answers[category];
//     if (categoryMap) {
//       for (const [key, exercises] of categoryMap) {
//         for (const exercise of exercises) {
//           if (exercise.exerciseId.toString() === exerciseId) {
//             foundExercise = exercise;
//             const question = exercise.questions.find(q => 
//               q.questionId && q.questionId.toString() === questionId
//             );
//             if (question) {
//               foundQuestion = question;
//               break;
//             }
//           }
//         }
//         if (foundQuestion) break;
//       }
//     }

//     if (!foundQuestion) {
//       return res.status(404).json({
//         success: false,
//         message: "No previous submission found"
//       });
//     }

//     // Return data in the format expected by frontend
//     res.status(200).json({
//       success: true,
//       data: {
//         htmlCode: foundQuestion.files?.find(f => f.language === 'html' && f.isEntryPoint)?.content || 
//                 foundQuestion.files?.find(f => f.language === 'html')?.content || "",
//         cssCode: foundQuestion.files?.find(f => f.language === 'css')?.content || "",
//         jsCode: foundQuestion.files?.find(f => f.language === 'javascript')?.content || "",
//         sqlCode: foundQuestion.files?.find(f => f.language === 'sql')?.content || "",
//         files: foundQuestion.files || [],
//         folders: foundQuestion.folders || [],
//         projectStructure: foundQuestion.projectStructure || {},
//         score: foundQuestion.score,
//         status: foundQuestion.status,
//         submittedAt: foundQuestion.submittedAt,
//         attempts: foundQuestion.attempts,
//         entryPoints: foundQuestion.entryPoints || []
//       }
//     });

//   } catch (error) {
//     console.error("Get previous submission error:", error);
//     res.status(500).json({
//       success: false,
//       message: error.message
//     });
//   }
// };

// ── Persist AI-generated test cases on the question doc ──────────────────────
// Called fire-and-forget by the first student's Submit when the exercise's
// evaluationMethod is 'ai' and no cached cases exist on the question yet.
// Every subsequent student reuses these cached cases (same 20 for every
// student). If the cache was populated in the meantime by a concurrent request,
// this call is idempotent — we DO NOT overwrite existing cases, ever.
exports.persistAiTestCases = async (req, res) => {
  try {
    const {
      exerciseId, questionId, nodeId, nodeType, category, subcategory,
      testCases, model,
    } = req.body;

    if (!exerciseId || !questionId || !nodeId || !nodeType || !category || !subcategory) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }
    if (!Array.isArray(testCases) || testCases.length === 0) {
      return res.status(400).json({ success: false, message: 'testCases must be a non-empty array' });
    }

    // Sanitise + cap the incoming test cases so a malicious client can't stuff
    // huge payloads onto the question doc.
    const MAX_CASES = 50;
    const MAX_FIELD_CHARS = 4000;
    const clean = testCases.slice(0, MAX_CASES).map(tc => ({
      input: (tc?.input ?? '').toString().slice(0, MAX_FIELD_CHARS),
      expectedOutput: (tc?.expectedOutput ?? '').toString().slice(0, MAX_FIELD_CHARS),
    })).filter(tc => tc.input.length > 0 || tc.expectedOutput.length > 0);
    if (clean.length === 0) {
      return res.status(400).json({ success: false, message: 'testCases had no usable rows' });
    }

    // Resolve the entity model + load the node.
    const modelMap = {
      module: mongoose.model('Module1'),
      submodule: mongoose.model('SubModule1'),
      topic: mongoose.model('Topic1'),
      subtopic: mongoose.model('SubTopic1'),
    };
    const Model = modelMap[String(nodeType).toLowerCase()];
    if (!Model) {
      return res.status(400).json({ success: false, message: `Invalid nodeType: ${nodeType}` });
    }
    const entity = await Model.findById(nodeId);
    if (!entity) {
      return res.status(404).json({ success: false, message: 'Node not found' });
    }

    const located = locateExerciseContainer(entity, category, subcategory, exerciseId);
    if (!located) {
      return res.status(404).json({ success: false, message: 'Exercise not found in this node' });
    }
    const { exercise, basePath, index: exerciseIndex } = located;
    if (!exercise) {
      return res.status(404).json({ success: false, message: 'Exercise container empty' });
    }

    const question = (exercise.questions || []).find(q => q && String(q._id) === String(questionId));
    if (!question) {
      return res.status(404).json({ success: false, message: 'Question not found in exercise' });
    }

    // Idempotency — a concurrent first-student race could try to write twice.
    // Whoever gets there second is a no-op; the "same 20 for every student"
    // guarantee holds because the FIRST winning write is what everyone reads.
    if (Array.isArray(question.aiGeneratedTestCases) && question.aiGeneratedTestCases.length > 0) {
      return res.status(200).json({ success: true, alreadyCached: true, count: question.aiGeneratedTestCases.length });
    }

    question.aiGeneratedTestCases = clean;
    question.aiGeneratedTestCasesModel = typeof model === 'string' ? model.slice(0, 100) : '';
    question.aiGeneratedTestCasesAt = new Date();

    // Because the exercise lives inside a Map inside pedagogy/batchPedagogy,
    // Mongoose needs the exact path marked modified to persist a nested
    // subdoc mutation. `basePath` is the pedagogy root ('pedagogy' or
    // 'batchPedagogy.<id>'); the section+subcategory+index is unstable to
    // encode, so we mark the pedagogy root — small overwrite cost, correct.
    entity.markModified(basePath);
    await entity.save();

    return res.status(200).json({ success: true, count: clean.length });
  } catch (err) {
    console.error('persistAiTestCases error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ────────────────────────────────────────────────────────────────────────────
// RERUN — bulk re-score submissions against the CURRENT question test cases /
// AI prompt. The teacher's browser runs the actual code execution and AI
// evaluation (same client-side pipeline the student's Submit uses), builds a
// fresh `evaluationBreakdown` per student × question, and POSTs the batch here.
//
// This endpoint is a persistence-only path: it does NOT execute code and does
// NOT call the LLM. It just walks the User doc to each affected submission,
// pushes the OLD score onto `scoreHistory[]` for audit, and overwrites with
// the new values. On successful batch it can also clear the
// `lastEditedAfterSubmissionAt` flag on the affected questions (in the node
// tree) so the "Recently edited" filter shows them as back in sync.
//
// Request body:
//   {
//     courseId, exerciseId, category, subcategory,   // path
//     nodeId, nodeType,                              // for flag-clear lookup
//     updates: [
//       { userId, questionId, score, status, evaluationBreakdown, note? }
//     ],
//     clearFlagsForQuestionIds?: string[]            // question _ids to clear
//   }
// Response: { success, updated, failed:[{userId, questionId, reason}], flagsCleared }
exports.rerunSubmissions = async (req, res) => {
  try {
    const {
      courseId, exerciseId, category, subcategory,
      nodeId, nodeType,
      updates,
      clearFlagsForQuestionIds,
    } = req.body || {};

    if (!courseId || !exerciseId || !category) {
      return res.status(400).json({ success: false, message: 'courseId, exerciseId, category are required' });
    }
    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ success: false, message: 'updates must be a non-empty array' });
    }
    const validCategories = ['I_Do', 'We_Do', 'You_Do'];
    if (!validCategories.includes(category)) {
      return res.status(400).json({ success: false, message: 'category must be I_Do | We_Do | You_Do' });
    }

    // Reuse the same sanitiser semantics submitAnswer uses, so a rerun-produced
    // breakdown lands with the same shape any first-submit breakdown does.
    const ALLOWED_METHOD = new Set(['manual', 'testcase', 'ai']);
    const ALLOWED_CRIT = new Set(['correctness','codeQuality','efficiency','readability','edgeCases','bestPractices']);
    const sanitizeBreakdown = (raw) => {
      const b = (typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw);
      if (!b || typeof b !== 'object') return null;
      if (!ALLOWED_METHOD.has(b.method)) return null;
      const out = { method: b.method };
      if (b.method === 'testcase' && b.testcase && typeof b.testcase === 'object') {
        // Per-case rows (which case failed + input/expected/got) — capped at
        // 50 rows / 2000-char strings like the AI test-case list, so the
        // answer doc stays bounded. Older clients that only send counts still
        // sanitize fine (cases → []).
        const tcCases = Array.isArray(b.testcase.cases) ? b.testcase.cases : [];
        out.testcase = {
          passed: Number(b.testcase.passed) || 0,
          total: Number(b.testcase.total) || 0,
          cases: tcCases.slice(0, 50).map((t, i) => ({
            index: Number(t?.index) === Number(t?.index) ? Number(t.index) : i,
            passed: !!t?.passed,
            hidden: !!t?.hidden,
            input: typeof t?.input === 'string' ? t.input.slice(0, 2000) : '',
            expectedOutput: typeof t?.expectedOutput === 'string' ? t.expectedOutput.slice(0, 2000) : '',
            actualOutput: typeof t?.actualOutput === 'string' ? t.actualOutput.slice(0, 2000) : '',
          })),
        };
      }
      if (b.method === 'ai' && b.ai && typeof b.ai === 'object') {
        const criteria = Array.isArray(b.ai.criteria) ? b.ai.criteria : [];
        const testCases = Array.isArray(b.ai.testCases) ? b.ai.testCases : [];
        out.ai = {
          perCriterionMax: Number(b.ai.perCriterionMax) || 0,
          criteria: criteria
            .filter(c => c && ALLOWED_CRIT.has(c.key))
            .map(c => ({
              key: c.key,
              percentage: Math.max(0, Math.min(100, Number(c.percentage) || 0)),
              score: Math.max(0, Number(c.score) || 0),
              comment: typeof c.comment === 'string' ? c.comment.slice(0, 500) : '',
            })),
          testCases: testCases.slice(0, 50).map((t, i) => ({
            index: Number(t?.index) === Number(t?.index) ? Number(t.index) : i,
            source: t?.source === 'ai' ? 'ai' : 'question',
            input: typeof t?.input === 'string' ? t.input.slice(0, 2000) : '',
            expectedOutput: typeof t?.expectedOutput === 'string' ? t.expectedOutput.slice(0, 2000) : '',
            passed: !!t?.passed,
            comment: typeof t?.comment === 'string' ? t.comment.slice(0, 500) : '',
          })),
          passedTestCases: Math.max(0, Number(b.ai.passedTestCases) || 0),
          totalTestCases: Math.max(0, Number(b.ai.totalTestCases) || 0),
          criteriaPortion: Math.max(0, Number(b.ai.criteriaPortion) || 0),
          testCasePortion: Math.max(0, Number(b.ai.testCasePortion) || 0),
          model: typeof b.ai.model === 'string' ? b.ai.model.slice(0, 100) : '',
          failed: !!b.ai.failed,
        };
      }
      return out;
    };

    // Group updates by userId so we do at most one save per user.
    const byUser = new Map();
    for (const u of updates) {
      if (!u || !u.userId || !u.questionId) continue;
      const arr = byUser.get(String(u.userId)) || [];
      arr.push(u);
      byUser.set(String(u.userId), arr);
    }

    const failed = [];
    let updatedCount = 0;

    for (const [userId, userUpdates] of byUser.entries()) {
      let user;
      try {
        user = await User.findById(userId);
      } catch (e) {
        userUpdates.forEach(u => failed.push({ userId, questionId: u.questionId, reason: 'user lookup failed' }));
        continue;
      }
      if (!user) {
        userUpdates.forEach(u => failed.push({ userId, questionId: u.questionId, reason: 'user not found' }));
        continue;
      }

      // Walk to the exercise entry.
      const courseIdx = user.courses.findIndex(c => c.courseId && c.courseId.toString() === courseId);
      if (courseIdx === -1) {
        userUpdates.forEach(u => failed.push({ userId, questionId: u.questionId, reason: 'course entry missing' }));
        continue;
      }
      const answers = user.courses[courseIdx].answers;
      if (!answers || !answers[category]) {
        userUpdates.forEach(u => failed.push({ userId, questionId: u.questionId, reason: 'category map missing' }));
        continue;
      }
      const exerciseKey = (category === 'We_Do' || category === 'You_Do') ? subcategory : exerciseId.toString();
      const exerciseArray = answers[category].get(exerciseKey);
      if (!Array.isArray(exerciseArray) || exerciseArray.length === 0) {
        userUpdates.forEach(u => failed.push({ userId, questionId: u.questionId, reason: 'exercise array missing' }));
        continue;
      }
      const exerciseIdx = exerciseArray.findIndex(ex => ex.exerciseId && ex.exerciseId.toString() === exerciseId);
      if (exerciseIdx === -1) {
        userUpdates.forEach(u => failed.push({ userId, questionId: u.questionId, reason: 'exercise entry missing' }));
        continue;
      }
      const exercise = exerciseArray[exerciseIdx];

      let userDirty = false;
      for (const u of userUpdates) {
        const qIdx = (exercise.questions || []).findIndex(q => q.questionId && q.questionId.toString() === String(u.questionId));
        if (qIdx === -1) {
          failed.push({ userId, questionId: u.questionId, reason: 'question submission not found' });
          continue;
        }
        const q = exercise.questions[qIdx];

        const newBreakdown = sanitizeBreakdown(u.evaluationBreakdown);
        const newScore = Math.max(0, Math.min(100, Number(u.score) || 0));
        const newStatus = ['solved','attempted','skipped','submitted','evaluated'].includes(u.status)
          ? u.status
          : (q.status || 'submitted');
        const newIsCorrect = newStatus === 'solved' || newScore >= 70;

        // Push previous values to scoreHistory before overwriting. This is the
        // audit trail — teachers can see "was 3, now 7 (rerun on 2026-08-07)".
        if (!Array.isArray(q.scoreHistory)) q.scoreHistory = [];
        q.scoreHistory.push({
          previousScore: Number(q.score) || 0,
          previousStatus: q.status || '',
          previousIsCorrect: !!q.isCorrect,
          at: new Date(),
          source: 'rerun',
          note: typeof u.note === 'string' ? u.note.slice(0, 300) : '',
        });

        q.score = newScore;
        q.status = newStatus;
        q.isCorrect = newIsCorrect;
        q.lastRerunAt = new Date();
        q.updatedAt = new Date();
        if (newBreakdown) q.evaluationBreakdown = newBreakdown;

        exercise.questions[qIdx] = q;
        userDirty = true;
        updatedCount++;
      }

      if (userDirty) {
        // Mongoose Map + nested array — the same `markModified` dance
        // submitAnswer uses to persist deep changes reliably.
        answers[category].set(exerciseKey, exerciseArray);
        user.markModified(`courses.${courseIdx}.answers.${category}`);
        try {
          await user.save();
        } catch (saveErr) {
          userUpdates.forEach(u => failed.push({ userId, questionId: u.questionId, reason: 'save failed: ' + saveErr.message }));
          updatedCount -= userUpdates.length; // roll back the count optimistically added above
        }
      }
    }

    // ── Clear the "recently edited" flag on the affected questions ──────────
    // The client passes the list of question _ids that were fully rerun for
    // every affected student — those questions are now in sync with all stored
    // scores again, so the flag can be cleared.
    let flagsCleared = 0;
    if (Array.isArray(clearFlagsForQuestionIds) && clearFlagsForQuestionIds.length > 0 && nodeId && nodeType) {
      try {
        // Reuse the same node-model resolver the rest of the file uses; falls
        // back gracefully across module/submodule/topic/subtopic.
        const modelForNodeType = {
          module: require('../../../models/Courses/moduleStructure/moduleModal'),
          submodule: require('../../../models/Courses/moduleStructure/subModuleModal'),
          topic: require('../../../models/Courses/moduleStructure/topicModal'),
          subtopic: require('../../../models/Courses/moduleStructure/subTopicModal'),
        }[String(nodeType).toLowerCase()];

        if (modelForNodeType) {
          const nodeDoc = await modelForNodeType.findById(nodeId);
          if (nodeDoc && nodeDoc.pedagogy) {
            // pedagogy is a single nested subdoc { I_Do, We_Do, You_Do }, not an
            // array. Wrap it in an array so the walking loop below works uniformly.
            let touched = false;
            const wanted = new Set(clearFlagsForQuestionIds.map(String));
            for (const ped of [nodeDoc.pedagogy]) {
              const groups = ped?.[category];
              if (!groups) continue;
              // groups is a Map (or plain object) keyed by subcategory.
              const groupIter = typeof groups.entries === 'function' ? groups.entries() : Object.entries(groups);
              for (const [, subExercises] of groupIter) {
                if (!Array.isArray(subExercises)) continue;
                for (const ex of subExercises) {
                  // Pedagogy exercises use Mongoose _id, not a top-level
                  // exerciseId field. The human-readable id lives at
                  // ex.exerciseInformation.exerciseId — accept either match.
                  const matches = (ex && ex._id && ex._id.toString() === String(exerciseId))
                    || (ex && ex.exerciseInformation && ex.exerciseInformation.exerciseId === exerciseId);
                  if (!matches) continue;
                  for (const q of ex.questions || []) {
                    if (q && q._id && wanted.has(q._id.toString()) && q.lastEditedAfterSubmissionAt) {
                      q.lastEditedAfterSubmissionAt = null;
                      touched = true;
                      flagsCleared++;
                    }
                  }
                }
              }
            }
            if (touched) {
              nodeDoc.markModified('pedagogy');
              await nodeDoc.save();
            }
          }
        }
      } catch (flagErr) {
        // Flag clearing is best-effort — the score updates already committed.
        console.warn('[rerunSubmissions] flag clear failed:', flagErr.message);
      }
    }

    return res.status(200).json({
      success: true,
      updated: updatedCount,
      failed,
      flagsCleared,
    });
  } catch (err) {
    console.error('rerunSubmissions error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ────────────────────────────────────────────────────────────────────────────
// RERUN CONTEXT — the client calls this before showing the Rerun dialog to
// know (a) which questions in the exercise are "recently edited" and (b) how
// many student submissions each question has. Also returns each question's
// current test cases + evaluation method + language so the client-side runner
// can score locally against the CURRENT state.
//
// GET /courses/exercises/:exerciseId/rerun-context
// Query: courseId, category, subcategory, nodeId, nodeType
exports.getRerunContext = async (req, res) => {
  try {
    const { exerciseId } = req.params;
    const { courseId, category, subcategory, nodeId, nodeType } = req.query;

    if (!courseId || !exerciseId || !category || !nodeId || !nodeType) {
      return res.status(400).json({ success: false, message: 'courseId, exerciseId, category, nodeId, nodeType required' });
    }

    const modelForNodeType = {
      module: require('../../../models/Courses/moduleStructure/moduleModal'),
      submodule: require('../../../models/Courses/moduleStructure/subModuleModal'),
      topic: require('../../../models/Courses/moduleStructure/topicModal'),
      subtopic: require('../../../models/Courses/moduleStructure/subTopicModal'),
    }[String(nodeType).toLowerCase()];
    if (!modelForNodeType) {
      return res.status(400).json({ success: false, message: 'unknown nodeType' });
    }

    const nodeDoc = await modelForNodeType.findById(nodeId).lean();
    if (!nodeDoc) return res.status(404).json({ success: false, message: 'node not found' });

    // Find the target exercise + collect its questions. pedagogy is an object
    // { I_Do, We_Do, You_Do }, not an array — wrap for uniform traversal.
    let targetExercise = null;
    let evaluationMethod = null;
    for (const ped of (nodeDoc.pedagogy ? [nodeDoc.pedagogy] : [])) {
      const groups = ped?.[category];
      if (!groups) continue;
      const groupIter = typeof groups.entries === 'function' ? groups.entries() : Object.entries(groups);
      for (const [, subExercises] of groupIter) {
        if (!Array.isArray(subExercises)) continue;
        for (const ex of subExercises) {
          // Pedagogy exercise identity: match on Mongoose _id (the primary key
          // the client passes as exerciseId in the URL) or on the human-readable
          // exerciseInformation.exerciseId as a fallback.
          const matches = (ex && ex._id && ex._id.toString() === String(exerciseId))
            || (ex && ex.exerciseInformation && ex.exerciseInformation.exerciseId === exerciseId);
          if (!matches) continue;
          targetExercise = ex;
          evaluationMethod = ex.evaluationMethod || null;
          break;
        }
        if (targetExercise) break;
      }
      if (targetExercise) break;
    }
    if (!targetExercise) return res.status(404).json({ success: false, message: 'exercise not found in this node' });

    // Only programming questions are eligible (Manual has no auto-scorer).
    const eligibleQuestions = (targetExercise.questions || [])
      .filter(q => q && (q.questionType === 'programming' || Array.isArray(q.testCases)))
      .map(q => ({
        _id: q._id,
        title: q.title || q.programmingQuestionDescription?.text || '',
        difficulty: q.difficulty || null,
        testCases: q.testCases || [],
        sampleInput: q.sampleInput || '',
        sampleOutput: q.sampleOutput || '',
        constraints: q.constraints || [],
        score: q.score || 100,
        lastEditedAfterSubmissionAt: q.lastEditedAfterSubmissionAt || null,
      }));

    // Count submissions per question (across ALL enrolled users for this course).
    // Best-effort — batch scans the whole User collection filtered by course.
    // For a large user base this can be slow; acceptable for the rerun panel
    // which is trainer-only and rare.
    const users = await User.find({ 'courses.courseId': courseId })
      .select('_id firstName lastName email courses')
      .lean();

    const perQuestionSubmitCount = new Map();
    const submissionsIndex = []; // { userId, userName, questionId, codeAnswer, language, currentScore, currentStatus }
    const exerciseKey = (category === 'We_Do' || category === 'You_Do') ? subcategory : String(exerciseId);

    for (const u of users) {
      const courseEntry = (u.courses || []).find(c => c.courseId && c.courseId.toString() === String(courseId));
      if (!courseEntry) continue;
      const catMap = courseEntry.answers && courseEntry.answers[category];
      if (!catMap) continue;
      // Lean docs come back as plain objects for Maps too.
      const subArr = catMap instanceof Map ? catMap.get(exerciseKey) : catMap[exerciseKey];
      if (!Array.isArray(subArr)) continue;
      const exEntry = subArr.find(ex => ex && ex.exerciseId && ex.exerciseId.toString() === String(exerciseId));
      if (!exEntry || !Array.isArray(exEntry.questions)) continue;
      for (const q of exEntry.questions) {
        if (!q || !q.questionId) continue;
        const qid = q.questionId.toString();
        perQuestionSubmitCount.set(qid, (perQuestionSubmitCount.get(qid) || 0) + 1);
        submissionsIndex.push({
          userId: u._id,
          userName: `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email,
          userEmail: u.email,
          questionId: qid,
          codeAnswer: q.codeAnswer || '',
          language: q.language || '',
          currentScore: q.score || 0,
          currentStatus: q.status || 'attempted',
          hasBreakdown: !!q.evaluationBreakdown,
          currentBreakdownMethod: q.evaluationBreakdown ? q.evaluationBreakdown.method : null,
        });
      }
    }

    return res.status(200).json({
      success: true,
      exerciseId,
      evaluationMethod, // { method: 'testcase' | 'ai' | 'manual', ... }
      questions: eligibleQuestions.map(q => ({
        ...q,
        submissionCount: perQuestionSubmitCount.get(String(q._id)) || 0,
      })),
      submissions: submissionsIndex,
    });
  } catch (err) {
    console.error('getRerunContext error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

