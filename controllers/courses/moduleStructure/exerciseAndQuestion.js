const mongoose = require('mongoose');
const Module1 = mongoose.model('Module1');
const SubModule1 = mongoose.model('SubModule1');
const Topic1 = mongoose.model('Topic1');
const SubTopic1 = mongoose.model('SubTopic1');
const User = require("../../../models/UserModel");
const CourseStructure = require("../../../models/Courses/courseStructureModal");
// ExamSession — one row per (assessment, student) once the student joins the
// test. Never deleted (submittedAt just flips), so the presence of any row
// for an assessmentId is the "someone has ever started this test" signal.
// Read here to stamp `hasParticipants` onto each row of the You_Do exercise
// list, so the client can hide the "Live Dashboard" menu entry until the
// first student joins and keep it visible forever afterwards.
const ExamSession = require("../../../models/Courses/moduleStructure/ExamSessionModel");
// Phase 6 — Question Bank model used when `saveToBank` is true on save.
const QuestionBank = require("../../../models/Courses/QuestionbankModal");
const {
  resolveCourseId,
  buildInitialApprovalWorkflow,
  canUserActOnStep,
  isStudentRequester,
  isExerciseStudentVisible,
  notifyApproversForStep,
  notifyStudentsExerciseAvailable,
  notifySingleUser,
} = require("../../../utils/approvalWorkflow");
// Resources by Batch. We Do assignments and You Do assessments live in the
// same pedagogy maps as I Do resources, so they obey the same rule: a shared
// element sits on the course-level `pedagogy`, a batch-wise one on that
// batch's `batchPedagogy.<batchId>`. Shared with pedagogyView.js on purpose —
// when only that file knew about batches, I Do scoped correctly while We Do
// and You Do silently kept serving the course-level set.
const {
  resolvePedagogyScope,
  resolveSearchScopes,
  loadCourseForNode,
  readRequestedBatch,
  mergeSectionAcrossBatches,
  locateExerciseContainer,
  COURSE_BATCH_FIELDS,
} = require("../../../utils/pedagogyScope");
const { scopeNodePedagogy, resolveViewerBatchId } = require("../../../utils/batchResources");
const { stripHiddenOnQuestion } = require("../../../services/testCaseVisibility");

// Code Setup (Starter/Solution) — Programming and Database questions store a
// single code string; Frontend stores { html, css, javascript }. Accept
// either shape from the client, sanitize sub-fields to strings, and return
// undefined for anything else so the "remove undefined fields" pass below
// drops it rather than persisting garbage.
function normalizeCodeSetupValue(v) {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    return {
      html: typeof v.html === 'string' ? v.html : '',
      css: typeof v.css === 'string' ? v.css : '',
      javascript: typeof v.javascript === 'string' ? v.javascript : '',
    };
  }
  return undefined;
}

// ─── Approval-workflow gate helpers ─────────────────────────────────────────
// Two-part rule (mirrors the client's `isAssessmentComplete`):
//  - If availabilityPeriod.approvalScope === "settings" (default) → approval
//    notification fires as soon as the workflow is attached.
//  - If approvalScope === "settings_and_questions" → notification is deferred
//    until the exercise is fully configured (all planned questions added).
// A per-step `notifiedAt` timestamp keeps the fire idempotent, so we can
// safely re-check on question-add paths without spamming approvers.

/**
 * Phase 6 — Fire-and-forget helper: clone an exercise's attached questions into
 * the institution's QuestionBank collection. Idempotent per-question via a
 * simple `_clonedFromExercise:<exerciseId>+_id:<questionId>` marker so calling
 * on every save doesn't duplicate. Preserves the per-question `source` tag.
 * Errors are swallowed and logged — the exercise save must never be blocked by
 * a bank-clone failure.
 */
async function cloneQuestionsToBank({ institutionId, exerciseId, questions, actorEmail }) {
  try {
    if (!institutionId || !Array.isArray(questions) || questions.length === 0) return;
    // Find-or-create the institution's bank doc.
    let bank = await QuestionBank.findOne({ institution: institutionId });
    if (!bank) {
      bank = new QuestionBank({ institution: institutionId, questions: [] });
    }
    const existingMarkers = new Set(
      (bank.questions || [])
        .map(q => q && q._clonedFromExercise && q._clonedFromExerciseQuestionId
          ? `${q._clonedFromExercise}:${q._clonedFromExerciseQuestionId}`
          : null)
        .filter(Boolean)
    );
    let addedCount = 0;
    for (const q of questions) {
      if (!q) continue;
      const qId = (q._id && q._id.toString) ? q._id.toString() : String(q._id || '');
      const marker = `${exerciseId}:${qId}`;
      if (qId && existingMarkers.has(marker)) continue; // already cloned
      // Shallow clone; preserve source; drop the exercise-scoped _id so the
      // bank assigns its own.
      const clone = { ...q, _id: undefined, source: q.source || null,
        _clonedFromExercise: exerciseId,
        _clonedFromExerciseQuestionId: qId || undefined,
        createdBy: q.createdBy || undefined,
        createdByEmail: q.createdByEmail || actorEmail || '',
      };
      bank.questions.push(clone);
      addedCount += 1;
    }
    if (addedCount > 0) {
      await bank.save();
    }
  } catch (err) {
    console.error('[cloneQuestionsToBank] failed:', err && err.message);
  }
}

/**
 * Port of the client-side `isAssessmentComplete` — same rules, same order.
 * Called on the raw exercise sub-doc as it lives inside pedagogy.
 */
const isExerciseFullyConfigured = (ex) => {
  if (!ex) return false;
  if (!ex.exerciseType) return false;
  const info = ex.exerciseInformation || {};
  if (!info.exerciseName || !String(info.exerciseName).trim()) return false;
  if (!ex.availabilityPeriod || !ex.availabilityPeriod.startDate) return false;
  // Non-graded exercises (isGraded === false) legitimately carry totalMarks=0,
  // so the marks requirement only applies to graded ones. Without this guard
  // every non-graded We_Do/You_Do item is stuck "not fully configured" — hidden
  // from the approvals overview and its step-1 notification never fires.
  if (ex.isGraded !== false
      && (info.totalMarks ?? 0) <= 0 && (info.totalMarksMCQ ?? 0) <= 0) return false;

  // Scope-aware baseline: for "settings_and_questions", questions are the
  // whole point — an exercise with zero questions is by definition NOT
  // fully configured, even if the trainer hasn't set a count yet. Without
  // this guard the per-type checks below fall through when the configured
  // count is 0/undefined, letting an empty exercise pass as "complete".
  const scope = ex.availabilityPeriod?.approvalScope || 'settings';
  const hasQuestions = Array.isArray(ex.questions) && ex.questions.length > 0;
  if (scope === 'settings_and_questions' && !hasQuestions) return false;

  // Section-based
  if (ex.isSectionBased) {
    const sectionConfigs = ex.sectionConfigs instanceof Map
      ? Object.fromEntries(ex.sectionConfigs)
      : (ex.sectionConfigs || {});
    const allQuestions = ex.questions || [];
    const countBySection = {};
    allQuestions.forEach((q) => {
      const sid = q.sectionId;
      if (!sid) return;
      if (!countBySection[sid]) countBySection[sid] = { mcq: 0, prog: 0 };
      if (q.questionType === 'mcq') countBySection[sid].mcq++;
      else if (['programming', 'database', 'others'].includes(q.questionType)) countBySection[sid].prog++;
    });
    for (const key of Object.keys(sectionConfigs)) {
      const cfg = sectionConfigs[key] || {};
      const sectionId = cfg.id || key;
      const type = cfg.exerciseType || 'MCQ';
      const c = countBySection[sectionId] || { mcq: 0, prog: 0 };
      if (type === 'MCQ' || type === 'Combined') {
        const limit = cfg.mcqConfig?.generalQuestionCount || 0;
        if (limit > 0 && c.mcq < limit) return false;
      }
      if (type === 'Programming' || type === 'Combined') {
        const pc = cfg.programmingConfig || {};
        const lb = pc.levelBasedCounts || {};
        const limit = pc.questionConfigType === 'general'
          ? (pc.generalQuestionCount || 0)
          : ((lb.easy || 0) + (lb.medium || 0) + (lb.hard || 0));
        if (limit > 0 && c.prog < limit) return false;
      }
    }
    return true;
  }

  // Non-section-based
  const qc = ex.questionConfiguration || {};
  const mcqCfg = qc.mcqQuestionConfiguration;
  const progCfg = qc.programmingQuestionConfiguration;
  const questions = ex.questions || [];
  const mcqQs = questions.filter((q) => q.questionType === 'mcq');
  const progQs = questions.filter((q) => ['programming', 'database', 'others'].includes(q.questionType));

  if (ex.exerciseType === 'MCQ') {
    const maxQ = mcqCfg?.totalMcqQuestions ?? 0;
    if (maxQ > 0 && mcqQs.length < maxQ) return false;
  } else if (ex.exerciseType === 'Programming') {
    const ct = progCfg?.questionConfigType;
    const lc = progCfg?.levelBasedCounts ?? progCfg?.selectionLevelCounts ?? {};
    const maxQ = ct === 'general'
      ? (progCfg?.generalQuestionCount ?? 0)
      : ((lc.easy ?? 0) + (lc.medium ?? 0) + (lc.hard ?? 0));
    if (maxQ > 0 && progQs.length < maxQ) return false;
  } else if (ex.exerciseType === 'Combined') {
    const ct = progCfg?.questionConfigType;
    const lc = progCfg?.levelBasedCounts ?? progCfg?.selectionLevelCounts ?? {};
    const progMax = ct === 'general'
      ? (progCfg?.generalQuestionCount ?? 0)
      : ((lc.easy ?? 0) + (lc.medium ?? 0) + (lc.hard ?? 0));
    const maxQ = (mcqCfg?.totalMcqQuestions ?? 0) + progMax;
    const curQ = mcqQs.length + progQs.length;
    if (maxQ > 0 && curQ < maxQ) return false;
  }
  return true;
};

// ─── Question quota enforcement ───────────────────────────────────────────────
// The exercise configuration is the single source of truth for how many
// questions may be added, and to which section / difficulty / source slice.
// The UI disables its controls at the limit, but a disabled button is not a
// rule — this is. Running it before anything is pushed means an over-quota
// request is rejected no matter where it came from: a stale browser tab, a
// bypassed control, or a hand-rolled batch of 50 against a quota of 2.
//
// A limit is enforced only where one is configured (> 0). "No count set" means
// "no cap", not zero — otherwise every exercise created before its config was
// filled in would be frozen and unable to accept its first question.

// Anything that isn't explicitly easy/hard is billed to the neutral 'medium'
// bucket — the same normalisation the client quota math uses.
const quotaDifficultyOf = (q) => {
  const d = (q?.difficulty || '').toString().toLowerCase();
  return d === 'easy' || d === 'hard' ? d : 'medium';
};

// 'scratch-manual' and 'scratch-bank' both bill the Manual slice — the bank is
// Manual's second entry point, not a source of its own. Untagged questions bill
// Manual too: they predate source tagging and were authored by hand.
const quotaSourceOf = (q) => {
  const s = (q?.source || '').toString();
  if (s.startsWith('thirdParty')) return 'thirdParty';
  if (s === 'ai') return 'ai';
  return 'scratch';
};

// programming / database / frontend all draw on the same programming config.
const quotaFamilyOf = (qType) => {
  const t = (qType || '').toString().toLowerCase();
  if (t === 'mcq') return 'mcq';
  if (t === 'others') return 'others';
  return 'prog';
};

const asPlainObject = (v) => (v instanceof Map ? Object.fromEntries(v) : (v || {}));

// Section-based exercises carry their counts on the section, not on the
// exercise — sectionConfigs[key] = { id, exerciseType, mcqConfig, programmingConfig }.
const quotaConfigFor = (ex, sectionId, family) => {
  if (ex.isSectionBased) {
    const sectionConfigs = asPlainObject(ex.sectionConfigs);
    let cfg = null;
    for (const key of Object.keys(sectionConfigs)) {
      const c = sectionConfigs[key] || {};
      if (String(c.id || key) === String(sectionId)) { cfg = c; break; }
    }
    if (!cfg) return null;
    return family === 'mcq' ? (cfg.mcqConfig || null) : (cfg.programmingConfig || null);
  }
  const qc = ex.questionConfiguration || {};
  if (family === 'mcq') return qc.mcqQuestionConfiguration || null;
  if (family === 'others') return qc.othersQuestionConfiguration || null;
  return qc.programmingQuestionConfiguration || null;
};

const quotaLevelCounts = (cfg) => {
  const t = cfg?.questionConfigType || 'general';
  if (t === 'general') return null;
  return (t === 'selectionLevel' ? cfg?.selectionLevelCounts : cfg?.levelBasedCounts) || {};
};

// Total cap for a family. MCQ stores it as totalMcqQuestions at exercise level
// and generalQuestionCount on a section config.
const quotaTotalLimit = (cfg, family) => {
  if (!cfg) return 0;
  if (family === 'mcq') return Number(cfg.totalMcqQuestions || cfg.generalQuestionCount || 0) || 0;
  const counts = quotaLevelCounts(cfg);
  if (!counts) return Number(cfg.generalQuestionCount || 0) || 0;
  return (Number(counts.easy || 0) + Number(counts.medium || 0) + Number(counts.hard || 0)) || 0;
};

// Per-difficulty cap — only levelBased / selectionLevel programming configs
// have one. A full difficulty must block even when the overall total has room.
const quotaDiffLimit = (cfg, family, diff) => {
  if (!cfg || family === 'mcq') return 0;
  const counts = quotaLevelCounts(cfg);
  if (!counts) return 0;
  return Number(counts[diff] || 0) || 0;
};

// Per-source slice. Section-based reads its own entry so one section's Manual
// allocation can never be spent by another.
const quotaDistFor = (ex, sectionId) => {
  if (ex.questionSource !== 'custom') return null;
  if (ex.isSectionBased) {
    const by = asPlainObject(ex.customDistributionBySection);
    return by[sectionId] || by[String(sectionId)] || null;
  }
  return ex.customDistribution || null;
};

const quotaDistTotal = (dist) => {
  if (!dist) return 0;
  return ['easy', 'medium', 'hard'].reduce((s, r) => s
    + Number(dist[r]?.scratch || 0)
    + Number(dist[r]?.ai || 0)
    + Number(dist[r]?.thirdParty || 0), 0);
};

/**
 * Validate a batch of incoming questions against the exercise configuration.
 * Returns null when the batch is allowed, or a human-readable reason string.
 * The whole batch is rejected if any single question would breach a cap — a
 * partial insert would leave the trainer guessing which ones landed.
 */
const validateQuestionQuota = (ex, questionsToAdd) => {
  const existing = (ex.questions || []).filter((q) => q.isActive !== false);

  // Running tally so a batch can't slip N questions through a cap of 1 by
  // having every one of them measured against the same starting count.
  const pending = [];
  const countMatching = (predicate) =>
    existing.filter(predicate).length + pending.filter(predicate).length;

  for (let i = 0; i < questionsToAdd.length; i++) {
    const incoming = questionsToAdd[i];
    const qType = incoming.questionType;
    const family = quotaFamilyOf(qType);
    const sectionId = incoming.sectionId || null;
    const diff = quotaDifficultyOf(incoming);
    const srcKey = quotaSourceOf(incoming);
    const label = `Question ${i + 1}`;

    const sameScope = (q) => {
      if (ex.isSectionBased && String(q.sectionId || '') !== String(sectionId || '')) return false;
      return quotaFamilyOf(q.questionType) === family;
    };

    const cfg = quotaConfigFor(ex, sectionId, family);
    const where = ex.isSectionBased ? ' for this section' : '';

    // 0. Duplicate Question Bank import — the same bank doc may only appear
    // once per exercise, whether it landed in an earlier save or earlier in
    // this very batch.
    const bankId = incoming.bankQuestionId ? String(incoming.bankQuestionId) : null;
    if (bankId) {
      const sameBank = (q) => q.bankQuestionId && String(q.bankQuestionId) === bankId;
      if (existing.some(sameBank) || pending.some(sameBank)) {
        return `${label}: this Question Bank question is already in the exercise — duplicates are not allowed.`;
      }
    }

    // 1. Total cap for the family (within the section, when section-based).
    const totalLimit = quotaTotalLimit(cfg, family);
    if (totalLimit > 0) {
      const used = countMatching(sameScope);
      if (used >= totalLimit) {
        return `${label}: all ${totalLimit} question slots${where} are already filled (${used}/${totalLimit}). Delete a question before adding another.`;
      }
    }

    // 2. Per-difficulty cap.
    const diffLimit = quotaDiffLimit(cfg, family, diff);
    if (diffLimit > 0) {
      const usedDiff = countMatching((q) => sameScope(q) && quotaDifficultyOf(q) === diff);
      if (usedDiff >= diffLimit) {
        return `${label}: the ${diff} quota${where} is full (${usedDiff}/${diffLimit}). Choose another difficulty or delete a ${diff} question.`;
      }
    }

    // 3. Per-source slice (Manual / AI / Other Platform) under a Custom mix.
    const dist = quotaDistFor(ex, sectionId);
    if (dist && quotaDistTotal(dist) > 0) {
      const perDifficulty = !!quotaLevelCounts(cfg) && family !== 'mcq';
      const sliceLimit = perDifficulty
        ? Number(dist[diff]?.[srcKey] || 0)
        : ['easy', 'medium', 'hard'].reduce((s, r) => s + Number(dist[r]?.[srcKey] || 0), 0);
      const usedSlice = countMatching((q) =>
        sameScope(q)
        && quotaSourceOf(q) === srcKey
        && (!perDifficulty || quotaDifficultyOf(q) === diff));
      if (usedSlice >= sliceLimit) {
        const srcLabel = srcKey === 'ai' ? 'AI' : srcKey === 'thirdParty' ? 'Other Platform' : 'Manual';
        const scope = perDifficulty ? ` ${diff}` : '';
        return `${label}: the${scope} ${srcLabel} quota${where} is full (${usedSlice}/${sliceLimit}). Use a different source or delete one of its questions.`;
      }
    }

    pending.push({
      questionType: qType,
      sectionId,
      difficulty: incoming.difficulty,
      source: incoming.source,
      bankQuestionId: bankId,
      isActive: true,
    });
  }

  return null;
};

/**
 * Should the step-1 approver notification fire *now* for this exercise?
 * Idempotent — returns false once steps[0].notifiedAt is set.
 * Callers must set notifiedAt themselves before saving, then fire the notify.
 */
const shouldFireStep1Notification = (ex) => {
  const wf = ex?.approvalWorkflow;
  if (!wf || !Array.isArray(wf.steps) || wf.steps.length === 0) return false;
  if ((wf.currentStep || 0) !== 1) return false;
  const step = wf.steps[0];
  if (!step || step.status !== 'pending') return false;
  if (step.notifiedAt) return false; // already sent
  const scope = ex?.availabilityPeriod?.approvalScope || 'settings';
  if (scope === 'settings') return true;
  // settings_and_questions → defer until fully configured
  return isExerciseFullyConfigured(ex);
};

const path = require('path');
const fs = require('fs');


const cloudinary = require('cloudinary').v2;
const stream = require('stream');
const { createClient } = require("@supabase/supabase-js");
const supabaseKey = process.env.SUPABASE_KEY;
const supabaseUrl = process.env.SUPABASE_URL;

const supabase = createClient(supabaseUrl, supabaseKey);
// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});





const modelMap = {
  modules: { model: Module1, path: "modules" },
  submodules: { model: SubModule1, path: "submodules" },
  topics: { model: Topic1, path: "topics" },
  subtopics: { model: SubTopic1, path: "subtopics" },
};








// Get a single exercise by ID - Return FULL exercise data
exports.getExerciseById = async (req, res) => {
  try {
    const { exerciseId } = req.params;
    const {
      type,       // Optional: entity type (modules, submodules, topics, subtopics)
      id,         // Optional: entity ID
    } = req.query;

    console.log(`🔍 Fetching COMPLETE exercise by ID: ${exerciseId}`);

    if (!exerciseId) {
      return res.status(400).json({
        message: [{ key: "error", value: "Exercise ID is required" }]
      });
    }

    let foundExercise = null;
    let foundEntity = null;
    let foundLocation = null;

    // If type and id are provided, search in specific entity
    if (type && id && modelMap[type]) {
      const { model } = modelMap[type];
      const entity = await model.findById(id);

      // ── Resources by Batch ─────────────────────────────────────────────
      // This lookup is by exercise id alone, with no section to scope by, so
      // search the caller's batch container FIRST and the shared one after.
      // Both are needed: an id can legitimately live in either, and a course
      // whose config was flipped after content existed has some of each. The
      // batch container comes first so a batch's own copy wins.
      const searchScopes = entity ? await resolveSearchScopes(entity, req) : [];

      for (const scope of searchScopes) {
        if (foundExercise) break;
        // Search through all pedagogy sections
        ['I_Do', 'We_Do', 'You_Do'].forEach(section => {
          if (scope.container[section]) {
            const sectionData = scope.container[section];

            // Handle Map and object formats
            let subcategories = [];
            if (sectionData instanceof Map) {
              subcategories = Array.from(sectionData.entries());
            } else if (typeof sectionData === 'object') {
              subcategories = Object.entries(sectionData);
            }

            subcategories.forEach(([subcategory, exercises]) => {
              if (!exercises) return;

              let exercisesArray = [];
              if (Array.isArray(exercises)) {
                exercisesArray = exercises;
              } else if (exercises._id) {
                exercisesArray = [exercises];
              }

              const exercise = exercisesArray.find(ex =>
                ex._id && ex._id.toString() === exerciseId
              );

              if (exercise) {
                // Return the FULL exercise object as-is
                foundExercise = exercise;

                // Convert Mongoose document to plain object if needed
                if (foundExercise.toObject) {
                  foundExercise = foundExercise.toObject();
                }

                foundEntity = {
                  type: type,
                  id: entity._id,
                  title: entity.title || entity.name,
                  description: entity.description || ''
                };
                foundLocation = {
                  section,
                  subcategory,
                  path: `${type}/${entity.title || entity.name}/${section}/${subcategory}`
                };
              }
            });
          }
        });
      }
    }
    // Otherwise, search across all entities
    else {
      console.log(`🔍 Searching across all entities for exercise: ${exerciseId}`);

      // Define models to search
      const modelsToSearch = [
        { name: 'modules', model: Module1, type: 'module' },
        { name: 'submodules', model: SubModule1, type: 'submodule' },
        { name: 'topics', model: Topic1, type: 'topic' },
        { name: 'subtopics', model: SubTopic1, type: 'subtopic' }
      ];

      for (const { model, type } of modelsToSearch) {
        try {
          // Search all entities with pedagogy.
          //
          // Resources by Batch — `batchPedagogy` has to be in the filter as
          // well as the walk. A node whose only content is batch-wise has NO
          // `pedagogy` at all, so the original `pedagogy: {$exists: true}`
          // filter would skip it and this fallback would report the exercise
          // as missing.
          const entities = await model.find({
            $or: [
              { 'pedagogy': { $exists: true, $ne: null } },
              { 'batchPedagogy': { $exists: true, $ne: null } },
            ],
          }).lean();

          for (const entity of entities) {
            // Flatten the caller's batch onto `pedagogy` before walking, so
            // one loop covers shared and batch-wise content alike. Safe to
            // mutate: these are `.lean()` copies, not live documents.
            const batchCourse = await loadCourseForNode(entity);
            if (batchCourse) {
              scopeNodePedagogy(
                entity,
                batchCourse,
                resolveViewerBatchId(batchCourse, req.user, readRequestedBatch(req)),
              );
            }
            if (entity.pedagogy) {
              // Search through all sections
              ['I_Do', 'We_Do', 'You_Do'].forEach(section => {
                if (entity.pedagogy[section]) {
                  const sectionData = entity.pedagogy[section];

                  let subcategories = [];
                  if (sectionData instanceof Map) {
                    subcategories = Array.from(sectionData.entries());
                  } else if (typeof sectionData === 'object') {
                    subcategories = Object.entries(sectionData);
                  }

                  subcategories.forEach(([subcategory, exercises]) => {
                    if (!exercises) return;

                    let exercisesArray = [];
                    if (Array.isArray(exercises)) {
                      exercisesArray = exercises;
                    } else if (exercises._id) {
                      exercisesArray = [exercises];
                    }

                    const exercise = exercisesArray.find(ex =>
                      ex._id && ex._id.toString() === exerciseId
                    );

                    if (exercise) {
                      // Return the FULL exercise object as-is
                      foundExercise = exercise;

                      // Convert Mongoose document to plain object if needed
                      if (foundExercise.toObject) {
                        foundExercise = foundExercise.toObject();
                      }

                      foundEntity = {
                        type: type,
                        id: entity._id,
                        title: entity.title || entity.name,
                        description: entity.description || ''
                      };
                      foundLocation = {
                        section,
                        subcategory,
                        path: `${type}/${entity.title || entity.name}/${section}/${subcategory}`
                      };
                    }
                  });
                }
              });
            }
            if (foundExercise) break;
          }
          if (foundExercise) break;
        } catch (err) {
          console.log(`Error searching in ${type}:`, err.message);
        }
      }
    }

    if (!foundExercise) {
      return res.status(404).json({
        message: [{ key: "error", value: `Exercise with ID ${exerciseId} not found` }]
      });
    }

    // ── Approval gating ─────────────────────────────────────────────────
    // Students may only fetch exercises whose approval chain has finished —
    // this payload ships questions with correct answers and test cases.
    const requesterIsStudent = await isStudentRequester(req.user);
    if (!isExerciseStudentVisible(foundExercise) && requesterIsStudent) {
      return res.status(403).json({
        message: [{ key: "error", value: "This exercise is awaiting approval and is not yet available." }]
      });
    }

    // Return the COMPLETE exercise object as it exists in database
    // This includes ALL fields: questions, options, correctAnswer, etc.
    const completeExerciseData = {
      ...foundExercise,  // Spread ALL properties from the found exercise

      // Add location info as additional metadata
      entity: foundEntity,
      location: foundLocation
    };

    // This is the endpoint the student attempt UI calls to load the exercise
    // + its questions into the code editor — blank hidden test cases and
    // Code Setup's Solution Code before they leave the server. Trainers/staff
    // (requesterIsStudent === false) still get the full authoring view.
    if (requesterIsStudent && Array.isArray(completeExerciseData.questions)) {
      completeExerciseData.questions.forEach(stripHiddenOnQuestion);
    }

    // Remove any Mongoose-specific properties if they exist
    if (completeExerciseData.__v !== undefined) {
      delete completeExerciseData.__v;
    }

    return res.status(200).json({
      message: [{ key: "success", value: "Complete exercise data retrieved successfully" }],
      data: {
        exercise: completeExerciseData,  // Complete exercise with ALL data
        metadata: {
          exerciseId: exerciseId,
          found: true,
          entityType: foundEntity?.type,
          section: foundLocation?.section,
          subcategory: foundLocation?.subcategory,
          location: foundLocation?.path,
          totalQuestions: completeExerciseData.questions?.length || 0,
          exerciseType: completeExerciseData.exerciseType,
          exerciseName: completeExerciseData.exerciseInformation?.exerciseName || 'Unnamed Exercise'
        }
      }
    });

  } catch (err) {
    console.error("❌ Get exercise by ID error:", err);
    res.status(500).json({
      message: [{ key: "error", value: `Internal server error: ${err.message}` }]
    });
  }
};




// =============================================================================
// SHARED HELPERS (put at the top of the controller file, outside any export)
// =============================================================================

/**
 * Auto-compute the "grade" (maximum score) fields that the UI shows as readonly.
 * The user only enters GradeToPass; Grades are derived from totalMarks values.
 */
// FIXED
const computeAutoGrades = (exerciseType, exerciseInfo, gradeSettingsRaw) => {
  const result = {};

  if (exerciseType === 'MCQ' || exerciseType === 'Combined') {
    result.mcqGrade = exerciseInfo.totalMarksMCQ || exerciseInfo.totalMarks || 0;
    result.mcqGradeToPass = (gradeSettingsRaw.mcqGradeToPass !== undefined &&
      gradeSettingsRaw.mcqGradeToPass !== null)
      ? Number(gradeSettingsRaw.mcqGradeToPass)
      : null;
  }

  if (exerciseType === 'Programming' || exerciseType === 'Other' || exerciseType === 'Combined') {
    result.programmingGrade = exerciseInfo.totalMarksProgramming || exerciseInfo.totalMarks || 0;
    result.programmingGradeToPass = (gradeSettingsRaw.programmingGradeToPass !== undefined &&
      gradeSettingsRaw.programmingGradeToPass !== null)
      ? Number(gradeSettingsRaw.programmingGradeToPass)
      : null;
  }

  if (exerciseType === 'Combined') {
    result.combinedGrade = (exerciseInfo.totalMarksMCQ || 0) +
      (exerciseInfo.totalMarksProgramming || 0);
    result.combinedGradeToPass = (gradeSettingsRaw.combinedGradeToPass !== undefined &&
      gradeSettingsRaw.combinedGradeToPass !== null)
      ? Number(gradeSettingsRaw.combinedGradeToPass)
      : null;
  }

  result.separateMarks = gradeSettingsRaw.separateMarks ?? false;

  // Difficulty-based pass marks
  result.difficultyPassEnabled = gradeSettingsRaw.difficultyPassEnabled ?? false;
  result.easyPassMark = (gradeSettingsRaw.easyPassMark !== undefined && gradeSettingsRaw.easyPassMark !== null)
    ? Number(gradeSettingsRaw.easyPassMark)
    : null;
  result.mediumPassMark = (gradeSettingsRaw.mediumPassMark !== undefined && gradeSettingsRaw.mediumPassMark !== null)
    ? Number(gradeSettingsRaw.mediumPassMark)
    : null;
  result.hardPassMark = (gradeSettingsRaw.hardPassMark !== undefined && gradeSettingsRaw.hardPassMark !== null)
    ? Number(gradeSettingsRaw.hardPassMark)
    : null;

  // Overall mark to pass (optional)
  result.overallMarkToPassEnabled = gradeSettingsRaw.overallMarkToPassEnabled ?? false;
  result.overallMarkToPass = (gradeSettingsRaw.overallMarkToPass !== undefined && gradeSettingsRaw.overallMarkToPass !== null)
    ? Number(gradeSettingsRaw.overallMarkToPass)
    : null;

  // Grade bands (labelled % ranges) — passed through untouched when provided.
  result.gradeBands = Array.isArray(gradeSettingsRaw.gradeBands)
    ? gradeSettingsRaw.gradeBands
    : undefined;

  return result;
};
/**
 * Build a clean availabilityPeriod object from the raw frontend payload.
 * endDate = submission deadline (stored when provided).
 * cutOffDate = optional late boundary (stored only when cutOffEnabled).
 */
const buildAvailabilityPeriod = (avail) => {
  const safeD = (v) => {
    if (!v || v === 'null' || v === 'undefined') return undefined;
    const d = new Date(v);
    return isNaN(d.getTime()) ? undefined : d;
  };

  const ap = {};
  if (safeD(avail.startDate)) ap.startDate = safeD(avail.startDate);
  if (safeD(avail.endDate)) ap.endDate = safeD(avail.endDate);   // submission deadline

  ap.cutOffEnabled = !!avail.cutOffEnabled;
  if (ap.cutOffEnabled && safeD(avail.cutOffDate)) ap.cutOffDate = safeD(avail.cutOffDate);

  ap.remindGradeByEnabled = !!avail.remindGradeByEnabled;
  if (ap.remindGradeByEnabled && safeD(avail.remindGradeBy))
    ap.remindGradeBy = safeD(avail.remindGradeBy);

  ap.gracePeriodAllowed = !!(avail.gracePeriodAllowed || avail.gracePeriodEnabled);
  ap.gracePeriodEnabled = ap.gracePeriodAllowed;
  if (ap.gracePeriodAllowed && safeD(avail.gracePeriodDate))
    ap.gracePeriodDate = safeD(avail.gracePeriodDate);

  ap.extendedDays = avail.extendedDays ?? 0;
  ap.requiresAdminApproval = !!avail.requiresAdminApproval;
  // Approval scope is only meaningful when approval is on; default to "settings"
  ap.approvalScope = avail.approvalScope === 'settings_and_questions' ? 'settings_and_questions' : 'settings';
  return ap;
};

// =============================================================================
// addExercise — FULL UPDATED VERSION
// =============================================================================
exports.addExercise = async (req, res) => {
  try {
    const { type, id } = req.params;
    const {
      tabType,
      subcategory,
      exerciseType,
      programmingSettings,
      exerciseInformation,
      availabilityPeriod,
      questionConfiguration,
      questionBehavior,       // allQuestionsRequired flag
      notificationSettings,   // from frontend buildFullPayload
      gradeSettings,          // NEW — from frontend buildFullPayload
      additionalOptions,      // NEW — from frontend buildFullPayload
      isGraded,               // Graded / Non-Graded toggle
      stepsSaved,             // Array of step titles explicitly saved by user
      selectedTopics,         // NEW — course topics this assessment covers (Select Content step)
      instructions,           // NEW — assessment instructions (Select Content step)
      // ── Question Source feature (Phase 2 / 5 / 6) ──────────────────────────
      questionSource,
      customDistribution,
      customSources,
      // Section-based Custom mix: per-section distribution keyed by sectionId.
      customDistributionBySection,
      saveToBank,
      // Combined-only: MCQ part's own source + single-cell Custom split.
      questionSourceMcq,
      customSourcesMcq,
      customDistributionMcq,
      // Evaluation Method — { method: 'testcase' | 'ai' }. Stored as-is; no
      // evaluation runs off it yet.
      evaluationMethod,
    } = req.body;

    // ── Validate entity type ───────────────────────────────────────────────
    if (!modelMap[type]) {
      return res.status(400).json({
        message: [{ key: 'error', value: `Invalid entity type: ${type}. Valid types: modules, submodules, topics, subtopics` }]
      });
    }

    if (!subcategory) {
      return res.status(400).json({
        message: [{ key: 'error', value: "Subcategory is required." }]
      });
    }

    // ── Helper: parse JSON strings if needed ──────────────────────────────
    const parseIfNeeded = (data) => {
      if (typeof data === 'string') {
        try { return JSON.parse(data); } catch { return data; }
      }
      return data;
    };

    // ── Transform description fields ──────────────────────────────────────
    const transformQuestionDescription = (question) => {
      if (!question) return question;
      if (question.description && typeof question.description === 'string') {
        question.description = { text: question.description, imageUrl: null, imageAlignment: 'left', imageSizePercent: 100 };
      }
      return question;
    };

    const transformExerciseInfo = (info) => {
      if (!info) return info;
      const t = { ...info };
      if (t.description && typeof t.description === 'object') {
        t.description = t.description.text || '';
      }
      return t;
    };

    // ── Parse all incoming data ────────────────────────────────────────────
    let exerciseTypeParsed = parseIfNeeded(exerciseType);
    let exerciseInfo = parseIfNeeded(exerciseInformation);
    let progSettings = programmingSettings ? parseIfNeeded(programmingSettings) : null;
    let availPeriod = availabilityPeriod ? parseIfNeeded(availabilityPeriod) : {};
    let quesConfig = questionConfiguration ? parseIfNeeded(questionConfiguration) : {};
    let notifSettings = notificationSettings ? parseIfNeeded(notificationSettings) : {};
    let gradeSettingsRaw = gradeSettings ? parseIfNeeded(gradeSettings) : {};
    let additOptions = additionalOptions ? parseIfNeeded(additionalOptions) : {};

    exerciseInfo = transformExerciseInfo(exerciseInfo);

    if (quesConfig.questions) {
      if (Array.isArray(quesConfig.questions)) {
        quesConfig.questions = quesConfig.questions.map(q => transformQuestionDescription(q));
      } else {
        quesConfig.questions = transformQuestionDescription(quesConfig.questions);
      }
    }

    // ── Basic validation ──────────────────────────────────────────────────
    if (!exerciseInfo || !exerciseInfo.exerciseName) {
      return res.status(400).json({
        message: [{ key: 'error', value: 'Exercise information with exerciseName is required' }]
      });
    }

    if (!exerciseTypeParsed) {
      return res.status(400).json({
        message: [{ key: 'error', value: 'Exercise type is required (MCQ, Programming, or Combined)' }]
      });
    }

    // ── Find entity ───────────────────────────────────────────────────────
    const { model } = modelMap[type];
    const entity = await model.findById(id);

    if (!entity) {
      return res.status(404).json({
        message: [{ key: 'error', value: `${type} with ID ${id} not found` }]
      });
    }
    // ── Resources by Batch ───────────────────────────────────────────────
    // Which I_Do/We_Do/You_Do set this request belongs to. For a shared
    // element that is the course-level `pedagogy`; for one ticked batch-wise
    // in Course Setup it is this batch's own `batchPedagogy.<batchId>`.
    // Resolving it here means every lookup and markModified below lands in
    // the right place — without it We Do and You Do would keep reading the
    // course-level set while the batch strip claimed otherwise.
    const { container: pedagogyRoot, basePath: pedagogyPath } =
      await resolvePedagogyScope(entity, tabType, req);


    // (The container is created by resolvePedagogyScope above — it is the one
    // place that decides whether that is `pedagogy` or a batch's own bucket.)
    if (!pedagogyRoot[tabType]) {
      pedagogyRoot[tabType] = new Map();
    }

    let exercises = pedagogyRoot[tabType].has(subcategory)
      ? pedagogyRoot[tabType].get(subcategory)
      : [];

    // ── Generate exercise ID ───────────────────────────────────────────────
    const generateExerciseId = () =>
      `EX${(exercises.length + 1).toString().padStart(3, '0')}`;

    const exerciseId = exerciseInfo.exerciseId || generateExerciseId();

    // ── Configuration type flags ──────────────────────────────────────────
    const configTypeSettings = {
      mcqMode: exerciseTypeParsed === 'MCQ' || exerciseTypeParsed === 'Combined',
      programmingMode: exerciseTypeParsed === 'Programming' || exerciseTypeParsed === 'Combined',
      combinedMode: exerciseTypeParsed === 'Combined',
      otherMode: exerciseTypeParsed === 'Other',
    };

    // ── Build MCQ / Programming question configurations ───────────────────
    let mcqQuestionConfig = null;
    let programmingQuestionConfig = null;
    let othersQuestionConfig = null;
    let mcqTotalMarks = 0;
    let progTotalMarks = 0;

    // ── MCQ config builder ─────────────────────────────────────────────────
    const buildMCQConfig = (mcqCfg) => {
      const scoreType = mcqCfg.scoreSettings?.scoreType || 'equalDistribution';
      let marksPerQuestion = 0;
      let total = 0;
      if (scoreType === 'equalDistribution') {
        marksPerQuestion = mcqCfg.scoreSettings?.equalDistribution || 0;
        total = (mcqCfg.generalQuestionCount || 0) * marksPerQuestion;
      } else {
        total = mcqCfg.scoreSettings?.totalMarks || 0;
      }
      return {
        cfg: {
          totalMcqQuestions: mcqCfg.generalQuestionCount || 0,
          marksPerQuestion,
          mcqTotalMarks: total,
          attemptLimitEnabled: mcqCfg.attemptLimitEnabled || false,
          submissionAttempts: mcqCfg.submissionAttempts || 1,
          shuffleQuestions: true,
          scoringType: scoreType,
        },
        total,
      };
    };

    // ── Programming config builder ─────────────────────────────────────────
    const buildProgConfig = (progCfg) => {
      const qConfigType = progCfg.questionConfigType || 'general';
      let backendType;
      switch (qConfigType) {
        case 'levelBased': backendType = 'levelBased'; break;
        case 'selectionLevel': backendType = 'selectionLevel'; break;
        default: backendType = qConfigType;
      }

      let total = 0;
      if (qConfigType === 'general' && progCfg.scoreSettings?.scoreType === 'equalDistribution') {
        total = (progCfg.generalQuestionCount || 0) * (progCfg.scoreSettings.equalDistribution || 0);
      } else if (qConfigType === 'levelBased' || qConfigType === 'selectionLevel') {
        const counts = qConfigType === 'selectionLevel' ? progCfg.selectionLevelCounts : progCfg.levelBasedCounts;
        const levelScoring = progCfg.scoreSettings?.levelScoringConfiguration;
        if (levelScoring) {
          ['easy', 'medium', 'hard'].forEach(l => {
            const c = counts?.[l] || 0;
            if (!c) return;
            const s = levelScoring[l];
            if (!s) return;
            if (s.type === 'level_specific' && s.marksPerQuestion) total += c * s.marksPerQuestion;
            else if (s.type === 'question_specific' && s.totalMarks) total += s.totalMarks;
          });
        }
      }

      // Determine backend score type
      let backendScoreType;
      if (qConfigType === 'levelBased' || qConfigType === 'selectionLevel') {
        backendScoreType = 'levelBasedMarks';
      } else {
        switch (progCfg.scoreSettings?.scoreType) {
          case 'equalDistribution': backendScoreType = 'evenMarks'; break;
          case 'questionSpecific': backendScoreType = 'separateMarks'; break;
          case 'levelSpecific': backendScoreType = 'levelBasedMarks'; break;
          default: backendScoreType = progCfg.scoreSettings?.scoreType || 'evenMarks';
        }
      }

      const levelScoringConfig = progCfg.scoreSettings?.levelScoringConfiguration;
      let levelBasedMarks = progCfg.scoreSettings?.levelBasedMarks || { easy: 0, medium: 0, hard: 0 };

      // Populate levelBasedMarks from levelScoringConfiguration when applicable
      if (levelScoringConfig && (qConfigType === 'levelBased' || qConfigType === 'selectionLevel')) {
        const counts = qConfigType === 'selectionLevel' ? progCfg.selectionLevelCounts : progCfg.levelBasedCounts;
        ['easy', 'medium', 'hard'].forEach(l => {
          const c = counts?.[l] || 0;
          if (!c) return;
          const s = levelScoringConfig[l];
          if (s?.type === 'level_specific' && s.marksPerQuestion) {
            levelBasedMarks[l] = s.marksPerQuestion;
            if (!levelScoringConfig[l].questionCount) levelScoringConfig[l].questionCount = c;
          } else if (s?.type === 'question_specific' && s.totalMarks) {
            if (!levelScoringConfig[l].questionCount) levelScoringConfig[l].questionCount = c;
          }
        });
      }

      const cfg = {
        questionConfigType: backendType || 'general',
        attemptLimitEnabled: progCfg.attemptLimitEnabled || false,
        submissionAttempts: progCfg.submissionAttempts || 1,
        questionFlow: progCfg.questionFlow || 'freeFlow',
        compilerFileMode: progCfg.compilerFileMode || 'single',
        allowCodeExecution: true,
        enableTestCases: true,
        showSampleCases: true,
        scoreSettings: {
          scoreType: backendScoreType,
          evenMarks: progCfg.scoreSettings?.scoreType === 'equalDistribution' ? (progCfg.scoreSettings.equalDistribution || 0) : 0,
          separateMarks: progCfg.scoreSettings?.questionSpecific || { general: [], levelBased: { easy: [], medium: [], hard: [] } },
          levelBasedMarks,
          levelScoringConfiguration: levelScoringConfig,
          totalMarks: total,
        },
      };

      if (qConfigType === 'general') {
        cfg.generalQuestionCount = progCfg.generalQuestionCount || 0;
        cfg.generalMarksPerQuestion = progCfg.scoreSettings?.equalDistribution || progCfg.scoreSettings?.evenMarks || 0;
      } else if (qConfigType === 'levelBased') {
        cfg.levelBasedCounts = progCfg.levelBasedCounts || { easy: 0, medium: 0, hard: 0 };
      } else if (qConfigType === 'selectionLevel') {
        cfg.selectionLevelCounts = progCfg.selectionLevelCounts || { easy: 0, medium: 0, hard: 0 };
      }

      return { cfg, total };
    };

    // ── Dispatch to builders by exercise type ──────────────────────────────
    if (exerciseTypeParsed === 'MCQ' || exerciseTypeParsed === 'Combined') {
      if (quesConfig.mcqConfig) {
        const { cfg, total } = buildMCQConfig(quesConfig.mcqConfig);
        mcqQuestionConfig = cfg;
        mcqTotalMarks = total;
      }
    }
    if (exerciseTypeParsed === 'Programming' || exerciseTypeParsed === 'Combined') {
      if (quesConfig.programmingConfig) {
        const { cfg, total } = buildProgConfig(quesConfig.programmingConfig);
        programmingQuestionConfig = cfg;
        progTotalMarks = total;
      }
    }

    if (exerciseTypeParsed === 'Other') {
      // Frontend sends it as othersQuestionConfiguration (from buildFullPayload)
      const othersCfg = quesConfig.othersQuestionConfiguration
        || quesConfig.othersConfig  // fallback for older payloads
        || null;

      if (othersCfg) {
        const qConfigType = othersCfg.questionConfigType || 'general';

        let othersTotal = 0;

        if (qConfigType === 'general') {
          const evenMarks = othersCfg.generalMarksPerQuestion
            || othersCfg.scoreSettings?.evenMarks
            || othersCfg.scoreSettings?.equalDistribution
            || 0;
          const qCount = othersCfg.generalQuestionCount || 0;
          othersTotal = qCount * evenMarks;
        } else {
          // levelBased or selectionLevel — sum from levelScoringConfiguration
          const counts = qConfigType === 'selectionLevel'
            ? othersCfg.selectionLevelCounts
            : othersCfg.levelBasedCounts;
          const levelScoring = othersCfg.scoreSettings?.levelScoringConfiguration;

          if (levelScoring) {
            ['easy', 'medium', 'hard'].forEach(l => {
              const c = counts?.[l] || 0;
              if (!c) return;
              const s = levelScoring[l];
              if (!s) return;
              if (s.type === 'level_specific' && s.marksPerQuestion) othersTotal += c * s.marksPerQuestion;
              else if (s.type === 'question_specific' && s.totalMarks) othersTotal += s.totalMarks;
            });
          } else if (othersCfg.scoreSettings?.levelBasedMarks) {
            const lbm = othersCfg.scoreSettings.levelBasedMarks;
            ['easy', 'medium', 'hard'].forEach(l => {
              othersTotal += (counts?.[l] || 0) * (lbm[l] || 0);
            });
          }
        }

        // Use the totalMarks from scoreSettings if calculated value is 0 (fallback)
        if (!othersTotal) {
          othersTotal = othersCfg.scoreSettings?.totalMarks
            || exerciseInfo.totalMarks
            || 0;
        }

        // Build levelBasedMarks for storage
        let levelBasedMarks = { easy: 0, medium: 0, hard: 0 };
        const levelScoringConfig = othersCfg.scoreSettings?.levelScoringConfiguration;

        if (levelScoringConfig && (qConfigType === 'levelBased' || qConfigType === 'selectionLevel')) {
          const counts = qConfigType === 'selectionLevel'
            ? othersCfg.selectionLevelCounts
            : othersCfg.levelBasedCounts;
          ['easy', 'medium', 'hard'].forEach(l => {
            const c = counts?.[l] || 0;
            if (!c) return;
            const s = levelScoringConfig[l];
            if (s?.type === 'level_specific' && s.marksPerQuestion) {
              levelBasedMarks[l] = s.marksPerQuestion;
              if (!levelScoringConfig[l].questionCount) levelScoringConfig[l].questionCount = c;
            } else if (s?.type === 'question_specific' && s.totalMarks) {
              levelBasedMarks[l] = c > 0 ? s.totalMarks / c : 0;
              if (!levelScoringConfig[l].questionCount) levelScoringConfig[l].questionCount = c;
            }
          });
        }

        othersQuestionConfig = {
          questionConfigType: qConfigType,
          ...(qConfigType === 'general' && {
            generalQuestionCount: othersCfg.generalQuestionCount || 0,
            generalMarksPerQuestion: othersCfg.generalMarksPerQuestion
              || othersCfg.scoreSettings?.evenMarks
              || 0,
          }),
          ...(qConfigType === 'levelBased' && {
            levelBasedCounts: othersCfg.levelBasedCounts || { easy: 0, medium: 0, hard: 0 },
          }),
          ...(qConfigType === 'selectionLevel' && {
            selectionLevelCounts: othersCfg.selectionLevelCounts || { easy: 0, medium: 0, hard: 0 },
          }),
          scoreSettings: {
            scoreType: qConfigType === 'general' ? 'evenMarks' : 'levelBasedMarks',
            evenMarks: othersCfg.scoreSettings?.evenMarks
              || othersCfg.generalMarksPerQuestion
              || 0,
            levelBasedMarks,
            levelScoringConfiguration: levelScoringConfig || undefined,
            totalMarks: othersTotal,
          },
          questionFlow: othersCfg.questionFlow || 'freeFlow',
          attemptLimitEnabled: othersCfg.attemptLimitEnabled || false,
          submissionAttempts: othersCfg.submissionAttempts || 1,
        };

        progTotalMarks = othersTotal;
      }
    }
    // ── Build availabilityPeriod (endDate always stored) ──────────────────
    const availabilityPeriodData = buildAvailabilityPeriod(availPeriod);

    // ── Build approvalWorkflow (snapshot from course hierarchy) ───────────
    let approvalWorkflowData = null;
    if (availabilityPeriodData.requiresAdminApproval) {
      const courseIdForWorkflow = resolveCourseId(entity);
      approvalWorkflowData = await buildInitialApprovalWorkflow(courseIdForWorkflow);
      if (!approvalWorkflowData) {
        return res.status(400).json({
          message: [{
            key: 'error',
            value: 'Approval is required for this exercise, but no approver could be resolved — the course has no Approval Hierarchy and the institution has no L&D role to default to. Configure the hierarchy on the Approvals page first.'
          }]
        });
      }
    }

    // ── Build notificationSettings (full, separate from grades) ───────────
    // const notificationSettingsData = {
    //   notifyUsers: notifSettings.notifyUsers || false,
    //   notifyGmail: notifSettings.notifyGmail || false,
    //   notifyWhatsApp: notifSettings.notifyWhatsApp || false,
    //   gradeSheet: notifSettings.gradeSheet !== undefined ? notifSettings.gradeSheet : true,
    //   notifyGradersSubmissions: notifSettings.notifyGradersSubmissions || false,
    //   notifyGradersLateSubmissions: notifSettings.notifyGradersLateSubmissions || false,
    //   notifyStudent: notifSettings.notifyStudent !== undefined ? notifSettings.notifyStudent : true,
    // };

    // ── Build notificationSettings (full, separate from grades) ───────────
    const notificationSettingsData = {
      // Global notification settings
      notifyUsers: notifSettings.notifyUsers || false,
      notifyGmail: notifSettings.notifyGmail || false,
      notifyWhatsApp: notifSettings.notifyWhatsApp || false,
      gradeSheet: notifSettings.gradeSheet !== undefined ? notifSettings.gradeSheet : true,

      // Grader submission notifications with channel support
      notifyGradersSubmissions: notifSettings.notifyGradersSubmissions || false,
      notifyGradersSubmissionsChannels: {
        dashboard: notifSettings.notifyGradersSubmissionsChannels?.dashboard ?? false,
        gmail: notifSettings.notifyGradersSubmissionsChannels?.gmail ?? false,
        whatsapp: notifSettings.notifyGradersSubmissionsChannels?.whatsapp ?? false,
      },

      // Grader late submission notifications with channel support
      notifyGradersLateSubmissions: notifSettings.notifyGradersLateSubmissions || false,
      notifyGradersLateSubmissionsChannels: {
        dashboard: notifSettings.notifyGradersLateSubmissionsChannels?.dashboard ?? false,
        gmail: notifSettings.notifyGradersLateSubmissionsChannels?.gmail ?? false,
        whatsapp: notifSettings.notifyGradersLateSubmissionsChannels?.whatsapp ?? false,
      },

      // Student notifications with channel support
      notifyStudent: notifSettings.notifyStudent !== undefined ? notifSettings.notifyStudent : true,
      notifyStudentChannels: {
        dashboard: notifSettings.notifyStudentChannels?.dashboard ?? false,
        gmail: notifSettings.notifyStudentChannels?.gmail ?? false,
        whatsapp: notifSettings.notifyStudentChannels?.whatsapp ?? false,
      },
    };

    // ── Build gradeSettings with auto-computed values ──────────────────────
    const exerciseInfoForGrade = {
      totalMarks: exerciseInfo.totalMarks || 0,
      totalMarksMCQ: exerciseInfo.totalMarksMCQ || (exerciseTypeParsed === 'MCQ' ? (exerciseInfo.totalMarks || 0) : 0),
      totalMarksProgramming: exerciseInfo.totalMarksProgramming || ((exerciseTypeParsed === 'Programming' || exerciseTypeParsed === 'Other') ? (exerciseInfo.totalMarks || 0) : 0),
    };
    const gradeSettingsData = computeAutoGrades(exerciseTypeParsed, exerciseInfoForGrade, gradeSettingsRaw);

    // ── Build additionalOptions ────────────────────────────────────────────
    const additionalOptionsData = {
      anonymousSubmissions: additOptions.anonymousSubmissions || false,
      hideGraderIdentity: additOptions.hideGraderIdentity || false,
    };

    // ── Assemble the new exercise document ────────────────────────────────
    const totalMarksForInfo = exerciseTypeParsed === 'Combined'
      ? (exerciseInfo.totalMarksMCQ || 0) + (exerciseInfo.totalMarksProgramming || 0)
      : (exerciseInfo.totalMarks || 0);

    const newExercise = {
      _id: new mongoose.Types.ObjectId(),

      exerciseType: exerciseTypeParsed,
      isGraded: isGraded !== false,
      stepsSaved: Array.isArray(stepsSaved) ? stepsSaved : [],
      configurationType: configTypeSettings,
      // Phase 2 / 5 / 6 — question source, custom matrix, save-to-bank flag.
      questionSource: questionSource || null,
      customDistribution: customDistribution || null,
      customSources: Array.isArray(customSources) ? customSources : [],
      // Section-based Custom mix's per-section split (keyed by sectionId).
      // Non-section flow sends {}. Persist as-is (schema is Mixed).
      customDistributionBySection: customDistributionBySection && typeof customDistributionBySection === 'object'
        ? customDistributionBySection
        : {},
      saveToBank: !!saveToBank,
      // Combined-only MCQ-part source (null = inherit questionSource).
      questionSourceMcq: questionSourceMcq || null,
      customSourcesMcq: Array.isArray(customSourcesMcq) ? customSourcesMcq : [],
      customDistributionMcq: customDistributionMcq || null,
      // Evaluation Method config ({ method }). null when the client didn't
      // send one — downstream reads that as test-case based.
      evaluationMethod: parseIfNeeded(evaluationMethod) || null,

      exerciseInformation: {
        exerciseId: exerciseId,
        exerciseName: exerciseInfo.exerciseName || '',
        description: exerciseInfo.description || '',
        exerciseLevel: exerciseInfo.exerciseLevel || 'intermediate',
        exerciseType: exerciseInfo.exerciseType || exerciseTypeParsed || '',
        testType: exerciseInfo.testType || 'mock',
        totalDuration: exerciseInfo.totalDuration || 1,
        totalMarksMCQ: exerciseTypeParsed === 'MCQ' || exerciseTypeParsed === 'Combined'
          ? (exerciseInfo.totalMarksMCQ !== undefined ? exerciseInfo.totalMarksMCQ : mcqTotalMarks) : 0,
        totalMarksProgramming: exerciseTypeParsed === 'Programming' || exerciseTypeParsed === 'Other' || exerciseTypeParsed === 'Combined'
          ? (exerciseInfo.totalMarksProgramming !== undefined ? exerciseInfo.totalMarksProgramming : progTotalMarks) : 0,
        totalMarks: exerciseInfo.totalMarks || totalMarksForInfo,
        selectedModule: exerciseInfo.selectedModule || '',
        selectedLanguages: exerciseInfo.selectedLanguages || [],
        isSectionBased: exerciseInfo.isSectionBased || false,
        sectionBasedDuration: exerciseInfo.sectionBasedDuration || false,
      },

      questionConfiguration: {},

      // Availability (endDate is always stored)
      availabilityPeriod: availabilityPeriodData,

      // Sequential approval workflow snapshot (null when toggle is off)
      approvalWorkflow: approvalWorkflowData,

      // Notifications (separate from grades)
      notificationSettings: notificationSettingsData,
      // Keep legacy field populated for backward compatibility
      notificatonandGradeSettings: {
        notifyUsers: notifSettings.notifyUsers || false,
        notifyGmail: notifSettings.notifyGmail || false,
        notifyWhatsApp: notifSettings.notifyWhatsApp || false,
        gradeSheet: notifSettings.gradeSheet !== undefined ? notifSettings.gradeSheet : true,
      },

      // Grade settings (auto-computed + user-entered)
      gradeSettings: gradeSettingsData,

      // Additional options
      additionalOptions: additionalOptionsData,

      // Question behavior flags
      questionBehavior: {
        allQuestionsRequired: questionBehavior?.allQuestionsRequired !== undefined
          ? questionBehavior.allQuestionsRequired
          : true,
      },

      // Select Assessment Content step — topics covered + instructions shown to students.
      selectedTopics: Array.isArray(selectedTopics) ? selectedTopics : [],
      instructions: typeof instructions === 'string' ? instructions : '',

      questions: quesConfig.questions || [],
      createdAt: new Date(),
      createdBy: req.user?.email || 'system',
      version: 1,
    };

    // ── Attach programming settings ────────────────────────────────────────
    if ((exerciseTypeParsed === 'Programming' || exerciseTypeParsed === 'Combined') && progSettings) {
      newExercise.programmingSettings = {
        selectedModule: progSettings.selectedModule || null,
        selectedLanguages: progSettings.selectedLanguages || [],
      };
    }

    // ── Attach question configurations ─────────────────────────────────────
    if (mcqQuestionConfig) newExercise.questionConfiguration.mcqQuestionConfiguration = mcqQuestionConfig;
    if (programmingQuestionConfig) newExercise.questionConfiguration.programmingQuestionConfiguration = programmingQuestionConfig;
    if (othersQuestionConfig) newExercise.questionConfiguration.othersQuestionConfiguration = othersQuestionConfig;

    // ── Persist ────────────────────────────────────────────────────────────
    // Decide notification BEFORE save so we can stamp notifiedAt in the same
    // write (avoids a second entity.save() round-trip).
    const willNotifyStep1 = shouldFireStep1Notification(newExercise);
    if (willNotifyStep1) {
      newExercise.approvalWorkflow.steps[0].notifiedAt = new Date();
    }
    exercises.push(newExercise);
    pedagogyRoot[tabType].set(subcategory, exercises);
    entity.markModified(`${pedagogyPath}.${tabType}`);
    entity.updatedBy = req.user?.email || 'system';
    entity.updatedAt = new Date();
    await entity.save();

    // Phase 6 — When the teacher opts in via saveToBank, clone the new
    // exercise's attached questions into the institution's Question Bank.
    if (newExercise.saveToBank && Array.isArray(newExercise.questions) && newExercise.questions.length > 0) {
      const institutionId = req.user?.institution?._id || req.user?.institution;
      cloneQuestionsToBank({
        institutionId,
        exerciseId: newExercise._id.toString(),
        questions: newExercise.questions,
        actorEmail: req.user?.email,
      });
    }

    // ── Notify step-1 approvers when the gate says so (non-blocking) ───────
    // Gate skips when approvalScope="settings_and_questions" and questions
    // are not yet fully added — that path fires later from addQuestion.
    if (willNotifyStep1) {
      const courseIdForNotify = resolveCourseId(entity);
      const courseDoc = courseIdForNotify
        ? await CourseStructure.findById(courseIdForNotify).select('courseName').lean()
        : null;
      notifyApproversForStep({
        courseId: courseIdForNotify,
        courseName: courseDoc?.courseName,
        step: newExercise.approvalWorkflow.steps[0],
        exerciseName: newExercise.exerciseInformation?.exerciseName,
        exerciseId: newExercise._id,
      }).catch((e) => console.warn('notifyApproversForStep failed:', e.message));
    }

    // ── Build response config ──────────────────────────────────────────────
    let responseConfig = {};
    if (exerciseTypeParsed === 'MCQ') responseConfig = { mode: 'mcq', config: mcqQuestionConfig };
    else if (exerciseTypeParsed === 'Programming') responseConfig = { mode: 'programming', config: programmingQuestionConfig };
    else if (exerciseTypeParsed === 'Other') responseConfig = { mode: 'other', config: othersQuestionConfig };
    else if (exerciseTypeParsed === 'Combined') responseConfig = { mode: 'combined', mcqConfig: mcqQuestionConfig, programmingConfig: programmingQuestionConfig };

    return res.status(201).json({
      message: [{ key: 'success', value: `Exercise added successfully to ${subcategory}` }],
      data: {
        exercise: newExercise,
        configuration: responseConfig,
        gradeSettings: gradeSettingsData,
        notificationSettings: notificationSettingsData,
        additionalOptions: additionalOptionsData,
        subcategory,
        tabType,
        entityType: type,
        entityId: id,
        totalExercises: exercises.length,
        generatedExerciseId: exerciseId,
        location: { section: tabType, subcategory, index: exercises.length - 1 },
      },
    });

  } catch (err) {
    console.error('❌ Add exercise error:', err);
    res.status(500).json({
      message: [{ key: 'error', value: `Internal server error: ${err.message}` }],
    });
  }
};

// =============================================================================
// updateExercise — FULL UPDATED VERSION
// NOTE: computeAutoGrades, buildAvailabilityPeriod helpers must be defined
//       in the same file (see addExercise.js for their implementations).
// =============================================================================
// =============================================================================
// updateExercise — FULL UPDATED VERSION
// NOTE: computeAutoGrades, buildAvailabilityPeriod helpers must be defined
//       in the same file (see addExercise.js for their implementations).
// =============================================================================
exports.updateExercise = async (req, res) => {
  try {
    const { type, id, exerciseId } = req.params;
    const {
      tabType,
      subcategory,
      exerciseType,
      programmingSettings,
      exerciseInformation,
      availabilityPeriod,
      questionConfiguration,
      questionBehavior,       // allQuestionsRequired flag
      notificationSettings,   // from frontend
      notificationGradeSettings, // legacy field name (keep support)
      gradeSettings,          // NEW
      additionalOptions,      // NEW
      isGraded,               // Graded / Non-Graded toggle
      stepsSaved,             // Array of step titles explicitly saved by user
      selectedTopics,         // NEW — Select Assessment Content step
      instructions,           // NEW — Select Assessment Content step
      // ── Question Source feature (Phase 2 / 5 / 6) ──────────────────────────
      questionSource,         // 'scratch' | 'ai' | 'thirdParty' | 'custom' | null
      customDistribution,     // { easy:{scratch,ai,thirdParty}, medium:{...}, hard:{...} }
      customDistributionBySection, // { <sectionId>: { easy:{...}, medium:{...}, hard:{...} } } — per-section split
      customSources,          // ['scratch','ai','thirdParty'] — subset for Custom
      saveToBank,             // boolean — clone attached questions to Question Bank
      questionSourceMcq,      // Combined-only: MCQ part's own source (null = inherit)
      customSourcesMcq,       // Combined-only: ['scratch','ai'] for MCQ Custom
      customDistributionMcq,  // Combined-only: { scratch, ai, thirdParty } single cell
      evaluationMethod,     // Evaluation Method: { method: 'testcase' | 'ai' }
    } = req.body;

    // ── Validate ──────────────────────────────────────────────────────────
    if (!modelMap[type]) {
      return res.status(400).json({
        message: [{ key: 'error', value: `Invalid entity type: ${type}.` }]
      });
    }
    if (!subcategory) {
      return res.status(400).json({ message: [{ key: 'error', value: 'Subcategory is required.' }] });
    }
    if (!tabType) {
      return res.status(400).json({ message: [{ key: 'error', value: 'tabType is required (I_Do, We_Do, You_Do)' }] });
    }

    // ── Helpers ────────────────────────────────────────────────────────────
    const parseIfNeeded = (data) => {
      if (typeof data === 'string') {
        try { return JSON.parse(data); } catch { return data; }
      }
      return data;
    };

    const transformQuestionDescription = (question) => {
      if (!question) return question;
      if (question.description && typeof question.description === 'string') {
        question.description = { text: question.description, imageUrl: null, imageAlignment: 'left', imageSizePercent: 100 };
      }
      return question;
    };

    // ── Parse all incoming ─────────────────────────────────────────────────
    const parsedExerciseType = exerciseType ? parseIfNeeded(exerciseType) : null;
    const parsedExerciseInfo = exerciseInformation ? parseIfNeeded(exerciseInformation) : null;
    const parsedProgSettings = programmingSettings ? parseIfNeeded(programmingSettings) : null;
    const parsedAvailPeriod = availabilityPeriod ? parseIfNeeded(availabilityPeriod) : null;
    const parsedQuesConfig = questionConfiguration ? parseIfNeeded(questionConfiguration) : null;
    // Accept either field name for notifications
    const parsedNotifSettings = notificationSettings
      ? parseIfNeeded(notificationSettings)
      : (notificationGradeSettings ? parseIfNeeded(notificationGradeSettings) : null);
    const parsedGradeSettings = gradeSettings ? parseIfNeeded(gradeSettings) : null;
    const parsedAdditOptions = additionalOptions ? parseIfNeeded(additionalOptions) : null;

    // ── Find entity ───────────────────────────────────────────────────────
    const { model } = modelMap[type];
    const entity = await model.findById(id);

    if (!entity) return res.status(404).json({ message: [{ key: 'error', value: `${type} with ID ${id} not found` }] });
    // ── Resources by Batch ───────────────────────────────────────────────
    // Which I_Do/We_Do/You_Do set this request belongs to. For a shared
    // element that is the course-level `pedagogy`; for one ticked batch-wise
    // in Course Setup it is this batch's own `batchPedagogy.<batchId>`.
    // Resolving it here means every lookup and markModified below lands in
    // the right place — without it We Do and You Do would keep reading the
    // course-level set while the batch strip claimed otherwise.
    const { container: pedagogyRoot, basePath: pedagogyPath } =
      await resolvePedagogyScope(entity, tabType, req);

    if (!pedagogyRoot) return res.status(404).json({ message: [{ key: 'error', value: 'Pedagogy structure not found' }] });
    if (!pedagogyRoot[tabType]) return res.status(404).json({ message: [{ key: 'error', value: `Pedagogy tab '${tabType}' not found` }] });
    if (!pedagogyRoot[tabType].has(subcategory))
      return res.status(404).json({ message: [{ key: 'error', value: `Subcategory '${subcategory}' not found in ${tabType}` }] });

    const exercises = pedagogyRoot[tabType].get(subcategory);
    const exerciseIndex = exercises.findIndex(ex => ex._id.toString() === exerciseId);

    if (exerciseIndex === -1) {
      return res.status(404).json({
        message: [{ key: 'error', value: `Exercise with ID ${exerciseId} not found in subcategory '${subcategory}'` }]
      });
    }

    const existingExercise = exercises[exerciseIndex].toObject
      ? exercises[exerciseIndex].toObject()
      : { ...exercises[exerciseIndex] };
    delete existingExercise.$__;
    delete existingExercise.$isNew;
    delete existingExercise._doc;

    const finalExerciseType = parsedExerciseType || existingExercise.exerciseType;

    const configTypeSettings = {
      mcqMode: finalExerciseType === 'MCQ' || finalExerciseType === 'Combined',
      programmingMode: finalExerciseType === 'Programming' || finalExerciseType === 'Combined',
      combinedMode: finalExerciseType === 'Combined',
      otherMode: finalExerciseType === 'Other',
    };

    // ── Re-use question config builders (same logic as addExercise) ────────
    let mcqQuestionConfig = existingExercise.questionConfiguration?.mcqQuestionConfiguration || null;
    let programmingQuestionConfig = existingExercise.questionConfiguration?.programmingQuestionConfiguration || null;
    let othersQuestionConfig = existingExercise.questionConfiguration?.othersQuestionConfiguration || null;
    let mcqTotalMarks = existingExercise.exerciseInformation?.totalMarksMCQ || 0;
    let progTotalMarks = existingExercise.exerciseInformation?.totalMarksProgramming || 0;

    if (parsedQuesConfig) {
      // ── MCQ config ───────────────────────────────────────────────────────
      if (parsedQuesConfig.mcqConfig) {
        const mcqCfg = parsedQuesConfig.mcqConfig;
        const scoreType = mcqCfg.scoreSettings?.scoreType || 'equalDistribution';
        let marksPerQuestion = 0;
        if (scoreType === 'equalDistribution') {
          marksPerQuestion = mcqCfg.scoreSettings?.equalDistribution || 0;
          mcqTotalMarks = (mcqCfg.generalQuestionCount || 0) * marksPerQuestion;
        } else {
          mcqTotalMarks = mcqCfg.scoreSettings?.totalMarks || 0;
        }
        mcqQuestionConfig = {
          totalMcqQuestions: mcqCfg.generalQuestionCount || 0,
          marksPerQuestion,
          mcqTotalMarks,
          attemptLimitEnabled: mcqCfg.attemptLimitEnabled || false,
          submissionAttempts: mcqCfg.submissionAttempts || 1,
          shuffleQuestions: true,
          scoringType: scoreType,
        };
      }

      // ── Programming config ───────────────────────────────────────────────
      if (parsedQuesConfig.programmingConfig) {
        const progCfg = parsedQuesConfig.programmingConfig;
        const qConfigType = progCfg.questionConfigType || 'general';
        let backendType;
        switch (qConfigType) {
          case 'levelBased': backendType = 'levelBased'; break;
          case 'selectionLevel': backendType = 'selectionLevel'; break;
          default: backendType = qConfigType;
        }

        // Recalculate total marks
        progTotalMarks = 0;
        if (qConfigType === 'general' && progCfg.scoreSettings?.scoreType === 'equalDistribution') {
          progTotalMarks = (progCfg.generalQuestionCount || 0) * (progCfg.scoreSettings.equalDistribution || 0);
        } else if (qConfigType === 'levelBased' || qConfigType === 'selectionLevel') {
          const counts = qConfigType === 'selectionLevel' ? progCfg.selectionLevelCounts : progCfg.levelBasedCounts;
          const levelScoring = progCfg.scoreSettings?.levelScoringConfiguration;
          if (levelScoring) {
            ['easy', 'medium', 'hard'].forEach(l => {
              const c = counts?.[l] || 0; if (!c) return;
              const s = levelScoring[l]; if (!s) return;
              if (s.type === 'level_specific' && s.marksPerQuestion) progTotalMarks += c * s.marksPerQuestion;
              else if (s.type === 'question_specific' && s.totalMarks) progTotalMarks += s.totalMarks;
            });
          }
        }

        let backendScoreType;
        if (qConfigType === 'levelBased' || qConfigType === 'selectionLevel') {
          backendScoreType = 'levelBasedMarks';
        } else {
          switch (progCfg.scoreSettings?.scoreType) {
            case 'equalDistribution': backendScoreType = 'evenMarks'; break;
            case 'questionSpecific': backendScoreType = 'separateMarks'; break;
            case 'levelSpecific': backendScoreType = 'levelBasedMarks'; break;
            default: backendScoreType = progCfg.scoreSettings?.scoreType || 'evenMarks';
          }
        }

        const levelScoringConfig = progCfg.scoreSettings?.levelScoringConfiguration;
        let levelBasedMarks = progCfg.scoreSettings?.levelBasedMarks || { easy: 0, medium: 0, hard: 0 };

        if (levelScoringConfig && (qConfigType === 'levelBased' || qConfigType === 'selectionLevel')) {
          const counts = qConfigType === 'selectionLevel' ? progCfg.selectionLevelCounts : progCfg.levelBasedCounts;
          ['easy', 'medium', 'hard'].forEach(l => {
            const c = counts?.[l] || 0; if (!c) return;
            const s = levelScoringConfig[l];
            if (s?.type === 'level_specific' && s.marksPerQuestion) {
              levelBasedMarks[l] = s.marksPerQuestion;
              if (!levelScoringConfig[l].questionCount) levelScoringConfig[l].questionCount = c;
            } else if (s?.type === 'question_specific' && s.totalMarks) {
              if (!levelScoringConfig[l].questionCount) levelScoringConfig[l].questionCount = c;
            }
          });
        }

        programmingQuestionConfig = {
          questionConfigType: backendType || 'general',
          attemptLimitEnabled: progCfg.attemptLimitEnabled || false,
          submissionAttempts: progCfg.submissionAttempts || 1,
          questionFlow: progCfg.questionFlow || 'freeFlow',
          compilerFileMode: progCfg.compilerFileMode || 'single',
          allowCodeExecution: true,
          enableTestCases: true,
          showSampleCases: true,
          scoreSettings: {
            scoreType: backendScoreType,
            evenMarks: progCfg.scoreSettings?.scoreType === 'equalDistribution' ? (progCfg.scoreSettings.equalDistribution || 0) : 0,
            separateMarks: progCfg.scoreSettings?.questionSpecific || { general: [], levelBased: { easy: [], medium: [], hard: [] } },
            levelBasedMarks,
            levelScoringConfiguration: levelScoringConfig,
            totalMarks: progTotalMarks,
          },
        };
        if (qConfigType === 'general') {
          programmingQuestionConfig.generalQuestionCount = progCfg.generalQuestionCount || 0;
          programmingQuestionConfig.generalMarksPerQuestion = progCfg.scoreSettings?.equalDistribution || progCfg.scoreSettings?.evenMarks || 0;
        } else if (qConfigType === 'levelBased') {
          programmingQuestionConfig.levelBasedCounts = progCfg.levelBasedCounts || { easy: 0, medium: 0, hard: 0 };
        } else if (qConfigType === 'selectionLevel') {
          programmingQuestionConfig.selectionLevelCounts = progCfg.selectionLevelCounts || { easy: 0, medium: 0, hard: 0 };
        }
      }

      // ── Others config (NEW schema, replaces the old flat one) ──────────────────
      if (parsedQuesConfig.othersQuestionConfiguration || parsedQuesConfig.othersConfig) {
        const othersCfg = parsedQuesConfig.othersQuestionConfiguration
          || parsedQuesConfig.othersConfig;
        const qConfigType = othersCfg.questionConfigType || 'general';

        let othersTotal = 0;
        if (qConfigType === 'general') {
          const evenMarks = othersCfg.generalMarksPerQuestion
            || othersCfg.scoreSettings?.evenMarks || 0;
          othersTotal = (othersCfg.generalQuestionCount || 0) * evenMarks;
        } else {
          const counts = qConfigType === 'selectionLevel'
            ? othersCfg.selectionLevelCounts
            : othersCfg.levelBasedCounts;
          const levelScoring = othersCfg.scoreSettings?.levelScoringConfiguration;
          if (levelScoring) {
            ['easy', 'medium', 'hard'].forEach(l => {
              const c = counts?.[l] || 0; if (!c) return;
              const s = levelScoring[l]; if (!s) return;
              if (s.type === 'level_specific' && s.marksPerQuestion)
                othersTotal += c * s.marksPerQuestion;
              else if (s.type === 'question_specific' && s.totalMarks)
                othersTotal += s.totalMarks;
            });
          }
        }

        if (!othersTotal) {
          othersTotal = othersCfg.scoreSettings?.totalMarks
            || parsedExerciseInfo?.totalMarks
            || existingExercise.exerciseInformation?.totalMarks || 0;
        }

        othersQuestionConfig = {
          questionConfigType: qConfigType,
          ...(qConfigType === 'general' && {
            generalQuestionCount: othersCfg.generalQuestionCount || 0,
            generalMarksPerQuestion: othersCfg.generalMarksPerQuestion
              || othersCfg.scoreSettings?.evenMarks || 0,
          }),
          ...(qConfigType === 'levelBased' && {
            levelBasedCounts: othersCfg.levelBasedCounts || { easy: 0, medium: 0, hard: 0 },
          }),
          ...(qConfigType === 'selectionLevel' && {
            selectionLevelCounts: othersCfg.selectionLevelCounts || { easy: 0, medium: 0, hard: 0 },
          }),
          scoreSettings: {
            scoreType: qConfigType === 'general' ? 'evenMarks' : 'levelBasedMarks',
            evenMarks: othersCfg.generalMarksPerQuestion
              || othersCfg.scoreSettings?.evenMarks || 0,
            levelBasedMarks: othersCfg.scoreSettings?.levelBasedMarks
              || { easy: 0, medium: 0, hard: 0 },
            // ✅ Preserved on update
            levelScoringConfiguration: othersCfg.scoreSettings?.levelScoringConfiguration,
            totalMarks: othersTotal,
          },
          questionFlow: othersCfg.questionFlow || 'freeFlow',
          attemptLimitEnabled: othersCfg.attemptLimitEnabled || false,
          submissionAttempts: othersCfg.submissionAttempts || 1,
        };
        progTotalMarks = othersTotal;
      }
      // Direct overrides (if frontend sends already-formatted config objects)
      if (parsedQuesConfig.mcqQuestionConfiguration) {
        mcqQuestionConfig = parsedQuesConfig.mcqQuestionConfiguration;
        mcqTotalMarks = mcqQuestionConfig.mcqTotalMarks || 0;
      }
      if (parsedQuesConfig.programmingQuestionConfiguration) {
        programmingQuestionConfig = parsedQuesConfig.programmingQuestionConfiguration;
        progTotalMarks = programmingQuestionConfig.scoreSettings?.totalMarks
          || (programmingQuestionConfig.generalQuestionCount || 0) * (programmingQuestionConfig.scoreSettings?.evenMarks || 0)
          || 0;
      }

      if (parsedQuesConfig.questions) {
        if (Array.isArray(parsedQuesConfig.questions)) {
          parsedQuesConfig.questions = parsedQuesConfig.questions.map(q => transformQuestionDescription(q));
        }
      }
    }

    // ── Build updated exercise (spread existing, apply changes) ────────────
    const updatedExercise = {
      ...existingExercise,
      ...(parsedExerciseType && { exerciseType: finalExerciseType }),
      isGraded: isGraded !== undefined ? isGraded !== false : (existingExercise.isGraded !== false),
      stepsSaved: Array.isArray(stepsSaved) ? stepsSaved : (existingExercise.stepsSaved || []),
      configurationType: configTypeSettings,
      // Select Assessment Content step — preserve when not re-sent.
      selectedTopics: Array.isArray(selectedTopics) ? selectedTopics : (existingExercise.selectedTopics || []),
      instructions: typeof instructions === 'string' ? instructions : (existingExercise.instructions || ''),
      // Phase 2 / 5 / 6 — teacher's source choice + custom matrix + save-to-bank flag.
      // Merge from incoming, else preserve existing.
      questionSource: questionSource !== undefined ? questionSource : (existingExercise.questionSource || null),
      customDistribution: customDistribution !== undefined ? customDistribution : (existingExercise.customDistribution || null),
      customSources: Array.isArray(customSources) ? customSources : (existingExercise.customSources || []),
      // Section-based per-section split — merge-or-preserve, same as the
      // aggregate customDistribution above. Empty object is a valid value
      // (non-section flow / trainer cleared it) so use `!== undefined`.
      customDistributionBySection: customDistributionBySection !== undefined
        ? (customDistributionBySection && typeof customDistributionBySection === 'object' ? customDistributionBySection : {})
        : (existingExercise.customDistributionBySection || {}),
      saveToBank: typeof saveToBank === 'boolean' ? saveToBank : !!existingExercise.saveToBank,
      // Combined-only MCQ-part source — merge-or-preserve like the above.
      questionSourceMcq: questionSourceMcq !== undefined ? questionSourceMcq : (existingExercise.questionSourceMcq || null),
      customSourcesMcq: Array.isArray(customSourcesMcq) ? customSourcesMcq : (existingExercise.customSourcesMcq || []),
      customDistributionMcq: customDistributionMcq !== undefined ? customDistributionMcq : (existingExercise.customDistributionMcq || null),
      // Evaluation Method — merge-or-preserve, so a step-scoped save that
      // doesn't own this step leaves the stored config untouched.
      evaluationMethod: evaluationMethod !== undefined
        ? (parseIfNeeded(evaluationMethod) || null)
        : (existingExercise.evaluationMethod || null),
      updatedAt: new Date(),
      updatedBy: req.user?.email || 'system',
      version: (existingExercise.version || 1) + 1,
    };

    // ── Exercise information ───────────────────────────────────────────────
    if (parsedExerciseInfo) {
      updatedExercise.exerciseInformation = {
        ...existingExercise.exerciseInformation,
        exerciseId: parsedExerciseInfo.exerciseId || existingExercise.exerciseInformation?.exerciseId,
        exerciseName: parsedExerciseInfo.exerciseName || existingExercise.exerciseInformation?.exerciseName,
        description: parsedExerciseInfo.description !== undefined ? parsedExerciseInfo.description : existingExercise.exerciseInformation?.description,
        exerciseLevel: parsedExerciseInfo.exerciseLevel || existingExercise.exerciseInformation?.exerciseLevel,
        exerciseType: parsedExerciseInfo.exerciseType || existingExercise.exerciseInformation?.exerciseType || '',
        testType: parsedExerciseInfo.testType || existingExercise.exerciseInformation?.testType || 'mock',
        totalDuration: parsedExerciseInfo.totalDuration !== undefined ? parsedExerciseInfo.totalDuration : existingExercise.exerciseInformation?.totalDuration,
        totalMarksMCQ: finalExerciseType === 'MCQ' || finalExerciseType === 'Combined'
          ? (parsedExerciseInfo.totalMarksMCQ !== undefined ? parsedExerciseInfo.totalMarksMCQ : mcqTotalMarks) : 0,
        totalMarksProgramming: finalExerciseType === 'Programming' || finalExerciseType === 'Other' || finalExerciseType === 'Combined'
          ? (parsedExerciseInfo.totalMarksProgramming !== undefined ? parsedExerciseInfo.totalMarksProgramming : progTotalMarks) : 0,
        totalMarks: parsedExerciseInfo.totalMarks || (mcqTotalMarks + progTotalMarks),
        selectedModule: parsedExerciseInfo.selectedModule !== undefined ? parsedExerciseInfo.selectedModule : existingExercise.exerciseInformation?.selectedModule || '',
        selectedLanguages: parsedExerciseInfo.selectedLanguages !== undefined ? parsedExerciseInfo.selectedLanguages : existingExercise.exerciseInformation?.selectedLanguages || [],
        isSectionBased: parsedExerciseInfo.isSectionBased !== undefined ? parsedExerciseInfo.isSectionBased : existingExercise.exerciseInformation?.isSectionBased || false,
        sectionBasedDuration: parsedExerciseInfo.sectionBasedDuration !== undefined ? parsedExerciseInfo.sectionBasedDuration : existingExercise.exerciseInformation?.sectionBasedDuration || false,
      };
    }

    // ── Programming settings ───────────────────────────────────────────────
    if (parsedProgSettings) {
      updatedExercise.programmingSettings = {
        selectedModule: parsedProgSettings.selectedModule || existingExercise.programmingSettings?.selectedModule,
        selectedLanguages: parsedProgSettings.selectedLanguages || existingExercise.programmingSettings?.selectedLanguages || [],
      };
    }

    // ── Question configuration ─────────────────────────────────────────────
    if (parsedQuesConfig) {
      if (!updatedExercise.questionConfiguration) updatedExercise.questionConfiguration = {};
      if (mcqQuestionConfig) updatedExercise.questionConfiguration.mcqQuestionConfiguration = mcqQuestionConfig;
      if (programmingQuestionConfig) updatedExercise.questionConfiguration.programmingQuestionConfiguration = programmingQuestionConfig;
      if (othersQuestionConfig) updatedExercise.questionConfiguration.othersQuestionConfiguration = othersQuestionConfig;
      if (parsedQuesConfig.questions) updatedExercise.questions = parsedQuesConfig.questions;
    }

    // ── Question behavior ──────────────────────────────────────────────────
    if (questionBehavior !== undefined) {
      updatedExercise.questionBehavior = {
        allQuestionsRequired: questionBehavior?.allQuestionsRequired !== undefined
          ? questionBehavior.allQuestionsRequired
          : (existingExercise.questionBehavior?.allQuestionsRequired !== undefined
            ? existingExercise.questionBehavior.allQuestionsRequired
            : true),
      };
    }

    // ── Availability period ────────────────────────────────────────────────
    if (parsedAvailPeriod) {
      const safeD = (v) => {
        if (!v || v === 'null' || v === 'undefined') return undefined;
        const d = new Date(v);
        return isNaN(d.getTime()) ? undefined : d;
      };
      const existAvail = existingExercise.availabilityPeriod || {};
      const prev = (f) => existAvail[f] ? new Date(existAvail[f]) : undefined;

      const startDate = safeD(parsedAvailPeriod.startDate) || prev('startDate');
      // endDate = submission deadline; fall back to existing
      const endDate = safeD(parsedAvailPeriod.endDate) || prev('endDate');
      const cutOffEnabled = parsedAvailPeriod.cutOffEnabled !== undefined
        ? !!parsedAvailPeriod.cutOffEnabled
        : !!(existAvail.cutOffEnabled ?? false);
      // cutOffDate: only keep when toggle is ON
      const cutOffDate = cutOffEnabled
        ? (safeD(parsedAvailPeriod.cutOffDate) || prev('cutOffDate'))
        : undefined;
      const remindEnabled = parsedAvailPeriod.remindGradeByEnabled !== undefined
        ? !!parsedAvailPeriod.remindGradeByEnabled
        : !!(existAvail.remindGradeByEnabled ?? false);
      const remindGradeBy = remindEnabled
        ? (safeD(parsedAvailPeriod.remindGradeBy) || prev('remindGradeBy'))
        : undefined;
      const gracePeriodOn = parsedAvailPeriod.gracePeriodAllowed !== undefined
        ? !!(parsedAvailPeriod.gracePeriodAllowed || parsedAvailPeriod.gracePeriodEnabled)
        : !!(existAvail.gracePeriodAllowed || existAvail.gracePeriodEnabled);
      const gracePeriodDate = gracePeriodOn
        ? (safeD(parsedAvailPeriod.gracePeriodDate) || prev('gracePeriodDate'))
        : undefined;

      if (startDate) {
        const ap = {};
        ap.startDate = startDate;
        if (endDate) ap.endDate = endDate;
        if (cutOffDate) ap.cutOffDate = cutOffDate;
        ap.cutOffEnabled = cutOffEnabled;
        if (remindGradeBy) ap.remindGradeBy = remindGradeBy;
        ap.remindGradeByEnabled = remindEnabled;
        ap.gracePeriodAllowed = gracePeriodOn;
        ap.gracePeriodEnabled = gracePeriodOn;
        if (gracePeriodOn && gracePeriodDate) ap.gracePeriodDate = gracePeriodDate;
        ap.extendedDays = parsedAvailPeriod.extendedDays ?? existAvail.extendedDays ?? 0;
        ap.requiresAdminApproval = parsedAvailPeriod.requiresAdminApproval !== undefined
          ? !!parsedAvailPeriod.requiresAdminApproval
          : !!existAvail.requiresAdminApproval;
        // Approval scope — locked once a workflow exists, otherwise editable.
        const incomingScope = parsedAvailPeriod.approvalScope === 'settings_and_questions'
          ? 'settings_and_questions'
          : parsedAvailPeriod.approvalScope === 'settings'
          ? 'settings'
          : null;
        ap.approvalScope = incomingScope || existAvail.approvalScope || 'settings';
        updatedExercise.availabilityPeriod = ap;

        // ── Approval workflow transitions on toggle change ─────────────────
        const prevApproval = !!existAvail.requiresAdminApproval;
        const nextApproval = !!ap.requiresAdminApproval;
        if (nextApproval && !prevApproval) {
          // off → on: snapshot a new workflow from the course hierarchy
          const courseIdForWorkflow = resolveCourseId(entity);
          const wf = await buildInitialApprovalWorkflow(courseIdForWorkflow);
          if (!wf) {
            return res.status(400).json({
              message: [{
                key: 'error',
                value: 'Approval is required, but no approver could be resolved — the course has no Approval Hierarchy and the institution has no L&D role to default to. Configure the hierarchy on the Approvals page first.'
              }]
            });
          }
          updatedExercise.approvalWorkflow = wf;
          // Step-1 notification is fired after entity.save() below.
        } else if (!nextApproval && prevApproval) {
          // on → off: clear workflow and reopen for students
          updatedExercise.approvalWorkflow = null;
        }
        // unchanged → leave any existing approvalWorkflow alone
      } else {
        delete updatedExercise.availabilityPeriod;
      }
    }
    // ── Notification settings (separate from grades) ───────────────────────
    // ── Notification settings (separate from grades) ───────────────────────
    if (parsedNotifSettings) {
      const ex = existingExercise.notificationSettings || existingExercise.notificatonandGradeSettings || {};

      updatedExercise.notificationSettings = {
        // Global settings
        notifyUsers: parsedNotifSettings.notifyUsers !== undefined ? parsedNotifSettings.notifyUsers : (ex.notifyUsers ?? false),
        notifyGmail: parsedNotifSettings.notifyGmail !== undefined ? parsedNotifSettings.notifyGmail : (ex.notifyGmail ?? false),
        notifyWhatsApp: parsedNotifSettings.notifyWhatsApp !== undefined ? parsedNotifSettings.notifyWhatsApp : (ex.notifyWhatsApp ?? false),
        gradeSheet: parsedNotifSettings.gradeSheet !== undefined ? parsedNotifSettings.gradeSheet : (ex.gradeSheet ?? true),

        // Grader submission notifications
        notifyGradersSubmissions: parsedNotifSettings.notifyGradersSubmissions !== undefined
          ? parsedNotifSettings.notifyGradersSubmissions
          : (ex.notifyGradersSubmissions ?? false),
        notifyGradersSubmissionsChannels: {
          dashboard: parsedNotifSettings.notifyGradersSubmissionsChannels?.dashboard ?? ex.notifyGradersSubmissionsChannels?.dashboard ?? false,
          gmail: parsedNotifSettings.notifyGradersSubmissionsChannels?.gmail ?? ex.notifyGradersSubmissionsChannels?.gmail ?? false,
          whatsapp: parsedNotifSettings.notifyGradersSubmissionsChannels?.whatsapp ?? ex.notifyGradersSubmissionsChannels?.whatsapp ?? false,
        },

        // Grader late submission notifications
        notifyGradersLateSubmissions: parsedNotifSettings.notifyGradersLateSubmissions !== undefined
          ? parsedNotifSettings.notifyGradersLateSubmissions
          : (ex.notifyGradersLateSubmissions ?? false),
        notifyGradersLateSubmissionsChannels: {
          dashboard: parsedNotifSettings.notifyGradersLateSubmissionsChannels?.dashboard ?? ex.notifyGradersLateSubmissionsChannels?.dashboard ?? false,
          gmail: parsedNotifSettings.notifyGradersLateSubmissionsChannels?.gmail ?? ex.notifyGradersLateSubmissionsChannels?.gmail ?? false,
          whatsapp: parsedNotifSettings.notifyGradersLateSubmissionsChannels?.whatsapp ?? ex.notifyGradersLateSubmissionsChannels?.whatsapp ?? false,
        },

        // Student notifications
        notifyStudent: parsedNotifSettings.notifyStudent !== undefined
          ? parsedNotifSettings.notifyStudent
          : (ex.notifyStudent ?? true),
        notifyStudentChannels: {
          dashboard: parsedNotifSettings.notifyStudentChannels?.dashboard ?? ex.notifyStudentChannels?.dashboard ?? false,
          gmail: parsedNotifSettings.notifyStudentChannels?.gmail ?? ex.notifyStudentChannels?.gmail ?? false,
          whatsapp: parsedNotifSettings.notifyStudentChannels?.whatsapp ?? ex.notifyStudentChannels?.whatsapp ?? false,
        },
      };

      // Keep legacy field in sync
      updatedExercise.notificatonandGradeSettings = {
        notifyUsers: updatedExercise.notificationSettings.notifyUsers,
        notifyGmail: updatedExercise.notificationSettings.notifyGmail,
        notifyWhatsApp: updatedExercise.notificationSettings.notifyWhatsApp,
        gradeSheet: updatedExercise.notificationSettings.gradeSheet,
      };
    }

    // ── Grade settings — merge then auto-compute ───────────────────────────
    if (parsedGradeSettings !== null) {
      const exGrade = existingExercise.gradeSettings || {};
      // FIXED
      const merged = {
        mcqGrade: parsedGradeSettings?.mcqGrade !== undefined
          ? Number(parsedGradeSettings.mcqGrade)
          : exGrade.mcqGrade,
        mcqGradeToPass: parsedGradeSettings?.mcqGradeToPass !== undefined
          ? (parsedGradeSettings.mcqGradeToPass !== null
            ? Number(parsedGradeSettings.mcqGradeToPass)
            : null)
          : exGrade.mcqGradeToPass,
        programmingGrade: parsedGradeSettings?.programmingGrade !== undefined
          ? Number(parsedGradeSettings.programmingGrade)
          : exGrade.programmingGrade,
        programmingGradeToPass: parsedGradeSettings?.programmingGradeToPass !== undefined
          ? (parsedGradeSettings.programmingGradeToPass !== null
            ? Number(parsedGradeSettings.programmingGradeToPass)
            : null)
          : exGrade.programmingGradeToPass,
        combinedGrade: parsedGradeSettings?.combinedGrade !== undefined
          ? Number(parsedGradeSettings.combinedGrade)
          : exGrade.combinedGrade,
        combinedGradeToPass: parsedGradeSettings?.combinedGradeToPass !== undefined
          ? (parsedGradeSettings.combinedGradeToPass !== null
            ? Number(parsedGradeSettings.combinedGradeToPass)
            : null)
          : exGrade.combinedGradeToPass,
        separateMarks: parsedGradeSettings?.separateMarks !== undefined
          ? parsedGradeSettings.separateMarks
          : (exGrade.separateMarks ?? false),

        // Difficulty-based pass marks — merge from incoming or fall back to existing
        difficultyPassEnabled: parsedGradeSettings?.difficultyPassEnabled !== undefined
          ? parsedGradeSettings.difficultyPassEnabled
          : (exGrade.difficultyPassEnabled ?? false),
        easyPassMark: parsedGradeSettings?.easyPassMark !== undefined
          ? (parsedGradeSettings.easyPassMark !== null ? Number(parsedGradeSettings.easyPassMark) : null)
          : exGrade.easyPassMark ?? null,
        mediumPassMark: parsedGradeSettings?.mediumPassMark !== undefined
          ? (parsedGradeSettings.mediumPassMark !== null ? Number(parsedGradeSettings.mediumPassMark) : null)
          : exGrade.mediumPassMark ?? null,
        hardPassMark: parsedGradeSettings?.hardPassMark !== undefined
          ? (parsedGradeSettings.hardPassMark !== null ? Number(parsedGradeSettings.hardPassMark) : null)
          : exGrade.hardPassMark ?? null,

        // Overall mark to pass (optional)
        overallMarkToPassEnabled: parsedGradeSettings?.overallMarkToPassEnabled !== undefined
          ? parsedGradeSettings.overallMarkToPassEnabled
          : (exGrade.overallMarkToPassEnabled ?? false),
        overallMarkToPass: parsedGradeSettings?.overallMarkToPass !== undefined
          ? (parsedGradeSettings.overallMarkToPass !== null ? Number(parsedGradeSettings.overallMarkToPass) : null)
          : exGrade.overallMarkToPass ?? null,

        // Grade bands (labelled % ranges) — incoming wins, else keep existing.
        gradeBands: Array.isArray(parsedGradeSettings?.gradeBands)
          ? parsedGradeSettings.gradeBands
          : (exGrade.gradeBands ?? undefined),
      };

      // Re-run auto-compute so grade fields always reflect current totalMarks
      const infoForGrade = updatedExercise.exerciseInformation || existingExercise.exerciseInformation || {};
      updatedExercise.gradeSettings = computeAutoGrades(finalExerciseType, infoForGrade, merged);
    } else if (!existingExercise.gradeSettings && updatedExercise.exerciseInformation) {
      // First time update — auto-compute from existing info
      updatedExercise.gradeSettings = computeAutoGrades(finalExerciseType, updatedExercise.exerciseInformation, {});
    }

    // ── Additional options ─────────────────────────────────────────────────
    if (parsedAdditOptions) {
      const exAddit = existingExercise.additionalOptions || {};
      updatedExercise.additionalOptions = {
        anonymousSubmissions: parsedAdditOptions.anonymousSubmissions !== undefined ? parsedAdditOptions.anonymousSubmissions : (exAddit.anonymousSubmissions ?? false),
        hideGraderIdentity: parsedAdditOptions.hideGraderIdentity !== undefined ? parsedAdditOptions.hideGraderIdentity : (exAddit.hideGraderIdentity ?? false),
      };
    }

    // ── Persist ────────────────────────────────────────────────────────────
    // Decide notification BEFORE the JSON snapshot so notifiedAt persists in
    // the same save. `updatedExercise` is a partial merge — for the gate check
    // we overlay it on the existing exercise so `approvalScope`, question
    // counts, config etc. all resolve correctly.
    const mergedForGate = { ...existingExercise, ...updatedExercise };
    const willNotifyStep1 = shouldFireStep1Notification(mergedForGate);
    if (willNotifyStep1) {
      if (!updatedExercise.approvalWorkflow) updatedExercise.approvalWorkflow = existingExercise.approvalWorkflow;
      updatedExercise.approvalWorkflow.steps[0].notifiedAt = new Date();
    }
    // Trainer just saved an edit — if the workflow is currently `rejected`,
    // mark it so the approver's UI shows a plain "Approve" instead of
    // "Approve anyway". Applied whether or not the approval scope defers,
    // and irrespective of what fields actually changed (any save counts).
    if (existingExercise?.approvalWorkflow?.overallStatus === 'rejected') {
      if (!updatedExercise.approvalWorkflow) updatedExercise.approvalWorkflow = existingExercise.approvalWorkflow;
      updatedExercise.approvalWorkflow.editedSinceReject = true;
    }
    const cleanExercise = JSON.parse(JSON.stringify(updatedExercise));
    exercises[exerciseIndex] = cleanExercise;
    pedagogyRoot[tabType].set(subcategory, exercises);
    // Mongoose change tracking for pedagogy.{tabType}: Map<String, [exerciseSchema]>
    // is unreliable when the mutation is deep inside a nested subdocument (e.g.
    // availabilityPeriod.startDate / endDate Date fields). A single
    // markModified on the Map path is NOT enough — schedule updates were
    // silently being dropped at save time. Mark each level of the nesting so
    // Mongoose emits the SET ops for these Date fields. Every other handler in
    // this file that touches an exercise inside the pedagogy Map already does
    // this; updateExercise was the outlier.
    entity.markModified(`${pedagogyPath}.${tabType}`);
    entity.markModified(`${pedagogyPath}.${tabType}.${subcategory}`);
    entity.markModified(`${pedagogyPath}.${tabType}.${subcategory}.${exerciseIndex}`);
    entity.markModified(`${pedagogyPath}.${tabType}.${subcategory}.${exerciseIndex}.availabilityPeriod`);
    entity.markModified(`${pedagogyPath}.${tabType}.${subcategory}.${exerciseIndex}.approvalWorkflow`);
    // customDistributionBySection is a Mixed type (dynamic section-id keys).
    // Mongoose can't auto-detect deep changes on Mixed fields, so without an
    // explicit markModified the update payload is written into memory but
    // .save() skips emitting it to Mongo — trainer edits vanish silently.
    entity.markModified(`${pedagogyPath}.${tabType}.${subcategory}.${exerciseIndex}.customDistributionBySection`);
    entity.updatedBy = req.user?.email || 'system';
    entity.updatedAt = new Date();
    await entity.save();

    // Phase 6 — When the teacher opts in via saveToBank, clone the exercise's
    // attached questions into the institution's Question Bank. Fire-and-forget
    // so an occasional bank failure never breaks the exercise save response.
    if (updatedExercise.saveToBank && Array.isArray(cleanExercise.questions) && cleanExercise.questions.length > 0) {
      const institutionId = req.user?.institution?._id || req.user?.institution;
      cloneQuestionsToBank({
        institutionId,
        exerciseId,
        questions: cleanExercise.questions,
        actorEmail: req.user?.email,
      });
    }

    // Notify step-1 approvers only when the gate said so above. This handles
    // both "settings" scope (fire immediately) and "settings_and_questions"
    // scope (skipped here; fires from addQuestion once complete).
    if (willNotifyStep1) {
      const courseIdForNotify = resolveCourseId(entity);
      const courseDoc = courseIdForNotify
        ? await CourseStructure.findById(courseIdForNotify).select('courseName').lean()
        : null;
      notifyApproversForStep({
        courseId: courseIdForNotify,
        courseName: courseDoc?.courseName,
        step: updatedExercise.approvalWorkflow.steps[0],
        exerciseName: updatedExercise.exerciseInformation?.exerciseName,
        exerciseId: updatedExercise._id,
      }).catch((e) => console.warn('notifyApproversForStep failed:', e.message));
    }

    // ── Build response config ──────────────────────────────────────────────
    let responseConfig = {};
    if (finalExerciseType === 'MCQ') responseConfig = { mode: 'mcq', config: mcqQuestionConfig };
    else if (finalExerciseType === 'Programming') responseConfig = { mode: 'programming', config: programmingQuestionConfig };
    else if (finalExerciseType === 'Other') responseConfig = { mode: 'other', config: othersQuestionConfig };
    else if (finalExerciseType === 'Combined') responseConfig = { mode: 'combined', mcqConfig: mcqQuestionConfig, programmingConfig: programmingQuestionConfig };

    return res.status(200).json({
      message: [{ key: 'success', value: `Exercise updated successfully in ${subcategory}` }],
      data: {
        exercise: cleanExercise,
        configuration: responseConfig,
        gradeSettings: cleanExercise.gradeSettings,
        notificationSettings: cleanExercise.notificationSettings,
        additionalOptions: cleanExercise.additionalOptions,
        subcategory,
        tabType,
        entityType: type,
        entityId: id,
        exerciseId,
        totalExercises: exercises.length,
        location: { section: tabType, subcategory, index: exerciseIndex },
      },
    });

  } catch (err) {
    console.error('❌ Update exercise error:', err);
    console.error('Error stack:', err.stack);
    res.status(500).json({
      message: [{ key: 'error', value: `Internal server error: ${err.message}` }],
    });
  }
};
// ── Derived Assignment-list status ───────────────────────────────────────────
// Mirror of the client's isExerciseComplete + getExerciseStatus in
// ProblemSolving.tsx — keep the two in LOCKSTEP. Used only by getExercises'
// paginated mode so the list's "Incomplete / Completed" status filter can run
// server-side over the whole list, not just the visible page.
const psIsExerciseComplete = (ex) => {
  if (!ex.exerciseType) return false;
  if (!(ex.exerciseInformation?.exerciseName || '').trim()) return false;
  if (!ex.availabilityPeriod?.startDate) return false;

  if (ex.isGraded !== false) {
    if (ex.exerciseType === 'Combined') {
      if ((ex.exerciseInformation?.totalMarksMCQ ?? 0) <= 0) return false;
      if ((ex.exerciseInformation?.totalMarksProgramming ?? 0) <= 0) return false;
    } else {
      if ((ex.exerciseInformation?.totalMarks ?? 0) <= 0) return false;
    }
  }

  const saved = Array.isArray(ex.stepsSaved) ? ex.stepsSaved : [];
  const requiredSteps = ['Exercise Details', 'Question Configuration', 'Schedule', 'Notifications'];
  if (ex.isGraded !== false) requiredSteps.push('Grade Settings');
  return requiredSteps.every((step) => saved.includes(step));
};

const psExerciseStatus = (ex) => {
  if (!psIsExerciseComplete(ex)) return 'Incomplete';
  const questions = ex.questions ?? [];
  const mcqCfg = ex.questionConfiguration?.mcqQuestionConfiguration ?? null;
  const progCfg = ex.questionConfiguration?.programmingQuestionConfiguration ?? null;
  const mcqCount = questions.filter((q) => q.questionType === 'mcq').length;
  const progCount = questions.filter(
    (q) => q.questionType === 'programming' || q.questionType === 'database' || q.questionType === 'others'
  ).length;
  let maxQ = 0, curQ = 0;
  const progMaxOf = () => {
    const counts = progCfg?.levelBasedCounts ?? progCfg?.selectionLevelCounts ?? {};
    return progCfg?.questionConfigType === 'general'
      ? (progCfg?.generalQuestionCount ?? 0)
      : ((counts.easy ?? 0) + (counts.medium ?? 0) + (counts.hard ?? 0));
  };
  if (ex.exerciseType === 'MCQ') {
    maxQ = mcqCfg?.totalMcqQuestions ?? 0;
    curQ = mcqCount;
  } else if (ex.exerciseType === 'Programming') {
    maxQ = progMaxOf();
    curQ = progCount;
  } else if (ex.exerciseType === 'Combined') {
    maxQ = (mcqCfg?.totalMcqQuestions ?? 0) + progMaxOf();
    curQ = mcqCount + progCount;
  }
  if (maxQ > 0 && curQ < maxQ) return 'Incomplete';
  return 'Completed';
};

exports.getExercises = async (req, res) => {
  try {
    const { type, id } = req.params;
    const {
      section,
      subcategory
    } = req.query;


    if (!modelMap[type]) {
      return res.status(400).json({
        message: [{ key: "error", value: `Invalid entity type: ${type}` }]
      });
    }

    const { model } = modelMap[type];
    const entity = await model.findById(id);

    if (!entity) {
      return res.status(404).json({
        message: [{ key: "error", value: `${type} not found` }]
      });
    }
    // ── Resources by Batch ───────────────────────────────────────────────
    // Which I_Do/We_Do/You_Do set this request belongs to. For a shared
    // element that is the course-level `pedagogy`; for one ticked batch-wise
    // in Course Setup it is this batch's own `batchPedagogy.<batchId>`.
    // Resolving it here means every lookup and markModified below lands in
    // the right place — without it We Do and You Do would keep reading the
    // course-level set while the batch strip claimed otherwise.
    const { container: pedagogyRoot, basePath: pedagogyPath } =
      await resolvePedagogyScope(entity, section, req);


    // Check if pedagogy exists
    if (!pedagogyRoot || !pedagogyRoot[section]) {
      return res.json({
        message: [{ key: "success", value: "No exercises found" }],
        data: {
          exercises: [],
          section: section,
          subcategory: subcategory,
          total: 0
        }
      });
    }

    // Get exercises for specific subcategory or all in section
    let exercises = [];
    if (subcategory) {
      exercises = pedagogyRoot[section].get(subcategory) || [];
    } else {
      // Return all exercises from all subcategories in section
      const allExercises = [];
      pedagogyRoot[section].forEach((exArray, subcat) => {
        if (Array.isArray(exArray)) {
          exArray.forEach(ex => {
            allExercises.push({
              ...ex._doc,
              subcategory: subcat
            });
          });
        }
      });
      exercises = allExercises;
    }

    // ── Question-Bank-style optional pagination ──────────────────────────
    // Passing `page` switches this endpoint into paginated mode: the list's
    // filters (search / exerciseType / derived status) + newest-first sort
    // run over the WHOLE list here, and one slice goes back with the pager
    // totals. Without `page` the response below is the original full array,
    // unchanged — every existing caller keeps working.
    const { page, limit, search, exerciseType, status } = req.query;
    if (page !== undefined) {
      let rows = [...exercises];
      rows.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      if (exerciseType) rows = rows.filter((ex) => ex.exerciseType === exerciseType);
      if (status) rows = rows.filter((ex) => psExerciseStatus(ex) === status);
      if (search) {
        const q = String(search).toLowerCase();
        rows = rows.filter((ex) =>
          (ex.exerciseInformation?.exerciseName || '').toLowerCase().includes(q) ||
          (ex.exerciseInformation?.exerciseId || '').toLowerCase().includes(q)
        );
      }
      const itemsPerPage = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 100);
      const totalItems = rows.length;
      const totalPages = Math.max(1, Math.ceil(totalItems / itemsPerPage));
      const currentPage = Math.min(Math.max(parseInt(page, 10) || 1, 1), totalPages);
      const slice = rows.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

      return res.json({
        message: [{ key: "success", value: "Exercises retrieved successfully" }],
        data: {
          exercises: slice,
          section: section,
          subcategory: subcategory,
          total: totalItems,
          pagination: { currentPage, totalPages, totalItems, itemsPerPage },
          entityType: type,
          entityId: id
        }
      });
    }

    return res.json({
      message: [{ key: "success", value: "Exercises retrieved successfully" }],
      data: {
        exercises,
        section: section,
        subcategory: subcategory,
        total: exercises.length,
        entityType: type,
        entityId: id
      }
    });

  } catch (err) {
    console.error("❌ Get exercises error:", err);
    res.status(500).json({
      message: [{ key: "error", value: "Internal server error" }]
    });
  }
};




// Delete Exercise
exports.deleteExercise = async (req, res) => {
  try {
    const { type, id, exerciseId } = req.params;
    const {
      tabType,
      subcategory
    } = req.query;

    // Validate entity type
    if (!modelMap[type]) {
      return res.status(400).json({
        message: [{ key: "error", value: `Invalid entity type: ${type}. Valid types: modules, submodules, topics, subtopics` }]
      });
    }

    // Validate required parameters
    if (!subcategory) {
      return res.status(400).json({
        message: [{ key: "error", value: "Subcategory is required as query parameter. Valid values: 'exercises', 'practical', 'Project Development', etc." }]
      });
    }

    // Validate tabType
    if (!tabType || !['I_Do', 'We_Do', 'You_Do'].includes(tabType)) {
      return res.status(400).json({
        message: [{ key: "error", value: "tabType is required and must be one of: 'I_Do', 'We_Do', 'You_Do'" }]
      });
    }

    const { model } = modelMap[type];
    const entity = await model.findById(id);

    if (!entity) {
      return res.status(404).json({
        message: [{ key: "error", value: `${type} with ID ${id} not found` }]
      });
    }
    // ── Resources by Batch ───────────────────────────────────────────────
    // Which I_Do/We_Do/You_Do set this request belongs to. For a shared
    // element that is the course-level `pedagogy`; for one ticked batch-wise
    // in Course Setup it is this batch's own `batchPedagogy.<batchId>`.
    // Resolving it here means every lookup and markModified below lands in
    // the right place — without it We Do and You Do would keep reading the
    // course-level set while the batch strip claimed otherwise.
    const { container: pedagogyRoot, basePath: pedagogyPath } =
      await resolvePedagogyScope(entity, tabType, req);


    // Check if pedagogy exists
    if (!pedagogyRoot) {
      return res.status(404).json({
        message: [{ key: "error", value: "Pedagogy structure not found for this entity" }]
      });
    }

    // Check if tabType exists
    if (!pedagogyRoot[tabType]) {
      return res.status(404).json({
        message: [{ key: "error", value: `Pedagogy tab '${tabType}' not found` }]
      });
    }

    // Convert Map to object if needed
    let tabData = pedagogyRoot[tabType];
    if (tabData instanceof Map) {
      tabData = Object.fromEntries(tabData);
    }

    // Check if subcategory exists
    if (!tabData[subcategory] || !Array.isArray(tabData[subcategory])) {
      return res.status(404).json({
        message: [{ key: "error", value: `Subcategory '${subcategory}' not found in ${tabType}` }]
      });
    }

    // Find exercise index
    const exerciseIndex = tabData[subcategory].findIndex(
      exercise => exercise._id.toString() === exerciseId
    );

    if (exerciseIndex === -1) {
      return res.status(404).json({
        message: [{ key: "error", value: `Exercise with ID ${exerciseId} not found in subcategory '${subcategory}'` }]
      });
    }

    // Get exercise data for response message (including security settings)
    const exerciseToDelete = tabData[subcategory][exerciseIndex];
    const exerciseName = exerciseToDelete?.exerciseInformation?.exerciseName || 'Unknown Exercise';
    const exerciseIdValue = exerciseToDelete?.exerciseInformation?.exerciseId || exerciseId;

    // Store deleted exercise data for response (including security settings)
    const deletedExerciseData = {
      exerciseId: exerciseIdValue,
      exerciseName: exerciseName,
      securitySettings: exerciseToDelete?.securitySettings || null,
      deletedAt: new Date()
    };

    // Remove exercise from array
    tabData[subcategory].splice(exerciseIndex, 1);

    // Convert back to Map if needed
    if (pedagogyRoot[tabType] instanceof Map) {
      pedagogyRoot[tabType].set(subcategory, tabData[subcategory]);
    } else {
      pedagogyRoot[tabType][subcategory] = tabData[subcategory];
    }

    // Mark as modified
    entity.markModified(`${pedagogyPath}.${tabType}`);
    entity.markModified(`${pedagogyPath}.${tabType}.${subcategory}`);

    // Update entity timestamps
    entity.updatedBy = req.user?.email || "roobankr5@gmail.com";
    entity.updatedAt = new Date();

    // Save entity
    await entity.save();


    return res.status(200).json({
      message: [{ key: "success", value: `Exercise "${exerciseName}" deleted successfully from ${subcategory}` }],
      data: {
        deletedExercise: deletedExerciseData,
        subcategory: subcategory,
        tabType: tabType,
        entityType: type,
        entityId: id,
        totalExercises: tabData[subcategory].length,
        location: {
          section: tabType,
          subcategory: subcategory,
          deletedIndex: exerciseIndex
        }
      }
    });

  } catch (err) {
    console.error("❌ Delete exercise error:", err);
    console.error("❌ Error stack:", err.stack);
    res.status(500).json({
      message: [{ key: "error", value: `Internal server error: ${err.message}` }]
    });
  }
};
// Get All Subcategories
exports.getSubcategories = async (req, res) => {
  try {
    const { type, id } = req.params;
    const { section = 'We_Do' } = req.query;


    if (!modelMap[type]) {
      return res.status(400).json({
        message: [{ key: "error", value: "Invalid entity type" }]
      });
    }

    const { model } = modelMap[type];
    const entity = await model.findById(id);

    if (!entity) {
      return res.status(404).json({
        message: [{ key: "error", value: `${type} not found` }]
      });
    }
    // ── Resources by Batch ───────────────────────────────────────────────
    // Which I_Do/We_Do/You_Do set this request belongs to. For a shared
    // element that is the course-level `pedagogy`; for one ticked batch-wise
    // in Course Setup it is this batch's own `batchPedagogy.<batchId>`.
    // Resolving it here means every lookup and markModified below lands in
    // the right place — without it We Do and You Do would keep reading the
    // course-level set while the batch strip claimed otherwise.
    const { container: pedagogyRoot, basePath: pedagogyPath } =
      await resolvePedagogyScope(entity, section, req);


    // Check if pedagogy exists
    if (!pedagogyRoot || !pedagogyRoot[section]) {
      return res.json({
        message: [{ key: "success", value: "No subcategories found" }],
        data: {
          subcategories: [],
          section: section,
          total: 0
        }
      });
    }

    // Get all subcategories
    const subcategories = Array.from(pedagogyRoot[section].keys());

    // Count exercises in each subcategory
    const subcategoryDetails = subcategories.map(subcat => {
      const exercises = pedagogyRoot[section].get(subcat) || [];
      return {
        name: subcat,
        exerciseCount: exercises.length,
        lastUpdated: exercises.length > 0
          ? exercises[exercises.length - 1].updatedAt
          : null
      };
    });

    return res.json({
      message: [{ key: "success", value: "Subcategories retrieved successfully" }],
      data: {
        subcategories: subcategoryDetails,
        section: section,
        total: subcategories.length,
        entityType: type,
        entityId: id
      }
    });

  } catch (err) {
    console.error("❌ Get subcategories error:", err);
    res.status(500).json({
      message: [{ key: "error", value: "Internal server error" }]
    });
  }
};




exports.lockExercise = async (req, res) => {
  try {
    const userId = req.body.targetUserId || req.user._id;
    const {
      courseId,
      exerciseId,
      category,
      subcategory,
      status,
      isLocked,
      submitType,
      autoSubmitReason,
      reason,
    } = req.body;

    // AUTO submit when the client flags it (proctoring/face/tab/timeout
    // termination), or when the exercise is being terminated.
    const _isAutoSubmit = submitType === 'AUTO' || status === 'terminated';
    const _autoReason = _isAutoSubmit
      ? String(autoSubmitReason || reason || '').slice(0, 300)
      : '';


    if (!courseId || !exerciseId || !subcategory) {
      return res.status(400).json({ message: [{ key: "error", value: "Missing required fields" }] });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: [{ key: "error", value: "User not found" }] });

    // 1. Find Course Index
    const courseIndex = user.courses.findIndex(c => c.courseId && c.courseId.toString() === courseId);

    if (courseIndex === -1) {
      return res.status(404).json({ message: [{ key: "error", value: "Course not enrolled" }] });
    }

    const userCourse = user.courses[courseIndex];

    // 2. Ensure Path Exists
    if (!userCourse.answers) userCourse.answers = { I_Do: new Map(), We_Do: new Map(), You_Do: new Map() };

    const categoryKey = category;
    if (!userCourse.answers[categoryKey]) userCourse.answers[categoryKey] = new Map();

    const categoryMap = userCourse.answers[categoryKey];

    // 3. Get Exercises Array
    let exercisesArray = categoryMap.get(subcategory) || [];
    if (exercisesArray.toObject) exercisesArray = exercisesArray.toObject();

    // 4. Handle Screen Recording Upload from Form-Data
    let screenRecordingUrl = null;

    // Check if file exists in the request (for form-data uploads)
    if (req.files && req.files.screenRecording) {
      try {
        const screenRecordingFile = req.files.screenRecording;

        // Upload to Cloudinary from buffer
        const uploadResult = await new Promise((resolve, reject) => {
          // Create upload stream to Cloudinary
          const uploadStream = cloudinary.uploader.upload_stream(
            {
              resource_type: 'video',
              folder: `lms/pedagogy/${category}/${subcategory}/screen-recordings`,
              overwrite: true,
              chunk_size: 6000000, // 6MB chunks
              eager: [
                { width: 640, height: 480, crop: "scale" }
              ]
            },
            (error, result) => {
              if (error) {
                console.error('❌ Cloudinary upload error:', error);
                reject(error);
              } else {
                resolve(result);
              }
            }
          );

          // Create readable stream from buffer
          const bufferStream = new stream.PassThrough();
          bufferStream.end(screenRecordingFile.data);

          // Pipe buffer to Cloudinary upload stream
          bufferStream.pipe(uploadStream);
        });

        screenRecordingUrl = uploadResult.secure_url;
      } catch (uploadError) {
        console.error("❌ Error uploading screen recording to Cloudinary:", uploadError);
        // Continue without failing the entire operation
      }
    }
    // Also check if screenRecording was sent as Base64 in body (for backward compatibility)
    else if (req.body.screenRecording && req.body.screenRecording.startsWith('data:video/')) {
      try {
        const base64Data = req.body.screenRecording;

        const uploadResult = await cloudinary.uploader.upload(base64Data, {
          resource_type: 'video',
          folder: `lms/pedagogy/${category}/${subcategory}/screen-recordings`,
          overwrite: true,
          chunk_size: 6000000
        });

        screenRecordingUrl = uploadResult.secure_url;
      } catch (uploadError) {
        console.error("❌ Error uploading Base64 screen recording:", uploadError);
      }
    }

    // 5. Update or Push Exercise Progress
    const exerciseIndex = exercisesArray.findIndex(ex => ex.exerciseId && ex.exerciseId.toString() === exerciseId);
    let updatedExercise = null;

    if (exerciseIndex > -1) {
      // Update Existing
      if (status) exercisesArray[exerciseIndex].status = status;
      if (isLocked !== undefined) exercisesArray[exerciseIndex].isLocked = isLocked;
      else if (status === 'terminated') exercisesArray[exerciseIndex].isLocked = true;
      if (_isAutoSubmit) {
        exercisesArray[exerciseIndex].submitType = 'AUTO';
        exercisesArray[exerciseIndex].autoSubmitReason = _autoReason;
      }

      // Add screen recording URL if uploaded
      if (screenRecordingUrl) {
        exercisesArray[exerciseIndex].screenRecording = screenRecordingUrl;
      }

      updatedExercise = exercisesArray[exerciseIndex];
    } else {
      // Create New
      const newEntry = {
        exerciseId: new mongoose.Types.ObjectId(exerciseId),
        status: status || 'in-progress',
        isLocked: isLocked !== undefined ? (isLocked === 'true' || isLocked === true) : (status === 'terminated'),
        questions: [],
        screenRecording: screenRecordingUrl || undefined,
        submitType: _isAutoSubmit ? 'AUTO' : 'USER',
        autoSubmitReason: _autoReason,
      };
      exercisesArray.push(newEntry);
      updatedExercise = newEntry;
    }

    // 6. Save to Database
    categoryMap.set(subcategory, exercisesArray);

    // Mark the SPECIFIC path modified
    user.markModified(`courses.${courseIndex}.answers.${categoryKey}`);

    await user.save();
    console.log("✅ Exercise status updated successfully", updatedExercise);
    return res.status(200).json({
      message: [{ key: "success", value: "Exercise status updated successfully" }],
      data: updatedExercise
    });

  } catch (error) {
    console.error("Lock Exercise Error:", error);
    return res.status(500).json({
      message: [{ key: "error", value: "Internal server error" }],
      error: error.message
    });
  }
};


// 2. Get Exercise Status (Debugged)
exports.getExerciseStatus = async (req, res) => {
  try {
    const userId = req.query.targetUserId || req.user._id;
    const { courseId, exerciseId, category = 'We_Do', subcategory } = req.query;

    // console.log(`🔍 STATUS REQ: User: ${userId} | Ex: ${exerciseId}`);

    if (!courseId || !exerciseId || !subcategory) {
      return res.status(400).json({ message: [{ key: "error", value: "Missing parameters" }] });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: [{ key: "error", value: "User not found" }] });

    const userCourse = user.courses ? user.courses.find(c => c.courseId && c.courseId.toString() === courseId) : null;

    if (!userCourse || !userCourse.answers) {
      return res.status(200).json({ success: true, data: { isLocked: false, status: 'new' } });
    }

    const categoryKey = category || 'We_Do';
    const categoryMap = userCourse.answers[categoryKey];

    if (!categoryMap) {
      return res.status(200).json({ success: true, data: { isLocked: false, status: 'new' } });
    }

    const exercisesArray = categoryMap.get(subcategory) || [];

    // Find the exercise
    const exercise = exercisesArray.find(ex => ex.exerciseId && ex.exerciseId.toString() === exerciseId);

    if (exercise) {
      // console.log("👉 Found Status:", exercise.isLocked, exercise.status);
      return res.status(200).json({
        success: true,
        data: {
          isLocked: exercise.isLocked || false,
          status: exercise.status || 'in-progress',
          screenRecording: exercise.screenRecording || 'empty'

        }
      });
    }

    // console.log("👉 Exercise Not Found in Array, returning unlocked");
    return res.status(200).json({
      success: true,
      data: { isLocked: false, status: 'new' }
    });

  } catch (error) {
    console.error("Get Status Error:", error);
    return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};


// ── Save Assessment Screen Recording URL (from proctoring hook) ───────────────
// Called after the client uploads to Cloudinary and gets a URL back.
// Saves the URL to the student's exercise record so getExerciseStatus can return it.
exports.saveAssessmentRecording = async (req, res) => {
  try {
    const {
      courseId,
      exerciseId,
      studentId,
      recordingUrl,
      category = 'You_Do',
      subcategory = 'assessments',
    } = req.body;

    const userId = studentId || req.user._id;

    if (!courseId || !exerciseId || !recordingUrl) {
      return res.status(400).json({
        success: false,
        message: [{ key: 'error', value: 'Missing required fields: courseId, exerciseId, recordingUrl' }],
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: [{ key: 'error', value: 'User not found' }] });
    }

    // Ensure course exists in user's enrolled list
    const courseIndex = user.courses
      ? user.courses.findIndex(c => c.courseId && c.courseId.toString() === courseId)
      : -1;

    if (courseIndex === -1) {
      return res.status(404).json({ success: false, message: [{ key: 'error', value: 'Course not enrolled' }] });
    }

    const userCourse = user.courses[courseIndex];

    // Ensure answers map exists
    if (!userCourse.answers) {
      userCourse.answers = { I_Do: new Map(), We_Do: new Map(), You_Do: new Map() };
    }
    const categoryKey = category;
    if (!userCourse.answers[categoryKey]) userCourse.answers[categoryKey] = new Map();

    const categoryMap = userCourse.answers[categoryKey];

    // Get or create the exercises array for this subcategory
    let exercisesArray = categoryMap.get(subcategory) || [];
    if (exercisesArray.toObject) exercisesArray = exercisesArray.toObject();

    const exerciseIndex = exercisesArray.findIndex(
      ex => ex.exerciseId && ex.exerciseId.toString() === exerciseId
    );

    if (exerciseIndex > -1) {
      // Update existing entry
      exercisesArray[exerciseIndex].screenRecording = recordingUrl;
    } else {
      // Create a new entry just to store the recording
      exercisesArray.push({
        exerciseId: new mongoose.Types.ObjectId(exerciseId),
        status: 'in-progress',
        isLocked: false,
        questions: [],
        screenRecording: recordingUrl,
      });
    }

    categoryMap.set(subcategory, exercisesArray);
    user.markModified(`courses.${courseIndex}.answers.${categoryKey}`);
    await user.save();

    console.log(`✅ Assessment recording saved for user ${userId}, exercise ${exerciseId}`);
    return res.status(200).json({
      success: true,
      message: [{ key: 'success', value: 'Recording saved successfully' }],
      data: { recordingUrl },
    });
  } catch (error) {
    console.error('saveAssessmentRecording error:', error);
    return res.status(500).json({
      success: false,
      message: [{ key: 'error', value: 'Internal server error' }],
      error: error.message,
    });
  }
};


async function uploadBufferToSupabase(buffer, filePath, mimeType) {
  try {
    const { data, error } = await supabase.storage
      .from("smartlms")
      .upload(filePath, buffer, {
        contentType: mimeType,
        cacheControl: '3600',
        upsert: false
      });

    if (error) {
      throw new Error(`Supabase upload failed: ${error.message}`);
    }

    // Generate public URL
    const imageUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/smartlms/${filePath}`;

    return imageUrl;

  } catch (error) {
    console.error("❌ Buffer upload failed:", error);
    throw error;
  }
}

// Define the uploadImageToSupabase function if not already imported
async function uploadImageToSupabase(file, folderPath) {
  try {
    // Generate unique filename
    const timestamp = Date.now();
    const sanitizedName = file.name.replace(/[^a-zA-Z0-9.]/g, '_');
    const fileName = `${timestamp}_${sanitizedName}`;
    const filePath = `question/${folderPath}/${fileName}`;

    // Upload to Supabase
    const { data, error } = await supabase.storage
      .from("smartlms")
      .upload(filePath, file.data, {
        contentType: file.mimetype,
        cacheControl: '3600',
        upsert: false
      });

    if (error) {
      throw new Error(`Supabase upload failed: ${error.message}`);
    }

    // Generate public URL
    const imageUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/smartlms/${filePath}`;

    return imageUrl;

  } catch (error) {
    console.error("❌ Image upload failed:", error);
    throw error;
  }
}

exports.addQuestion = async (req, res) => {
  try {
    const { type, id, exerciseId } = req.params;
    const {
      tabType,
      subcategory,
      questionsData, // Accept array of questions
      questionType, // Keep for backward compatibility
      ...questionFields // Keep for backward compatibility
    } = req.body;

    // Handle file uploads if present
    let uploadedFiles = [];
    if (req.files && req.files.length > 0) {
      uploadedFiles = req.files;
    }

    // Validate required parameters
    if (!type || !modelMap[type]) {
      return res.status(400).json({
        message: [{ key: "error", value: `Invalid entity type: ${type}. Valid types: modules, submodules, topics, subtopics` }]
      });
    }

    // Check if we have multiple questions or single question
    const isMultipleQuestions = Array.isArray(questionsData) && questionsData.length > 0;
    const questionsToAdd = isMultipleQuestions ? questionsData : [req.body];

    console.log(`📥 Processing ${questionsToAdd.length} question(s) to add`);

    // Validate all questions
    for (let i = 0; i < questionsToAdd.length; i++) {
      const questionData = questionsToAdd[i];
      const questionIndex = i + 1;

      // Get question type
      const qType = questionData.questionType || questionType;
      const validQuestionTypes = ['mcq', 'programming', 'database', 'others'];

      if (!qType || !validQuestionTypes.includes(qType)) {
        return res.status(400).json({
          message: [{ key: "error", value: `Invalid question type for question ${questionIndex}: ${qType}. Valid types: ${validQuestionTypes.join(', ')}` }]
        });
      }

      // Validate based on question type
      if (qType === 'mcq') {
        // Validate MCQ fields
        if (!questionData.questionTitle && !questionData.mcqQuestionTitle) {
          return res.status(400).json({
            message: [{ key: "error", value: `Question ${questionIndex}: MCQ question title is required` }]
          });
        }

        const options = questionData.options || questionData.mcqOptions;
        if (!Array.isArray(options) || options.length < 2) {
          return res.status(400).json({
            message: [{ key: "error", value: `Question ${questionIndex}: At least 2 options are required for MCQ` }]
          });
        }

        const correctAnswer = questionData.correctAnswer || questionData.mcqCorrectAnswer;
        if (!correctAnswer) {
          return res.status(400).json({
            message: [{ key: "error", value: `Question ${questionIndex}: Correct answer is required for MCQ` }]
          });
        }
      } else if (qType === 'programming') {
        // ── Link questions: the teacher pastes ONE external URL (e.g. a
        // LeetCode problem) instead of authoring the question here. Only the
        // link is validated — title/description/test cases don't exist for
        // these. http/https only: the value becomes a student-facing iframe
        // src, so javascript:/data: URLs must never pass.
        if (questionData.isLinkQuestion === true) {
          const _link = typeof questionData.questionLink === 'string' ? questionData.questionLink.trim() : '';
          if (!/^https?:\/\/\S+$/i.test(_link)) {
            return res.status(400).json({
              message: [{ key: "error", value: `Question ${questionIndex}: A valid http(s) question link is required` }]
            });
          }
          continue;
        }

        // Validate Programming fields
        // title can be a plain string OR an array of content blocks (programmingQuestionTitle)
        const _progTitleText = typeof questionData.title === 'string' ? questionData.title.trim() : '';
        if (!_progTitleText) {
          return res.status(400).json({
            message: [{ key: "error", value: `Question ${questionIndex}: Programming question title is required` }]
          });
        }

        // Check if description exists and has text
        let descriptionText = '';
        if (questionData.description) {
          // New format: description is a ProgContentBlock[] array
          if (Array.isArray(questionData.description)) {
            descriptionText = questionData.description
              .filter(b => b.type === 'text' || b.type === 'image')
              .map(b => b.type === 'image' ? '[image]' : (b.value || ''))
              .join(' ')
              .replace(/<[^>]*>/g, '')
              .trim();
          } else if (typeof questionData.description === 'object') {
            // Legacy format: { text, imageUrl, contentBlocks }
            if (Array.isArray(questionData.description.contentBlocks) && questionData.description.contentBlocks.length > 0) {
              descriptionText = questionData.description.contentBlocks
                .filter(b => b.type === 'text' || b.type === 'image')
                .map(b => b.type === 'image' ? '[image]' : (b.value || ''))
                .join(' ')
                .replace(/<[^>]*>/g, '')
                .trim();
            } else {
              descriptionText = questionData.description.text || '';
            }
          } else {
            descriptionText = questionData.description;
          }
        }
        // Backward compat: also accept from programmingQuestionDescription
        if (!descriptionText && Array.isArray(questionData.programmingQuestionDescription)) {
          descriptionText = questionData.programmingQuestionDescription
            .filter(b => b.type === 'text')
            .map(b => b.value || '')
            .join(' ')
            .replace(/<[^>]*>/g, '')
            .trim();
        }

        if (!descriptionText || !descriptionText.trim()) {
          return res.status(400).json({
            message: [{ key: "error", value: `Question ${questionIndex}: Programming question description text is required` }]
          });
        }

        // Validate programming difficulty
        const validDifficulties = ['easy', 'medium', 'hard'];
        const difficulty = questionData.difficulty || 'medium';
        if (!validDifficulties.includes(difficulty)) {
          return res.status(400).json({
            message: [{ key: "error", value: `Question ${questionIndex}: Invalid difficulty. Valid values: ${validDifficulties.join(', ')}` }]
          });
        }
      }
    }

    // Get the model from modelMap
    const { model } = modelMap[type];

    if (!model) {
      return res.status(400).json({
        message: [{ key: "error", value: `Model not found for type: ${type}` }]
      });
    }

    // Find the entity
    const entity = await model.findById(id);

    if (!entity) {
      return res.status(404).json({
        message: [{ key: "error", value: `${type} with ID ${id} not found` }]
      });
    }
    // ── Resources by Batch ───────────────────────────────────────────────
    // Which I_Do/We_Do/You_Do set this request belongs to. For a shared
    // element that is the course-level `pedagogy`; for one ticked batch-wise
    // in Course Setup it is this batch's own `batchPedagogy.<batchId>`.
    // Resolving it here means every lookup and markModified below lands in
    // the right place — without it We Do and You Do would keep reading the
    // course-level set while the batch strip claimed otherwise.
    const { container: pedagogyRoot, basePath: pedagogyPath } =
      await resolvePedagogyScope(entity, tabType, req);


    // Check if pedagogy exists
    if (!pedagogyRoot) {
      return res.status(404).json({
        message: [{ key: "error", value: "No pedagogy structure found in this entity" }]
      });
    }

    // Check if tabType exists
    if (!pedagogyRoot[tabType]) {
      return res.status(404).json({
        message: [{ key: "error", value: `No ${tabType} section found in pedagogy` }]
      });
    }

    // Convert Map to object if needed
    const tabData = pedagogyRoot[tabType] instanceof Map
      ? Object.fromEntries(pedagogyRoot[tabType])
      : pedagogyRoot[tabType];

    // Check if subcategory exists
    if (!tabData[subcategory]) {
      return res.status(404).json({
        message: [{ key: "error", value: `Subcategory "${subcategory}" not found in ${tabType}` }]
      });
    }

    const exercises = tabData[subcategory];

    if (!Array.isArray(exercises)) {
      return res.status(400).json({
        message: [{ key: "error", value: `Invalid exercises format in subcategory "${subcategory}"` }]
      });
    }

    // Find the exercise by ID
    let foundExercise = null;
    let foundExerciseIndex = -1;

    for (let i = 0; i < exercises.length; i++) {
      const exercise = exercises[i];

      // Check all possible ID fields
      const matches = (
        (exercise._id && exercise._id.toString() === exerciseId) ||
        (exercise.exerciseInformation?.exerciseId === exerciseId) ||
        (exercise.exerciseInformation?._id?.toString() === exerciseId)
      );

      if (matches) {
        foundExercise = exercise;
        foundExerciseIndex = i;
        break;
      }
    }

    if (!foundExercise) {
      console.error(`❌ Exercise with ID "${exerciseId}" not found in subcategory "${subcategory}"`);

      const availableExercises = exercises.map((ex, idx) => ({
        index: idx,
        _id: ex._id?.toString(),
        exerciseId: ex.exerciseInformation?.exerciseId,
        name: ex.exerciseInformation?.exerciseName,
        exerciseLevel: ex.exerciseInformation?.exerciseLevel,
        questionsCount: ex.questions?.length || 0
      }));

      return res.status(404).json({
        message: [{
          key: "error",
          value: `Exercise with ID "${exerciseId}" not found in subcategory "${subcategory}". Available exercises: ${availableExercises.length}`
        }],
        availableExercises
      });
    }

    // Initialize questions array if not exists
    if (!foundExercise.questions) {
      foundExercise.questions = [];
    }

    // ── Quota gate ────────────────────────────────────────────────────────────
    // The configuration decides how many questions this exercise may hold, per
    // section, difficulty and source slice. Checked here — before anything is
    // written — so a disabled button in the UI is a convenience, not the only
    // thing standing between a quota of 2 and a batch of 50.
    const quotaError = validateQuestionQuota(foundExercise, questionsToAdd);
    if (quotaError) {
      return res.status(400).json({
        message: [{ key: "error", value: quotaError }],
        quotaExceeded: true,
      });
    }

    const addedQuestions = [];
    const startSequence = foundExercise.questions.length;

    // Add all questions
    for (let i = 0; i < questionsToAdd.length; i++) {
      const questionData = questionsToAdd[i];
      const qType = questionData.questionType || questionType;
      const questionId = new mongoose.Types.ObjectId();

      // Create base question object
      // Create base question object
      const newQuestion = {
        _id: questionId,
        questionType: qType,
        sectionId: questionData.sectionId || null, // ✅ ADD THIS LINE
        // Question Source tag ('scratch-manual' / 'scratch-bank' / 'ai' /
        // 'thirdParty') — drives the source badge and per-source quota math.
        source: questionData.source || null,
        // Origin Question Bank doc id — lets the picker and quota validator
        // reject re-imports of the same bank question.
        bankQuestionId: questionData.bankQuestionId || null,
        isActive: questionData.isActive !== undefined ? questionData.isActive : true,
        sequence: startSequence + i,
        createdAt: new Date(),
        updatedAt: new Date()
      };
      // Add fields based on question type
      if (qType === 'mcq') {
        // Process MCQ options
        const options = questionData.options || questionData.mcqOptions || [];
        const processedOptions = [];

        for (let optIndex = 0; optIndex < options.length; optIndex++) {
          const option = options[optIndex];

          let optionText = '';
          let isCorrect = false;
          let imageUrl = null;
          let imageAlignment = 'left';
          let imageSizePercent = 100;

          if (typeof option === 'string') {
            optionText = option;
            const correctAnswer = questionData.correctAnswer || questionData.mcqCorrectAnswer;
            isCorrect = (parseInt(correctAnswer) === optIndex) || (correctAnswer === option);
          } else if (typeof option === 'object' && option !== null) {
            optionText = option.text || '';
            isCorrect = option.isCorrect || false;
            imageUrl = option.imageUrl || null;
            imageAlignment = option.imageAlignment || 'left';
            imageSizePercent = option.imageSizePercent || 100;

            // Handle base64 image if present (from frontend editor)
            if (option.imageUrl && option.imageUrl.startsWith('data:image')) {
              try {
                // Convert base64 to buffer and upload to Supabase
                const base64Data = option.imageUrl.split(',')[1];
                const buffer = Buffer.from(base64Data, 'base64');
                const fileName = `mcq_option_${Date.now()}_${optIndex}.png`;
                const filePath = `${entity._id}/${exerciseId}/${questionId}/options/${fileName}`;

                const uploadedImageUrl = await uploadBufferToSupabase(
                  buffer,
                  filePath,
                  'image/png'
                );
                imageUrl = uploadedImageUrl;
              } catch (uploadError) {
                console.error(`Error uploading base64 image for option ${optIndex}:`, uploadError);
              }
            }
          }

          processedOptions.push({
            _id: new mongoose.Types.ObjectId(),
            text: optionText,
            isCorrect: isCorrect,
            imageUrl: imageUrl,
            imageAlignment: imageAlignment,
            imageSizePercent: imageSizePercent
          });
        }

        Object.assign(newQuestion, {
          questionTitle: questionData.questionTitle || questionData.mcqQuestionTitle || '',
          options: processedOptions,
          correctAnswer: questionData.correctAnswer || questionData.mcqCorrectAnswer || '',
        });

      } else if (qType === 'programming') {
        // Handle description with potential base64 image
        let imageUrl = null;

        // Check if description contains base64 image
        if (questionData.description && questionData.description.imageUrl) {
          const imageData = questionData.description.imageUrl;

          if (imageData.startsWith('data:image')) {
            try {
              // Extract base64 data
              const matches = imageData.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
              if (matches && matches.length === 3) {
                const mimeType = matches[1];
                const base64Data = matches[2];
                const buffer = Buffer.from(base64Data, 'base64');

                // Determine file extension
                const extension = mimeType.split('/')[1] || 'png';
                const fileName = `question_image_${Date.now()}.${extension}`;
                const filePath = `${entity._id}/${exerciseId}/${questionId}/${fileName}`;

                // Upload to Supabase
                const uploadedImageUrl = await uploadBufferToSupabase(
                  buffer,
                  filePath,
                  mimeType
                );
                imageUrl = uploadedImageUrl;
              }
            } catch (uploadError) {
              console.error('Error uploading base64 image:', uploadError);
            }
          } else {
            // Already a URL
            imageUrl = questionData.description.imageUrl;
          }
        }

        const descriptionObj = {
          text: questionData.description?.text || questionData.description || '',
          imageUrl: imageUrl,
          imageAlignment: questionData.description?.imageAlignment || 'left',
          imageSizePercent: questionData.description?.imageSizePercent || 100
        };

        // Extract plain-text title for search/display; store rich blocks separately
        const _plainTitle = typeof questionData.title === 'string'
          ? questionData.title.trim()
          : (Array.isArray(questionData.programmingQuestionTitle)
            ? questionData.programmingQuestionTitle.filter(b => b.type === 'text').map(b => b.value || '').join(' ').trim()
            : '');

        Object.assign(newQuestion, {
          title: _plainTitle,
          // Store rich title blocks separately for rendering
          programmingQuestionTitle: Array.isArray(questionData.programmingQuestionTitle)
            ? questionData.programmingQuestionTitle
            : undefined,
          // Store rich description blocks array for rendering
          programmingQuestionDescription: Array.isArray(questionData.programmingQuestionDescription)
            ? questionData.programmingQuestionDescription
            : undefined,
          description: descriptionObj,
          difficulty: questionData.difficulty || 'medium',
          sampleInput: questionData.sampleInput || '',
          sampleOutput: questionData.sampleOutput || '',
          score: questionData.score || 0,
          constraints: Array.isArray(questionData.constraints) && questionData.constraints.length > 0
            ? questionData.constraints.filter(c => c && c.trim())
            : undefined,
          hints: Array.isArray(questionData.hints) && questionData.hints.length > 0
            ? questionData.hints.map((hint, index) => ({
              _id: new mongoose.Types.ObjectId(),
              hintText: hint.hintText || hint,
              pointsDeduction: hint.pointsDeduction || 0,
              isPublic: hint.isPublic !== undefined ? hint.isPublic : true,
              sequence: hint.sequence || index
            }))
            : undefined,
          testCases: Array.isArray(questionData.testCases) && questionData.testCases.length > 0
            ? questionData.testCases.map((testCase, index) => ({
              _id: new mongoose.Types.ObjectId(),
              input: testCase.input || '',
              expectedOutput: testCase.expectedOutput || '',
              isSample: testCase.isSample !== undefined ? testCase.isSample : false,
              isHidden: testCase.isHidden !== undefined ? testCase.isHidden : true,
              points: testCase.points || 1,
              explanation: testCase.explanation || `Test case ${index + 1}`,
              sequence: testCase.sequence || index
            }))
            : undefined,
          solutions: questionData.solutions && typeof questionData.solutions === 'object'
            ? {
              startedCode: questionData.solutions.startedCode || '',
              functionName: questionData.solutions.functionName || '',
              language: questionData.solutions.language || ''
            }
            : undefined,
          timeLimit: questionData.timeLimit || 2000,
          memoryLimit: questionData.memoryLimit || 256,
          // Per-question AI test case count. When the exercise's
          // evaluationMethod is 'ai' + 'perQuestion' mode, the client sends a
          // non-null value; otherwise it may be omitted / null. Clamped and
          // filtered by the "Remove undefined fields" pass below.
          aiTestCasesCount: (typeof questionData.aiTestCasesCount === 'number'
              && questionData.aiTestCasesCount >= 0)
            ? Math.min(50, Math.floor(questionData.aiTestCasesCount))
            : (questionData.aiTestCasesCount === null ? null : undefined),
          // Link questions: the external URL replaces the authored content;
          // validated http(s)-only above. Absent → stripped by the
          // remove-undefined pass.
          isLinkQuestion: questionData.isLinkQuestion === true ? true : undefined,
          questionLink: (questionData.isLinkQuestion === true
              && typeof questionData.questionLink === 'string'
              && /^https?:\/\/\S+$/i.test(questionData.questionLink.trim()))
            ? questionData.questionLink.trim()
            : undefined,
          // Code Setup — starterCode ships to the student attempt UI;
          // solutionCode is author-only (stripped for students by
          // testCaseVisibility.js on every pedagogy read). Link questions
          // carry neither.
          starterCode: questionData.isLinkQuestion === true
            ? undefined
            : normalizeCodeSetupValue(questionData.starterCode),
          solutionCode: questionData.isLinkQuestion === true
            ? undefined
            : normalizeCodeSetupValue(questionData.solutionCode),
          codeSetupLanguage: (questionData.isLinkQuestion !== true
              && typeof questionData.codeSetupLanguage === 'string'
              && questionData.codeSetupLanguage)
            ? questionData.codeSetupLanguage
            : undefined,
        });

        // Remove undefined fields
        Object.keys(newQuestion).forEach(key => {
          if (newQuestion[key] === undefined) {
            delete newQuestion[key];
          }
        });

      } else if (qType === 'database') {
        // Handle description with contentBlocks
        const descObj = typeof questionData.description === 'object'
          ? questionData.description
          : { text: questionData.description || '', contentBlocks: [] };

        Object.assign(newQuestion, {
          title: typeof questionData.title === 'string' ? questionData.title.trim() : '',
          description: {
            text: descObj.text || '',
            imageUrl: descObj.imageUrl || null,
            imageAlignment: descObj.imageAlignment || 'left',
            imageSizePercent: descObj.imageSizePercent || 100,
            contentBlocks: Array.isArray(descObj.contentBlocks) ? descObj.contentBlocks : [],
          },
          sampleQuery: questionData.sampleQuery || '',
          sampleResult: Array.isArray(questionData.sampleResult)
            ? questionData.sampleResult
            : (questionData.sampleResult ? [{ type: 'text', value: String(questionData.sampleResult) }] : []),
          difficulty: questionData.difficulty || 'medium',
          score: questionData.score || questionData.points || 0,
          points: questionData.score || questionData.points || 0,
          isDatabase: true,
          moduleType: 'Database',
          constraints: Array.isArray(questionData.constraints)
            ? questionData.constraints.filter(c => c && c.trim())
            : [],
          hints: Array.isArray(questionData.hints) && questionData.hints.length > 0
            ? questionData.hints.map((hint, index) => ({
              _id: new mongoose.Types.ObjectId(),
              hintText: hint.hintText || hint,
              pointsDeduction: hint.pointsDeduction || 0,
              isPublic: hint.isPublic !== undefined ? hint.isPublic : true,
              sequence: hint.sequence || index,
            }))
            : undefined,
          // Code Setup — starterCode ships to the student attempt UI;
          // solutionCode is author-only (stripped for students by
          // testCaseVisibility.js on every pedagogy read).
          starterCode: typeof questionData.starterCode === 'string' ? questionData.starterCode : undefined,
          solutionCode: typeof questionData.solutionCode === 'string' ? questionData.solutionCode : undefined,
        });
      } else if (qType === 'others') {
        // Build othersDescription object with text, html, images, and attachments
        const othersDescription = {
          text: "",
          html: "",
          images: [],
          attachments: []
        };

        // Process description from the request
        if (questionData.description) {
          // If description is a string (HTML with image)
          if (typeof questionData.description === 'string') {
            othersDescription.html = questionData.description;
            // Strip HTML tags for plain text
            othersDescription.text = questionData.description.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

            // Extract images from HTML
            const imgRegex = /<img[^>]+src="([^">]+)"[^>]*(?:alt="([^">]*)")?[^>]*>/gi;
            let match;
            while ((match = imgRegex.exec(questionData.description)) !== null) {
              // Extract style attribute if present
              const styleMatch = questionData.description.match(/style="([^"]+)"/);

              othersDescription.images.push({
                url: match[1],
                alt: match[2] || "",
                alignment: "left",
                style: styleMatch ? styleMatch[1] : "max-width:100%;border-radius:6px;margin-top:8px;",
                width: "100%",
                height: "auto"
              });
            }
          }
          // If description is already an object
          else if (typeof questionData.description === 'object' && questionData.description !== null) {
            othersDescription.text = questionData.description.text || "";
            othersDescription.html = questionData.description.html || "";
            othersDescription.images = questionData.description.images || [];
            othersDescription.attachments = questionData.description.attachments || [];
          }
        }

        // Process attachments from root level and add to othersDescription
        if (Array.isArray(questionData.attachments) && questionData.attachments.length > 0) {
          for (const att of questionData.attachments) {
            // Determine icon based on mime type
            let icon = "📎";
            const mimeType = att.mimeType || "";
            if (mimeType.includes('pdf')) icon = "📄";
            else if (mimeType.includes('word') || mimeType.includes('docx') || mimeType.includes('document')) icon = "📝";
            else if (mimeType.includes('image')) icon = "🖼️";
            else if (mimeType.includes('video')) icon = "🎥";
            else if (mimeType.includes('audio')) icon = "🎵";
            else if (mimeType.includes('spreadsheet') || mimeType.includes('excel') || mimeType.includes('csv')) icon = "📊";
            else if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) icon = "📽️";
            else if (mimeType.includes('zip') || mimeType.includes('compressed')) icon = "🗜️";
            else if (mimeType.includes('text')) icon = "📃";

            othersDescription.attachments.push({
              name: att.name || "untitled",
              url: att.url || "",
              mimeType: mimeType || "application/octet-stream",
              size: att.size || 0,
              icon: icon,
              description: att.description || "",
              uploadedAt: new Date()
            });
          }
        }

        // Process file upload settings
        const fileUploadSettings = {
          allowMultiple: questionData.fileUploadSettings?.allowMultiple || false,
          maxFiles: questionData.fileUploadSettings?.maxFiles || 1,
          maxFileSizeMB: questionData.fileUploadSettings?.maxFileSizeMB || 10,
          allowedTypes: Array.isArray(questionData.fileUploadSettings?.allowedTypes)
            ? questionData.fileUploadSettings.allowedTypes
            : ["pdf", "docx"],
          requiredFormats: Array.isArray(questionData.fileUploadSettings?.requiredFormats)
            ? questionData.fileUploadSettings.requiredFormats
            : [],
          instructions: questionData.fileUploadSettings?.instructions || ""
        };

        Object.assign(newQuestion, {
          title: typeof questionData.title === 'string' ? questionData.title.trim() : '',
          othersDescription: othersDescription,
          difficulty: questionData.difficulty || 'medium',
          score: questionData.score || 0,
          isRequired: questionData.isRequired !== undefined ? questionData.isRequired : true,
          othersQuestionType: questionData.othersQuestionType || 'file-upload',
          fileUploadSettings: fileUploadSettings,
          scoringType: questionData.scoringType || 'levelBased',
          questionCountPerLevel: questionData.questionCountPerLevel || {
            easy: 2,
            medium: 2,
            hard: 2
          },
          totalMarks: questionData.totalMarks || 50,
          notionSettings: questionData.notionSettings || undefined
        });

        console.log('✅ Others question processed:', {
          title: newQuestion.title,
          descriptionHasImages: othersDescription.images.length,
          descriptionHasAttachments: othersDescription.attachments.length,
          attachmentsDetails: othersDescription.attachments.map(a => ({ name: a.name, mimeType: a.mimeType }))
        });
      }
      // Stamp creator + initial approval so the approver-query notification
      // has a recipient and per-step approval starts in 'pending'.
      newQuestion.createdBy = req.user?._id || req.user?.id || null;
      newQuestion.createdByEmail = req.user?.email || '';
      if (!newQuestion.approval) newQuestion.approval = { status: 'pending', queries: [] };
      // Add question to exercise
      foundExercise.questions.push(newQuestion);
      addedQuestions.push({
        question: newQuestion,
        index: startSequence + i
      });
    }

    // Update the exercise in the array
    exercises[foundExerciseIndex] = foundExercise;

    // ── Deferred approval-notify for "settings_and_questions" scope ────────
    // If the exercise's approvalScope was "settings_and_questions", the
    // step-1 notification was deliberately skipped at create-time. Now that
    // questions have been added, re-check: if the exercise just became
    // fully configured, stamp notifiedAt (idempotent) and fire the notify
    // after save.
    const questionAddNotify = shouldFireStep1Notification(foundExercise);
    if (questionAddNotify) {
      foundExercise.approvalWorkflow.steps[0].notifiedAt = new Date();
      entity.markModified(`${pedagogyPath}.${tabType}.${subcategory}.${foundExerciseIndex}.approvalWorkflow`);
    }
    // Trainer added a question to a rejected assessment — flip the flag so
    // the approver's UI shows "Approve" (not "Approve anyway").
    if (foundExercise?.approvalWorkflow?.overallStatus === 'rejected') {
      foundExercise.approvalWorkflow.editedSinceReject = true;
      entity.markModified(`${pedagogyPath}.${tabType}.${subcategory}.${foundExerciseIndex}.approvalWorkflow`);
    }

    // Update the entity's pedagogy structure
    if (pedagogyRoot[tabType] instanceof Map) {
      pedagogyRoot[tabType].set(subcategory, exercises);
    } else {
      pedagogyRoot[tabType][subcategory] = exercises;
    }

    // Mark as modified
    entity.markModified(`${pedagogyPath}.${tabType}`);
    entity.markModified(`${pedagogyPath}.${tabType}.${subcategory}`);
    entity.markModified(`${pedagogyPath}.${tabType}.${subcategory}.${foundExerciseIndex}.questions`);

    // Update timestamps
    entity.updatedBy = req.user?.email || "roobankr5@gmail.com";
    entity.updatedAt = new Date();

    // Save entity
    await entity.save();

    // ── Fire deferred approval notify (best-effort, non-blocking) ──────────
    if (questionAddNotify) {
      const courseIdForNotify = resolveCourseId(entity);
      const courseDoc = courseIdForNotify
        ? await CourseStructure.findById(courseIdForNotify).select('courseName').lean()
        : null;
      notifyApproversForStep({
        courseId: courseIdForNotify,
        courseName: courseDoc?.courseName,
        step: foundExercise.approvalWorkflow.steps[0],
        exerciseName: foundExercise.exerciseInformation?.exerciseName,
        exerciseId: foundExercise._id,
      }).catch((e) => console.warn('notifyApproversForStep (deferred) failed:', e.message));
    }

    // Prepare response data
    const responseData = {
   addedQuestions: addedQuestions.map(q => ({
  questionId: q.question._id.toString(),
  questionTitle: q.question.questionTitle || q.question.title,
  questionType: q.question.questionType,
  sectionId: q.question.sectionId, // ✅ ADD THIS LINE
  sequence: q.index,
        description: q.question.description ? {
          text: q.question.description.text,
          imageUrl: q.question.description.imageUrl,
          imageAlignment: q.question.description.imageAlignment,
          imageSizePercent: q.question.description.imageSizePercent
        } : undefined
      })),
      totalAdded: addedQuestions.length,
      exercise: {
        exerciseId: foundExercise.exerciseInformation?.exerciseId || foundExercise._id.toString(),
        exerciseName: foundExercise.exerciseInformation?.exerciseName || "Exercise",
        exerciseLevel: foundExercise.exerciseInformation?.exerciseLevel || "medium",
        totalQuestions: foundExercise.questions.length,
        totalScore: foundExercise.questions.reduce((sum, q) => sum + (q.score || 0), 0)
      },
      entity: {
        type: type,
        id: entity._id.toString(),
        title: entity.title || entity.name || "Entity"
      },
      location: {
        tabType: tabType,
        subcategory: subcategory,
        exerciseIndex: foundExerciseIndex,
        exerciseId: foundExercise._id.toString(),
        startQuestionIndex: startSequence
      }
    };

    return res.status(201).json({
      message: [{
        key: "success",
        value: `Added ${addedQuestions.length} question(s) successfully to "${foundExercise.exerciseInformation?.exerciseName}" in ${subcategory}`
      }],
      data: responseData
    });

  } catch (err) {
    console.error("❌ Add questions error:", err);
    console.error("❌ Error stack:", err.stack);

    res.status(500).json({
      message: [{
        key: "error",
        value: `Internal server error: ${err.message}`
      }],
      error: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
};


// Update question
// Update question
exports.updateQuestion = async (req, res) => {
  try {
    const { type, id, exerciseId, questionId } = req.params;
    const {
      tabType,
      subcategory,
      questionData,
      ...questionFields // Keep for backward compatibility
    } = req.body;

    // Handle file uploads if present
    let uploadedFiles = [];
    if (req.files && req.files.length > 0) {
      uploadedFiles = req.files;
    }

    // Validate required parameters
    if (!type || !modelMap[type]) {
      return res.status(400).json({
        message: [{ key: "error", value: `Invalid entity type: ${type}. Valid types: modules, submodules, topics, subtopics` }]
      });
    }

    if (!questionId) {
      return res.status(400).json({
        message: [{ key: "error", value: "Question ID is required" }]
      });
    }

    // Get the data to update (either from questionData object or from req.body directly)
    const updateData = questionData || req.body;

    // FIX: Rename this variable to avoid conflict with the parameter
    const questionTypeValue = updateData.questionType;  // ← CHANGED: was 'questionType'

    const validQuestionTypes = ['mcq', 'programming', 'database', 'others'];

    if (questionTypeValue && !validQuestionTypes.includes(questionTypeValue)) {
      return res.status(400).json({
        message: [{ key: "error", value: `Invalid question type: ${questionTypeValue}. Valid types: ${validQuestionTypes.join(', ')}` }]
      });
    }

    // Validate based on question type if validation fields are provided
    if (questionTypeValue === 'mcq') {
      // Validate MCQ fields if they are being updated
      if (updateData.questionTitle !== undefined || updateData.mcqQuestionTitle !== undefined) {
        const questionTitle = updateData.questionTitle || updateData.mcqQuestionTitle;
        if (!questionTitle || !questionTitle.trim()) {
          return res.status(400).json({
            message: [{ key: "error", value: "MCQ question title cannot be empty" }]
          });
        }
      }

      if (updateData.options !== undefined || updateData.mcqOptions !== undefined) {
        const options = updateData.options || updateData.mcqOptions;
        if (!Array.isArray(options) || options.length < 2) {
          return res.status(400).json({
            message: [{ key: "error", value: "At least 2 options are required for MCQ" }]
          });
        }
      }

      if (updateData.correctAnswer !== undefined || updateData.mcqCorrectAnswer !== undefined) {
        const correctAnswer = updateData.correctAnswer || updateData.mcqCorrectAnswer;
        if (!correctAnswer && correctAnswer !== 0) {
          return res.status(400).json({
            message: [{ key: "error", value: "Correct answer is required for MCQ" }]
          });
        }
      }
    } else if (questionTypeValue === 'programming') {
      // Link questions: the URL is the whole question — an empty authored
      // body is the NORMAL state, not an error (mirror of the add path).
      const _isLinkUpdate = updateData.isLinkQuestion === true;
      if (_isLinkUpdate) {
        const _lnk = typeof updateData.questionLink === 'string' ? updateData.questionLink.trim() : '';
        if (!/^https?:\/\/\S+$/i.test(_lnk)) {
          return res.status(400).json({
            message: [{ key: "error", value: "A valid http(s) question link is required" }]
          });
        }
      }

      // Validate Programming fields if they are being updated
      if (!_isLinkUpdate && updateData.title !== undefined) {
        if (!updateData.title || !updateData.title.trim()) {
          return res.status(400).json({
            message: [{ key: "error", value: "Programming question title cannot be empty" }]
          });
        }
      }

      // Check if description is being updated and validate
      if (!_isLinkUpdate && updateData.description !== undefined) {
        let descriptionText = '';
        if (Array.isArray(updateData.description)) {
          // New format: ProgContentBlock[] array
          descriptionText = updateData.description
            .filter(b => b.type === 'text' || b.type === 'image')
            .map(b => b.type === 'image' ? '[image]' : (b.value || ''))
            .join(' ')
            .replace(/<[^>]*>/g, '')
            .trim();
        } else if (typeof updateData.description === 'object' && updateData.description !== null) {
          // Legacy format
          if (Array.isArray(updateData.description.contentBlocks) && updateData.description.contentBlocks.length > 0) {
            descriptionText = updateData.description.contentBlocks
              .filter(b => b.type === 'text' || b.type === 'image')
              .map(b => b.type === 'image' ? '[image]' : (b.value || ''))
              .join(' ')
              .replace(/<[^>]*>/g, '')
              .trim();
          } else {
            descriptionText = updateData.description.text || '';
          }
        } else {
          descriptionText = updateData.description || '';
        }

        if (!descriptionText || !descriptionText.trim()) {
          return res.status(400).json({
            message: [{ key: "error", value: "Programming question description text cannot be empty" }]
          });
        }
      }

      // Validate programming difficulty if being updated
      if (updateData.difficulty !== undefined) {
        const validDifficulties = ['easy', 'medium', 'hard'];
        if (!validDifficulties.includes(updateData.difficulty)) {
          return res.status(400).json({
            message: [{ key: "error", value: `Invalid difficulty. Valid values: ${validDifficulties.join(', ')}` }]
          });
        }
      }
    }

    // Get the model from modelMap
    const { model } = modelMap[type];

    if (!model) {
      return res.status(400).json({
        message: [{ key: "error", value: `Model not found for type: ${type}` }]
      });
    }

    // Find the entity
    const entity = await model.findById(id);

    if (!entity) {
      return res.status(404).json({
        message: [{ key: "error", value: `${type} with ID ${id} not found` }]
      });
    }
    // ── Resources by Batch ───────────────────────────────────────────────
    // Which I_Do/We_Do/You_Do set this request belongs to. For a shared
    // element that is the course-level `pedagogy`; for one ticked batch-wise
    // in Course Setup it is this batch's own `batchPedagogy.<batchId>`.
    // Resolving it here means every lookup and markModified below lands in
    // the right place — without it We Do and You Do would keep reading the
    // course-level set while the batch strip claimed otherwise.
    const { container: pedagogyRoot, basePath: pedagogyPath } =
      await resolvePedagogyScope(entity, tabType, req);


    // Check if pedagogy exists
    if (!pedagogyRoot) {
      return res.status(404).json({
        message: [{ key: "error", value: "No pedagogy structure found in this entity" }]
      });
    }

    // Check if tabType exists
    if (!pedagogyRoot[tabType]) {
      return res.status(404).json({
        message: [{ key: "error", value: `No ${tabType} section found in pedagogy` }]
      });
    }

    // Convert Map to object if needed
    const tabData = pedagogyRoot[tabType] instanceof Map
      ? Object.fromEntries(pedagogyRoot[tabType])
      : pedagogyRoot[tabType];

    // Check if subcategory exists
    if (!tabData[subcategory]) {
      return res.status(404).json({
        message: [{ key: "error", value: `Subcategory "${subcategory}" not found in ${tabType}` }]
      });
    }

    const exercises = tabData[subcategory];

    if (!Array.isArray(exercises)) {
      return res.status(400).json({
        message: [{ key: "error", value: `Invalid exercises format in subcategory "${subcategory}"` }]
      });
    }

    // Find the exercise by ID
    let foundExercise = null;
    let foundExerciseIndex = -1;

    for (let i = 0; i < exercises.length; i++) {
      const exercise = exercises[i];

      // Check all possible ID fields
      const matches = (
        (exercise._id && exercise._id.toString() === exerciseId) ||
        (exercise.exerciseInformation?.exerciseId === exerciseId) ||
        (exercise.exerciseInformation?._id?.toString() === exerciseId)
      );

      if (matches) {
        foundExercise = exercise;
        foundExerciseIndex = i;
        break;
      }
    }

    if (!foundExercise) {
      console.error(`❌ Exercise with ID "${exerciseId}" not found in subcategory "${subcategory}"`);

      const availableExercises = exercises.map((ex, idx) => ({
        index: idx,
        _id: ex._id?.toString(),
        exerciseId: ex.exerciseInformation?.exerciseId,
        name: ex.exerciseInformation?.exerciseName,
        exerciseLevel: ex.exerciseInformation?.exerciseLevel,
        questionsCount: ex.questions?.length || 0
      }));

      return res.status(404).json({
        message: [{
          key: "error",
          value: `Exercise with ID "${exerciseId}" not found in subcategory "${subcategory}". Available exercises: ${availableExercises.length}`
        }],
        availableExercises
      });
    }

    // Check if questions array exists
    if (!foundExercise.questions || !Array.isArray(foundExercise.questions)) {
      return res.status(404).json({
        message: [{ key: "error", value: "No questions found in this exercise" }]
      });
    }

    // Find the question to update
    const questionIndex = foundExercise.questions.findIndex(q =>
      q._id.toString() === questionId
    );

    if (questionIndex === -1) {
      return res.status(404).json({
        message: [{ key: "error", value: `Question with ID ${questionId} not found in exercise` }]
      });
    }

    const existingQuestion = foundExercise.questions[questionIndex];
    // FIX: Use the renamed variable here
    const finalQuestionType = questionTypeValue || existingQuestion.questionType;

    // Create updated question object by merging existing with new data
    const updatedQuestion = { ...existingQuestion.toObject ? existingQuestion.toObject() : existingQuestion };

    // Update common fields
  // Update common fields
if (updateData.isActive !== undefined) {
  updatedQuestion.isActive = updateData.isActive;
}
if (updateData.sectionId !== undefined) {
  updatedQuestion.sectionId = updateData.sectionId; // ✅ ADD THIS
}
// Question Source tag — only overwrite when the client sends a real value so
// legacy edit paths (no source in payload) can't wipe an existing tag.
if (updateData.source) {
  updatedQuestion.source = updateData.source;
}

    // Update based on question type
    if (finalQuestionType === 'mcq') {
      // Update MCQ fields
      if (updateData.questionTitle !== undefined || updateData.mcqQuestionTitle !== undefined) {
        updatedQuestion.questionTitle = updateData.questionTitle || updateData.mcqQuestionTitle || '';
      }

      // Process MCQ options if provided
      if (updateData.options !== undefined || updateData.mcqOptions !== undefined) {
        const options = updateData.options || updateData.mcqOptions || [];
        const processedOptions = [];

        for (let optIndex = 0; optIndex < options.length; optIndex++) {
          const option = options[optIndex];

          let optionText = '';
          let isCorrect = false;
          let imageUrl = null;
          let imageAlignment = 'left';
          let imageSizePercent = 100;

          if (typeof option === 'string') {
            optionText = option;
            const correctAnswer = updateData.correctAnswer || updateData.mcqCorrectAnswer;
            if (correctAnswer !== undefined) {
              isCorrect = (parseInt(correctAnswer) === optIndex) || (correctAnswer === option);
            } else {
              // Keep existing isCorrect value if not updating correctAnswer
              isCorrect = updatedQuestion.options[optIndex]?.isCorrect || false;
            }
          } else if (typeof option === 'object' && option !== null) {
            optionText = option.text || '';
            isCorrect = option.isCorrect !== undefined ? option.isCorrect : (updatedQuestion.options[optIndex]?.isCorrect || false);
            imageUrl = option.imageUrl || updatedQuestion.options[optIndex]?.imageUrl || null;
            imageAlignment = option.imageAlignment || updatedQuestion.options[optIndex]?.imageAlignment || 'left';
            imageSizePercent = option.imageSizePercent || updatedQuestion.options[optIndex]?.imageSizePercent || 100;

            // Handle base64 image if present (from frontend editor)
            if (option.imageUrl && option.imageUrl.startsWith('data:image')) {
              try {
                // Convert base64 to buffer and upload to Supabase
                const base64Data = option.imageUrl.split(',')[1];
                const buffer = Buffer.from(base64Data, 'base64');
                const fileName = `mcq_option_${Date.now()}_${optIndex}.png`;
                const filePath = `${entity._id}/${exerciseId}/${questionId}/options/${fileName}`;

                const uploadedImageUrl = await uploadBufferToSupabase(
                  buffer,
                  filePath,
                  'image/png'
                );
                imageUrl = uploadedImageUrl;
              } catch (uploadError) {
                console.error(`Error uploading base64 image for option ${optIndex}:`, uploadError);
              }
            }
          }

          processedOptions.push({
            _id: updatedQuestion.options[optIndex]?._id || new mongoose.Types.ObjectId(),
            text: optionText,
            isCorrect: isCorrect,
            imageUrl: imageUrl,
            imageAlignment: imageAlignment,
            imageSizePercent: imageSizePercent
          });
        }

        updatedQuestion.options = processedOptions;
      }

      if (updateData.correctAnswer !== undefined || updateData.mcqCorrectAnswer !== undefined) {
        updatedQuestion.correctAnswer = updateData.correctAnswer || updateData.mcqCorrectAnswer || '';
      }

    } else if (finalQuestionType === 'programming') {
      // Update Programming fields
      if (updateData.title !== undefined) {
        updatedQuestion.title = typeof updateData.title === 'string'
          ? updateData.title.trim()
          : (updatedQuestion.title || '');
      }

      // Handle description with potential base64 image
      if (updateData.description !== undefined) {
        let imageUrl = updatedQuestion.description?.imageUrl || null;

        // Check if description contains base64 image
        if (updateData.description && updateData.description.imageUrl) {
          const imageData = updateData.description.imageUrl;

          if (imageData.startsWith('data:image')) {
            try {
              // Extract base64 data
              const matches = imageData.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
              if (matches && matches.length === 3) {
                const mimeType = matches[1];
                const base64Data = matches[2];
                const buffer = Buffer.from(base64Data, 'base64');

                // Determine file extension
                const extension = mimeType.split('/')[1] || 'png';
                const fileName = `question_image_${Date.now()}.${extension}`;
                const filePath = `${entity._id}/${exerciseId}/${questionId}/${fileName}`;

                // Upload to Supabase
                const uploadedImageUrl = await uploadBufferToSupabase(
                  buffer,
                  filePath,
                  mimeType
                );
                imageUrl = uploadedImageUrl;
              }
            } catch (uploadError) {
              console.error('Error uploading base64 image:', uploadError);
            }
          } else if (imageData !== updatedQuestion.description?.imageUrl) {
            // Only update if it's a new URL (not the same as existing)
            imageUrl = imageData;
          }
        }

        const descriptionObj = {
          text: updateData.description?.text !== undefined ? updateData.description.text : (updatedQuestion.description?.text || ''),
          imageUrl: imageUrl,
          imageAlignment: updateData.description?.imageAlignment !== undefined ? updateData.description.imageAlignment : (updatedQuestion.description?.imageAlignment || 'left'),
          imageSizePercent: updateData.description?.imageSizePercent !== undefined ? updateData.description.imageSizePercent : (updatedQuestion.description?.imageSizePercent || 100)
        };

        updatedQuestion.description = descriptionObj;
      }

      if (updateData.difficulty !== undefined) {
        updatedQuestion.difficulty = updateData.difficulty;
      }

      if (updateData.sampleInput !== undefined) {
        updatedQuestion.sampleInput = updateData.sampleInput;
      }

      if (updateData.sampleOutput !== undefined) {
        updatedQuestion.sampleOutput = updateData.sampleOutput;
      }

      if (updateData.score !== undefined) {
        updatedQuestion.score = updateData.score;
      }

      // Update constraints if provided
      if (updateData.constraints !== undefined) {
        updatedQuestion.constraints = Array.isArray(updateData.constraints) && updateData.constraints.length > 0
          ? updateData.constraints.filter(c => c && c.trim())
          : undefined;
      }

      // Update hints if provided
      if (updateData.hints !== undefined) {
        if (Array.isArray(updateData.hints) && updateData.hints.length > 0) {
          updatedQuestion.hints = updateData.hints.map((hint, index) => ({
            _id: hint._id || new mongoose.Types.ObjectId(),
            hintText: hint.hintText || hint,
            pointsDeduction: hint.pointsDeduction || 0,
            isPublic: hint.isPublic !== undefined ? hint.isPublic : true,
            sequence: hint.sequence || index
          }));
        } else {
          updatedQuestion.hints = undefined;
        }
      }

      // Update test cases if provided
      if (updateData.testCases !== undefined) {
        if (Array.isArray(updateData.testCases) && updateData.testCases.length > 0) {
          updatedQuestion.testCases = updateData.testCases.map((testCase, index) => ({
            _id: testCase._id || new mongoose.Types.ObjectId(),
            input: testCase.input || '',
            expectedOutput: testCase.expectedOutput || '',
            isSample: testCase.isSample !== undefined ? testCase.isSample : false,
            isHidden: testCase.isHidden !== undefined ? testCase.isHidden : true,
            points: testCase.points || 1,
            explanation: testCase.explanation || `Test case ${index + 1}`,
            sequence: testCase.sequence || index
          }));
        } else {
          updatedQuestion.testCases = undefined;
        }
      }

      // Update solutions if provided
      if (updateData.solutions !== undefined) {
        if (updateData.solutions && typeof updateData.solutions === 'object') {
          updatedQuestion.solutions = {
            startedCode: updateData.solutions.startedCode !== undefined ? updateData.solutions.startedCode : (updatedQuestion.solutions?.startedCode || ''),
            functionName: updateData.solutions.functionName !== undefined ? updateData.solutions.functionName : (updatedQuestion.solutions?.functionName || ''),
            language: updateData.solutions.language !== undefined ? updateData.solutions.language : (updatedQuestion.solutions?.language || '')
          };
        } else {
          updatedQuestion.solutions = undefined;
        }
      }

      if (updateData.timeLimit !== undefined) {
        updatedQuestion.timeLimit = updateData.timeLimit;
      }

      if (updateData.memoryLimit !== undefined) {
        updatedQuestion.memoryLimit = updateData.memoryLimit;
      }

      // Per-question AI test case count — clamped [0, 50]; null accepted
      // (means "not set", falls back to exercise count at Submit time).
      if (updateData.aiTestCasesCount !== undefined) {
        const raw = updateData.aiTestCasesCount;
        if (raw === null) {
          updatedQuestion.aiTestCasesCount = null;
        } else if (typeof raw === 'number' && raw >= 0) {
          updatedQuestion.aiTestCasesCount = Math.min(50, Math.floor(raw));
        }
      }

      // Link questions — same http(s)-only sanitising as the add path (the
      // value becomes a student-facing iframe src).
      if (updateData.isLinkQuestion !== undefined) {
        updatedQuestion.isLinkQuestion = updateData.isLinkQuestion === true;
      }
      if (updateData.questionLink !== undefined) {
        const link = typeof updateData.questionLink === 'string' ? updateData.questionLink.trim() : '';
        updatedQuestion.questionLink = /^https?:\/\/\S+$/i.test(link) ? link : '';
      }

      // Code Setup — starterCode ships to the student attempt UI; solutionCode
      // is author-only (stripped for students by testCaseVisibility.js on
      // every pedagogy read). Switching a question to link mode clears both.
      if (updatedQuestion.isLinkQuestion === true) {
        updatedQuestion.starterCode = undefined;
        updatedQuestion.solutionCode = undefined;
      } else {
        if (updateData.starterCode !== undefined) {
          updatedQuestion.starterCode = normalizeCodeSetupValue(updateData.starterCode);
        }
        if (updateData.solutionCode !== undefined) {
          updatedQuestion.solutionCode = normalizeCodeSetupValue(updateData.solutionCode);
        }
      }
      if (updateData.codeSetupLanguage !== undefined) {
        updatedQuestion.codeSetupLanguage = (typeof updateData.codeSetupLanguage === 'string' && updateData.codeSetupLanguage)
          ? updateData.codeSetupLanguage
          : undefined;
      }
    } else if (finalQuestionType === 'database') {
      // Update Database fields
      if (updateData.title !== undefined) {
        updatedQuestion.title = updateData.title.trim();
      }

      if (updateData.description !== undefined) {
        const descObj = typeof updateData.description === 'object'
          ? updateData.description
          : { text: updateData.description || '' };
        updatedQuestion.description = {
          text: descObj.text || updatedQuestion.description?.text || '',
          imageUrl: descObj.imageUrl !== undefined ? descObj.imageUrl : (updatedQuestion.description?.imageUrl || null),
          imageAlignment: descObj.imageAlignment || updatedQuestion.description?.imageAlignment || 'left',
          imageSizePercent: descObj.imageSizePercent || updatedQuestion.description?.imageSizePercent || 100,
          contentBlocks: Array.isArray(descObj.contentBlocks) ? descObj.contentBlocks : (updatedQuestion.description?.contentBlocks || []),
        };
      }

      if (updateData.sampleQuery !== undefined) {
        updatedQuestion.sampleQuery = updateData.sampleQuery;
      }

      if (updateData.sampleResult !== undefined) {
        updatedQuestion.sampleResult = Array.isArray(updateData.sampleResult)
          ? updateData.sampleResult
          : [{ type: 'text', value: String(updateData.sampleResult) }];
      }

      if (updateData.difficulty !== undefined) {
        updatedQuestion.difficulty = updateData.difficulty;
      }

      if (updateData.score !== undefined || updateData.points !== undefined) {
        updatedQuestion.score = updateData.score || updateData.points || 0;
        updatedQuestion.points = updatedQuestion.score;
      }

      if (updateData.constraints !== undefined) {
        updatedQuestion.constraints = Array.isArray(updateData.constraints)
          ? updateData.constraints.filter(c => c && c.trim())
          : [];
      }

      if (updateData.hints !== undefined) {
        if (Array.isArray(updateData.hints) && updateData.hints.length > 0) {
          updatedQuestion.hints = updateData.hints.map((hint, index) => ({
            _id: hint._id || new mongoose.Types.ObjectId(),
            hintText: hint.hintText || hint,
            pointsDeduction: hint.pointsDeduction || 0,
            isPublic: hint.isPublic !== undefined ? hint.isPublic : true,
            sequence: hint.sequence || index,
          }));
        } else {
          updatedQuestion.hints = [];
        }
      }

      // Code Setup — starterCode ships to the student attempt UI; solutionCode
      // is author-only (stripped for students by testCaseVisibility.js on
      // every pedagogy read).
      if (updateData.starterCode !== undefined) {
        updatedQuestion.starterCode = typeof updateData.starterCode === 'string' ? updateData.starterCode : '';
      }
      if (updateData.solutionCode !== undefined) {
        updatedQuestion.solutionCode = typeof updateData.solutionCode === 'string' ? updateData.solutionCode : '';
      }

      // Preserve database flags
      updatedQuestion.isDatabase = true;
      updatedQuestion.moduleType = 'Database';
      //     } else if (finalExerciseType === 'Other' && parsedQuesConfig) {
      //   const othersCfg = parsedQuesConfig.othersQuestionConfiguration 
      //     || parsedQuesConfig.othersConfig
      //     || null;

      //   if (othersCfg) {
      //     const qConfigType = othersCfg.questionConfigType || 'general';
      //     const exInfo = parsedExerciseInfo || existingExercise.exerciseInformation || {};

      //     let othersTotal = 0;

      //     if (qConfigType === 'general') {
      //       const evenMarks = othersCfg.generalMarksPerQuestion 
      //         || othersCfg.scoreSettings?.evenMarks 
      //         || 0;
      //       othersTotal = (othersCfg.generalQuestionCount || 0) * evenMarks;
      //     } else {
      //       const counts = qConfigType === 'selectionLevel'
      //         ? othersCfg.selectionLevelCounts
      //         : othersCfg.levelBasedCounts;
      //       const levelScoring = othersCfg.scoreSettings?.levelScoringConfiguration;

      //       if (levelScoring) {
      //         ['easy', 'medium', 'hard'].forEach(l => {
      //           const c = counts?.[l] || 0;
      //           if (!c) return;
      //           const s = levelScoring[l];
      //           if (!s) return;
      //           if (s.type === 'level_specific' && s.marksPerQuestion) othersTotal += c * s.marksPerQuestion;
      //           else if (s.type === 'question_specific' && s.totalMarks) othersTotal += s.totalMarks;
      //         });
      //       }
      //     }

      //     if (!othersTotal) {
      //       othersTotal = othersCfg.scoreSettings?.totalMarks 
      //         || exInfo.totalMarks 
      //         || existingExercise.exerciseInformation?.totalMarks 
      //         || 0;
      //     }

      //     let levelBasedMarks = { easy: 0, medium: 0, hard: 0 };
      //     const levelScoringConfig = othersCfg.scoreSettings?.levelScoringConfiguration;

      //     if (levelScoringConfig && (qConfigType === 'levelBased' || qConfigType === 'selectionLevel')) {
      //       const counts = qConfigType === 'selectionLevel'
      //         ? othersCfg.selectionLevelCounts
      //         : othersCfg.levelBasedCounts;
      //       ['easy', 'medium', 'hard'].forEach(l => {
      //         const c = counts?.[l] || 0;
      //         if (!c) return;
      //         const s = levelScoringConfig[l];
      //         if (s?.type === 'level_specific' && s.marksPerQuestion) {
      //           levelBasedMarks[l] = s.marksPerQuestion;
      //           if (!levelScoringConfig[l].questionCount) levelScoringConfig[l].questionCount = c;
      //         } else if (s?.type === 'question_specific' && s.totalMarks) {
      //           levelBasedMarks[l] = c > 0 ? s.totalMarks / c : 0;
      //           if (!levelScoringConfig[l].questionCount) levelScoringConfig[l].questionCount = c;
      //         }
      //       });
      //     }

      //     othersQuestionConfig = {
      //       questionConfigType: qConfigType,
      //       ...(qConfigType === 'general' && {
      //         generalQuestionCount: othersCfg.generalQuestionCount || 0,
      //         generalMarksPerQuestion: othersCfg.generalMarksPerQuestion 
      //           || othersCfg.scoreSettings?.evenMarks 
      //           || 0,
      //       }),
      //       ...(qConfigType === 'levelBased' && {
      //         levelBasedCounts: othersCfg.levelBasedCounts || { easy: 0, medium: 0, hard: 0 },
      //       }),
      //       ...(qConfigType === 'selectionLevel' && {
      //         selectionLevelCounts: othersCfg.selectionLevelCounts || { easy: 0, medium: 0, hard: 0 },
      //       }),
      //       scoreSettings: {
      //         scoreType: qConfigType === 'general' ? 'evenMarks' : 'levelBasedMarks',
      //         evenMarks: othersCfg.generalMarksPerQuestion || othersCfg.scoreSettings?.evenMarks || 0,
      //         levelBasedMarks,
      //         levelScoringConfiguration: levelScoringConfig || undefined,
      //         totalMarks: othersTotal,
      //       },
      //       questionFlow: othersCfg.questionFlow || 'freeFlow',
      //       attemptLimitEnabled: othersCfg.attemptLimitEnabled || false,
      //       submissionAttempts: othersCfg.submissionAttempts || 1,
      //     };

      //     progTotalMarks = othersTotal;
      //   }
      // }
    } else if (finalQuestionType === 'others') {
      // Update Others question fields
      if (updateData.title !== undefined) {
        updatedQuestion.title = updateData.title;
      }
      if (updateData.description !== undefined) {
        updatedQuestion.description = updateData.description;
      }
      if (updateData.difficulty !== undefined) {
        updatedQuestion.difficulty = updateData.difficulty;
      }
      if (updateData.score !== undefined) {
        updatedQuestion.score = updateData.score;
      }
      if (updateData.isRequired !== undefined) {
        updatedQuestion.isRequired = updateData.isRequired;
      }
      if (updateData.othersQuestionType !== undefined) {
        updatedQuestion.othersQuestionType = updateData.othersQuestionType;
      }
      if (updateData.notionSettings !== undefined) {
        updatedQuestion.notionSettings = updateData.notionSettings;
      }
      if (updateData.fileUploadSettings !== undefined) {
        updatedQuestion.fileUploadSettings = updateData.fileUploadSettings;
      }
      if (updateData.attachments !== undefined) {
        updatedQuestion.attachments = Array.isArray(updateData.attachments) ? updateData.attachments : [];
      }
    }
    // Update timestamp
    updatedQuestion.updatedAt = new Date();

    // Remove undefined fields
    Object.keys(updatedQuestion).forEach(key => {
      if (updatedQuestion[key] === undefined) {
        delete updatedQuestion[key];
      }
    });

    // Flip the "trainer touched this rejected question" marker so the
    // approver's UI re-enables Approve/Reject on this row.
    if (updatedQuestion?.approval?.status === 'rejected') {
      updatedQuestion.approval.editedSinceReject = true;
    }

    // Update the question in the array
    foundExercise.questions[questionIndex] = updatedQuestion;

    // Update the exercise in the array
    exercises[foundExerciseIndex] = foundExercise;

    // Update the entity's pedagogy structure
    if (pedagogyRoot[tabType] instanceof Map) {
      pedagogyRoot[tabType].set(subcategory, exercises);
    } else {
      pedagogyRoot[tabType][subcategory] = exercises;
    }

    // Mark as modified
    entity.markModified(`${pedagogyPath}.${tabType}`);
    entity.markModified(`${pedagogyPath}.${tabType}.${subcategory}`);
    entity.markModified(`${pedagogyPath}.${tabType}.${subcategory}.${foundExerciseIndex}.questions`);
    entity.markModified(`${pedagogyPath}.${tabType}.${subcategory}.${foundExerciseIndex}.questions.${questionIndex}`);

    // ── Rerun tracking: if this edit touches a scoring-relevant field AND at
    // least one student has already submitted an answer to this question, flag
    // the question so the Rerun UI's "Recently edited" filter surfaces it. The
    // flag is cleared by the rerun endpoint on successful batch completion.
    // False positives (unchanged values that just pass through the payload)
    // are acceptable — the worst case is a rerun that produces identical
    // scores, which is harmless.
    try {
      const isProgramming = (updatedQuestion.questionType === 'programming'
        || (updatedQuestion.testCases && updatedQuestion.testCases.length > 0));
      const SCORING_FIELDS = ['testCases','sampleInput','sampleOutput','expectedOutput','constraints','score'];
      const touchedScoring = SCORING_FIELDS.some(f => Object.prototype.hasOwnProperty.call(updateData, f));
      if (isProgramming && touchedScoring) {
        // Cheap existence check: any User doc with a submission for this
        // question in this course? If so, flag.
        const User = require('../../../models/UserModel');
        const submissionExists = await User.exists({
          'courses.answers.I_Do': { $exists: true },
          $or: [
            { 'courses.answers.I_Do': { $exists: true } },
            { 'courses.answers.We_Do': { $exists: true } },
            { 'courses.answers.You_Do': { $exists: true } },
          ],
          [`courses.answers.${tabType}`]: { $exists: true },
        });
        if (submissionExists) {
          // A more precise check would walk the Map to confirm THIS questionId
          // is present, but the coarse-grained check is cheap and the false-
          // positive risk (flag set when no submission for THIS question yet
          // exists) just means a harmless zero-op rerun.
          updatedQuestion.lastEditedAfterSubmissionAt = new Date();
        }
      }
    } catch (flagErr) {
      // Flag setting is best-effort — never block a successful question save.
      console.warn('[updateQuestion] lastEditedAfterSubmissionAt hook failed:', flagErr.message);
    }

    // Update timestamps
    entity.updatedBy = req.user?.email || "roobankr5@gmail.com";
    entity.updatedAt = new Date();

    // Save entity
    await entity.save();

    // Prepare response data
    const responseData = {
      updatedQuestion: {
        questionId: updatedQuestion._id.toString(),
        questionTitle: updatedQuestion.questionTitle || updatedQuestion.title,
        questionType: updatedQuestion.questionType,
        sequence: updatedQuestion.sequence,
        description: updatedQuestion.description ? {
          text: updatedQuestion.description.text,
          imageUrl: updatedQuestion.description.imageUrl,
          imageAlignment: updatedQuestion.description.imageAlignment,
          imageSizePercent: updatedQuestion.description.imageSizePercent
        } : undefined
      },
      exercise: {
        exerciseId: foundExercise.exerciseInformation?.exerciseId || foundExercise._id.toString(),
        exerciseName: foundExercise.exerciseInformation?.exerciseName || "Exercise",
        exerciseLevel: foundExercise.exerciseInformation?.exerciseLevel || "medium",
        totalQuestions: foundExercise.questions.length,
        totalScore: foundExercise.questions.reduce((sum, q) => sum + (q.score || 0), 0)
      },
      entity: {
        type: type,
        id: entity._id.toString(),
        title: entity.title || entity.name || "Entity"
      },
      location: {
        tabType: tabType,
        subcategory: subcategory,
        exerciseIndex: foundExerciseIndex,
        exerciseId: foundExercise._id.toString(),
        questionIndex: questionIndex
      }
    };

    return res.status(200).json({
      message: [{
        key: "success",
        value: `Question updated successfully in "${foundExercise.exerciseInformation?.exerciseName}"`
      }],
      data: responseData
    });

  } catch (err) {
    console.error("❌ Update question error:", err);
    console.error("❌ Error stack:", err.stack);

    res.status(500).json({
      message: [{
        key: "error",
        value: `Internal server error: ${err.message}`
      }],
      error: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
};
// Get all questions for an exercise
exports.getQuestions = async (req, res) => {
  try {
    const { type, id, exerciseId } = req.params;
    const {
      includeInactive = 'false'
    } = req.query; // Keep includeInactive as query parameter

    // Validate entity type
    if (!type || !modelMap[type]) {
      return res.status(400).json({
        message: [{ key: "error", value: `Invalid entity type: ${type}. Valid types: modules, submodules, topics, subtopics` }]
      });
    }

    // Get the model from modelMap
    const { model } = modelMap[type];

    if (!model) {
      return res.status(400).json({
        message: [{ key: "error", value: `Model not found for type: ${type}` }]
      });
    }

    // Find the entity
    const entity = await model.findById(id);

    if (!entity) {
      return res.status(404).json({
        message: [{ key: "error", value: `${type} with ID ${id} not found` }]
      });
    }
    // ── Resources by Batch ───────────────────────────────────────────────
    // Which I_Do/We_Do/You_Do set this request belongs to. For a shared
    // element that is the course-level `pedagogy`; for one ticked batch-wise
    // in Course Setup it is this batch's own `batchPedagogy.<batchId>`.
    // Resolving it here means every lookup and markModified below lands in
    // the right place — without it We Do and You Do would keep reading the
    // course-level set while the batch strip claimed otherwise.
    // Id-only lookup with no section in the request — `tabType` does not
    // exist in this handler's scope (referencing it threw a ReferenceError
    // and every questions-get call 500'd). Search the caller's batch
    // container first, then the shared one, like getExerciseById.
    const searchScopes = await resolveSearchScopes(entity, req);

    if (searchScopes.length === 0) {
      return res.status(404).json({
        message: [{ key: "error", value: "No pedagogy structure found in this entity" }]
      });
    }

    const validTabTypes = ['I_Do', 'We_Do', 'You_Do'];
    let foundExercise = null;
    let foundTabType = null;
    let foundSubcategory = null;

    // Search through all tab types for the exercise
    for (const scope of searchScopes) {
    for (const tabType of validTabTypes) {
      if (!scope.container[tabType]) continue;

      // Convert Map to object if needed
      const tabData = scope.container[tabType] instanceof Map
        ? Object.fromEntries(scope.container[tabType])
        : scope.container[tabType];

      // Search through all subcategories in this tabType
      for (const [subcategory, exercises] of Object.entries(tabData)) {
        if (Array.isArray(exercises)) {
          const exercise = exercises.find(ex => {
            // Check both _id and exerciseInformation.exerciseId
            return ex._id && ex._id.toString() === exerciseId ||
              (ex.exerciseInformation && ex.exerciseInformation.exerciseId === exerciseId);
          });
          if (exercise) {
            foundExercise = exercise;
            foundTabType = tabType;
            foundSubcategory = subcategory;
            break;
          }
        }
      }
      if (foundExercise) break; // Stop searching if found
    }
    if (foundExercise) break; // batch copy wins — skip the shared scope
    }

    if (!foundExercise) {
      console.error(`❌ Exercise with ID "${exerciseId}" not found in ${type} "${entity.title || entity.name}"`);

      // Log available exercises for debugging
      const availableExercises = [];
      searchScopes.forEach(scope => {
      validTabTypes.forEach(tabType => {
        if (scope.container[tabType]) {
          const tabData = scope.container[tabType] instanceof Map
            ? Object.fromEntries(scope.container[tabType])
            : scope.container[tabType];

          Object.entries(tabData).forEach(([subcat, exercises]) => {
            if (Array.isArray(exercises)) {
              exercises.forEach((ex, idx) => {
                availableExercises.push({
                  tabType: tabType,
                  subcategory: subcat,
                  index: idx,
                  _id: ex._id?.toString(),
                  exerciseId: ex.exerciseInformation?.exerciseId,
                  name: ex.exerciseInformation?.exerciseName,
                  hasQuestions: ex.questions && Array.isArray(ex.questions) ? ex.questions.length : 0
                });
              });
            }
          });
        }
      });
      });

      return res.status(404).json({
        message: [{ key: "error", value: `No exercise found with ID ${exerciseId}` }],
        data: {
          questions: [],
          exercise: {
            exerciseId: exerciseId,
            exerciseName: "Unknown Exercise",
            exerciseLevel: "medium",
            totalQuestions: 0,
            totalPoints: 0
          },
          entity: {
            type: type,
            id: entity._id.toString(),
            title: entity.title || entity.name || "Entity",
            tabType: null,
            subcategory: null
          },
          metadata: {
            exerciseId: exerciseId,
            includeInactive: includeInactive === 'true'
          },
          debug: {
            availableExercises: availableExercises
          }
        }
      });
    }

    // Get questions - handle cases where questions might not exist
    let questions = [];
    if (foundExercise.questions && Array.isArray(foundExercise.questions)) {
      questions = foundExercise.questions;
    } else {
      // Initialize empty questions array if it doesn't exist
      foundExercise.questions = [];
    }

    // Filter inactive questions if requested
    if (includeInactive === 'false') {
      questions = questions.filter(q => q.isActive !== false);
    }

    // Sort by sequence
    questions.sort((a, b) => (a.sequence || 0) - (b.sequence || 0));

    // Prepare exercise data with all settings including securitySettings
    const exerciseData = {
      _id: foundExercise._id?.toString() || exerciseId,
      exerciseId: foundExercise.exerciseInformation?.exerciseId || exerciseId,
      exerciseName: foundExercise.exerciseInformation?.exerciseName || "Exercise",
      exerciseLevel: foundExercise.exerciseInformation?.exerciseLevel || "medium",
      description: foundExercise.exerciseInformation?.description || "",
      totalQuestions: questions.length,
      totalPoints: questions.reduce((sum, q) => sum + (q.score || 0), 0),
      estimatedTime: foundExercise.exerciseInformation?.estimatedTime || 60,

      // Include all settings
      programmingSettings: foundExercise.programmingSettings || {},
      compilerSettings: foundExercise.compilerSettings || {},
      availabilityPeriod: foundExercise.availabilityPeriod || {},
      questionBehavior: foundExercise.questionBehavior || {},
      evaluationMethod: foundExercise.evaluationMethod || {},
      groupSettings: foundExercise.groupSettings || {},
      scoreSettings: foundExercise.scoreSettings || {},
      securitySettings: foundExercise.securitySettings || {}, // Include security settings

      createdAt: foundExercise.createdAt,
      updatedAt: foundExercise.updatedAt,
      createdBy: foundExercise.createdBy,
      updatedBy: foundExercise.updatedBy
    };

    return res.status(200).json({
      message: [{ key: "success", value: `Found ${questions.length} questions in ${foundTabType}` }],
      data: {
        questions,
        exercise: exerciseData,
        entity: {
          type: type,
          id: entity._id.toString(),
          title: entity.title || entity.name || "Entity",
          tabType: foundTabType,
          subcategory: foundSubcategory
        },
        metadata: {
          exerciseId: exerciseId,
          tabType: foundTabType,
          subcategory: foundSubcategory,
          includeInactive: includeInactive === 'true',
          totalQuestions: questions.length,
          activeQuestions: questions.filter(q => q.isActive !== false).length,
          inactiveQuestions: questions.filter(q => q.isActive === false).length
        }
      }
    });

  } catch (err) {
    console.error("❌ Get questions error:", err);
    res.status(500).json({
      message: [{ key: "error", value: `Internal server error: ${err.message}` }]
    });
  }
};
// Get single question by ID
exports.getQuestionById = async (req, res) => {
  try {
    const { type, id, exerciseId, questionId } = req.params;

    // Validate entity type
    if (!type || !modelMap[type]) {
      return res.status(400).json({
        message: [{ key: "error", value: `Invalid entity type: ${type}. Valid types: modules, submodules, topics, subtopics` }]
      });
    }

    // Get the model from modelMap
    const { model } = modelMap[type];

    if (!model) {
      return res.status(400).json({
        message: [{ key: "error", value: `Model not found for type: ${type}` }]
      });
    }

    // Find the entity
    const entity = await model.findById(id);

    if (!entity) {
      return res.status(404).json({
        message: [{ key: "error", value: `${type} with ID ${id} not found` }]
      });
    }
    // ── Resources by Batch ───────────────────────────────────────────────
    // Which I_Do/We_Do/You_Do set this request belongs to. For a shared
    // element that is the course-level `pedagogy`; for one ticked batch-wise
    // in Course Setup it is this batch's own `batchPedagogy.<batchId>`.
    // Resolving it here means every lookup and markModified below lands in
    // the right place — without it We Do and You Do would keep reading the
    // course-level set while the batch strip claimed otherwise.
    // Id-only lookup — same ReferenceError fix as getQuestions above:
    // there is no `tabType` in this handler's scope, so use the search-scope
    // helper (batch container first, shared after).
    const searchScopes = await resolveSearchScopes(entity, req);

    if (searchScopes.length === 0) {
      return res.status(404).json({
        message: [{ key: "error", value: "No pedagogy structure found in this entity" }]
      });
    }

    const validTabTypes = ['I_Do', 'We_Do', 'You_Do'];
    let foundExercise = null;
    let foundTabType = null;
    let foundSubcategory = null;
    let foundQuestion = null;
    let questionIndex = -1;

    // Search through all tab types for the exercise and question
    for (const scope of searchScopes) {
    for (const tabType of validTabTypes) {
      if (!scope.container[tabType]) continue;

      // Convert Map to object if needed
      const tabData = scope.container[tabType] instanceof Map
        ? Object.fromEntries(scope.container[tabType])
        : scope.container[tabType];

      // Search through all subcategories in this tabType
      for (const [subcategory, exercises] of Object.entries(tabData)) {
        if (Array.isArray(exercises)) {
          const exercise = exercises.find(ex => {
            // Check both _id and exerciseInformation.exerciseId
            return ex._id && ex._id.toString() === exerciseId ||
              (ex.exerciseInformation && ex.exerciseInformation.exerciseId === exerciseId);
          });

          if (exercise) {
            // Now search for the question within this exercise
            if (exercise.questions && Array.isArray(exercise.questions)) {
              const qIndex = exercise.questions.findIndex(q =>
                q._id && q._id.toString() === questionId
              );

              if (qIndex !== -1) {
                foundExercise = exercise;
                foundTabType = tabType;
                foundSubcategory = subcategory;
                foundQuestion = exercise.questions[qIndex];
                questionIndex = qIndex;
                break;
              }
            }
          }
        }
        if (foundQuestion) break;
      }
      if (foundQuestion) break; // Stop searching if found
    }
    if (foundQuestion) break; // batch copy wins — skip the shared scope
    }

    if (!foundExercise) {
      return res.status(404).json({
        message: [{ key: "error", value: `Exercise with ID ${exerciseId} not found` }]
      });
    }

    if (!foundQuestion) {
      // Log available questions for debugging
      const availableQuestions = [];
      if (foundExercise.questions && Array.isArray(foundExercise.questions)) {
        foundExercise.questions.forEach((q, idx) => {
          availableQuestions.push({
            index: idx,
            _id: q._id?.toString(),
            title: q.title,
            difficulty: q.difficulty,
            score: q.score
          });
        });
      }

      return res.status(404).json({
        message: [{ key: "error", value: `Question with ID ${questionId} not found in exercise ${foundExercise.exerciseInformation?.exerciseName || exerciseId}` }],
        data: {
          exercise: {
            exerciseId: exerciseId,
            exerciseName: foundExercise.exerciseInformation?.exerciseName || "Exercise",
            totalQuestions: foundExercise.questions?.length || 0
          },
          debug: {
            availableQuestions: availableQuestions
          }
        }
      });
    }

    // Prepare exercise data with all settings including securitySettings
    const exerciseData = {
      _id: foundExercise._id?.toString() || exerciseId,
      exerciseId: foundExercise.exerciseInformation?.exerciseId || exerciseId,
      exerciseName: foundExercise.exerciseInformation?.exerciseName || "Exercise",
      exerciseLevel: foundExercise.exerciseInformation?.exerciseLevel || "medium",
      description: foundExercise.exerciseInformation?.description || "",
      totalQuestions: foundExercise.questions?.length || 0,
      totalPoints: foundExercise.questions?.reduce((sum, q) => sum + (q.score || 0), 0) || 0,
      estimatedTime: foundExercise.exerciseInformation?.estimatedTime || 60,

      // Include all settings
      programmingSettings: foundExercise.programmingSettings || {},
      compilerSettings: foundExercise.compilerSettings || {},
      availabilityPeriod: foundExercise.availabilityPeriod || {},
      questionBehavior: foundExercise.questionBehavior || {},
      evaluationMethod: foundExercise.evaluationMethod || {},
      groupSettings: foundExercise.groupSettings || {},
      scoreSettings: foundExercise.scoreSettings || {},
      securitySettings: foundExercise.securitySettings || {}, // Include security settings

      createdAt: foundExercise.createdAt,
      updatedAt: foundExercise.updatedAt,
      createdBy: foundExercise.createdBy,
      updatedBy: foundExercise.updatedBy
    };

    // Get adjacent questions for navigation
    let previousQuestion = null;
    let nextQuestion = null;

    if (foundExercise.questions && Array.isArray(foundExercise.questions)) {
      if (questionIndex > 0) {
        previousQuestion = {
          _id: foundExercise.questions[questionIndex - 1]._id?.toString(),
          title: foundExercise.questions[questionIndex - 1].title,
          sequence: foundExercise.questions[questionIndex - 1].sequence
        };
      }

      if (questionIndex < foundExercise.questions.length - 1) {
        nextQuestion = {
          _id: foundExercise.questions[questionIndex + 1]._id?.toString(),
          title: foundExercise.questions[questionIndex + 1].title,
          sequence: foundExercise.questions[questionIndex + 1].sequence
        };
      }
    }

    return res.status(200).json({
      message: [{ key: "success", value: `Question "${foundQuestion.title}" retrieved successfully from ${foundTabType}` }],
      data: {
        question: foundQuestion,
        exercise: exerciseData,
        entity: {
          type: type,
          id: entity._id.toString(),
          title: entity.title || entity.name || "Entity",
          tabType: foundTabType,
          subcategory: foundSubcategory
        },
        navigation: {
          previous: previousQuestion,
          next: nextQuestion,
          currentIndex: questionIndex,
          totalQuestions: foundExercise.questions?.length || 0
        },
        metadata: {
          exerciseId: exerciseId,
          questionId: questionId,
          tabType: foundTabType,
          subcategory: foundSubcategory,
          questionSequence: foundQuestion.sequence || 0,
          isActive: foundQuestion.isActive !== false,
          difficulty: foundQuestion.difficulty || 'medium',
          score: foundQuestion.score || 0
        }
      }
    });

  } catch (err) {
    console.error("❌ Get question by ID error:", err);
    res.status(500).json({
      message: [{ key: "error", value: `Internal server error: ${err.message}` }]
    });
  }
};



// Delete question
exports.deleteQuestion = async (req, res) => {
  try {
    const { type, id, exerciseId, questionId } = req.params;
    const {
      tabType,
      subcategory
    } = req.body;

    // Validate entity type
    if (!type || !modelMap[type]) {
      return res.status(400).json({
        message: [{ key: "error", value: `Invalid entity type: ${type}. Valid types: modules, submodules, topics, subtopics` }]
      });
    }

    // Validate required parameters
    if (!tabType) {
      return res.status(400).json({
        message: [{ key: "error", value: "tabType is required (I_Do, We_Do, You_Do)" }]
      });
    }

    if (!subcategory) {
      return res.status(400).json({
        message: [{ key: "error", value: "Subcategory is required (e.g., 'Practical', 'Project Development')" }]
      });
    }

    // Get the model from modelMap
    const { model } = modelMap[type];

    if (!model) {
      return res.status(400).json({
        message: [{ key: "error", value: `Model not found for type: ${type}` }]
      });
    }

    // Find the entity
    const entity = await model.findById(id);

    if (!entity) {
      return res.status(404).json({
        message: [{ key: "error", value: `${type} with ID ${id} not found` }]
      });
    }
    // ── Resources by Batch ───────────────────────────────────────────────
    // Which I_Do/We_Do/You_Do set this request belongs to. For a shared
    // element that is the course-level `pedagogy`; for one ticked batch-wise
    // in Course Setup it is this batch's own `batchPedagogy.<batchId>`.
    // Resolving it here means every lookup and markModified below lands in
    // the right place — without it We Do and You Do would keep reading the
    // course-level set while the batch strip claimed otherwise.
    const { container: pedagogyRoot, basePath: pedagogyPath } =
      await resolvePedagogyScope(entity, tabType, req);


    // Check if pedagogy exists
    if (!pedagogyRoot) {
      return res.status(404).json({
        message: [{ key: "error", value: "No pedagogy structure found in this entity" }]
      });
    }

    // Check if tabType exists
    if (!pedagogyRoot[tabType]) {
      return res.status(404).json({
        message: [{ key: "error", value: `No ${tabType} section found in pedagogy` }]
      });
    }

    // Convert Map to object if needed
    const tabData = pedagogyRoot[tabType] instanceof Map
      ? Object.fromEntries(pedagogyRoot[tabType])
      : pedagogyRoot[tabType];

    // Check if subcategory exists
    if (!tabData[subcategory]) {
      return res.status(404).json({
        message: [{ key: "error", value: `Subcategory "${subcategory}" not found in ${tabType}` }]
      });
    }

    const exercises = tabData[subcategory];

    if (!Array.isArray(exercises)) {
      return res.status(400).json({
        message: [{ key: "error", value: `Invalid exercises format in subcategory "${subcategory}"` }]
      });
    }

    // Find the exercise by ID
    let foundExercise = null;
    let foundExerciseIndex = -1;

    for (let i = 0; i < exercises.length; i++) {
      const exercise = exercises[i];

      // Check all possible ID fields
      const matches = (
        (exercise._id && exercise._id.toString() === exerciseId) ||
        (exercise.exerciseInformation?.exerciseId === exerciseId) ||
        (exercise.exerciseInformation?._id?.toString() === exerciseId)
      );

      if (matches) {
        foundExercise = exercise;
        foundExerciseIndex = i;
        break;
      }
    }

    if (!foundExercise) {
      console.error(`❌ Exercise with ID "${exerciseId}" not found in subcategory "${subcategory}"`);

      // Log all available exercises for debugging
      const availableExercises = exercises.map((ex, idx) => ({
        index: idx,
        _id: ex._id?.toString(),
        exerciseId: ex.exerciseInformation?.exerciseId,
        name: ex.exerciseInformation?.exerciseName,
        exerciseLevel: ex.exerciseInformation?.exerciseLevel,
        questionsCount: ex.questions?.length || 0
      }));

      return res.status(404).json({
        message: [{
          key: "error",
          value: `Exercise with ID "${exerciseId}" not found in subcategory "${subcategory}". Available exercises: ${availableExercises.length}`
        }],
        availableExercises
      });
    }

    // Check if questions array exists
    if (!foundExercise.questions || !Array.isArray(foundExercise.questions)) {
      return res.status(404).json({
        message: [{ key: "error", value: `No questions found in exercise "${foundExercise.exerciseInformation?.exerciseName}"` }]
      });
    }

    // Find the question by ID
    const questionIndex = foundExercise.questions.findIndex(q =>
      q._id && q._id.toString() === questionId
    );

    if (questionIndex === -1) {
      // Log available questions for debugging
      const availableQuestions = foundExercise.questions.map((q, idx) => ({
        index: idx,
        _id: q._id?.toString(),
        title: q.title,
        difficulty: q.difficulty,
        score: q.score
      }));

      return res.status(404).json({
        message: [{
          key: "error",
          value: `Question with ID "${questionId}" not found in exercise "${foundExercise.exerciseInformation?.exerciseName}"`
        }],
        availableQuestions
      });
    }

    // Get the question data before deletion for response
    const deletedQuestion = foundExercise.questions[questionIndex];
    const questionTitle = deletedQuestion.title || "Question";

    // Remove the question from the array
    foundExercise.questions.splice(questionIndex, 1);

    // Update the exercise in the array
    exercises[foundExerciseIndex] = foundExercise;

    // Update the entity's pedagogy structure
    if (pedagogyRoot[tabType] instanceof Map) {
      pedagogyRoot[tabType].set(subcategory, exercises);
    } else {
      pedagogyRoot[tabType][subcategory] = exercises;
    }

    // Mark as modified
    entity.markModified(`${pedagogyPath}.${tabType}.${subcategory}`);
    entity.markModified(`${pedagogyPath}.${tabType}.${subcategory}.${foundExerciseIndex}.questions`);

    // Update timestamps
    entity.updatedBy = req.user?.email || "system";
    entity.updatedAt = new Date();

    // Save entity
    await entity.save();

    // Calculate updated totals
    const totalQuestions = foundExercise.questions.length;
    const totalScore = foundExercise.questions.reduce((sum, q) => sum + (q.score || 0), 0);

    // Prepare exercise data with all settings including securitySettings
    const exerciseData = {
      _id: foundExercise._id?.toString() || exerciseId,
      exerciseId: foundExercise.exerciseInformation?.exerciseId || exerciseId,
      exerciseName: foundExercise.exerciseInformation?.exerciseName || "Exercise",
      exerciseLevel: foundExercise.exerciseInformation?.exerciseLevel || "medium",
      description: foundExercise.exerciseInformation?.description || "",
      totalQuestions: totalQuestions,
      totalScore: totalScore,
      estimatedTime: foundExercise.exerciseInformation?.estimatedTime || 60,

      // Include all settings
      programmingSettings: foundExercise.programmingSettings || {},
      compilerSettings: foundExercise.compilerSettings || {},
      availabilityPeriod: foundExercise.availabilityPeriod || {},
      questionBehavior: foundExercise.questionBehavior || {},
      evaluationMethod: foundExercise.evaluationMethod || {},
      groupSettings: foundExercise.groupSettings || {},
      scoreSettings: foundExercise.scoreSettings || {},
      securitySettings: foundExercise.securitySettings || {},

      createdAt: foundExercise.createdAt,
      updatedAt: foundExercise.updatedAt,
      createdBy: foundExercise.createdBy,
      updatedBy: foundExercise.updatedBy
    };

    const responseData = {
      deletedQuestion: {
        _id: deletedQuestion._id?.toString(),
        title: deletedQuestion.title,
        description: deletedQuestion.description,
        difficulty: deletedQuestion.difficulty,
        score: deletedQuestion.score,
        deletedAt: new Date()
      },
      exercise: exerciseData,
      entity: {
        type: type,
        id: entity._id.toString(),
        title: entity.title || entity.name || "Entity",
        tabType: tabType,
        subcategory: subcategory
      },
      location: {
        tabType: tabType,
        subcategory: subcategory,
        exerciseIndex: foundExerciseIndex,
        exerciseId: foundExercise._id.toString(),
        deletedQuestionId: questionId.toString(),
        deletedQuestionIndex: questionIndex
      },
      metadata: {
        totalQuestionsAfterDeletion: totalQuestions,
        questionsDeleted: 1,
        remainingQuestions: totalQuestions
      }
    };

    return res.status(200).json({
      message: [{
        key: "success",
        value: `Question "${questionTitle}" deleted successfully from "${foundExercise.exerciseInformation?.exerciseName}"`
      }],
      data: responseData
    });

  } catch (err) {
    console.error("❌ Delete question error:", err);
    console.error("❌ Error stack:", err.stack);
    console.error("❌ Error details:", {
      name: err.name,
      message: err.message,
      code: err.code,
      keyValue: err.keyValue
    });

    res.status(500).json({
      message: [{
        key: "error",
        value: `Internal server error: ${err.message}`
      }],
      error: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
};






exports.getUserExerciseGradeAnalytics = async (req, res) => {
  try {
    const userId = req.user._id;
    const { exerciseId } = req.params;
    const {
      courseId,
      category = null,
      subcategory = null
    } = req.query;

    if (!exerciseId || !courseId) {
      return res.status(400).json({
        success: false,
        message: "exerciseId parameter and courseId query are required"
      });
    }

    console.log(`\n🚀 START getUserExerciseGradeAnalytics`);
    console.log(`User: ${userId}, Course: ${courseId}, Exercise: ${exerciseId}`);
    console.log(`Searching with category: ${category || 'ALL'}, subcategory: ${subcategory || 'ALL'}`);

    // 1. Find user and convert to plain object to avoid Mongoose subdocument issues
    const user = await User.findById(userId).lean();
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const userCourse = user.courses.find(c =>
      c.courseId && c.courseId.toString() === courseId
    );

    if (!userCourse) {
      return res.status(404).json({
        success: false,
        message: "User is not enrolled in this course"
      });
    }

    console.log(`✅ User course found`);

    // 2. SEARCH USER ANSWERS
    let userQuestions = [];
    let foundCategory = null;
    let foundSubcategory = null;
    let foundUserExercise = null;

    console.log(`\n🔍 SEARCHING USER ANSWERS...`);

    const searchCategories = category ? [category] : ['I_Do', 'We_Do', 'You_Do'];
    // 'assignment' / 'assesment' (singular) are the keys the We Do and You Do
    // screens actually write — omitting them made this lookup miss real data.
    const searchSubcategories = subcategory ? [subcategory] : ['practical', 'assignments', 'assignment', 'assessments', 'assesments', 'assesment', 'homework', 'practice', 'project_development'];

    let answersData = userCourse.answers;

    if (answersData && answersData.toObject) {
      answersData = answersData.toObject();
      console.log(`  Converted answers from Mongoose subdocument to plain object`);
    }

    console.log(`  Answers data type: ${typeof answersData}`);
    console.log(`  Answers data keys: ${answersData ? Object.keys(answersData).join(', ') : 'none'}`);

    for (const cat of searchCategories) {
      console.log(`\n🔍 Checking category: ${cat}`);

      if (!answersData || !answersData[cat]) {
        console.log(`  No answers in category "${cat}"`);
        continue;
      }

      const categoryData = answersData[cat];
      console.log(`  Category data type: ${typeof categoryData}`);
      console.log(`  Category data keys: ${categoryData ? Object.keys(categoryData).join(', ') : 'none'}`);

      if (categoryData && typeof categoryData === 'object') {
        for (const subcat of searchSubcategories) {
          console.log(`    🔍 Checking subcategory: ${subcat}`);

          if (!categoryData[subcat]) {
            console.log(`    No data in "${subcat}"`);
            continue;
          }

          let exercises = categoryData[subcat];
          if (!Array.isArray(exercises)) {
            exercises = [exercises];
          }

          console.log(`    Found ${exercises.length} exercises in ${subcat}`);

          const targetId = exerciseId.toString ? exerciseId.toString() : String(exerciseId);

          for (const exercise of exercises) {
            if (!exercise) continue;

            let exerciseObj = exercise;
            if (exerciseObj && exerciseObj.toObject) {
              exerciseObj = exerciseObj.toObject();
            }

            const exerciseIdField = exerciseObj.exerciseId || exerciseObj._id || exerciseObj.id;
            if (!exerciseIdField) continue;

            const exId = exerciseIdField.toString ? exerciseIdField.toString() : String(exerciseIdField);

            console.log(`      Checking exercise ID: ${exId} against target: ${targetId}`);

            if (exId === targetId) {
              console.log(`    ✅✅✅ FOUND EXERCISE in ${cat}/${subcat}!`);
              console.log(`      Exercise ID: ${exId}`);
              console.log(`      Exercise Name: ${exerciseObj.exerciseName || exerciseObj.exerciseInformation?.exerciseName || 'No name'}`);
              console.log(`      Exercise has keys: ${Object.keys(exerciseObj).join(', ')}`);

              foundCategory = cat;
              foundSubcategory = subcat;
              foundUserExercise = exerciseObj;

              if (exerciseObj.questions && Array.isArray(exerciseObj.questions)) {
                userQuestions = exerciseObj.questions.map(q => {
                  if (q && q.toObject) return q.toObject();
                  return q;
                });
                console.log(`      Extracted ${userQuestions.length} user questions directly from exercise.questions`);
              } else {
                console.log(`      ⚠️ No questions found in exercise.questions`);
              }

              if (userQuestions.length > 0) {
                userQuestions.forEach((q, i) => {
                  if (q) {
                    const qId = q.questionId ?
                      (q.questionId.toString ? q.questionId.toString() : String(q.questionId)) :
                      'NO_ID';
                    console.log(`      Q${i + 1}: ID=${qId}, score=${q.score || 0}, totalScore=${q.totalScore || 0}, status=${q.status || 'unknown'}`);
                  }
                });
              }

              break;
            }
          }

          if (foundUserExercise) break;
        }
      }

      if (foundUserExercise) break;
    }

    console.log(`\n📊 USER ANSWERS SUMMARY:`);
    console.log(`  Found in: ${foundCategory}/${foundSubcategory || 'unknown'}`);
    console.log(`  Found exercise: ${!!foundUserExercise}`);
    console.log(`  Total user questions: ${userQuestions.length}`);

    // 3. FIND EXERCISE DETAILS FROM COURSE STRUCTURE
    let exerciseDetails = null;
    let allQuestions = [];
    let foundInEntity = null;
    let passingMarks = null;
    let totalMarks = null;

    console.log(`\n🔍 Searching for exercise details in course structure...`);

    // Helper function to extract question title safely
    const getQuestionTitle = (question) => {
      if (!question) return "Untitled";

      // Handle MCQ question title (array of blocks)
      if (question.mcqQuestionTitle && Array.isArray(question.mcqQuestionTitle)) {
        // Extract text from blocks
        const textBlocks = question.mcqQuestionTitle
          .filter(block => block.type === 'text')
          .map(block => block.value)
          .join(' ');
        if (textBlocks.trim()) return textBlocks;
        return "MCQ Question";
      }

      // Handle programming question title (array of blocks)
      if (question.programmingQuestionTitle && Array.isArray(question.programmingQuestionTitle)) {
        const textBlocks = question.programmingQuestionTitle
          .filter(block => block.type === 'text')
          .map(block => block.value)
          .join(' ');
        if (textBlocks.trim()) return textBlocks;
        return "Programming Question";
      }

      // Handle regular title
      if (question.title) return question.title;
      if (question.questionTitle) return question.questionTitle;

      return "Untitled";
    };

    const findExerciseInPedagogy = (pedagogy, targetExerciseId) => {
      if (!pedagogy) return null;

      const targetIdStr = targetExerciseId.toString ? targetExerciseId.toString() : String(targetExerciseId);

      const categories = ['I_Do', 'We_Do', 'You_Do'];
      // Includes the singular 'assignment' / 'assesment' keys the UI writes.
      const subcategories = ['practical', 'assignments', 'assignment', 'assessments', 'assesments', 'assesment', 'homework', 'practice', 'project_development'];

      for (const cat of categories) {
        if (pedagogy[cat]) {
          const sectionData = pedagogy[cat];

          if (typeof sectionData === 'object') {
            for (const subcat of subcategories) {
              if (sectionData[subcat] && Array.isArray(sectionData[subcat])) {
                console.log(`    Checking ${cat}/${subcat} - ${sectionData[subcat].length} exercises`);

                const found = sectionData[subcat].find(ex => {
                  if (!ex) return false;

                  const exId = ex._id?.toString() ||
                    ex.id?.toString() ||
                    ex.exerciseId?.toString() ||
                    ex.exerciseInformation?._id?.toString();

                  return exId === targetIdStr;
                });

                if (found) {
                  console.log(`    ✅ FOUND in pedagogy: ${cat}/${subcat}`);
                  return { exercise: found, category: cat, subcategory: subcat };
                }
              }
            }
          }
        }
      }

      return null;
    };

    // ── Resources by Batch ──────────────────────────────────────────────────
    // One lookup for the whole scan below: which batch this caller sees, and
    // the course config that says whether We Do / You Do are even batch-wise.
    // Each node is then flattened to that batch before it is searched, so the
    // walk stays batch-agnostic and finds batch-wise exercises the same way it
    // finds shared ones.
    const batchCourseForScan = await CourseStructure.findById(courseId)
      .select(COURSE_BATCH_FIELDS)
      .lean();
    const scanBatchId = batchCourseForScan
      ? resolveViewerBatchId(batchCourseForScan, req.user, readRequestedBatch(req))
      : "";

    const entityModels = [
      { name: 'Module1', model: Module1 },
      { name: 'SubModule1', model: SubModule1 },
      { name: 'Topic1', model: Topic1 },
      { name: 'SubTopic1', model: SubTopic1 }
    ];

    for (const { name, model } of entityModels) {
      try {
        const entities = await model.find({ courses: courseId }).lean();
        // Flatten each node to the caller's batch. Safe to mutate — these are
        // .lean() copies, not live documents.
        if (batchCourseForScan) {
          entities.forEach(e => scopeNodePedagogy(e, batchCourseForScan, scanBatchId));
        }
        console.log(`  Checking ${name}: ${entities.length} entities`);

        for (const entity of entities) {
          console.log(`    Entity: ${entity.title || entity.name || 'Unnamed'}`);

          const result = findExerciseInPedagogy(entity.pedagogy, exerciseId);
          if (result) {
            exerciseDetails = result.exercise;
            foundInEntity = {
              type: name,
              id: entity._id,
              title: entity.title || entity.name || "Entity",
              category: result.category,
              subcategory: result.subcategory
            };

            // Get questions from exercise
            allQuestions = exerciseDetails.questions || [];

            // Extract passing marks and total marks from exercise configuration
            if (exerciseDetails.gradeSettings) {
              passingMarks = exerciseDetails.gradeSettings.programmingGradeToPass ||
                exerciseDetails.gradeSettings.mcqGradeToPass ||
                exerciseDetails.gradeSettings.combinedGradeToPass;
              totalMarks = exerciseDetails.gradeSettings.programmingGrade ||
                exerciseDetails.gradeSettings.mcqGrade ||
                exerciseDetails.gradeSettings.combinedGrade;
              console.log(`  ✅ Found grade settings - Passing Marks: ${passingMarks}, Total Marks: ${totalMarks}`);
            } else if (exerciseDetails.exerciseInformation) {
              totalMarks = exerciseDetails.exerciseInformation.totalMarks;
              passingMarks = totalMarks ? Math.ceil(totalMarks * 0.4) : null;
              console.log(`  ⚠️ Using exerciseInformation - Total Marks: ${totalMarks}, Calculated Passing: ${passingMarks}`);
            }

            console.log(`  ✅ EXERCISE FOUND in ${name}: "${entity.title || entity.name}"`);
            console.log(`    Category: ${result.category}/${result.subcategory}`);
            console.log(`    Exercise Name: ${exerciseDetails.exerciseInformation?.exerciseName || exerciseDetails.exerciseName || 'Unnamed'}`);
            console.log(`    Total Questions: ${allQuestions.length}`);
            console.log(`    Passing Marks Required: ${passingMarks}`);

            allQuestions.forEach((q, i) => {
              if (q) {
                const qId = q._id ? q._id.toString() : 'NO_ID';
                const qTitle = getQuestionTitle(q);
                const qScore = q.mcqQuestionScore || q.score || 10;
                console.log(`    Q${i + 1}: "${qTitle.substring(0, 30)}...", ID=${qId}, score=${qScore}`);
              }
            });

            break;
          }
        }

        if (exerciseDetails) break;
      } catch (err) {
        console.log(`  Error checking ${name}: ${err.message}`);
      }
    }

    if (!exerciseDetails && foundUserExercise) {
      console.log(`\n⚠️ Using user exercise data as fallback`);
      exerciseDetails = foundUserExercise;
      allQuestions = userQuestions;
    }

    if (!exerciseDetails) {
      console.log(`❌ Exercise not found in course structure or user data`);
      return res.status(404).json({
        success: false,
        message: "Exercise not found in course structure"
      });
    }

    // 4. MATCH QUESTIONS
    console.log(`\n🔍 MATCHING QUESTIONS...`);
    console.log(`User questions to match: ${userQuestions.length}`);
    console.log(`Exercise questions from structure: ${allQuestions.length}`);

    const userQuestionMap = new Map();
    userQuestions.forEach((userQ, index) => {
      if (userQ) {
        let qId = null;
        if (userQ.questionId) {
          qId = userQ.questionId.toString ? userQ.questionId.toString() : String(userQ.questionId);
        } else if (userQ._id) {
          qId = userQ._id.toString ? userQ._id.toString() : String(userQ._id);
        }

        if (qId) {
          userQuestionMap.set(qId, {
            data: userQ,
            index: index
          });
          console.log(`  User Q${index + 1}: ID=${qId}, score=${userQ.score || 0}, totalScore=${userQ.totalScore || 0}, status=${userQ.status || 'unknown'}`);
        }
      }
    });

    let questionsToMatch = [];

    if (allQuestions.length > 0) {
      questionsToMatch = allQuestions;
      console.log(`  Using ${allQuestions.length} questions from exercise structure for matching`);
    } else if (userQuestions.length > 0) {
      questionsToMatch = userQuestions;
      console.log(`  Using ${userQuestions.length} questions from user answers as fallback`);
    }

    const questionsWithScores = questionsToMatch.map((exerciseQuestion, index) => {
      let exerciseQId = null;

      if (exerciseQuestion._id) {
        exerciseQId = exerciseQuestion._id.toString();
      } else if (exerciseQuestion.questionId) {
        exerciseQId = exerciseQuestion.questionId.toString();
      } else if (exerciseQuestion.id) {
        exerciseQId = exerciseQuestion.id.toString();
      }

      // Get title safely using helper function
      const exerciseTitle = getQuestionTitle(exerciseQuestion);

      let userAttempt = null;
      let matchedBy = null;

      if (exerciseQId && userQuestionMap.size > 0) {
        const displayTitle = exerciseTitle.length > 30 ? exerciseTitle.substring(0, 30) + "..." : exerciseTitle;
        console.log(`\n🔍 Matching: "${displayTitle}" (${exerciseQId})`);

        if (userQuestionMap.has(exerciseQId)) {
          const userQData = userQuestionMap.get(exerciseQId);
          userAttempt = userQData.data;
          matchedBy = 'exact_id_match';
          console.log(`  ✅ EXACT MATCH! Score: ${userAttempt.score || 0}/${userAttempt.totalScore || 0}`);
        } else {
          console.log(`  ❌ No exact match found for ID: ${exerciseQId}`);
          console.log(`  Available user question IDs: ${Array.from(userQuestionMap.keys()).join(', ')}`);
        }
      } else if (userQuestionMap.size === 0) {
        const displayTitle = exerciseTitle.length > 30 ? exerciseTitle.substring(0, 30) + "..." : exerciseTitle;
        console.log(`\n⚠️ No user questions to match with: "${displayTitle}"`);
      } else if (!exerciseQId) {
        const displayTitle = exerciseTitle.length > 30 ? exerciseTitle.substring(0, 30) + "..." : exerciseTitle;
        console.log(`\n⚠️ Exercise question has no ID: "${displayTitle}"`);
      }

      const questionMaxScore = exerciseQuestion.mcqQuestionScore ||
        exerciseQuestion.score ||
        10;
      const userScore = userAttempt?.score || 0;
      const totalScore = userAttempt?.totalScore || questionMaxScore;
      const percentage = totalScore > 0 ? (userScore / totalScore) * 100 : 0;

      return {
        _id: exerciseQuestion._id || exerciseQuestion.questionId,
        sequence: exerciseQuestion.sequence || index + 1,
        title: exerciseTitle,
        difficulty: exerciseQuestion.mcqQuestionDifficulty || exerciseQuestion.difficulty || 'medium',
        maxScore: questionMaxScore,
        userScore: userScore,
        totalScore: totalScore,
        percentage: percentage.toFixed(2),
        isCorrect: userAttempt?.isCorrect || (userAttempt?.status === 'solved') || percentage >= 70,
        userAttempt: userAttempt ? {
          status: userAttempt.status || 'attempted',
          attempts: userAttempt.attempts || 1,
          score: userAttempt.score,
          totalScore: userAttempt.totalScore,
          feedback: userAttempt.feedback || '',
          language: userAttempt.language || '',
          submittedAt: userAttempt.submittedAt,
          evaluatedAt: userAttempt.evaluatedAt,
          matchedBy: matchedBy
        } : null,
        debug: {
          exerciseQuestionId: exerciseQId,
          userQuestionId: userAttempt?.questionId?.toString?.() || userAttempt?._id?.toString?.(),
          matched: !!userAttempt
        }
      };
    });

    // 5. CALCULATE ANALYTICS
    const evaluatedQuestions = questionsWithScores.filter(q => q.userScore > 0);
    const attemptedQuestions = questionsWithScores.filter(q => q.userAttempt);
    const correctQuestions = questionsWithScores.filter(q => q.isCorrect);

    console.log(`\n📊 FINAL RESULTS:`);
    console.log(`  Total exercise questions: ${questionsToMatch.length}`);
    console.log(`  User attempts found: ${userQuestions.length}`);
    console.log(`  Matched questions: ${attemptedQuestions.length}`);
    console.log(`  Questions with scores > 0: ${evaluatedQuestions.length}`);
    console.log(`  Correct questions: ${correctQuestions.length}`);

    const totalUserScore = evaluatedQuestions.reduce((sum, q) => sum + q.userScore, 0);
    const totalMaxScore = questionsWithScores.reduce((sum, q) => sum + q.maxScore, 0);
    const overallPercentage = totalMaxScore > 0 ? (totalUserScore / totalMaxScore) * 100 : 0;

    console.log(`  Total User Score: ${totalUserScore.toFixed(2)} / ${totalMaxScore}`);
    console.log(`  Overall Percentage: ${overallPercentage.toFixed(2)}%`);

    // Helper function for letter grade
    const getLetterGrade = (percentage) => {
      if (percentage >= 90) return 'A';
      if (percentage >= 80) return 'B';
      if (percentage >= 70) return 'C';
      if (percentage >= 60) return 'D';
      return 'F';
    };

    // Determine passing status based on exercise configuration
    let isPassing = false;

    if (passingMarks !== null && totalMaxScore > 0) {
      isPassing = totalUserScore >= passingMarks;
      console.log(`  Passing Check: User Score (${totalUserScore}) >= Passing Marks (${passingMarks}) = ${isPassing}`);
    } else {
      isPassing = overallPercentage >= 70;
      console.log(`  Using fallback 70% threshold: ${overallPercentage}% >= 70% = ${isPassing}`);
    }

    // 6. PREPARE RESPONSE
    const response = {
      success: true,
      data: {
        user: {
          _id: user._id,
          name: `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email || 'Unknown',
          email: user.email
        },
        exercise: {
          _id: exerciseId,
          name: exerciseDetails.exerciseInformation?.exerciseName ||
            exerciseDetails.exerciseName ||
            "Exercise",
          totalQuestions: questionsToMatch.length,
          foundInCategory: foundCategory || foundInEntity?.category,
          foundInSubcategory: foundSubcategory || foundInEntity?.subcategory,
          entity: foundInEntity,
          passingMarks: passingMarks,
          totalMarks: totalMaxScore
        },
        summary: {
          totalQuestions: questionsToMatch.length,
          attemptedQuestions: attemptedQuestions.length,
          evaluatedQuestions: evaluatedQuestions.length,
          correctQuestions: correctQuestions.length,
          totalScore: totalUserScore.toFixed(2),
          maxPossibleScore: totalMaxScore,
          overallPercentage: overallPercentage.toFixed(2),
          completionRate: questionsToMatch.length > 0 ?
            ((attemptedQuestions.length / questionsToMatch.length) * 100).toFixed(2) : "0.00",
          averageScore: attemptedQuestions.length > 0 ?
            (totalUserScore / attemptedQuestions.length).toFixed(2) : "0.00"
        },
        questions: questionsWithScores,
        grade: {
          obtained: totalUserScore,
          outOf: totalMaxScore,
          percentage: overallPercentage.toFixed(2),
          letterGrade: getLetterGrade(overallPercentage),
          isPassing: isPassing,
          passingMarksRequired: passingMarks
        },
        debug: {
          userQuestionsFound: userQuestions.length,
          exerciseQuestionsFound: questionsToMatch.length,
          matchesFound: attemptedQuestions.length,
          searchLocation: foundCategory ? `${foundCategory}/${foundSubcategory}` : 'unknown',
          userQuestions: userQuestions.map(q => ({
            questionId: q.questionId ?
              (q.questionId.toString ? q.questionId.toString() : String(q.questionId)) :
              null,
            score: q.score || 0,
            totalScore: q.totalScore || 0,
            status: q.status || 'unknown'
          })),
          matchingDetails: {
            exactMatches: questionsWithScores.filter(q => q.userAttempt?.matchedBy === 'exact_id_match').length,
            partialMatches: questionsWithScores.filter(q => q.userAttempt?.matchedBy === 'partial_id_match').length,
            noMatches: questionsWithScores.filter(q => !q.userAttempt).length
          }
        }
      }
    };

    console.log(`\n✅ getUserExerciseGradeAnalytics COMPLETE`);
    console.log(`Response sent with ${attemptedQuestions.length} matched questions`);

    return res.status(200).json(response);

  } catch (error) {
    console.error("❌ getUserExerciseGradeAnalytics error:", error);
    console.error("❌ Error stack:", error.stack);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};




// Helper function for letter grade
function getLetterGrade(percentage) {
  if (percentage >= 90) return 'A';
  if (percentage >= 80) return 'B';
  if (percentage >= 70) return 'C';
  if (percentage >= 60) return 'D';
  return 'F';
}






// Get all exercises for a course with user scores and questions
exports.getCourseExercisesWithUserScores = async (req, res) => {
  try {
    const { courseId } = req.params;
    const userId = req.user._id; // Authenticated user (or pass userId if admin)
    const { targetUserId } = req.query; // Optional: for admin viewing other users

    const finalUserId = targetUserId || userId;

    console.log(`📊 Fetching exercises for Course: ${courseId}, User: ${finalUserId}`);

    if (!courseId) {
      return res.status(400).json({
        success: false,
        message: "courseId parameter is required"
      });
    }

    // 1. Find the user to get their progress
    const user = await User.findById(finalUserId)
      .select('firstName lastName email courses')
      .lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    // 2. Find user's course progress
    const userCourse = user.courses?.find(c =>
      c.courseId && c.courseId.toString() === courseId
    );

    if (!userCourse) {
      return res.status(404).json({
        success: false,
        message: "User is not enrolled in this course"
      });
    }

    // 3. Get all entities (modules, submodules, topics, subtopics) for this course
    const allEntities = [];

    // Get modules
    const modules = await Module1.find({ courses: courseId })
      .select('_id title description level duration pedagogy batchPedagogy')
      .lean();
    modules.forEach(mod => allEntities.push({ ...mod, type: 'module' }));

    // Get submodules
    const subModules = await SubModule1.find({ courses: courseId })
      .select('_id title description level duration pedagogy batchPedagogy')
      .lean();
    subModules.forEach(sub => allEntities.push({ ...sub, type: 'submodule' }));

    // Get topics
    const topics = await Topic1.find({ courses: courseId })
      .select('_id title description level duration pedagogy batchPedagogy')
      .lean();
    topics.forEach(topic => allEntities.push({ ...topic, type: 'topic' }));

    // Get subtopics
    const subTopics = await SubTopic1.find({ courses: courseId })
      .select('_id title description level duration pedagogy batchPedagogy')
      .lean();
    subTopics.forEach(st => allEntities.push({ ...st, type: 'subtopic' }));

    // ── Resources by Batch ──────────────────────────────────────────────────
    // Flatten every node to ONE batch's view before any exercise is read out.
    // Doing it here, on the whole collected set, keeps the extraction loop
    // below batch-agnostic — it walks `entity.pedagogy` exactly as it always
    // did, and that now holds the caller's batch's We Do / You Do exercises
    // when those elements are batch-wise.
    //
    // Students get their enrolled batch whatever they send; staff get the one
    // selected in the Resources page batch strip.
    const batchCourse = await CourseStructure.findById(courseId)
      .select(COURSE_BATCH_FIELDS)
      .lean();
    if (batchCourse) {
      const viewerBatchId = resolveViewerBatchId(batchCourse, req.user, readRequestedBatch(req));
      allEntities.forEach(entity => scopeNodePedagogy(entity, batchCourse, viewerBatchId));
    }

    // 4. Extract all exercises from all entities
    const allExercises = [];
    const entityMap = new Map(); // Map entity ID to entity info

    allEntities.forEach(entity => {
      entityMap.set(entity._id.toString(), {
        type: entity.type,
        title: entity.title,
        description: entity.description
      });

      if (entity.pedagogy) {
        // Search through all pedagogy sections
        ['I_Do', 'We_Do', 'You_Do'].forEach(section => {
          const sectionData = entity.pedagogy[section];
          if (!sectionData) return;

          // Handle both Map and object formats
          let subcategories = [];
          if (sectionData instanceof Map) {
            subcategories = Array.from(sectionData.entries());
          } else if (typeof sectionData === 'object') {
            subcategories = Object.entries(sectionData);
          }

          subcategories.forEach(([subcategory, value]) => {
            if (!value) return;

            let exercisesArray = [];
            if (Array.isArray(value)) {
              exercisesArray = value;
            } else if (value.exercises && Array.isArray(value.exercises)) {
              exercisesArray = value.exercises;
            } else if (value._id) {
              // Single exercise object
              exercisesArray = [value];
            }

            exercisesArray.forEach(exercise => {
              if (exercise && exercise._id) {
                allExercises.push({
                  ...exercise,
                  entity: {
                    id: entity._id,
                    type: entity.type,
                    title: entity.title
                  },
                  section,
                  subcategory,
                  location: `${entity.type}/${entity.title}/${section}/${subcategory}`
                });
              }
            });
          });
        });
      }
    });

    // 5. Get user's progress for these exercises
    const userProgressMap = new Map();

    // Search in user's course progress
    if (userCourse.answers) {
      ['I_Do', 'We_Do', 'You_Do'].forEach(section => {
        const sectionData = userCourse.answers[section];
        if (!sectionData) return;

        // Handle both Map and object formats
        let subcategories = [];
        if (sectionData instanceof Map) {
          subcategories = Array.from(sectionData.entries());
        } else if (typeof sectionData === 'object') {
          subcategories = Object.entries(sectionData);
        }

        subcategories.forEach(([subcategory, value]) => {
          if (!value) return;

          let exercisesArray = [];
          if (Array.isArray(value)) {
            exercisesArray = value;
          } else if (typeof value === 'object' && value.exercises) {
            exercisesArray = value.exercises;
          } else if (value._id) {
            exercisesArray = [value];
          }

          exercisesArray.forEach(userExercise => {
            if (userExercise && userExercise.exerciseId) {
              userProgressMap.set(userExercise.exerciseId.toString(), {
                status: userExercise.status || 'not_started',
                questions: userExercise.questions || [],
                totalScore: calculateTotalScore(userExercise.questions || []),
                averageScore: calculateAverageScore(userExercise.questions || []),
                completionRate: calculateCompletionRate(userExercise.questions || []),
                lastAccessed: userExercise.updatedAt
              });
            }
          });
        });
      });
    }

    // Helper functions
    function calculateTotalScore(questions) {
      return questions.reduce((sum, q) => sum + (q.score || 0), 0);
    }

    function calculateAverageScore(questions) {
      if (questions.length === 0) return 0;
      return calculateTotalScore(questions) / questions.length;
    }

    function calculateCompletionRate(questions) {
      if (questions.length === 0) return 0;
      const solved = questions.filter(q =>
        q.status === 'solved' || q.isCorrect === true
      ).length;
      return (solved / questions.length) * 100;
    }

    // 6. Combine exercises with user progress
    const exercisesWithProgress = allExercises.map(exercise => {
      const userProgress = userProgressMap.get(exercise._id.toString());
      const questions = exercise.questions || [];

      // Calculate exercise statistics
      const totalQuestions = questions.length;
      const totalPoints = questions.reduce((sum, q) => sum + (q.score || 0), 0);

      // Calculate difficulty distribution
      const difficultyCount = {
        easy: questions.filter(q => q.difficulty === 'easy').length,
        medium: questions.filter(q => q.difficulty === 'medium').length,
        hard: questions.filter(q => q.difficulty === 'hard').length
      };

      // Get user's question attempts
      const userQuestionAttempts = userProgress?.questions || [];
      const userQuestionMap = new Map();
      userQuestionAttempts.forEach(q => {
        if (q.questionId) {
          userQuestionMap.set(q.questionId.toString(), q);
        }
      });

      // Map questions with user attempts
      const questionsWithAttempts = questions.map(q => {
        const userAttempt = userQuestionMap.get(q._id?.toString());
        return {
          _id: q._id,
          title: q.title,
          difficulty: q.difficulty,
          score: q.score,
          maxScore: q.score,
          userScore: userAttempt?.score || 0,
          status: userAttempt?.status || 'not_attempted',
          isCorrect: userAttempt?.isCorrect || false,
          attempts: userAttempt?.attempts || 0,
          submittedAt: userAttempt?.submittedAt,
          feedback: userAttempt?.feedback,
          language: userAttempt?.language
        };
      });

      return {
        _id: exercise._id,
        exerciseId: exercise.exerciseInformation?.exerciseId,
        exerciseName: exercise.exerciseInformation?.exerciseName || 'Unnamed Exercise',
        description: exercise.exerciseInformation?.description || '',
        exerciseLevel: exercise.exerciseInformation?.exerciseLevel || 'intermediate',
        totalQuestions,
        totalPoints,
        estimatedTime: exercise.exerciseInformation?.estimatedTime || 0,

        // Entity location
        entity: exercise.entity,
        section: exercise.section,
        subcategory: exercise.subcategory,
        location: exercise.location,

        // User progress
        userProgress: userProgress || {
          status: 'not_started',
          totalScore: 0,
          averageScore: 0,
          completionRate: 0,
          lastAccessed: null
        },

        // Difficulty analysis
        difficultyCount,

        // Questions with user attempts
        questions: questionsWithAttempts,

        // Overall statistics
        statistics: {
          attemptedQuestions: questionsWithAttempts.filter(q => q.status !== 'not_attempted').length,
          solvedQuestions: questionsWithAttempts.filter(q => q.isCorrect === true).length,
          averageScore: calculateAverageScore(userQuestionAttempts),
          totalScore: calculateTotalScore(userQuestionAttempts),
          accuracy: userQuestionAttempts.length > 0
            ? (questionsWithAttempts.filter(q => q.isCorrect).length / userQuestionAttempts.length) * 100
            : 0
        },

        // Dates
        createdAt: exercise.createdAt,
        startDate: exercise.availabilityPeriod?.startDate,
        endDate: exercise.availabilityPeriod?.endDate,

        // Settings
        programmingLanguages: exercise.programmingSettings?.selectedLanguages || [],
        practiceMode: exercise.configurationType?.practiceMode || false,
        manualEvaluation: exercise.configurationType?.manualEvaluation || false
      };
    });

    // 7. Calculate overall course statistics
    const courseStatistics = {
      totalExercises: exercisesWithProgress.length,
      totalQuestions: exercisesWithProgress.reduce((sum, ex) => sum + ex.totalQuestions, 0),
      totalPoints: exercisesWithProgress.reduce((sum, ex) => sum + ex.totalPoints, 0),

      completedExercises: exercisesWithProgress.filter(ex =>
        ex.userProgress.status === 'completed' ||
        ex.userProgress.completionRate >= 100
      ).length,

      inProgressExercises: exercisesWithProgress.filter(ex =>
        ex.userProgress.status === 'in_progress' ||
        (ex.userProgress.completionRate > 0 && ex.userProgress.completionRate < 100)
      ).length,

      notStartedExercises: exercisesWithProgress.filter(ex =>
        ex.userProgress.status === 'not_started' ||
        ex.userProgress.completionRate === 0
      ).length,

      overallScore: exercisesWithProgress.reduce((sum, ex) => sum + ex.userProgress.totalScore, 0),
      overallAverage: exercisesWithProgress.length > 0
        ? exercisesWithProgress.reduce((sum, ex) => sum + ex.userProgress.averageScore, 0) / exercisesWithProgress.length
        : 0,

      overallCompletion: exercisesWithProgress.length > 0
        ? exercisesWithProgress.reduce((sum, ex) => sum + ex.userProgress.completionRate, 0) / exercisesWithProgress.length
        : 0,

      byDifficulty: {
        easy: {
          total: exercisesWithProgress.reduce((sum, ex) => sum + ex.difficultyCount.easy, 0),
          solved: exercisesWithProgress.reduce((sum, ex) =>
            sum + ex.questions.filter(q => q.difficulty === 'easy' && q.isCorrect).length, 0
          )
        },
        medium: {
          total: exercisesWithProgress.reduce((sum, ex) => sum + ex.difficultyCount.medium, 0),
          solved: exercisesWithProgress.reduce((sum, ex) =>
            sum + ex.questions.filter(q => q.difficulty === 'medium' && q.isCorrect).length, 0
          )
        },
        hard: {
          total: exercisesWithProgress.reduce((sum, ex) => sum + ex.difficultyCount.hard, 0),
          solved: exercisesWithProgress.reduce((sum, ex) =>
            sum + ex.questions.filter(q => q.difficulty === 'hard' && q.isCorrect).length, 0
          )
        }
      }
    };

    // 8. Prepare response
    const response = {
      success: true,
      data: {
        user: {
          _id: user._id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email
        },
        course: {
          _id: courseId,
          exercisesCount: exercisesWithProgress.length
        },
        exercises: exercisesWithProgress,
        statistics: courseStatistics,
        summary: {
          fetchedAt: new Date(),
          totalEntities: allEntities.length,
          exercisesFound: exercisesWithProgress.length,
          userProgressAvailable: userProgressMap.size > 0
        }
      }
    };

    return res.status(200).json(response);

  } catch (error) {
    console.error("❌ Get course exercises with user scores error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
};














// Get all exercises for a course (Admin/Program Coordinator View - No enrollment required)
exports.getCourseExercisesAdminView = async (req, res) => {
  try {
    const { courseId } = req.params;
    const {
      includeQuestions = 'false',
      includeUserProgress = 'false',
      userId = null  // Optional: if you want to check a specific user's progress
    } = req.query;

    console.log(`👨‍💼 Admin fetching exercises for Course: ${courseId}`);

    if (!courseId) {
      return res.status(400).json({
        success: false,
        message: "courseId parameter is required"
      });
    }

    // 1. Get course details. Combined with the batch-scoping select below —
    // this handler used to run TWO separate CourseStructure.findById(courseId)
    // queries for the same document; one select covers both purposes now.
    const course = await CourseStructure.findById(courseId)
      .select('courseName courseCode description startDate endDate status ' + COURSE_BATCH_FIELDS)
      .lean();

    if (!course) {
      return res.status(404).json({
        success: false,
        message: "Course not found"
      });
    }
    const batchCourse = course;

    console.log(`📚 Course found: ${course.courseName}`);

    // 2. Get all entities for this course. Four independent reads — Promise.all
    // (no early-exit logic here to preserve, unlike the exercise-search loops
    // in the other two handlers below).
    const allEntities = [];
    const nodeSelect = '_id title description level duration orderIndex pedagogy batchPedagogy';
    const [modules, subModules, topics, subTopics] = await Promise.all([
      Module1.find({ courses: courseId }).select(nodeSelect).sort({ orderIndex: 1 }).lean(),
      SubModule1.find({ courses: courseId }).select(nodeSelect).sort({ orderIndex: 1 }).lean(),
      Topic1.find({ courses: courseId }).select(nodeSelect).sort({ orderIndex: 1 }).lean(),
      SubTopic1.find({ courses: courseId }).select(nodeSelect).sort({ orderIndex: 1 }).lean(),
    ]);
    modules.forEach(mod => allEntities.push({ ...mod, type: 'module' }));
    subModules.forEach(sub => allEntities.push({ ...sub, type: 'submodule' }));
    topics.forEach(topic => allEntities.push({ ...topic, type: 'topic' }));
    subTopics.forEach(st => allEntities.push({ ...st, type: 'subtopic' }));

    // ── Resources by Batch ──────────────────────────────────────────────────
    // Flatten every node to ONE batch's view before any exercise is read out.
    // Doing it here, on the whole collected set, keeps the extraction loop
    // below batch-agnostic — it walks `entity.pedagogy` exactly as it always
    // did, and that now holds the caller's batch's We Do / You Do exercises
    // when those elements are batch-wise.
    //
    // Students get their enrolled batch whatever they send; staff get the one
    // selected in the Resources page batch strip.
    if (batchCourse) {
      const viewerBatchId = resolveViewerBatchId(batchCourse, req.user, readRequestedBatch(req));
      allEntities.forEach(entity => scopeNodePedagogy(entity, batchCourse, viewerBatchId));
    }

    console.log(`📦 Found ${allEntities.length} entities for course`);

    // 3. Extract all exercises from all entities
    const allExercises = [];
    const entityMap = new Map();

    allEntities.forEach(entity => {
      entityMap.set(entity._id.toString(), {
        type: entity.type,
        title: entity.title,
        description: entity.description,
        level: entity.level,
        duration: entity.duration,
        orderIndex: entity.orderIndex
      });

      if (entity.pedagogy) {
        // Search through all pedagogy sections
        ['I_Do', 'We_Do', 'You_Do'].forEach(section => {
          const sectionData = entity.pedagogy[section];
          if (!sectionData) return;

          // Handle both Map and object formats
          let subcategories = [];
          if (sectionData instanceof Map) {
            subcategories = Array.from(sectionData.entries());
          } else if (typeof sectionData === 'object') {
            subcategories = Object.entries(sectionData);
          }

          subcategories.forEach(([subcategory, value]) => {
            if (!value) return;

            let exercisesArray = [];
            if (Array.isArray(value)) {
              exercisesArray = value;
            } else if (value.exercises && Array.isArray(value.exercises)) {
              exercisesArray = value.exercises;
            } else if (value._id) {
              exercisesArray = [value];
            }

            exercisesArray.forEach(exercise => {
              if (exercise && exercise._id) {
                allExercises.push({
                  ...exercise,
                  entity: {
                    id: entity._id,
                    type: entity.type,
                    title: entity.title,
                    description: entity.description,
                    level: entity.level,
                    duration: entity.duration,
                    orderIndex: entity.orderIndex
                  },
                  section,
                  subcategory,
                  location: `${entity.type}/${entity.title}/${section}/${subcategory}`
                });
              }
            });
          });
        });
      }
    });

    console.log(`📊 Found ${allExercises.length} exercises in course`);

    // 4. Optional: Get user progress if userId is provided
    let userProgressMap = new Map();
    let userDetails = null;

    if (userId && includeUserProgress === 'true') {
      const user = await User.findById(userId)
        .select('firstName lastName email courses')
        .lean();

      if (user) {
        userDetails = {
          _id: user._id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email
        };

        // Find user's course progress
        const userCourse = user.courses?.find(c =>
          c.courseId && c.courseId.toString() === courseId
        );

        if (userCourse && userCourse.answers) {
          ['I_Do', 'We_Do', 'You_Do'].forEach(section => {
            const sectionData = userCourse.answers[section];
            if (!sectionData) return;

            // Handle both Map and object formats
            let subcategories = [];
            if (sectionData instanceof Map) {
              subcategories = Array.from(sectionData.entries());
            } else if (typeof sectionData === 'object') {
              subcategories = Object.entries(sectionData);
            }

            subcategories.forEach(([subcategory, value]) => {
              if (!value) return;

              let exercisesArray = [];
              if (Array.isArray(value)) {
                exercisesArray = value;
              } else if (typeof value === 'object' && value.exercises) {
                exercisesArray = value.exercises;
              } else if (value._id) {
                exercisesArray = [value];
              }

              exercisesArray.forEach(userExercise => {
                if (userExercise && userExercise.exerciseId) {
                  userProgressMap.set(userExercise.exerciseId.toString(), {
                    status: userExercise.status || 'not_started',
                    questions: userExercise.questions || [],
                    totalScore: userExercise.questions?.reduce((sum, q) => sum + (q.score || 0), 0) || 0,
                    averageScore: userExercise.questions?.length > 0 ?
                      (userExercise.questions.reduce((sum, q) => sum + (q.score || 0), 0) / userExercise.questions.length) : 0,
                    completionRate: userExercise.questions?.length > 0 ?
                      (userExercise.questions.filter(q => q.status === 'solved' || q.isCorrect === true).length / userExercise.questions.length * 100) : 0,
                    lastAccessed: userExercise.updatedAt,
                    startedAt: userExercise.createdAt
                  });
                }
              });
            });
          });
          console.log(`👤 Found progress for user ${userId}: ${userProgressMap.size} exercises`);
        }
      }
    }

    // 5. Format exercises for response
    const formattedExercises = allExercises.map(exercise => {
      const questions = exercise.questions || [];
      const totalQuestions = questions.length;
      const totalPoints = questions.reduce((sum, q) => sum + (q.score || 0), 0);

      // Get user progress for this exercise if available
      const userProgress = userProgressMap.get(exercise._id.toString());

      // Format exercise data
      const formattedExercise = {
        _id: exercise._id,
        exerciseId: exercise.exerciseInformation?.exerciseId,
        exerciseName: exercise.exerciseInformation?.exerciseName || 'Unnamed Exercise',
        description: exercise.exerciseInformation?.description || '',
        exerciseLevel: exercise.exerciseInformation?.exerciseLevel || 'intermediate',
        totalQuestions,
        totalPoints,
        estimatedTime: exercise.exerciseInformation?.estimatedTime || 0,

        // Entity location
        entity: exercise.entity,
        section: exercise.section,
        subcategory: exercise.subcategory,
        location: exercise.location,

        // Settings
        programmingLanguages: exercise.programmingSettings?.selectedLanguages || [],
        practiceMode: exercise.configurationType?.practiceMode || false,
        manualEvaluation: exercise.configurationType?.manualEvaluation || false,

        // Dates
        createdAt: exercise.createdAt,
        startDate: exercise.availabilityPeriod?.startDate,
        endDate: exercise.availabilityPeriod?.endDate,
        status: exercise.availabilityPeriod?.startDate && exercise.availabilityPeriod?.endDate ?
          (new Date() < new Date(exercise.availabilityPeriod.startDate) ? 'scheduled' :
            new Date() > new Date(exercise.availabilityPeriod.endDate) ? 'expired' : 'active') :
          'no_dates',

        // Question statistics
        questionStatistics: {
          easy: questions.filter(q => q.difficulty === 'easy').length,
          medium: questions.filter(q => q.difficulty === 'medium').length,
          hard: questions.filter(q => q.difficulty === 'hard').length,
          totalQuestions
        }
      };

      // Include questions if requested
      if (includeQuestions === 'true') {
        formattedExercise.questions = questions.map(q => ({
          _id: q._id,
          title: q.title,
          description: q.description,
          difficulty: q.difficulty,
          score: q.score,
          timeLimit: q.timeLimit,
          memoryLimit: q.memoryLimit,
          isActive: q.isActive !== false
        }));
      }

      // Include user progress if available and requested
      if (includeUserProgress === 'true' && userProgress) {
        formattedExercise.userProgress = {
          status: userProgress.status,
          totalScore: userProgress.totalScore,
          averageScore: userProgress.averageScore,
          completionRate: userProgress.completionRate,
          lastAccessed: userProgress.lastAccessed,
          startedAt: userProgress.startedAt,
          questionsAttempted: userProgress.questions?.length || 0,
          questionsSolved: userProgress.questions?.filter(q =>
            q.status === 'solved' || q.isCorrect === true
          ).length || 0
        };
      }

      return formattedExercise;
    });

    // 6. Sort exercises by entity type and order
    formattedExercises.sort((a, b) => {
      // First by entity type order
      const entityOrder = { module: 1, submodule: 2, topic: 3, subtopic: 4 };
      const entityA = entityOrder[a.entity.type] || 5;
      const entityB = entityOrder[b.entity.type] || 5;
      if (entityA !== entityB) return entityA - entityB;

      // Then by entity order index
      if (a.entity.orderIndex !== b.entity.orderIndex) {
        return (a.entity.orderIndex || 999) - (b.entity.orderIndex || 999);
      }

      // Then by entity title
      return a.entity.title.localeCompare(b.entity.title);
    });

    // 7. Group exercises by entity type for better organization
    const exercisesByEntityType = {
      modules: formattedExercises.filter(ex => ex.entity.type === 'module'),
      submodules: formattedExercises.filter(ex => ex.entity.type === 'submodule'),
      topics: formattedExercises.filter(ex => ex.entity.type === 'topic'),
      subtopics: formattedExercises.filter(ex => ex.entity.type === 'subtopic')
    };

    // 8. Calculate course statistics
    const courseStatistics = {
      totalEntities: allEntities.length,
      totalExercises: formattedExercises.length,
      totalQuestions: formattedExercises.reduce((sum, ex) => sum + ex.totalQuestions, 0),
      totalPoints: formattedExercises.reduce((sum, ex) => sum + ex.totalPoints, 0),

      byEntityType: {
        modules: {
          count: exercisesByEntityType.modules.length,
          questions: exercisesByEntityType.modules.reduce((sum, ex) => sum + ex.totalQuestions, 0)
        },
        submodules: {
          count: exercisesByEntityType.submodules.length,
          questions: exercisesByEntityType.submodules.reduce((sum, ex) => sum + ex.totalQuestions, 0)
        },
        topics: {
          count: exercisesByEntityType.topics.length,
          questions: exercisesByEntityType.topics.reduce((sum, ex) => sum + ex.totalQuestions, 0)
        },
        subtopics: {
          count: exercisesByEntityType.subtopics.length,
          questions: exercisesByEntityType.subtopics.reduce((sum, ex) => sum + ex.totalQuestions, 0)
        }
      },

      bySection: {
        I_Do: formattedExercises.filter(ex => ex.section === 'I_Do').length,
        We_Do: formattedExercises.filter(ex => ex.section === 'We_Do').length,
        You_Do: formattedExercises.filter(ex => ex.section === 'You_Do').length
      },

      byDifficulty: {
        easy: formattedExercises.reduce((sum, ex) => sum + ex.questionStatistics.easy, 0),
        medium: formattedExercises.reduce((sum, ex) => sum + ex.questionStatistics.medium, 0),
        hard: formattedExercises.reduce((sum, ex) => sum + ex.questionStatistics.hard, 0)
      },

      byStatus: {
        active: formattedExercises.filter(ex => ex.status === 'active').length,
        scheduled: formattedExercises.filter(ex => ex.status === 'scheduled').length,
        expired: formattedExercises.filter(ex => ex.status === 'expired').length,
        no_dates: formattedExercises.filter(ex => ex.status === 'no_dates').length
      }
    };

    // 9. Prepare final response
    const response = {
      success: true,
      data: {
        course: {
          _id: course._id,
          name: course.courseName,
          code: course.courseCode,
          description: course.description,
          startDate: course.startDate,
          endDate: course.endDate,
          status: course.status
        },

        // User details if provided
        ...(userDetails && { user: userDetails }),

        // Exercises in different formats
        exercises: formattedExercises,
        exercisesByEntityType,

        // Statistics
        statistics: courseStatistics,

        // Summary
        summary: {
          fetchedAt: new Date(),
          totalExercises: formattedExercises.length,
          includeQuestions: includeQuestions === 'true',
          includeUserProgress: includeUserProgress === 'true',
          userProgressAvailable: userProgressMap.size > 0
        }
      }
    };

    console.log(`✅ Admin view generated for course ${courseId}`);
    console.log(`   Total exercises: ${formattedExercises.length}`);
    console.log(`   Total questions: ${courseStatistics.totalQuestions}`);
    console.log(`   User progress included: ${includeUserProgress === 'true'}`);

    return res.status(200).json(response);

  } catch (error) {
    console.error("❌ Get course exercises (admin view) error:", error);
    console.error("❌ Error stack:", error.stack);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
};

exports.getEnrolledStudentsForExercise = async (req, res) => {
  try {
    const { courseId, exerciseId } = req.params;
    const {
      includeProgress = 'true',
      search = '',
      page = 1,
      limit = 20,
      sortBy = 'name',
      sortOrder = 'asc'
    } = req.query;

    console.log(`👨‍🏫 Fetching enrolled students for Exercise: ${exerciseId} in Course: ${courseId}`);

    if (!courseId || !exerciseId) {
      return res.status(400).json({
        success: false,
        message: "courseId and exerciseId parameters are required"
      });
    }

    // 1. Get course details. Combined with the batch-scoping select below —
    // was two separate findById(courseId) queries for the same document.
    const course = await CourseStructure.findById(courseId)
      .select('courseName courseCode description ' + COURSE_BATCH_FIELDS)
      .lean();

    if (!course) {
      return res.status(404).json({
        success: false,
        message: "Course not found"
      });
    }
    const batchCourseForScan = course;

    // 2. Get exercise details to verify it exists and get grade settings
    let exerciseDetails = null;
    let exerciseFoundIn = null;
    let gradeSettings = null;
    let totalMaxScore = 0;
    let exerciseName = '';

    // Search for exercise in all entity types
    // ── Resources by Batch ──────────────────────────────────────────────────
    // Which batch this caller sees, and the course config that says whether
    // We Do / You Do are even batch-wise. Each node is then flattened to that
    // batch before it is searched, so the walk stays batch-agnostic and finds
    // batch-wise exercises the same way it finds shared ones.
    const scanBatchId = batchCourseForScan
      ? resolveViewerBatchId(batchCourseForScan, req.user, readRequestedBatch(req))
      : "";

    const entityModels = [
      { name: 'Module1', model: Module1 },
      { name: 'SubModule1', model: SubModule1 },
      { name: 'Topic1', model: Topic1 },
      { name: 'SubTopic1', model: SubTopic1 }
    ];

    for (const { name, model } of entityModels) {
      try {
        const entities = await model.find({ courses: courseId })
          .select('_id title pedagogy batchPedagogy')
          .lean();
        // Flatten each node to the caller's batch. Safe to mutate — these are
        // .lean() copies, not live documents.
        if (batchCourseForScan) {
          entities.forEach(e => scopeNodePedagogy(e, batchCourseForScan, scanBatchId));
        }

        for (const entity of entities) {
          if (entity.pedagogy) {
            ['I_Do', 'We_Do', 'You_Do'].forEach(section => {
              if (entity.pedagogy[section]) {
                const sectionData = entity.pedagogy[section];
                let subcategories = [];

                if (sectionData instanceof Map) {
                  subcategories = Array.from(sectionData.entries());
                } else if (typeof sectionData === 'object') {
                  subcategories = Object.entries(sectionData);
                }

                subcategories.forEach(([subcategory, exercises]) => {
                  if (!exercises) return;

                  let exercisesArray = [];
                  if (Array.isArray(exercises)) {
                    exercisesArray = exercises;
                  } else if (exercises._id) {
                    exercisesArray = [exercises];
                  }

                  const exercise = exercisesArray.find(ex =>
                    ex._id && ex._id.toString() === exerciseId
                  );

                  if (exercise) {
                    exerciseDetails = {
                      ...exercise,
                      entity: {
                        type: name,
                        id: entity._id,
                        title: entity.title
                      },
                      section,
                      subcategory
                    };
                    exerciseFoundIn = { name, entity, section, subcategory };

                    // Get grade settings
                    gradeSettings = exercise.gradeSettings || null;

                    // Get exercise name
                    exerciseName = exercise.exerciseInformation?.exerciseName ||
                      exercise.exerciseName ||
                      'Unnamed Exercise';

                    // Calculate total max score
                    if (exercise.questions && Array.isArray(exercise.questions)) {
                      // Same string-concatenation hazard as overallScore
                      // below: mcqQuestionScore / score are String on a
                      // number of records, so coerce before summing or the
                      // Marks denominator comes back glued together too.
                      totalMaxScore = exercise.questions.reduce((sum, q) => {
                        const qScore = Number(q.mcqQuestionScore ?? q.score) || 10;
                        return sum + qScore;
                      }, 0);
                    }

                    console.log(`✅ Found exercise: ${exerciseName}`);
                    console.log(`   Grade Settings:`, gradeSettings);
                    console.log(`   Total Max Score: ${totalMaxScore}`);
                  }
                });
              }
            });
          }
        }
        if (exerciseDetails) break;
      } catch (err) {
        console.log(`Error searching in ${name}:`, err.message);
      }
    }

    if (!exerciseDetails) {
      return res.status(404).json({
        success: false,
        message: "Exercise not found in course structure"
      });
    }

    console.log(`✅ Exercise found: ${exerciseName}`);

    // 3. Get all enrolled users for this course. Was an UNSCOPED
    // User.find({courses: {$exists:true, $ne:null}}) — every user in the
    // entire platform with any course progress, filtered down to this course
    // in JS afterward. Scoping the query itself to the array-element match
    // returns the identical final set (the JS filter below checks exactly
    // this condition) without paying for every other tenant's users.
    const enrolledInCourse = await User.find({
      'courses.courseId': courseId
    })
      .select('_id firstName lastName email profile phone status createdAt role courses')
      .lean();

    console.log(`👥 ${enrolledInCourse.length} users enrolled in course ${courseId}`);

    // 4. Process each user to find their exercise progress with Pass/Fail
    const studentsWithProgress = await Promise.all(
      enrolledInCourse.map(async (user) => {
        const userCourses = user.courses || [];
        const userCourse = userCourses.find(c =>
          c && c.courseId && c.courseId.toString() === courseId
        );

        let exerciseProgress = null;
        let questionAttempts = [];
        let overallScore = 0;
        let completionPercentage = 0;
        let lastActivity = null;
        let status = 'not_started';
        let isPassing = false;
        let passingMarksRequired = null;

        if (userCourse && userCourse.answers) {
          // Search through all sections for this exercise
          ['I_Do', 'We_Do', 'You_Do'].forEach(section => {
            const sectionData = userCourse.answers[section];
            if (!sectionData) return;

            // Handle both Map and object formats
            let subcategories = [];
            if (sectionData instanceof Map) {
              subcategories = Array.from(sectionData.entries());
            } else if (typeof sectionData === 'object') {
              subcategories = Object.entries(sectionData);
            }

            subcategories.forEach(([subcategory, exercises]) => {
              if (!exercises) return;

              let exercisesArray = [];
              if (Array.isArray(exercises)) {
                exercisesArray = exercises;
              } else if (typeof exercises === 'object' && exercises._id) {
                exercisesArray = [exercises];
              }

              if (!exercisesArray || !Array.isArray(exercisesArray)) {
                return;
              }

              const userExercise = exercisesArray.find(ex =>
                ex && ex.exerciseId && ex.exerciseId.toString() === exerciseId
              );

              if (userExercise) {
                exerciseProgress = userExercise;
                questionAttempts = userExercise.questions || [];

                // Number(q.score) — several exercise records persist the
                // per-question score as a String, and `0 + "5"` in JS is
                // string CONCATENATION, so this reduce was emitting
                // overallScore: "05555505050" (ten questions' scores glued
                // together) instead of the sum, 35. That string then
                // rendered verbatim in the Student List Marks column.
                overallScore = questionAttempts.reduce((sum, q) => sum + (Number(q.score) || 0), 0);

                // Calculate completion percentage
                const totalQuestions = exerciseDetails.questions?.length || 0;
                const attemptedQuestions = questionAttempts.length;
                completionPercentage = totalQuestions > 0 ?
                  (attemptedQuestions / totalQuestions) * 100 : 0;

                // Determine status based on exercise type
                const isMCQExercise = exerciseDetails.exerciseType === 'MCQ' ||
                  (exerciseDetails.questions && exerciseDetails.questions.every(q => q.questionType === 'MCQ'));

                if (questionAttempts.length === 0) {
                  status = 'not_started';
                } else if (isMCQExercise) {
                  // For MCQ exercises, they're auto-evaluated when answered
                  status = 'evaluated';
                } else if (questionAttempts.some(q => q.status === 'submitted' || q.status === 'attempted')) {
                  status = 'in_progress';
                } else if (questionAttempts.every(q => q.status === 'evaluated')) {
                  status = 'evaluated';
                } else if (questionAttempts.every(q => q.status === 'solved' || q.status === 'completed')) {
                  status = 'completed';
                }

                lastActivity = userExercise.updatedAt || userExercise.createdAt;
              }
            });
          });
        }

        // Calculate Pass/Fail based on grade settings
        if (gradeSettings) {
          // Use mcqGradeToPass for MCQ exercises
          passingMarksRequired = gradeSettings.mcqGradeToPass ||
            gradeSettings.programmingGradeToPass ||
            gradeSettings.combinedGradeToPass ||
            (totalMaxScore * 0.4); // Default 40% if not specified

          // Check if student has passed
          isPassing = overallScore >= passingMarksRequired;

          console.log(`Student ${user.firstName} ${user.lastName}: Score ${overallScore}/${totalMaxScore}, Pass Mark ${passingMarksRequired}, Passing: ${isPassing}`);
        } else {
          // Default: 50% passing mark
          passingMarksRequired = totalMaxScore * 0.5;
          isPassing = overallScore >= passingMarksRequired;
        }

        // Get user role name
        let roleName = 'Student';
        if (user.role) {
          if (mongoose.Types.ObjectId.isValid(user.role)) {
            const roleDoc = await mongoose.model('Role').findById(user.role).lean();
            roleName = roleDoc?.renameRole || roleDoc?.originalRole || 'Student';
          } else if (typeof user.role === 'string') {
            roleName = user.role;
          }
        }

        let enrolledAt = user.createdAt;
        if (userCourse && userCourse.enrolledAt) {
          enrolledAt = userCourse.enrolledAt;
        } else if (userCourse && userCourse.createdAt) {
          enrolledAt = userCourse.createdAt;
        }

        return {
          _id: user._id,
          name: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
          firstName: user.firstName || '',
          lastName: user.lastName || '',
          email: user.email || '',
          profile: user.profile || '',
          phone: user.phone || '',
          status: user.status || 'active',
          role: roleName,
          enrolledAt: enrolledAt,
          lastAccessed: userCourse?.lastAccessed,

          // Exercise-specific progress with Pass/Fail
          exerciseProgress: includeProgress === 'true' ? {
            status,
            overallScore,
            completionPercentage: completionPercentage.toFixed(2),
            questionsAttempted: questionAttempts.length,
            questionsTotal: exerciseDetails.questions?.length || 0,
            lastActivity,
            startedAt: exerciseProgress?.createdAt,
            submittedAt: exerciseProgress?.updatedAt,
            isPassing: isPassing,
            passingMarksRequired: passingMarksRequired,
            totalMaxScore: totalMaxScore,

            // Detailed question attempts
            questionAttempts: includeProgress === 'true' ? questionAttempts.map(q => ({
              questionId: q.questionId,
              title: q.questionTitle || `Question ${q.questionId?.toString().substring(0, 8)}...`,
              score: q.score || 0,
              totalScore: q.totalScore || 0,
              status: q.status || 'attempted',
              isCorrect: q.isCorrect || false,
              attempts: q.attempts || 1,
              submittedAt: q.submittedAt,
              evaluatedAt: q.evaluatedAt,
              feedback: q.feedback || ''
            })) : [],

            projectType: exerciseProgress?.projectType,
            fileCount: exerciseProgress?.questions?.[0]?.files?.length || 0,
            folderCount: exerciseProgress?.questions?.[0]?.folders?.length || 0
          } : null
        };
      })
    );

    // 5. Apply search filter if provided
    let filteredStudents = studentsWithProgress;
    if (search) {
      const searchLower = search.toLowerCase();
      filteredStudents = studentsWithProgress.filter(student =>
        (student.name && student.name.toLowerCase().includes(searchLower)) ||
        (student.email && student.email.toLowerCase().includes(searchLower)) ||
        (student.role && student.role.toLowerCase().includes(searchLower))
      );
    }

    // 6. Apply sorting
    filteredStudents.sort((a, b) => {
      let aValue, bValue;

      switch (sortBy) {
        case 'progress':
          aValue = a.exerciseProgress?.completionPercentage || 0;
          bValue = b.exerciseProgress?.completionPercentage || 0;
          break;
        case 'score':
          aValue = a.exerciseProgress?.overallScore || 0;
          bValue = b.exerciseProgress?.overallScore || 0;
          break;
        case 'passing':
          aValue = a.exerciseProgress?.isPassing ? 1 : 0;
          bValue = b.exerciseProgress?.isPassing ? 1 : 0;
          break;
        case 'lastAccessed':
          aValue = a.exerciseProgress?.lastActivity ? new Date(a.exerciseProgress.lastActivity).getTime() : 0;
          bValue = b.exerciseProgress?.lastActivity ? new Date(b.exerciseProgress.lastActivity).getTime() : 0;
          break;
        case 'name':
        default:
          aValue = a.name ? a.name.toLowerCase() : '';
          bValue = b.name ? b.name.toLowerCase() : '';
      }

      if (sortOrder === 'desc') {
        return bValue > aValue ? 1 : bValue < aValue ? -1 : 0;
      } else {
        return aValue > bValue ? 1 : aValue < bValue ? -1 : 0;
      }
    });

    // 7. Apply pagination
    const totalStudents = filteredStudents.length;
    const startIndex = (parseInt(page) - 1) * parseInt(limit);
    const endIndex = startIndex + parseInt(limit);
    const paginatedStudents = filteredStudents.slice(startIndex, endIndex);

    // 8. Calculate exercise statistics with Pass/Fail counts
    const studentsWithProgressOnly = studentsWithProgress.filter(s =>
      s.exerciseProgress && s.exerciseProgress.status !== 'not_started'
    );

    const exerciseStatistics = {
      totalEnrolled: enrolledInCourse.length,
      studentsWithProgress: studentsWithProgressOnly.length,

      byStatus: {
        not_started: studentsWithProgress.filter(s =>
          s.exerciseProgress && s.exerciseProgress.status === 'not_started'
        ).length,
        in_progress: studentsWithProgress.filter(s =>
          s.exerciseProgress && s.exerciseProgress.status === 'in_progress'
        ).length,
        completed: studentsWithProgress.filter(s =>
          s.exerciseProgress && s.exerciseProgress.status === 'completed'
        ).length,
        evaluated: studentsWithProgress.filter(s =>
          s.exerciseProgress && s.exerciseProgress.status === 'evaluated'
        ).length
      },

      byPassFail: {
        pass: studentsWithProgressOnly.filter(s =>
          s.exerciseProgress && s.exerciseProgress.isPassing === true
        ).length,
        fail: studentsWithProgressOnly.filter(s =>
          s.exerciseProgress && s.exerciseProgress.isPassing === false
        ).length,
        not_started: studentsWithProgress.filter(s =>
          !s.exerciseProgress || s.exerciseProgress.status === 'not_started'
        ).length
      },

      averageScore: studentsWithProgressOnly.length > 0 ?
        studentsWithProgressOnly.reduce((sum, s) => sum + (s.exerciseProgress?.overallScore || 0), 0) /
        studentsWithProgressOnly.length : 0,

      averageCompletion: studentsWithProgressOnly.length > 0 ?
        studentsWithProgressOnly.reduce((sum, s) => sum + parseFloat(s.exerciseProgress?.completionPercentage || 0), 0) /
        studentsWithProgressOnly.length : 0,

      passingMarksRequired: gradeSettings?.mcqGradeToPass ||
        gradeSettings?.programmingGradeToPass ||
        gradeSettings?.combinedGradeToPass ||
        (totalMaxScore * 0.4),

      totalMaxScore: totalMaxScore,

      scoreDistribution: {
        '0-20': studentsWithProgressOnly.filter(s => (s.exerciseProgress?.overallScore || 0) <= 20).length,
        '21-40': studentsWithProgressOnly.filter(s => (s.exerciseProgress?.overallScore || 0) > 20 &&
          (s.exerciseProgress?.overallScore || 0) <= 40).length,
        '41-60': studentsWithProgressOnly.filter(s => (s.exerciseProgress?.overallScore || 0) > 40 &&
          (s.exerciseProgress?.overallScore || 0) <= 60).length,
        '61-80': studentsWithProgressOnly.filter(s => (s.exerciseProgress?.overallScore || 0) > 60 &&
          (s.exerciseProgress?.overallScore || 0) <= 80).length,
        '81-100': studentsWithProgressOnly.filter(s => (s.exerciseProgress?.overallScore || 0) > 80).length
      }
    };

    // 9. Prepare final response
    const responseData = {
      success: true,
      data: {
        course: {
          _id: course._id,
          name: course.courseName,
          code: course.courseCode,
          description: course.description
        },

        exercise: {
          _id: exerciseDetails._id,
          exerciseId: exerciseDetails.exerciseInformation?.exerciseId,
          name: exerciseName,
          description: exerciseDetails.exerciseInformation?.description || '',
          level: exerciseDetails.exerciseInformation?.exerciseLevel || 'intermediate',
          totalQuestions: exerciseDetails.questions?.length || 0,
          totalPoints: totalMaxScore,
          exerciseType: exerciseDetails.exerciseType ||
            (exerciseDetails.questions?.every(q => q.questionType === 'MCQ') ? 'MCQ' : 'Programming'),
          gradeSettings: gradeSettings,
          passingMarksRequired: gradeSettings?.mcqGradeToPass ||
            gradeSettings?.programmingGradeToPass ||
            gradeSettings?.combinedGradeToPass,

          location: {
            entityType: exerciseFoundIn?.name,
            entityTitle: exerciseFoundIn?.entity?.title,
            section: exerciseFoundIn?.section,
            subcategory: exerciseFoundIn?.subcategory
          },

          questions: exerciseDetails.questions?.map(q => ({
            _id: q._id,
            title: q.mcqQuestionTitle || q.title || 'Untitled Question',
            difficulty: q.mcqQuestionDifficulty || q.difficulty || 'medium',
            score: q.mcqQuestionScore || q.score || 10
          })) || []
        },

        students: paginatedStudents,

        statistics: exerciseStatistics,

        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: totalStudents,
          pages: Math.ceil(totalStudents / parseInt(limit)),
          showing: paginatedStudents.length
        },

        filters: {
          search,
          includeProgress: includeProgress === 'true',
          sortBy,
          sortOrder
        },

        summary: {
          fetchedAt: new Date(),
          totalEnrolled: enrolledInCourse.length,
          exerciseFound: true,
          exerciseName: exerciseName,
          totalMaxScore: totalMaxScore,
          passingMarks: gradeSettings?.mcqGradeToPass || gradeSettings?.programmingGradeToPass || totalMaxScore * 0.4
        }
      }
    };

    console.log(`✅ Exercise student list generated`);
    console.log(`   Total enrolled: ${enrolledInCourse.length}`);
    console.log(`   With progress: ${exerciseStatistics.studentsWithProgress}`);
    console.log(`   Pass: ${exerciseStatistics.byPassFail.pass}, Fail: ${exerciseStatistics.byPassFail.fail}`);
    console.log(`   Page ${page}: ${paginatedStudents.length} students`);

    return res.status(200).json(responseData);

  } catch (error) {
    console.error("❌ Get enrolled students for exercise error:", error);
    console.error("❌ Error stack:", error.stack);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};



// Get exercise questions with student's answers for admin/coordinator view
exports.getStudentExerciseQuestions = async (req, res) => {
  try {
    const { courseId, studentId, exerciseId } = req.params;
    const {
      includeCorrectAnswers = 'true',  // Whether to include correct answers
      includeTestCases = 'false',      // Whether to include test cases
      includeHints = 'false'           // Whether to include hints
    } = req.query;

    console.log(`👨‍🏫 Admin viewing student exercise questions`);
    console.log(`Course: ${courseId}, Student: ${studentId}, Exercise: ${exerciseId}`);

    // 1. Validate required parameters
    if (!courseId || !studentId || !exerciseId) {
      return res.status(400).json({
        success: false,
        message: "courseId, studentId, and exerciseId are required"
      });
    }

    // 2. Get student details. This handler used to run THREE separate
    // User.findById(studentId) queries for the same document (display
    // fields, then '.courses' twice more for the enrollment check and the
    // answer lookup below) — one select covering all three uses. `courses`
    // is never spread into the response (built field-by-field at the
    // bottom), so carrying it here doesn't change the payload.
    const student = await User.findById(studentId)
      .select('_id firstName lastName email profile status createdAt courses')
      .lean();

    if (!student) {
      return res.status(404).json({
        success: false,
        message: "Student not found"
      });
    }

    // 3. Get course details. Combined with the batch-scoping select below —
    // was two separate findById(courseId) queries for the same document.
    const course = await CourseStructure.findById(courseId)
      .select('courseName courseCode description ' + COURSE_BATCH_FIELDS)
      .lean();

    if (!course) {
      return res.status(404).json({
        success: false,
        message: "Course not found"
      });
    }
    const batchCourseForScan = course;

    // 4. Check if student is enrolled
    const isEnrolled = student.courses?.some(c =>
      c.courseId && c.courseId.toString() === courseId
    );

    if (!isEnrolled) {
      return res.status(404).json({
        success: false,
        message: "Student is not enrolled in this course"
      });
    }

    // 5. Find the exercise in course structure to get question details
    let exerciseDetails = null;
    let exerciseLocation = null;

    // Search in all entity types
    // ── Resources by Batch ──────────────────────────────────────────────────
    // Which batch this caller sees, and the course config that says whether
    // We Do / You Do are even batch-wise. Each node is then flattened to that
    // batch before it is searched, so the walk stays batch-agnostic and finds
    // batch-wise exercises the same way it finds shared ones.
    const scanBatchId = batchCourseForScan
      ? resolveViewerBatchId(batchCourseForScan, req.user, readRequestedBatch(req))
      : "";

    const entityModels = [
      { name: 'Module1', model: Module1 },
      { name: 'SubModule1', model: SubModule1 },
      { name: 'Topic1', model: Topic1 },
      { name: 'SubTopic1', model: SubTopic1 }
    ];

    for (const { name, model } of entityModels) {
      try {
        const entities = await model.find({ courses: courseId })
          .select('_id title pedagogy batchPedagogy')
          .lean();
        // Flatten each node to the caller's batch. Safe to mutate — these are
        // .lean() copies, not live documents.
        if (batchCourseForScan) {
          entities.forEach(e => scopeNodePedagogy(e, batchCourseForScan, scanBatchId));
        }

        for (const entity of entities) {
          if (entity.pedagogy) {
            ['I_Do', 'We_Do', 'You_Do'].forEach(section => {
              if (entity.pedagogy[section]) {
                const sectionData = entity.pedagogy[section];
                let subcategories = [];

                if (sectionData instanceof Map) {
                  subcategories = Array.from(sectionData.entries());
                } else if (typeof sectionData === 'object') {
                  subcategories = Object.entries(sectionData);
                }

                subcategories.forEach(([subcategory, exercises]) => {
                  if (!exercises) return;

                  let exercisesArray = [];
                  if (Array.isArray(exercises)) {
                    exercisesArray = exercises;
                  } else if (exercises._id) {
                    exercisesArray = [exercises];
                  }

                  const exercise = exercisesArray.find(ex =>
                    ex._id && ex._id.toString() === exerciseId
                  );

                  if (exercise) {
                    exerciseDetails = exercise;
                    exerciseLocation = {
                      entityType: name,
                      entityId: entity._id,
                      entityTitle: entity.title,
                      section,
                      subcategory,
                      fullPath: `${name}/${entity.title}/${section}/${subcategory}`
                    };
                  }
                });
              }
            });
          }
        }
        if (exerciseDetails) break;
      } catch (err) {
        console.log(`Error searching in ${name}:`, err.message);
      }
    }

    if (!exerciseDetails) {
      return res.status(404).json({
        success: false,
        message: "Exercise not found in course structure"
      });
    }


    // 6. Get student's answers for this exercise — reuses the `student` doc
    // fetched in step 2 (was a third User.findById(studentId) for the same
    // 'courses' field already selected there).
    let studentAnswers = [];
    let exerciseProgress = null;
    let foundInCategory = null;

    if (student.courses) {
      const userCourse = student.courses.find(c =>
        c.courseId && c.courseId.toString() === courseId
      );

      if (userCourse && userCourse.answers) {
        // Search through all categories
        ['I_Do', 'We_Do', 'You_Do'].forEach(category => {
          if (userCourse.answers[category]) {
            const categoryData = userCourse.answers[category];

            // Handle both Map and object formats
            let exercisesArray = [];
            if (categoryData instanceof Map) {
              const allExercises = [];
              categoryData.forEach((exArray, key) => {
                if (Array.isArray(exArray)) {
                  allExercises.push(...exArray);
                }
              });
              exercisesArray = allExercises;
            } else if (typeof categoryData === 'object') {
              exercisesArray = Object.values(categoryData).flat();
            }

            const userExercise = exercisesArray.find(ex =>
              ex.exerciseId && ex.exerciseId.toString() === exerciseId
            );

            if (userExercise) {
              studentAnswers = userExercise.questions || [];
              exerciseProgress = {
                status: userExercise.status || 'not_started',
                totalScore: userExercise.questions?.reduce((sum, q) => sum + (q.score || 0), 0) || 0,
                averageScore: userExercise.questions?.length > 0 ?
                  (userExercise.questions.reduce((sum, q) => sum + (q.score || 0), 0) / userExercise.questions.length) : 0,
                questionsAttempted: userExercise.questions?.length || 0,
                lastActivity: userExercise.updatedAt || userExercise.createdAt,
                startedAt: userExercise.createdAt,
                projectType: userExercise.projectType,
                fileCount: userExercise.questions?.[0]?.files?.length || 0,
                folderCount: userExercise.questions?.[0]?.folders?.length || 0
              };
              foundInCategory = category;
            }
          }
        });
      }
    }


    // 7. Create a map of student answers for easy lookup
    const studentAnswerMap = new Map();
    studentAnswers.forEach(answer => {
      if (answer.questionId) {
        const questionId = answer.questionId.toString ? answer.questionId.toString() : String(answer.questionId);
        studentAnswerMap.set(questionId, answer);
      }
    });

    // 8. Get exercise questions and combine with student answers
    const exerciseQuestions = exerciseDetails.questions || [];

    // MCQ questions keep their text in `mcqQuestionTitle`, programming ones in
    // `title` — reading only `title` meant every MCQ fell through to the
    // "Question N" placeholder, so the grades Question List showed
    // "Question 1, Question 2, …" instead of the actual wording, and a trainer
    // could not tell which question a mark belonged to. `mcqQuestionTitle` is
    // usually a string but can be an array of rich-content blocks (the
    // authoring UI allows both), so flatten that to plain text.
    // `mcqQuestionTitle` is an array of content blocks, each shaped
    //   { id: "cb-text-…", type: "text", value: "Which data structure …" }
    // — the wording lives in `value`. Non-text blocks (images and the like)
    // carry no wording and are skipped so they cannot inject empty strings
    // or "[object Object]" into the title.
    const blockText = (b) => {
      if (typeof b === 'string') return b;
      if (!b || (b.type && b.type !== 'text')) return '';
      return b.value ?? b.text ?? b.content ?? '';
    };
    const resolveQuestionTitle = (q, index) => {
      const raw = q.mcqQuestionTitle ?? q.title ?? q.questionTitle;
      const text = Array.isArray(raw)
        ? raw.map(blockText).filter(Boolean).join(' ').trim()
        : (typeof raw === 'string' ? raw.trim() : '');
      return text || `Question ${index + 1}`;
    };

    const questionsWithStudentAnswers = exerciseQuestions.map((question, index) => {
      const questionId = question._id?.toString();
      const studentAnswer = questionId ? studentAnswerMap.get(questionId) : null;

      // Format the question with student answer
      const formattedQuestion = {
        _id: question._id,
        sequence: question.sequence || index + 1,
        title: resolveQuestionTitle(question, index),
        description: question.description || '',
        difficulty: question.difficulty || 'medium',
        // Same split as the title above: an MCQ's per-question mark is
        // `mcqQuestionScore`, so reading only `score` fell through to the
        // default 10 and the Question List rendered "5/10" for questions
        // actually worth 5 — disagreeing with both the Manage Exercise list
        // and the 30/50 total on the Student List.
        score: Number(question.mcqQuestionScore ?? question.score) || 10,
        timeLimit: question.timeLimit || 2000,
        memoryLimit: question.memoryLimit || 256,
        isActive: question.isActive !== false,
        createdAt: question.createdAt,
        // Link questions — the admin viewer must know to show the URL
        // instead of an empty authored body.
        isLinkQuestion: question.isLinkQuestion === true,
        questionLink: question.questionLink || '',

        // Student's attempt (if any)
        studentAttempt: studentAnswer ? {
          _id: studentAnswer._id,
          questionId: studentAnswer.questionId,
          questionTitle: studentAnswer.questionTitle || question.title,

          // Code submission details
          codeAnswer: studentAnswer.codeAnswer || '',
          language: studentAnswer.language || '',

          // Multi-file project details
          files: studentAnswer.files || [],
          folders: studentAnswer.folders || [],
          projectStructure: studentAnswer.projectStructure || {},
          entryPoints: studentAnswer.entryPoints || [],
          isMultiFile: !!(studentAnswer.files && studentAnswer.files.length > 0),

          // Evaluation details
          score: studentAnswer.score || 0,
          totalScore: studentAnswer.totalScore || question.score || 10,
          percentage: studentAnswer.totalScore > 0 ?
            ((studentAnswer.score || 0) / studentAnswer.totalScore * 100).toFixed(2) :
            (question.score > 0 ? ((studentAnswer.score || 0) / question.score * 100).toFixed(2) : 0),
          isCorrect: studentAnswer.isCorrect || false,
          status: studentAnswer.status || 'attempted',
          attempts: studentAnswer.attempts || 1,
          feedback: studentAnswer.feedback || '',

          // Submission details
          submittedAt: studentAnswer.submittedAt,
          evaluatedAt: studentAnswer.evaluatedAt,
          evaluatedBy: studentAnswer.evaluatedBy,
          createdAt: studentAnswer.createdAt,
          updatedAt: studentAnswer.updatedAt
        } : null,

        // Question details (conditionally included)
        ...(includeCorrectAnswers === 'true' && {
          sampleInput: question.sampleInput || '',
          sampleOutput: question.sampleOutput || '',
          constraints: question.constraints || [],
          solutions: question.solutions || {}
        }),

        ...(includeHints === 'true' && {
          hints: question.hints || []
        }),

        ...(includeTestCases === 'true' && {
          testCases: question.testCases || []
        })
      };

      return formattedQuestion;
    });

    // 9. Calculate statistics
    const attemptedQuestions = questionsWithStudentAnswers.filter(q => q.studentAttempt).length;
    const solvedQuestions = questionsWithStudentAnswers.filter(q =>
      q.studentAttempt && (q.studentAttempt.isCorrect || q.studentAttempt.status === 'solved')
    ).length;

    const totalScoreObtained = questionsWithStudentAnswers.reduce((sum, q) =>
      sum + (q.studentAttempt?.score || 0), 0
    );

    const totalPossibleScore = questionsWithStudentAnswers.reduce((sum, q) =>
      sum + q.score, 0
    );

    const overallPercentage = totalPossibleScore > 0 ?
      (totalScoreObtained / totalPossibleScore * 100).toFixed(2) : 0;

    // 10. Prepare response
    const response = {
      success: true,
      data: {
        // Student information
        student: {
          _id: student._id,
          name: `${student.firstName} ${student.lastName || ''}`,
          email: student.email,
          profile: student.profile || '',
          status: student.status || 'active',
          enrolled: isEnrolled
        },

        // Course information
        course: {
          _id: course._id,
          name: course.courseName,
          code: course.courseCode,
          description: course.description
        },

        // Exercise information
        exercise: {
          _id: exerciseDetails._id,
          exerciseId: exerciseDetails.exerciseInformation?.exerciseId,
          name: exerciseDetails.exerciseInformation?.exerciseName || 'Unnamed Exercise',
          description: exerciseDetails.exerciseInformation?.description || '',
          level: exerciseDetails.exerciseInformation?.exerciseLevel || 'intermediate',
          totalDuration: exerciseDetails.exerciseInformation?.totalDuration || 0,
          createdAt: exerciseDetails.createdAt,

          // Location in course structure
          location: exerciseLocation,

          // Exercise settings
          programmingLanguages: exerciseDetails.programmingSettings?.selectedLanguages || [],
          practiceMode: exerciseDetails.configurationType?.practiceMode || false,
          manualEvaluation: exerciseDetails.configurationType?.manualEvaluation || false,
          availabilityPeriod: exerciseDetails.availabilityPeriod || {}
        },

        // Questions with student answers
        questions: questionsWithStudentAnswers,

        // Student's overall progress for this exercise
        studentProgress: {
          ...exerciseProgress,
          questionsAttempted: attemptedQuestions,
          questionsTotal: questionsWithStudentAnswers.length,
          questionsSolved: solvedQuestions,
          completionPercentage: questionsWithStudentAnswers.length > 0 ?
            (attemptedQuestions / questionsWithStudentAnswers.length * 100).toFixed(2) : 0,
          totalScoreObtained,
          totalPossibleScore,
          overallPercentage,
          foundInCategory
        },

        // Statistics
        statistics: {
          totalQuestions: questionsWithStudentAnswers.length,
          attemptedQuestions,
          solvedQuestions,
          pendingQuestions: questionsWithStudentAnswers.length - attemptedQuestions,
          averageScore: attemptedQuestions > 0 ? (totalScoreObtained / attemptedQuestions).toFixed(2) : 0,
          byDifficulty: {
            easy: {
              total: questionsWithStudentAnswers.filter(q => q.difficulty === 'easy').length,
              attempted: questionsWithStudentAnswers.filter(q => q.difficulty === 'easy' && q.studentAttempt).length,
              solved: questionsWithStudentAnswers.filter(q => q.difficulty === 'easy' && q.studentAttempt?.isCorrect).length
            },
            medium: {
              total: questionsWithStudentAnswers.filter(q => q.difficulty === 'medium').length,
              attempted: questionsWithStudentAnswers.filter(q => q.difficulty === 'medium' && q.studentAttempt).length,
              solved: questionsWithStudentAnswers.filter(q => q.difficulty === 'medium' && q.studentAttempt?.isCorrect).length
            },
            hard: {
              total: questionsWithStudentAnswers.filter(q => q.difficulty === 'hard').length,
              attempted: questionsWithStudentAnswers.filter(q => q.difficulty === 'hard' && q.studentAttempt).length,
              solved: questionsWithStudentAnswers.filter(q => q.difficulty === 'hard' && q.studentAttempt?.isCorrect).length
            }
          }
        },

        // Summary
        summary: {
          fetchedAt: new Date(),
          includeCorrectAnswers: includeCorrectAnswers === 'true',
          includeTestCases: includeTestCases === 'true',
          includeHints: includeHints === 'true',
          hasStudentAnswers: studentAnswers.length > 0,
          isMultiFileProject: questionsWithStudentAnswers.some(q => q.studentAttempt?.isMultiFile)
        }
      }
    };



    return res.status(200).json(response);

  } catch (error) {
    console.error("❌ Get student exercise questions error:", error);
    console.error("❌ Error stack:", error.stack);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
};


async function uploadImageToSupabase(file, folderPath) {
  try {
    // Generate unique filename
    const timestamp = Date.now();
    const sanitizedName = file.name.replace(/[^a-zA-Z0-9.]/g, '_');
    const fileName = `${timestamp}_${sanitizedName}`;
    const filePath = `question/${folderPath}/${fileName}`;

    // Upload to Supabase
    const { data, error } = await supabase.storage
      .from("smartlms")
      .upload(filePath, file.data, {
        contentType: file.mimetype,
        cacheControl: '3600',
        upsert: false
      });

    if (error) {
      throw new Error(`Supabase upload failed: ${error.message}`);
    }

    // Generate public URL
    const imageUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/smartlms/${filePath}`;

    return imageUrl;

  } catch (error) {
    console.error("❌ Image upload failed:", error);
    throw error;
  }
}
exports.addMCQQuestions = async (req, res) => {
  try {
    const { type, id, exerciseId } = req.params;
    let { tabType, subcategory, questionsData } = req.body;

    if (typeof questionsData === 'string') {
      try {
        questionsData = JSON.parse(questionsData);
      } catch (parseError) {
        console.error('❌ Failed to parse questionsData JSON:', parseError);
        return res.status(400).json({
          message: [{ key: "error", value: "Invalid questionsData format. Must be valid JSON array." }]
        });
      }
    }

    if (!type || !modelMap[type]) {
      return res.status(400).json({
        message: [{ key: "error", value: `Invalid entity type: ${type}` }]
      });
    }

    if (!Array.isArray(questionsData) || questionsData.length === 0) {
      console.error('❌ questionsData is not an array or empty:', questionsData);
      return res.status(400).json({
        message: [{ key: "error", value: "questionsData must be a non-empty array" }]
      });
    }

    // Option-based types that require mcqQuestionOptions validation
    const OPTION_BASED_TYPES = ['multiple_choice', 'multiple_select', 'dropdown', 'checkboxes'];
    // Text-based types that don't require options
    const TEXT_BASED_TYPES = ['short_answer', 'essay'];
    // Other types
    const OTHER_TYPES = ['true_false', 'numeric', 'matching', 'ordering'];

    const processedQuestions = [];

    for (let i = 0; i < questionsData.length; i++) {
      const question = questionsData[i];
      
      // Debug log to see what we're receiving
      console.log(`📝 Question ${i + 1} title type:`, typeof question.mcqQuestionTitle);
      console.log(`📝 Question ${i + 1} title value:`, question.mcqQuestionTitle);
      
      // Validate question title - Handle different data types
      let isValidTitle = false;
      let processedTitle = '';
      
      if (question.mcqQuestionTitle !== undefined && question.mcqQuestionTitle !== null) {
        if (typeof question.mcqQuestionTitle === 'string') {
          processedTitle = question.mcqQuestionTitle.trim();
          isValidTitle = processedTitle.length > 0;
        } else if (Array.isArray(question.mcqQuestionTitle)) {
          processedTitle = question.mcqQuestionTitle;
          isValidTitle = question.mcqQuestionTitle.length > 0;
        } else if (typeof question.mcqQuestionTitle === 'object') {
          // Handle object case - convert to string or use a property
          console.warn(`⚠️ Question ${i + 1}: mcqQuestionTitle is an object:`, question.mcqQuestionTitle);
          // Try to extract text from common patterns
          if (question.mcqQuestionTitle.text) {
            processedTitle = question.mcqQuestionTitle.text.trim();
          } else if (question.mcqQuestionTitle.title) {
            processedTitle = question.mcqQuestionTitle.title.trim();
          } else {
            processedTitle = JSON.stringify(question.mcqQuestionTitle);
          }
          isValidTitle = processedTitle.length > 0;
        } else if (typeof question.mcqQuestionTitle === 'number' || typeof question.mcqQuestionTitle === 'boolean') {
          // Convert numbers and booleans to string
          processedTitle = String(question.mcqQuestionTitle);
          isValidTitle = processedTitle.trim().length > 0;
        } else {
          processedTitle = String(question.mcqQuestionTitle || '').trim();
          isValidTitle = processedTitle.length > 0;
        }
      }
      
      if (!isValidTitle) {
        return res.status(400).json({
          message: [{ key: "error", value: `Question ${i + 1}: MCQ question title is required and must be a non-empty string or array` }]
        });
      }

      // Validate question type
      if (!question.mcqQuestionType) {
        return res.status(400).json({
          message: [{ key: "error", value: `Question ${i + 1}: MCQ question type is required` }]
        });
      }

      const isOptionBased = OPTION_BASED_TYPES.includes(question.mcqQuestionType);
      const isTextBased = TEXT_BASED_TYPES.includes(question.mcqQuestionType);

      // Validate options for option-based types
      if (isOptionBased) {
        if (!Array.isArray(question.mcqQuestionOptions) || question.mcqQuestionOptions.length < 2) {
          return res.status(400).json({
            message: [{ key: "error", value: `Question ${i + 1}: At least 2 options are required` }]
          });
        }

        if (!Array.isArray(question.mcqQuestionCorrectAnswers) || question.mcqQuestionCorrectAnswers.length === 0) {
          return res.status(400).json({
            message: [{ key: "error", value: `Question ${i + 1}: At least one correct answer is required` }]
          });
        }
      }

      // Process options (only for option-based types)
      let processedOptions = [];
      if (isOptionBased && Array.isArray(question.mcqQuestionOptions)) {
        processedOptions = await Promise.all(
          question.mcqQuestionOptions.map(async (option, optIndex) => {
            let imageUrl = option.imageUrl || null;

            const imageField = `question_${i}_option_${optIndex}_image`;
            const imageFile = req.files?.[imageField];

            if (imageFile) {
              try {
                imageUrl = await uploadImageToSupabase(
                  imageFile,
                  `mcq/${exerciseId}/question_${Date.now()}_option_${optIndex}`
                );
              } catch (uploadError) {
                console.error(`Error uploading image for option ${optIndex}:`, uploadError);
                return res.status(500).json({
                  message: [{ key: "error", value: `Failed to upload image for option ${optIndex + 1}` }]
                });
              }
            }

            return {
              _id: new mongoose.Types.ObjectId(),
              text: option.text || '',
              isCorrect: option.isCorrect || false,
              imageUrl: imageUrl,
              imageAlignment: option.imageAlignment || 'left',
              imageSizePercent: option.imageSizePercent || 100
            };
          })
        );
      }

      // Process question image
      let questionImageUrl = question.mcqQuestionImageUrl || null;
      const questionImageField = `question_${i}_image`;
      const questionImageFile = req.files?.[questionImageField];

      if (questionImageFile) {
        try {
          questionImageUrl = await uploadImageToSupabase(
            questionImageFile,
            `mcq/${exerciseId}/question_${Date.now()}_main`
          );
        } catch (uploadError) {
          console.error('Error uploading question image:', uploadError);
          return res.status(500).json({
            message: [{ key: "error", value: `Failed to upload image for question ${i + 1}` }]
          });
        }
      }

      // Handle mcqQuestionCorrectAnswers for ALL question types
      let correctAnswers = [];
      if (isOptionBased) {
        // For option-based types, use the provided correct answers array
        correctAnswers = question.mcqQuestionCorrectAnswers || [];
      } else if (isTextBased) {
        // For short_answer and essay, store the answer key in mcqQuestionCorrectAnswers
        if (question.mcqQuestionType === 'essay' && question.essayAnswer && typeof question.essayAnswer === 'string' && question.essayAnswer.trim()) {
          correctAnswers = [question.essayAnswer.trim()];
        } else if (question.shortAnswer && typeof question.shortAnswer === 'string' && question.shortAnswer.trim()) {
          correctAnswers = [question.shortAnswer.trim()];
        } else if (question.mcqQuestionCorrectAnswers && Array.isArray(question.mcqQuestionCorrectAnswers)) {
          correctAnswers = question.mcqQuestionCorrectAnswers;
        } else if (question.mcqQuestionCorrectAnswers && typeof question.mcqQuestionCorrectAnswers === 'string') {
          correctAnswers = [question.mcqQuestionCorrectAnswers];
        }
      } else if (question.mcqQuestionType === 'true_false') {
        // For true/false, store the boolean as string
        if (question.trueFalseAnswer !== null && question.trueFalseAnswer !== undefined) {
          correctAnswers = [String(question.trueFalseAnswer)];
        } else if (question.mcqQuestionCorrectAnswers && Array.isArray(question.mcqQuestionCorrectAnswers)) {
          correctAnswers = question.mcqQuestionCorrectAnswers;
        }
      } else if (question.mcqQuestionType === 'numeric') {
        // For numeric, store the answer as string
        if (question.numericAnswer !== null && question.numericAnswer !== undefined) {
          correctAnswers = [String(question.numericAnswer)];
        } else if (question.mcqQuestionCorrectAnswers && Array.isArray(question.mcqQuestionCorrectAnswers)) {
          correctAnswers = question.mcqQuestionCorrectAnswers;
        }
      } else if (question.mcqQuestionType === 'matching') {
        // For matching, store pairs as strings
        if (question.matchingPairs && question.matchingPairs.length > 0) {
          correctAnswers = question.matchingPairs.map(p => `${p.left}|${p.right}`);
        } else if (question.mcqQuestionCorrectAnswers && Array.isArray(question.mcqQuestionCorrectAnswers)) {
          correctAnswers = question.mcqQuestionCorrectAnswers;
        }
      } else if (question.mcqQuestionType === 'ordering') {
        // For ordering, store the correct order as strings
        if (question.orderingItems && question.orderingItems.length > 0) {
          const sorted = [...question.orderingItems].sort((a, b) => a.order - b.order);
          correctAnswers = sorted.map(item => item.text.trim());
        } else if (question.mcqQuestionCorrectAnswers && Array.isArray(question.mcqQuestionCorrectAnswers)) {
          correctAnswers = question.mcqQuestionCorrectAnswers;
        }
      } else {
        // Fallback: use provided correct answers or empty array
        correctAnswers = Array.isArray(question.mcqQuestionCorrectAnswers) 
          ? question.mcqQuestionCorrectAnswers 
          : (question.mcqQuestionCorrectAnswers ? [question.mcqQuestionCorrectAnswers] : []);
      }

      // Build base question object with properly processed title
      const processedQuestion = {
        _id: new mongoose.Types.ObjectId(),
        questionType: 'mcq',
        sectionId: question.sectionId || null,
        // Question Source tag ('scratch-manual' / 'scratch-bank' / 'ai') —
        // mirrors addQuestion; drives the source badge + per-source quotas.
        source: question.source || null,
        // Origin Question Bank doc id — mirrors addQuestion; drives
        // duplicate-import rejection.
        bankQuestionId: question.bankQuestionId || null,
        mcqQuestionTitle: processedTitle,
        mcqQuestionType: question.mcqQuestionType,
        mcqQuestionDifficulty: question.mcqQuestionDifficulty || undefined,
        mcqQuestionScore: question.mcqQuestionScore || 1,
        mcqQuestionTimeLimit: question.mcqQuestionTimeLimit || 0,
        mcqQuestionRequired: question.mcqQuestionRequired !== undefined ? question.mcqQuestionRequired : true,
        hasOtherOption: question.hasOtherOption || false,
        hasExplanation: question.hasExplanation || false,
        isActive: question.isActive !== undefined ? question.isActive : true,
        mcqQuestionOptionsPerRow: question.mcqQuestionOptionsPerRow || 1,
        mcqQuestionOptions: processedOptions,
        mcqQuestionCorrectAnswers: correctAnswers,
        mcqQuestionImageUrl: questionImageUrl,
        mcqQuestionImageAlignment: question.mcqQuestionImageAlignment || 'left',
        mcqQuestionImageSizePercent: question.mcqQuestionImageSizePercent || 100,
        sequence: 0, // updated below
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Add explanation if provided
      if (question.hasExplanation && question.mcqQuestionDescription && 
          typeof question.mcqQuestionDescription === 'string' && 
          question.mcqQuestionDescription.trim() !== '') {
        processedQuestion.mcqQuestionDescription = question.mcqQuestionDescription.trim();
      }

      // ── Type-specific answer fields (for backward compatibility) ──────────────
      if (question.mcqQuestionType === 'true_false') {
        processedQuestion.trueFalseAnswer = question.trueFalseAnswer ?? null;
      }

      if (question.mcqQuestionType === 'short_answer') {
        processedQuestion.shortAnswer = (question.shortAnswer && typeof question.shortAnswer === 'string') 
          ? question.shortAnswer.trim() 
          : '';
      }

      if (question.mcqQuestionType === 'essay') {
        // Sample/model answer used for auto-correction (word-overlap match)
        processedQuestion.essayAnswer = (question.essayAnswer && typeof question.essayAnswer === 'string')
          ? question.essayAnswer.trim()
          : ((question.shortAnswer && typeof question.shortAnswer === 'string') ? question.shortAnswer.trim() : '');
        // Keep legacy shortAnswer in sync for older readers
        processedQuestion.shortAnswer = processedQuestion.essayAnswer;
      }

      if (question.mcqQuestionType === 'numeric') {
        processedQuestion.numericAnswer = question.numericAnswer ?? null;
        processedQuestion.numericTolerance = question.numericTolerance ?? null;
      }

      if (question.mcqQuestionType === 'matching') {
        processedQuestion.matchingPairs = (question.matchingPairs || []).map(p => ({
          left: p.left || '',
          right: p.right || '',
        }));
      }

      if (question.mcqQuestionType === 'ordering') {
        processedQuestion.orderingItems = (question.orderingItems || []).map(item => ({
          text: item.text || '',
          order: item.order || 0,
        }));
      }

      processedQuestions.push(processedQuestion);
    }

    // Get model and entity
    const { model } = modelMap[type];
    if (!model) {
      return res.status(400).json({
        message: [{ key: "error", value: `Model not found for type: ${type}` }]
      });
    }

    const entity = await model.findById(id);
    if (!entity) {
      return res.status(404).json({
        message: [{ key: "error", value: `${type} with ID ${id} not found` }]
      });
    }
    // ── Resources by Batch ───────────────────────────────────────────────
    // Which I_Do/We_Do/You_Do set this request belongs to. For a shared
    // element that is the course-level `pedagogy`; for one ticked batch-wise
    // in Course Setup it is this batch's own `batchPedagogy.<batchId>`.
    // Resolving it here means every lookup and markModified below lands in
    // the right place — without it We Do and You Do would keep reading the
    // course-level set while the batch strip claimed otherwise.
    const { container: pedagogyRoot, basePath: pedagogyPath } =
      await resolvePedagogyScope(entity, tabType, req);


    if (!pedagogyRoot) {
      return res.status(404).json({
        message: [{ key: "error", value: "No pedagogy structure found in this entity" }]
      });
    }

    if (!pedagogyRoot[tabType]) {
      return res.status(404).json({
        message: [{ key: "error", value: `No ${tabType} section found in pedagogy` }]
      });
    }

    const tabData = pedagogyRoot[tabType] instanceof Map
      ? Object.fromEntries(pedagogyRoot[tabType])
      : pedagogyRoot[tabType];

    if (!tabData[subcategory]) {
      return res.status(404).json({
        message: [{ key: "error", value: `Subcategory "${subcategory}" not found in ${tabType}` }]
      });
    }

    const exercises = tabData[subcategory];

    if (!Array.isArray(exercises)) {
      return res.status(400).json({
        message: [{ key: "error", value: `Invalid exercises format in subcategory "${subcategory}"` }]
      });
    }

    const exerciseIndex = exercises.findIndex(ex =>
      ex._id?.toString() === exerciseId ||
      ex.exerciseInformation?.exerciseId === exerciseId
    );

    if (exerciseIndex === -1) {
      const availableExercises = exercises.map((ex, idx) => ({
        index: idx,
        _id: ex._id?.toString(),
        exerciseId: ex.exerciseInformation?.exerciseId,
        name: ex.exerciseInformation?.exerciseName,
        questionsCount: ex.questions?.length || 0
      }));

      return res.status(404).json({
        message: [{
          key: "error",
          value: `Exercise with ID "${exerciseId}" not found in subcategory "${subcategory}". Available exercises: ${availableExercises.length}`
        }],
        availableExercises
      });
    }

    const exercise = exercises[exerciseIndex];

    if (!exercise.questions) {
      exercise.questions = [];
    }

    // Same server-side quota + duplicate-bank gate as addQuestion — this MCQ
    // route is reachable from the assessment add-question flow, so it must
    // enforce the same rules before anything is pushed.
    const quotaError = validateQuestionQuota(exercise, processedQuestions);
    if (quotaError) {
      return res.status(400).json({
        message: [{ key: "error", value: quotaError }],
        quotaExceeded: true,
      });
    }

    const startSequence = exercise.questions.length;
    const addedQuestions = [];

    processedQuestions.forEach((question, index) => {
      question.sequence = startSequence + index;
      // Stamp creator + initial approval for query notifications & per-step gate
      question.createdBy = req.user?._id || req.user?.id || null;
      question.createdByEmail = req.user?.email || '';
      if (!question.approval) question.approval = { status: 'pending', queries: [] };
      exercise.questions.push(question);
      
      // Prepare response with safe title representation
      let responseTitle = question.mcqQuestionTitle;
      if (Array.isArray(question.mcqQuestionTitle)) {
        responseTitle = question.mcqQuestionTitle;
      } else if (typeof question.mcqQuestionTitle === 'string') {
        responseTitle = question.mcqQuestionTitle;
      } else {
        responseTitle = String(question.mcqQuestionTitle);
      }
      
      addedQuestions.push({
        questionId: question._id.toString(),
        mcqQuestionTitle: responseTitle,
        mcqQuestionType: question.mcqQuestionType,
        sequence: question.sequence,
        sectionId: question.sectionId,
        mcqQuestionCorrectAnswers: question.mcqQuestionCorrectAnswers,
        shortAnswer: question.shortAnswer,
        essayAnswer: question.essayAnswer,
        optionsCount: question.mcqQuestionOptions.length,
        mcqQuestionRequired: question.mcqQuestionRequired
      });
    });

    exercises[exerciseIndex] = exercise;

    // ── Deferred approval-notify for "settings_and_questions" scope ────────
    // Mirror of the check in the generic addQuestion handler: if the exercise
    // just crossed the completeness threshold, fire step-1 now (idempotent
    // via steps[0].notifiedAt).
    const questionAddNotify = shouldFireStep1Notification(exercise);
    if (questionAddNotify) {
      exercise.approvalWorkflow.steps[0].notifiedAt = new Date();
      entity.markModified(`${pedagogyPath}.${tabType}.${subcategory}.${exerciseIndex}.approvalWorkflow`);
    }
    if (exercise?.approvalWorkflow?.overallStatus === 'rejected') {
      exercise.approvalWorkflow.editedSinceReject = true;
      entity.markModified(`${pedagogyPath}.${tabType}.${subcategory}.${exerciseIndex}.approvalWorkflow`);
    }

    if (pedagogyRoot[tabType] instanceof Map) {
      pedagogyRoot[tabType].set(subcategory, exercises);
    } else {
      pedagogyRoot[tabType][subcategory] = exercises;
    }

    entity.markModified(`${pedagogyPath}.${tabType}.${subcategory}`);
    entity.markModified(`${pedagogyPath}.${tabType}.${subcategory}.${exerciseIndex}.questions`);
    entity.updatedAt = new Date();
    entity.updatedBy = req.user?.email || "system";

    await entity.save();

    if (questionAddNotify) {
      const courseIdForNotify = resolveCourseId(entity);
      const courseDoc = courseIdForNotify
        ? await CourseStructure.findById(courseIdForNotify).select('courseName').lean()
        : null;
      notifyApproversForStep({
        courseId: courseIdForNotify,
        courseName: courseDoc?.courseName,
        step: exercise.approvalWorkflow.steps[0],
        exerciseName: exercise.exerciseInformation?.exerciseName,
        exerciseId: exercise._id,
      }).catch((e) => console.warn('notifyApproversForStep (deferred) failed:', e.message));
    }

    const totalMCQMarks = processedQuestions.reduce((sum, q) => sum + (q.mcqQuestionScore || 0), 0);

    // Group added questions by section for response
    const addedBySection = {};
    addedQuestions.forEach(q => {
      const secId = q.sectionId || 'unassigned';
      if (!addedBySection[secId]) {
        addedBySection[secId] = [];
      }
      addedBySection[secId].push(q);
    });

    return res.status(201).json({
      success: true,
      message: `Successfully added ${addedQuestions.length} MCQ question(s)`,
      data: {
        addedQuestions,
        addedBySection,
        exercise: {
          id: exercise._id?.toString(),
          exerciseId: exercise.exerciseInformation?.exerciseId,
          exerciseName: exercise.exerciseInformation?.exerciseName,
          totalQuestions: exercise.questions.length,
          totalMCQMarks
        },
        location: {
          entityType: type,
          entityId: entity._id.toString(),
          tabType,
          subcategory,
          exerciseIndex
        }
      }
    });

  } catch (error) {
    console.error("❌ Error adding MCQ questions:", error);
    return res.status(500).json({
      success: false,
      message: [{ key: "error", value: `Internal server error: ${error.message}` }]
    });
  }
};
 

exports.updateMCQQuestion = async (req, res) => {
  try {
    const { type, id, exerciseId, questionId } = req.params;
    let { tabType, subcategory, questionData } = req.body;

    if (typeof questionData === 'string') {
      try {
        questionData = JSON.parse(questionData);
      } catch (parseError) {
        console.error('❌ Failed to parse questionData JSON:', parseError);
        return res.status(400).json({
          message: [{ key: "error", value: "Invalid questionData format. Must be valid JSON." }]
        });
      }
    }

    if (!type || !modelMap[type]) {
      return res.status(400).json({
        message: [{ key: "error", value: `Invalid entity type: ${type}` }]
      });
    }

    if (!questionId) {
      return res.status(400).json({
        message: [{ key: "error", value: "Question ID is required" }]
      });
    }

    if (!questionData || typeof questionData !== 'object') {
      return res.status(400).json({
        message: [{ key: "error", value: "questionData must be a valid object" }]
      });
    }

    if (!questionData.mcqQuestionTitle ||
      (typeof questionData.mcqQuestionTitle === 'string' && !questionData.mcqQuestionTitle.trim()) ||
      (Array.isArray(questionData.mcqQuestionTitle) && questionData.mcqQuestionTitle.length === 0)) {
      return res.status(400).json({
        message: [{ key: "error", value: "MCQ question title is required" }]
      });
    }

    if (!questionData.mcqQuestionType) {
      return res.status(400).json({
        message: [{ key: "error", value: "MCQ question type is required" }]
      });
    }

    // Option-based types that require options validation
    const OPTION_BASED_TYPES = ['multiple_choice', 'multiple_select', 'dropdown', 'checkboxes'];
    const isOptionBased = OPTION_BASED_TYPES.includes(questionData.mcqQuestionType);

    if (isOptionBased) {
      if (!Array.isArray(questionData.mcqQuestionOptions) || questionData.mcqQuestionOptions.length < 2) {
        return res.status(400).json({
          message: [{ key: "error", value: "At least 2 options are required" }]
        });
      }

      if (!Array.isArray(questionData.mcqQuestionCorrectAnswers) || questionData.mcqQuestionCorrectAnswers.length === 0) {
        return res.status(400).json({
          message: [{ key: "error", value: "At least one correct answer is required" }]
        });
      }
    }

    const { model } = modelMap[type];
    if (!model) {
      return res.status(400).json({
        message: [{ key: "error", value: `Model not found for type: ${type}` }]
      });
    }

    const entity = await model.findById(id);
    if (!entity) {
      return res.status(404).json({
        message: [{ key: "error", value: `${type} with ID ${id} not found` }]
      });
    }
    // ── Resources by Batch ───────────────────────────────────────────────
    // Which I_Do/We_Do/You_Do set this request belongs to. For a shared
    // element that is the course-level `pedagogy`; for one ticked batch-wise
    // in Course Setup it is this batch's own `batchPedagogy.<batchId>`.
    // Resolving it here means every lookup and markModified below lands in
    // the right place — without it We Do and You Do would keep reading the
    // course-level set while the batch strip claimed otherwise.
    const { container: pedagogyRoot, basePath: pedagogyPath } =
      await resolvePedagogyScope(entity, tabType, req);


    if (!pedagogyRoot) {
      return res.status(404).json({
        message: [{ key: "error", value: "No pedagogy structure found in this entity" }]
      });
    }

    if (!pedagogyRoot[tabType]) {
      return res.status(404).json({
        message: [{ key: "error", value: `No ${tabType} section found in pedagogy` }]
      });
    }

    const tabData = pedagogyRoot[tabType] instanceof Map
      ? Object.fromEntries(pedagogyRoot[tabType])
      : pedagogyRoot[tabType];

    if (!tabData[subcategory]) {
      return res.status(404).json({
        message: [{ key: "error", value: `Subcategory "${subcategory}" not found in ${tabType}` }]
      });
    }

    const exercises = tabData[subcategory];

    if (!Array.isArray(exercises)) {
      return res.status(400).json({
        message: [{ key: "error", value: `Invalid exercises format in subcategory "${subcategory}"` }]
      });
    }

    const exerciseIndex = exercises.findIndex(ex =>
      ex._id?.toString() === exerciseId ||
      ex.exerciseInformation?.exerciseId === exerciseId
    );

    if (exerciseIndex === -1) {
      return res.status(404).json({
        message: [{ key: "error", value: `Exercise with ID "${exerciseId}" not found in subcategory "${subcategory}"` }]
      });
    }

    const exercise = exercises[exerciseIndex];

    if (!exercise.questions || !Array.isArray(exercise.questions)) {
      return res.status(404).json({
        message: [{ key: "error", value: "No questions found in this exercise" }]
      });
    }

    const questionIndex = exercise.questions.findIndex(q =>
      q._id?.toString() === questionId
    );

    if (questionIndex === -1) {
      return res.status(404).json({
        message: [{ key: "error", value: `Question with ID "${questionId}" not found` }]
      });
    }

    const originalQuestion = exercise.questions[questionIndex];

    // Process options (only for option-based types)
    let processedOptions = [];
    if (isOptionBased && Array.isArray(questionData.mcqQuestionOptions)) {
      processedOptions = await Promise.all(
        questionData.mcqQuestionOptions.map(async (option, optIndex) => {
          let imageUrl = option.imageUrl || null;

          const imageField = `option_${optIndex}_image`;
          const imageFile = req.files?.[imageField];

          if (imageFile) {
            try {
              imageUrl = await uploadImageToSupabase(
                imageFile,
                `mcq/${exerciseId}/question_${questionId}_option_${optIndex}_${Date.now()}`
              );
            } catch (uploadError) {
              console.error(`Error uploading image for option ${optIndex}:`, uploadError);
              return res.status(500).json({
                message: [{ key: "error", value: `Failed to upload image for option ${optIndex + 1}` }]
              });
            }
          }

          return {
            _id: option._id || new mongoose.Types.ObjectId(),
            text: option.text || '',
            isCorrect: option.isCorrect || false,
            imageUrl: imageUrl,
            imageAlignment: option.imageAlignment || 'left',
            imageSizePercent: option.imageSizePercent || 100
          };
        })
      );
    }

    // Process question image
    let questionImageUrl = questionData.mcqQuestionImageUrl || questionData.questionImage || null;
    const questionImageFile = req.files?.questionImage;

    if (questionImageFile) {
      try {
        questionImageUrl = await uploadImageToSupabase(
          questionImageFile,
          `mcq/${exerciseId}/question_${questionId}_main_${Date.now()}`
        );
      } catch (uploadError) {
        console.error('Error uploading question image:', uploadError);
        return res.status(500).json({
          message: [{ key: "error", value: "Failed to upload question image" }]
        });
      }
    } else if (!questionImageUrl && originalQuestion.mcqQuestionImageUrl && !questionData.removeImage) {
      // Preserve existing image if not explicitly removed
      questionImageUrl = originalQuestion.mcqQuestionImageUrl;
    } else if (!questionImageUrl && originalQuestion.questionImage && !questionData.removeImage) {
      questionImageUrl = originalQuestion.questionImage;
    }

    // Build updated question
    const updatedQuestion = {
      _id: originalQuestion._id,
      questionType: 'mcq',
      sectionId: questionData.sectionId !== undefined ? questionData.sectionId : (originalQuestion.sectionId || null), // 🆕 NEW: Section update support
      // Source tag: accept a new value when sent, otherwise preserve the
      // stored one — this literal fully replaces the question (see below),
      // so omitting the field here would wipe the tag on every edit.
      source: questionData.source !== undefined ? questionData.source : (originalQuestion.source || null),
      mcqQuestionTitle: Array.isArray(questionData.mcqQuestionTitle)
        ? questionData.mcqQuestionTitle
        : (questionData.mcqQuestionTitle || '').trim(),
      mcqQuestionType: questionData.mcqQuestionType,
      mcqQuestionDifficulty: questionData.mcqQuestionDifficulty || originalQuestion.mcqQuestionDifficulty || undefined,
      mcqQuestionScore: questionData.mcqQuestionScore !== undefined ? questionData.mcqQuestionScore : (originalQuestion.mcqQuestionScore || 1),
      mcqQuestionTimeLimit: questionData.mcqQuestionTimeLimit !== undefined ? questionData.mcqQuestionTimeLimit : (originalQuestion.mcqQuestionTimeLimit || 0),
      mcqQuestionRequired: questionData.mcqQuestionRequired !== undefined
        ? questionData.mcqQuestionRequired
        : (originalQuestion.mcqQuestionRequired !== undefined ? originalQuestion.mcqQuestionRequired : true),
      hasOtherOption: questionData.hasOtherOption !== undefined ? questionData.hasOtherOption : (originalQuestion.hasOtherOption || false),
      hasExplanation: questionData.hasExplanation !== undefined ? questionData.hasExplanation : (originalQuestion.hasExplanation || false),
      isActive: questionData.isActive !== undefined ? questionData.isActive : (originalQuestion.isActive !== undefined ? originalQuestion.isActive : true),
      mcqQuestionOptionsPerRow: questionData.mcqQuestionOptionsPerRow || originalQuestion.mcqQuestionOptionsPerRow || 1,
      mcqQuestionOptions: processedOptions,
      mcqQuestionCorrectAnswers: isOptionBased ? (questionData.mcqQuestionCorrectAnswers || []) : [],
      mcqQuestionImageUrl: questionImageUrl,
      mcqQuestionImageAlignment: questionData.mcqQuestionImageAlignment || originalQuestion.mcqQuestionImageAlignment || 'left',
      mcqQuestionImageSizePercent: questionData.mcqQuestionImageSizePercent || originalQuestion.mcqQuestionImageSizePercent || 100,
      sequence: originalQuestion.sequence,
      createdAt: originalQuestion.createdAt || new Date(),
      updatedAt: new Date(),
    };

    // Explanation
    if (updatedQuestion.hasExplanation && questionData.mcqQuestionDescription && questionData.mcqQuestionDescription.trim() !== '') {
      updatedQuestion.mcqQuestionDescription = questionData.mcqQuestionDescription.trim();
    }

    // ── Type-specific answer fields ──────────────────────────────────────────
    if (questionData.mcqQuestionType === 'true_false') {
      updatedQuestion.trueFalseAnswer = questionData.trueFalseAnswer !== undefined
        ? questionData.trueFalseAnswer
        : (originalQuestion.trueFalseAnswer ?? null);
    }

    if (questionData.mcqQuestionType === 'short_answer') {
      updatedQuestion.shortAnswer = questionData.shortAnswer !== undefined
        ? questionData.shortAnswer
        : (originalQuestion.shortAnswer || '');
    }

    if (questionData.mcqQuestionType === 'essay') {
      updatedQuestion.essayAnswer = questionData.essayAnswer !== undefined
        ? questionData.essayAnswer
        : (originalQuestion.essayAnswer || originalQuestion.shortAnswer || '');
      // Keep legacy shortAnswer in sync for older readers
      updatedQuestion.shortAnswer = updatedQuestion.essayAnswer;
    }

    if (questionData.mcqQuestionType === 'numeric') {
      updatedQuestion.numericAnswer = questionData.numericAnswer !== undefined
        ? questionData.numericAnswer
        : (originalQuestion.numericAnswer ?? null);
      updatedQuestion.numericTolerance = questionData.numericTolerance !== undefined
        ? questionData.numericTolerance
        : (originalQuestion.numericTolerance ?? null);
    }

    if (questionData.mcqQuestionType === 'matching') {
      updatedQuestion.matchingPairs = Array.isArray(questionData.matchingPairs)
        ? questionData.matchingPairs.map(p => ({ left: p.left || '', right: p.right || '' }))
        : (originalQuestion.matchingPairs || []);
    }

    if (questionData.mcqQuestionType === 'ordering') {
      updatedQuestion.orderingItems = Array.isArray(questionData.orderingItems)
        ? questionData.orderingItems.map(item => ({ text: item.text || '', order: item.order || 0 }))
        : (originalQuestion.orderingItems || []);
    }

    // Preserve approval-workflow bookkeeping across the update — the
    // rewrite of `updatedQuestion` above doesn't spread `originalQuestion`,
    // so `approval` / `createdBy` would be wiped otherwise. That would also
    // reset a rejected question's status to `pending` on every edit, which
    // is not what we want. Instead:
    //   - Carry `approval` (with rejection state) forward.
    //   - Flip `editedSinceReject` when saving into a rejected question so
    //     the approver's UI re-opens Approve/Reject on the row.
    //   - Same-shape carry-over for `createdBy` / `createdByEmail`.
    const origApproval = (originalQuestion && originalQuestion.approval)
      ? (originalQuestion.approval.toObject ? originalQuestion.approval.toObject() : { ...originalQuestion.approval })
      : { status: 'pending', queries: [] };
    if (origApproval.status === 'rejected') {
      origApproval.editedSinceReject = true;
    }
    updatedQuestion.approval = origApproval;
    if (originalQuestion?.createdBy && !updatedQuestion.createdBy) {
      updatedQuestion.createdBy = originalQuestion.createdBy;
    }
    if (originalQuestion?.createdByEmail && !updatedQuestion.createdByEmail) {
      updatedQuestion.createdByEmail = originalQuestion.createdByEmail;
    }

    // Update in array
    exercise.questions[questionIndex] = updatedQuestion;
    exercises[exerciseIndex] = exercise;

    if (pedagogyRoot[tabType] instanceof Map) {
      pedagogyRoot[tabType].set(subcategory, exercises);
    } else {
      pedagogyRoot[tabType][subcategory] = exercises;
    }

    entity.markModified(`${pedagogyPath}.${tabType}.${subcategory}`);
    entity.markModified(`${pedagogyPath}.${tabType}.${subcategory}.${exerciseIndex}.questions.${questionIndex}`);
    entity.updatedAt = new Date();
    entity.updatedBy = req.user?.email || "system";

    await entity.save();

    const totalMCQMarks = exercise.questions
      .filter(q => q.questionType === 'mcq')
      .reduce((sum, q) => sum + (q.mcqQuestionScore || 0), 0);

    return res.status(200).json({
      success: true,
      message: "MCQ question updated successfully",
      data: {
        updatedQuestion: {
          questionId: updatedQuestion._id.toString(),
          mcqQuestionTitle: updatedQuestion.mcqQuestionTitle,
          mcqQuestionType: updatedQuestion.mcqQuestionType,
          mcqQuestionDifficulty: updatedQuestion.mcqQuestionDifficulty,
          mcqQuestionScore: updatedQuestion.mcqQuestionScore,
          mcqQuestionRequired: updatedQuestion.mcqQuestionRequired,
          isActive: updatedQuestion.isActive,
          sequence: updatedQuestion.sequence,
          sectionId: updatedQuestion.sectionId, // 🆕 Include sectionId in response
          optionsCount: updatedQuestion.mcqQuestionOptions.length
        },
        exercise: {
          id: exercise._id?.toString(),
          exerciseId: exercise.exerciseInformation?.exerciseId,
          exerciseName: exercise.exerciseInformation?.exerciseName,
          totalQuestions: exercise.questions.length,
          totalMCQMarks
        },
        location: {
          entityType: type,
          entityId: entity._id.toString(),
          tabType,
          subcategory,
          exerciseIndex,
          questionIndex
        }
      }
    });

  } catch (error) {
    console.error("❌ Error updating MCQ question:", error);
    return res.status(500).json({
      success: false,
      message: [{ key: "error", value: `Internal server error: ${error.message}` }]
    });
  }
};

exports.deleteMCQQuestion = async (req, res) => {
  try {
    const { type, id, exerciseId, questionId } = req.params;
    const { tabType, subcategory } = req.body;

    // ── 1. Validate entity type ───────────────────────────────────────────────
    if (!type || !modelMap[type]) {
      return res.status(400).json({
        success: false,
        message: [{ key: "error", value: `Invalid entity type: ${type}` }]
      });
    }

    if (!questionId) {
      return res.status(400).json({
        success: false,
        message: [{ key: "error", value: "Question ID is required" }]
      });
    }

    if (!tabType || !subcategory) {
      return res.status(400).json({
        success: false,
        message: [{ key: "error", value: `tabType and subcategory are required. Received: tabType="${tabType}", subcategory="${subcategory}"` }]
      });
    }

    // ── 2. Find the entity ────────────────────────────────────────────────────
    const { model } = modelMap[type];
    const entity = await model.findById(id);

    if (!entity) {
      return res.status(404).json({
        success: false,
        message: [{ key: "error", value: `${type} with ID ${id} not found` }]
      });
    }
    // ── Resources by Batch ───────────────────────────────────────────────
    // Which I_Do/We_Do/You_Do set this request belongs to. For a shared
    // element that is the course-level `pedagogy`; for one ticked batch-wise
    // in Course Setup it is this batch's own `batchPedagogy.<batchId>`.
    // Resolving it here means every lookup and markModified below lands in
    // the right place — without it We Do and You Do would keep reading the
    // course-level set while the batch strip claimed otherwise.
    const { container: pedagogyRoot, basePath: pedagogyPath } =
      await resolvePedagogyScope(entity, tabType, req);


    if (!pedagogyRoot) {
      return res.status(404).json({
        success: false,
        message: [{ key: "error", value: "No pedagogy data found on this entity" }]
      });
    }

    if (!pedagogyRoot[tabType]) {
      return res.status(404).json({
        success: false,
        message: [{ key: "error", value: `tabType "${tabType}" not found in pedagogy` }]
      });
    }

    // ── 3. Handle Mongoose Map — MUST use .get() not bracket access ───────────
    const tabSection = pedagogyRoot[tabType];
    const isMap = tabSection instanceof Map;

    // Get actual subcategory keys for error messages
    const availableKeys = isMap
      ? Array.from(tabSection.keys())
      : Object.keys(tabSection);

    // Get the exercises array using .get() for Map, bracket for plain object
    const exercises = isMap
      ? tabSection.get(subcategory)
      : tabSection[subcategory];

    if (!exercises) {
      return res.status(404).json({
        success: false,
        message: [{
          key: "error",
          value: `subcategory "${subcategory}" not found under tabType "${tabType}". Available keys: [${availableKeys.join(', ')}]`
        }]
      });
    }

    if (!Array.isArray(exercises)) {
      return res.status(400).json({
        success: false,
        message: [{ key: "error", value: `Expected array at pedagogy.${tabType}.${subcategory}, got ${typeof exercises}` }]
      });
    }

    // ── 4. Find the exercise ──────────────────────────────────────────────────
    const exerciseIndex = exercises.findIndex(ex =>
      ex._id?.toString() === exerciseId ||
      ex.exerciseInformation?.exerciseId === exerciseId
    );

    if (exerciseIndex === -1) {
      return res.status(404).json({
        success: false,
        message: [{ key: "error", value: `Exercise "${exerciseId}" not found` }]
      });
    }

    const exercise = exercises[exerciseIndex];

    // ── 5. Find and remove the question ──────────────────────────────────────
    if (!Array.isArray(exercise.questions)) {
      return res.status(400).json({
        success: false,
        message: [{ key: "error", value: "Exercise has no questions array" }]
      });
    }

    const questionIndex = exercise.questions.findIndex(q =>
      q._id?.toString() === questionId
    );

    if (questionIndex === -1) {
      return res.status(404).json({
        success: false,
        message: [{ key: "error", value: `Question "${questionId}" not found in this exercise` }]
      });
    }

    // 🆕 Get section info before deleting for response
    const deletedQuestionSection = exercise.questions[questionIndex].sectionId || null;

    exercise.questions.splice(questionIndex, 1);
    exercise.questions.forEach((q, idx) => { q.sequence = idx; });

    // ── 6. Save back — must use .set() for Mongoose Map ──────────────────────
    exercises[exerciseIndex] = exercise;

    if (isMap) {
      pedagogyRoot[tabType].set(subcategory, exercises);
    } else {
      pedagogyRoot[tabType][subcategory] = exercises;
    }

    entity.markModified(`${pedagogyPath}.${tabType}`);
    entity.updatedAt = new Date();
    entity.updatedBy = req.user?.email || "system";

    await entity.save();

    return res.status(200).json({
      success: true,
      message: "MCQ question deleted successfully",
      data: {
        exerciseId,
        questionId,
        deletedFromSection: deletedQuestionSection, // 🆕 Include which section it was deleted from
        remainingQuestions: exercise.questions.length
      }
    });

  } catch (error) {
    console.error("❌ Error deleting MCQ question:", error);
    return res.status(500).json({
      success: false,
      message: [{ key: "error", value: `Internal server error: ${error.message}` }]
    });
  }
};

// ─── Upload question image directly to Supabase ───────────────────────────────
exports.uploadQuestionImage = async (req, res) => {
  try {
    const file = req.files?.image;
    if (!file) {
      return res.status(400).json({ success: false, message: 'No image file provided' });
    }
    const url = await uploadImageToSupabase(file, `mcq/question-images`);
    return res.status(200).json({ success: true, url });
  } catch (error) {
    console.error('❌ Error uploading question image:', error);
    return res.status(500).json({ success: false, message: 'Failed to upload image' });
  }
};

// ─── Upload question file attachment to Supabase ──────────────────────────────
exports.uploadQuestionFile = async (req, res) => {
  try {
    const file = req.files?.file;
    if (!file) {
      return res.status(400).json({ success: false, message: 'No file provided' });
    }

    const ALLOWED_MIME_TYPES = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'text/plain',
      'text/csv',
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
    ];

    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      return res.status(400).json({ success: false, message: 'File type not allowed' });
    }

    const MAX_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB
    if (file.size > MAX_SIZE_BYTES) {
      return res.status(400).json({ success: false, message: 'File too large (max 20 MB)' });
    }

    const timestamp = Date.now();

    // ── Always derive the extension from the MIME type (not from the filename).
    // Filenames can arrive mangled (spaces, encoding quirks, wrong extension) but
    // the browser MIME type is always reliable.
    const MIME_TO_EXT = {
      'application/pdf': '.pdf',
      'application/msword': '.doc',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
      'application/vnd.ms-excel': '.xls',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
      'application/vnd.ms-powerpoint': '.ppt',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
      'text/plain': '.txt',
      'text/csv': '.csv',
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'video/mp4': '.mp4',
      'video/quicktime': '.mov',
      'application/zip': '.zip',
      'application/x-zip-compressed': '.zip',
    };

    const correctExt = MIME_TO_EXT[file.mimetype] || path.extname(file.name || '').toLowerCase() || '';
    // Strip the (potentially wrong) extension from the original name, keep only the stem
    const rawStem = path.basename(file.name || 'upload', path.extname(file.name || ''));
    const cleanStem = rawStem.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').slice(0, 100);
    const cleanName = cleanStem + correctExt;           // e.g. "ProblemStatementsforReact.docx"
    const fileName = `${timestamp}_${cleanName}`;
    const filePath = `question/others/attachments/${fileName}`;

    const { error } = await supabase.storage
      .from('smartlms')
      .upload(filePath, file.data, {
        contentType: file.mimetype,
        cacheControl: '3600',
        upsert: false,
      });

    if (error) {
      throw new Error(`Supabase upload failed: ${error.message}`);
    }

    const url = `${process.env.SUPABASE_URL}/storage/v1/object/public/smartlms/${filePath}`;
    // Return cleanName (correct extension) — NOT file.name which may be mangled
    return res.status(200).json({ success: true, url, name: cleanName, mimeType: file.mimetype });
  } catch (error) {
    console.error('❌ Error uploading question file:', error);
    return res.status(500).json({ success: false, message: 'Failed to upload file' });
  }
};



exports.addYouDoExercise = async (req, res) => {
  try {
    const { type, id } = req.params;
    const {
      tabType,
      subcategory,
      exerciseType,
      exerciseInformation,
      availabilityPeriod,
      questionConfiguration,
      notificationSettings,
      gradeSettings,
      additionalOptions,
      isSectionBased,
      sections,
      sectionConfigs,
      questions = [],
      securitySettings,  // ← Add securitySettings to destructuring
      selectedTopics,    // ← Select Assessment Content step: topics covered
      instructions,      // ← Select Assessment Content step: instructions
      // Question Source step (parity with the generic addExercise) — without
      // these, a You_Do assessment created via this endpoint silently dropped
      // the source config until the first updateYouDoExercise call.
      questionSource,
      customDistribution,
      customSources,
      // Section-based Custom mix: per-section split keyed by sectionId.
      customDistributionBySection,
      saveToBank,
      stepsSaved,
      isGraded,
      // Combined-only: MCQ part's own source + single-cell Custom split.
      questionSourceMcq,
      customSourcesMcq,
      customDistributionMcq,
      // Evaluation Method — { method: 'testcase' | 'ai' }.
      evaluationMethod,
    } = req.body;

    // ── Helper: parse JSON strings if needed (MUST be defined FIRST) ──────
    const parseIfNeeded = (data) => {
      if (typeof data === 'string') {
        try { return JSON.parse(data); } catch { return data; }
      }
      return data;
    };

    // ── Transform description fields ──────────────────────────────────────
    const transformExerciseInfo = (info) => {
      if (!info) return info;
      const t = { ...info };
      if (t.description && typeof t.description === 'object' && t.description.text !== undefined) {
        t.description = t.description.text;
      }
      return t;
    };

    // ── Parse all incoming data (NOW parseIfNeeded is defined) ─────────────
    let exerciseTypeParsed = parseIfNeeded(exerciseType);
    let exerciseInfo = transformExerciseInfo(parseIfNeeded(exerciseInformation));
    let availPeriod = parseIfNeeded(availabilityPeriod) || {};
    let quesConfig = parseIfNeeded(questionConfiguration) || {};
    let notifSettings = parseIfNeeded(notificationSettings) || {};
    let gradeSettingsRaw = parseIfNeeded(gradeSettings) || {};
    let additOptions = parseIfNeeded(additionalOptions) || {};
    let securitySettingsData = parseIfNeeded(securitySettings) || {};  // ← Now safe to use

    // ── Validate entity type ───────────────────────────────────────────────
    if (!modelMap[type]) {
      return res.status(400).json({
        message: [{ key: 'error', value: `Invalid entity type: ${type}` }]
      });
    }

    if (!subcategory) {
      return res.status(400).json({
        message: [{ key: 'error', value: "Subcategory is required." }]
      });
    }

    // ── Basic validation ──────────────────────────────────────────────────
    if (!exerciseInfo || !exerciseInfo.exerciseName) {
      return res.status(400).json({
        message: [{ key: 'error', value: 'Exercise name is required' }]
      });
    }

    // ── Find entity ───────────────────────────────────────────────────────
    const { model } = modelMap[type];
    const entity = await model.findById(id);

    if (!entity) {
      return res.status(404).json({
        message: [{ key: 'error', value: `${type} with ID ${id} not found` }]
      });
    }

    // ── Initialize pedagogy structure ─────────────────────────────────────
    // (The container is created by resolvePedagogyScope above — it is the one
    // place that decides whether that is `pedagogy` or a batch's own bucket.)

    const tabKey = tabType === 'I_Do' ? 'I_Do' : tabType === 'We_Do' ? 'We_Do' : 'You_Do';
    // ── Resources by Batch ───────────────────────────────────────────────
    // Which I_Do/We_Do/You_Do set this request belongs to. For a shared
    // element that is the course-level `pedagogy`; for one ticked batch-wise
    // in Course Setup it is this batch's own `batchPedagogy.<batchId>`.
    // Resolving it here means every lookup and markModified below lands in
    // the right place — without it We Do and You Do would keep reading the
    // course-level set while the batch strip claimed otherwise.
    const { container: pedagogyRoot, basePath: pedagogyPath } =
      await resolvePedagogyScope(entity, tabKey, req);


    if (!pedagogyRoot[tabKey]) {
      pedagogyRoot[tabKey] = new Map();
    }

    let exercises = pedagogyRoot[tabKey].has(subcategory)
      ? pedagogyRoot[tabKey].get(subcategory)
      : [];

    // ── Generate exercise ID ───────────────────────────────────────────────
    const generateExerciseId = () =>
      `EX${(exercises.length + 1).toString().padStart(3, '0')}`;

    const exerciseId = exerciseInfo.exerciseId || generateExerciseId();

    // ── Configuration type flags ──────────────────────────────────────────
    const configTypeSettings = {
      mcqMode: exerciseTypeParsed === 'MCQ' || exerciseTypeParsed === 'Combined',
      programmingMode: exerciseTypeParsed === 'Programming' || exerciseTypeParsed === 'Combined',
      combinedMode: exerciseTypeParsed === 'Combined',
      otherMode: exerciseTypeParsed === 'Other',
      sectionBased: isSectionBased === true,
    };

    // ── Build MCQ config ───────────────────────────────────────────────────
    const buildMCQConfig = (mcqCfg) => {
      if (!mcqCfg) return { cfg: null, total: 0 };

      const scoreType = mcqCfg.scoreSettings?.scoreType || 'equalDistribution';
      let marksPerQuestion = 0;
      let total = 0;

      if (scoreType === 'equalDistribution') {
        marksPerQuestion = mcqCfg.scoreSettings?.equalDistribution || 0;
        total = (mcqCfg.generalQuestionCount || 0) * marksPerQuestion;
      } else {
        total = mcqCfg.scoreSettings?.totalMarks || 0;
      }

      return {
        cfg: {
          totalMcqQuestions: mcqCfg.generalQuestionCount || 0,
          marksPerQuestion,
          mcqTotalMarks: total,
          attemptLimitEnabled: mcqCfg.attemptLimitEnabled || false,
          submissionAttempts: mcqCfg.submissionAttempts || 1,
          shuffleQuestions: true,
          scoringType: scoreType,
        },
        total,
      };
    };

    // ── Build Programming config ───────────────────────────────────────────
    const buildProgConfig = (progCfg) => {
      if (!progCfg) return { cfg: null, total: 0 };

      const qConfigType = progCfg.questionConfigType || 'general';
      let total = 0;

      if (qConfigType === 'general') {
        const evenMarks = progCfg.scoreSettings?.equalDistribution || 0;
        total = (progCfg.generalQuestionCount || 0) * evenMarks;
      } else if (qConfigType === 'levelBased' || qConfigType === 'selectionLevel') {
        const counts = qConfigType === 'selectionLevel'
          ? progCfg.selectionLevelCounts
          : progCfg.levelBasedCounts;
        const levelScoring = progCfg.scoreSettings?.levelScoringConfiguration;

        if (levelScoring) {
          ['easy', 'medium', 'hard'].forEach(l => {
            const c = counts?.[l] || 0;
            if (!c) return;
            const s = levelScoring[l];
            if (!s) return;
            if (s.type === 'level_specific' && s.marksPerQuestion) {
              total += c * s.marksPerQuestion;
            } else if (s.type === 'question_specific' && s.totalMarks) {
              total += s.totalMarks;
            }
          });
        }
      }

      let backendScoreType = 'evenMarks';
      if (qConfigType === 'levelBased' || qConfigType === 'selectionLevel') {
        backendScoreType = 'levelBasedMarks';
      } else {
        switch (progCfg.scoreSettings?.scoreType) {
          case 'equalDistribution': backendScoreType = 'evenMarks'; break;
          case 'questionSpecific': backendScoreType = 'separateMarks'; break;
          default: backendScoreType = progCfg.scoreSettings?.scoreType || 'evenMarks';
        }
      }

      const cfg = {
        questionConfigType: qConfigType,
        attemptLimitEnabled: progCfg.attemptLimitEnabled || false,
        submissionAttempts: progCfg.submissionAttempts || 1,
        questionFlow: progCfg.questionFlow || 'freeFlow',
        allowCodeExecution: true,
        enableTestCases: true,
        showSampleCases: true,
        scoreSettings: {
          scoreType: backendScoreType,
          evenMarks: progCfg.scoreSettings?.equalDistribution || 0,
          levelBasedMarks: progCfg.scoreSettings?.levelBasedMarks || { easy: 0, medium: 0, hard: 0 },
          levelScoringConfiguration: progCfg.scoreSettings?.levelScoringConfiguration,
          totalMarks: total,
        },
      };

      if (qConfigType === 'general') {
        cfg.generalQuestionCount = progCfg.generalQuestionCount || 0;
      } else if (qConfigType === 'levelBased') {
        cfg.levelBasedCounts = progCfg.levelBasedCounts || { easy: 0, medium: 0, hard: 0 };
      } else if (qConfigType === 'selectionLevel') {
        cfg.selectionLevelCounts = progCfg.selectionLevelCounts || { easy: 0, medium: 0, hard: 0 };
      }

      return { cfg, total };
    };

    // ── Build Others config ─────────────────────────────────────────────────
    const buildOthersConfig = (othersCfg) => {
      if (!othersCfg) return { cfg: null, total: 0 };

      const qConfigType = othersCfg.questionConfigType || 'general';
      let total = 0;

      if (qConfigType === 'general') {
        const evenMarks = othersCfg.scoreSettings?.equalDistribution || othersCfg.generalMarksPerQuestion || 0;
        total = (othersCfg.generalQuestionCount || 0) * evenMarks;
      } else if (qConfigType === 'levelBased' || qConfigType === 'selectionLevel') {
        const counts = qConfigType === 'selectionLevel'
          ? othersCfg.selectionLevelCounts
          : othersCfg.levelBasedCounts;
        const levelScoring = othersCfg.scoreSettings?.levelScoringConfiguration;

        if (levelScoring) {
          ['easy', 'medium', 'hard'].forEach(l => {
            const c = counts?.[l] || 0;
            if (!c) return;
            const s = levelScoring[l];
            if (!s) return;
            if (s.type === 'level_specific' && s.marksPerQuestion) {
              total += c * s.marksPerQuestion;
            } else if (s.type === 'question_specific' && s.totalMarks) {
              total += s.totalMarks;
            }
          });
        }
      }

      const cfg = {
        questionConfigType: qConfigType,
        attemptLimitEnabled: othersCfg.attemptLimitEnabled || false,
        submissionAttempts: othersCfg.submissionAttempts || 1,
        questionFlow: othersCfg.questionFlow || 'freeFlow',
        scoreSettings: {
          scoreType: qConfigType === 'general' ? 'evenMarks' : 'levelBasedMarks',
          evenMarks: othersCfg.scoreSettings?.equalDistribution || othersCfg.generalMarksPerQuestion || 0,
          levelBasedMarks: othersCfg.scoreSettings?.levelBasedMarks || { easy: 0, medium: 0, hard: 0 },
          levelScoringConfiguration: othersCfg.scoreSettings?.levelScoringConfiguration,
          totalMarks: total,
        },
      };

      if (qConfigType === 'general') {
        cfg.generalQuestionCount = othersCfg.generalQuestionCount || 0;
      } else if (qConfigType === 'levelBased') {
        cfg.levelBasedCounts = othersCfg.levelBasedCounts || { easy: 0, medium: 0, hard: 0 };
      } else if (qConfigType === 'selectionLevel') {
        cfg.selectionLevelCounts = othersCfg.selectionLevelCounts || { easy: 0, medium: 0, hard: 0 };
      }

      return { cfg, total };
    };

    // ── Extract MCQ/Programming/Others configs ─────────────────────────────
    let mcqQuestionConfig = null;
    let programmingQuestionConfig = null;
    let othersQuestionConfig = null;
    let mcqTotalMarks = 0;
    let progTotalMarks = 0;

    if (quesConfig.mcqConfig) {
      const { cfg, total } = buildMCQConfig(quesConfig.mcqConfig);
      mcqQuestionConfig = cfg;
      mcqTotalMarks = total;
    }

    if (quesConfig.programmingConfig) {
      const { cfg, total } = buildProgConfig(quesConfig.programmingConfig);
      programmingQuestionConfig = cfg;
      progTotalMarks = total;
    }

    if (quesConfig.othersQuestionConfiguration || quesConfig.othersConfig) {
      const othersCfg = quesConfig.othersQuestionConfiguration || quesConfig.othersConfig;
      const { cfg, total } = buildOthersConfig(othersCfg);
      othersQuestionConfig = cfg;
      progTotalMarks = total;
    }

    // ── Build availabilityPeriod ───────────────────────────────────────────
    const buildAvailabilityPeriod = (period) => {
      const parseDate = (dateObj) => {
        if (!dateObj) return null;
        // The client now sends ISO instant strings; keep object support for
        // backwards-compatibility with older payloads.
        if (typeof dateObj === 'string') {
          const d = new Date(dateObj);
          return isNaN(d.getTime()) ? null : d;
        }
        if (!dateObj.year || !dateObj.month || !dateObj.day) return null;
        return new Date(
          dateObj.year,
          dateObj.month - 1,
          dateObj.day,
          dateObj.hour || 0,
          dateObj.minute || 0
        );
      };

      const startDate = parseDate(period.startDate);
      const endDate = parseDate(period.endDate);
      const cutOffDate = period.cutOffEnabled ? parseDate(period.cutOffDate) : null;
      const gracePeriodDate = period.gracePeriodEnabled ? parseDate(period.gracePeriodDate) : null;

      return {
        startDate,
        endDate,
        cutOffDate,
        cutOffEnabled: period.cutOffEnabled || false,
        gracePeriodAllowed: period.gracePeriodEnabled || false,
        gracePeriodEnabled: period.gracePeriodEnabled || false,
        gracePeriodDate,
        extendedDays: period.extendedDays || 0,
        requiresAdminApproval: !!period.requiresAdminApproval,
        approvalScope: period.approvalScope === 'settings_and_questions' ? 'settings_and_questions' : 'settings',
      };
    };

    const availabilityPeriodData = buildAvailabilityPeriod(availPeriod);

    // ── Build approvalWorkflow (when staff turned on Requires Approval) ────
    // Snapshot the parent course's approvalHierarchy.steps so subsequent
    // changes to the course-level template don't disrupt this assessment.
    let approvalWorkflowData = null;
    if (availabilityPeriodData.requiresAdminApproval) {
      const courseIdForWorkflow = resolveCourseId(entity);
      approvalWorkflowData = await buildInitialApprovalWorkflow(courseIdForWorkflow);
      if (!approvalWorkflowData) {
        return res.status(400).json({
          message: [{
            key: 'error',
            value: 'Approval is required for this assessment, but no approver could be resolved — the course has no Approval Hierarchy and the institution has no L&D role to default to. Configure the hierarchy on the Approvals page first.'
          }]
        });
      }
    }

    // ── Build notificationSettings ─────────────────────────────────────────
    const notificationSettingsData = {
      notifyUsers: notifSettings.notifyUsers || false,
      notifyGmail: notifSettings.notifyGmail || false,
      notifyWhatsApp: notifSettings.notifyWhatsApp || false,
      gradeSheet: notifSettings.gradeSheet !== undefined ? notifSettings.gradeSheet : true,
      notifyGradersSubmissions: notifSettings.notifyGradersSubmissions || false,
      notifyGradersLateSubmissions: notifSettings.notifyGradersLateSubmissions || false,
      notifyStudent: notifSettings.notifyStudent !== undefined ? notifSettings.notifyStudent : true,
    };

    // ── Build gradeSettings ────────────────────────────────────────────────
    const totalMarksForMCQ = exerciseTypeParsed === 'MCQ' || exerciseTypeParsed === 'Combined'
      ? (exerciseInfo.totalMarksMCQ || mcqTotalMarks)
      : 0;
    const totalMarksForProg = exerciseTypeParsed === 'Programming' || exerciseTypeParsed === 'Other' || exerciseTypeParsed === 'Combined'
      ? (exerciseInfo.totalMarksProgramming || progTotalMarks)
      : 0;
    const totalMarksCombined = totalMarksForMCQ + totalMarksForProg;

    const gradeSettingsData = {
      mcqGrade: totalMarksForMCQ > 0 ? totalMarksForMCQ : null,
      mcqGradeToPass: gradeSettingsRaw.mcqGradeToPass || null,
      programmingGrade: totalMarksForProg > 0 ? totalMarksForProg : null,
      programmingGradeToPass: gradeSettingsRaw.programmingGradeToPass || null,
      combinedGrade: totalMarksCombined > 0 ? totalMarksCombined : null,
      combinedGradeToPass: gradeSettingsRaw.combinedGradeToPass || null,
      separateMarks: gradeSettingsRaw.separateMarks || false,
      // Grade-level "Section Based" split (toggle + per-part total/pass marks).
      sectionBased: gradeSettingsRaw.sectionBased || false,
      sections: Array.isArray(gradeSettingsRaw.sections) ? gradeSettingsRaw.sections : [],
      sectionPassMarks: gradeSettingsRaw.sectionPassMarks || {},
      // Grade bands (labelled % ranges) — passed through untouched when provided.
      gradeBands: Array.isArray(gradeSettingsRaw.gradeBands) ? gradeSettingsRaw.gradeBands : undefined,
    };

    // ── Build additionalOptions ────────────────────────────────────────────
    const additionalOptionsData = {
      anonymousSubmissions: additOptions.anonymousSubmissions || false,
      hideGraderIdentity: additOptions.hideGraderIdentity || false,
    };

    // ── Assemble the new exercise document ─────────────────────────────────
    const totalMarksForInfo = isSectionBased
      ? (exerciseInfo.totalMarks || 0)
      : exerciseTypeParsed === 'Combined'
        ? totalMarksCombined
        : (exerciseInfo.totalMarks || progTotalMarks || mcqTotalMarks);

    const newExercise = {
      _id: new mongoose.Types.ObjectId(),
      exerciseType: exerciseTypeParsed,
      isGraded: isGraded !== false,
      stepsSaved: Array.isArray(stepsSaved) ? stepsSaved : [],
      configurationType: configTypeSettings,
      // Question Source step — same shape addExercise persists.
      questionSource: questionSource || null,
      customDistribution: customDistribution || null,
      customSources: Array.isArray(customSources) ? customSources : [],
      // Section-based Custom mix's per-section split — parity with the other
      // add path so a You_Do assessment created here doesn't drop the field.
      customDistributionBySection: customDistributionBySection && typeof customDistributionBySection === 'object'
        ? customDistributionBySection
        : {},
      saveToBank: !!saveToBank,
      // Combined-only MCQ-part source (null = inherit questionSource).
      questionSourceMcq: questionSourceMcq || null,
      customSourcesMcq: Array.isArray(customSourcesMcq) ? customSourcesMcq : [],
      customDistributionMcq: customDistributionMcq || null,
      // Evaluation Method config ({ method }). null when the client didn't
      // send one — downstream reads that as test-case based.
      evaluationMethod: parseIfNeeded(evaluationMethod) || null,
      isSectionBased: isSectionBased || false,
      sections: sections || [],
      sectionConfigs: sectionConfigs || {},

      exerciseInformation: {
        exerciseId: exerciseId,
        exerciseName: exerciseInfo.exerciseName || '',
        testType: exerciseInfo.testType || 'mock',
        description: exerciseInfo.description || '',
        exerciseLevel: exerciseInfo.exerciseLevel || 'intermediate',
        exerciseType: exerciseInfo.exerciseType || exerciseTypeParsed || '',
        totalDuration: exerciseInfo.totalDuration || 1,
        totalMarksMCQ: totalMarksForMCQ,
        totalMarksProgramming: totalMarksForProg,
        totalMarks: totalMarksForInfo,
        selectedModule: exerciseInfo.selectedModule || '',
        selectedLanguages: exerciseInfo.selectedLanguages || [],
        isSectionBased: exerciseInfo.isSectionBased || isSectionBased || false,
        sectionBasedDuration: exerciseInfo.sectionBasedDuration || false,
      },

      securitySettings: securitySettingsData,  // ← Add security settings
      questionConfiguration: {},
      availabilityPeriod: availabilityPeriodData,
      approvalWorkflow: approvalWorkflowData,
      notificationSettings: notificationSettingsData,
      gradeSettings: gradeSettingsData,
      additionalOptions: additionalOptionsData,

      // Select Assessment Content step — topics covered + instructions shown
      // to students. Persisted so the attend flow can scope/brief the test.
      selectedTopics: Array.isArray(selectedTopics) ? selectedTopics : [],
      instructions: typeof instructions === 'string' ? instructions : '',

      questions: questions,
      createdAt: new Date(),
      createdBy: req.user?.email || 'system',
      version: 1,
    };

    // Attach question configurations
    if (mcqQuestionConfig) {
      newExercise.questionConfiguration.mcqQuestionConfiguration = mcqQuestionConfig;
    }
    if (programmingQuestionConfig) {
      newExercise.questionConfiguration.programmingQuestionConfiguration = programmingQuestionConfig;
    }
    if (othersQuestionConfig) {
      newExercise.questionConfiguration.othersQuestionConfiguration = othersQuestionConfig;
    }

    // Attach programming settings if needed
    if ((exerciseTypeParsed === 'Programming' || exerciseTypeParsed === 'Combined') && exerciseInfo.selectedLanguages) {
      newExercise.programmingSettings = {
        selectedModule: exerciseInfo.selectedModule || null,
        selectedLanguages: exerciseInfo.selectedLanguages || [],
      };
    }

    // ── Save to database ───────────────────────────────────────────────────
    // Decide notification BEFORE save so we can stamp notifiedAt in the same
    // write. Gate skips when approvalScope="settings_and_questions" and the
    // exercise isn't yet fully configured — that path fires from addQuestion.
    const willNotifyStep1 = shouldFireStep1Notification(newExercise);
    if (willNotifyStep1) {
      newExercise.approvalWorkflow.steps[0].notifiedAt = new Date();
    }
    exercises.push(newExercise);
    pedagogyRoot[tabKey].set(subcategory, exercises);
    entity.markModified(`${pedagogyPath}.${tabKey}`);
    entity.updatedBy = req.user?.email || 'system';
    entity.updatedAt = new Date();
    await entity.save();

    // When the teacher opted in via saveToBank, clone any attached questions
    // into the institution's Question Bank (mirrors addExercise; fire-and-forget).
    if (newExercise.saveToBank && Array.isArray(newExercise.questions) && newExercise.questions.length > 0) {
      const institutionId = req.user?.institution?._id || req.user?.institution;
      cloneQuestionsToBank({
        institutionId,
        exerciseId: newExercise._id.toString(),
        questions: newExercise.questions,
        actorEmail: req.user?.email,
      });
    }

    // ── Notify step-1 approvers (best-effort, non-blocking) ────────────────
    if (willNotifyStep1) {
      const courseIdForNotify = resolveCourseId(entity);
      const courseDoc = courseIdForNotify
        ? await CourseStructure.findById(courseIdForNotify).select('courseName').lean()
        : null;
      notifyApproversForStep({
        courseId: courseIdForNotify,
        courseName: courseDoc?.courseName,
        step: newExercise.approvalWorkflow.steps[0],
        exerciseName: newExercise.exerciseInformation?.exerciseName,
        exerciseId: newExercise._id,
      }).catch((e) => console.warn('notifyApproversForStep failed:', e.message));
    }

    // ── Build response config ──────────────────────────────────────────────
    let responseConfig = {};
    if (exerciseTypeParsed === 'MCQ') {
      responseConfig = { mode: 'mcq', config: mcqQuestionConfig };
    } else if (exerciseTypeParsed === 'Programming') {
      responseConfig = { mode: 'programming', config: programmingQuestionConfig };
    } else if (exerciseTypeParsed === 'Other') {
      responseConfig = { mode: 'other', config: othersQuestionConfig };
    } else if (exerciseTypeParsed === 'Combined') {
      responseConfig = {
        mode: 'combined',
        mcqConfig: mcqQuestionConfig,
        programmingConfig: programmingQuestionConfig
      };
    }

    return res.status(201).json({
      message: [{ key: 'success', value: `Exercise added successfully to ${subcategory}` }],
      data: {
        exercise: newExercise,
        configuration: responseConfig,
        gradeSettings: gradeSettingsData,
        notificationSettings: notificationSettingsData,
        additionalOptions: additionalOptionsData,
        securitySettings: securitySettingsData,
        subcategory,
        tabType: tabKey,
        entityType: type,
        entityId: id,
        totalExercises: exercises.length,
        generatedExerciseId: exerciseId,
        location: { section: tabKey, subcategory, index: exercises.length - 1 },
      },
    });

  } catch (err) {
    console.error('❌ Add exercise error:', err);
    res.status(500).json({
      message: [{ key: 'error', value: `Internal server error: ${err.message}` }],
    });
  }
};


exports.updateYouDoExercise = async (req, res) => {
  try {
    const { type, id, exerciseId } = req.params;
    const {
      tabType,
      subcategory,
      exerciseType,
      programmingSettings,
      exerciseInformation,
      availabilityPeriod,
      questionConfiguration,
      notificationSettings,
      notificationGradeSettings,
      gradeSettings,
      additionalOptions,
      isSectionBased,      // ← ADD THIS
      sections,            // ← ADD THIS
      sectionConfigs,      // ← ADD THIS
      securitySettings,    // ← ADD THIS (if needed)
      selectedTopics,      // ← Select Assessment Content step: topics covered
      instructions,        // ← Select Assessment Content step: instructions
      isGraded,            // Graded / Non-Graded toggle (controls Grade Settings step)
      stepsSaved,          // Array of step titles explicitly saved — drives the sidebar
      // ── Question Source feature (Phase 2 / 5 / 6) ──────────────────────────
      questionSource,
      customDistribution,
      customSources,
      // Section-based Custom mix: per-section split keyed by sectionId.
      customDistributionBySection,
      saveToBank,
      // Combined-only: MCQ part's own source + single-cell Custom split.
      questionSourceMcq,
      customSourcesMcq,
      customDistributionMcq,
      // Evaluation Method — { method: 'testcase' | 'ai' }.
      evaluationMethod,
    } = req.body;

    // ── Validate ──────────────────────────────────────────────────────────
    if (!modelMap[type]) {
      return res.status(400).json({
        message: [{ key: 'error', value: `Invalid entity type: ${type}.` }]
      });
    }
    if (!subcategory) {
      return res.status(400).json({ message: [{ key: 'error', value: 'Subcategory is required.' }] });
    }
    if (!tabType) {
      return res.status(400).json({ message: [{ key: 'error', value: 'tabType is required (I_Do, We_Do, You_Do)' }] });
    }

    // ── Helpers ────────────────────────────────────────────────────────────
    const parseIfNeeded = (data) => {
      if (typeof data === 'string') {
        try { return JSON.parse(data); } catch { return data; }
      }
      return data;
    };

    const transformQuestionDescription = (question) => {
      if (!question) return question;
      if (question.description && typeof question.description === 'string') {
        question.description = { text: question.description, imageUrl: null, imageAlignment: 'left', imageSizePercent: 100 };
      }
      return question;
    };

    // ── Parse all incoming ─────────────────────────────────────────────────
    const parsedExerciseType = exerciseType ? parseIfNeeded(exerciseType) : null;
    const parsedExerciseInfo = exerciseInformation ? parseIfNeeded(exerciseInformation) : null;
    const parsedProgSettings = programmingSettings ? parseIfNeeded(programmingSettings) : null;
    const parsedAvailPeriod = availabilityPeriod ? parseIfNeeded(availabilityPeriod) : null;
    const parsedQuesConfig = questionConfiguration ? parseIfNeeded(questionConfiguration) : null;
    const parsedNotifSettings = notificationSettings
      ? parseIfNeeded(notificationSettings)
      : (notificationGradeSettings ? parseIfNeeded(notificationGradeSettings) : null);
    const parsedGradeSettings = gradeSettings ? parseIfNeeded(gradeSettings) : null;
    const parsedAdditOptions = additionalOptions ? parseIfNeeded(additionalOptions) : null;

    // ── Parse section-related fields ───────────────────────────────────────
    const parsedIsSectionBased = isSectionBased !== undefined ? isSectionBased : false;
    const parsedSections = sections ? parseIfNeeded(sections) : [];
    const parsedSectionConfigs = sectionConfigs ? parseIfNeeded(sectionConfigs) : {};
    const parsedSecuritySettings = securitySettings ? parseIfNeeded(securitySettings) : null;
    const parsedSelectedTopics = selectedTopics !== undefined ? parseIfNeeded(selectedTopics) : undefined;
    const parsedInstructions = instructions !== undefined ? parseIfNeeded(instructions) : undefined;

    // ── Find entity ───────────────────────────────────────────────────────
    const { model } = modelMap[type];
    const entity = await model.findById(id);

    if (!entity) return res.status(404).json({ message: [{ key: 'error', value: `${type} with ID ${id} not found` }] });
    // ── Resources by Batch ───────────────────────────────────────────────
    // Which I_Do/We_Do/You_Do set this request belongs to. For a shared
    // element that is the course-level `pedagogy`; for one ticked batch-wise
    // in Course Setup it is this batch's own `batchPedagogy.<batchId>`.
    // Resolving it here means every lookup and markModified below lands in
    // the right place — without it We Do and You Do would keep reading the
    // course-level set while the batch strip claimed otherwise.
    const { container: pedagogyRoot, basePath: pedagogyPath } =
      await resolvePedagogyScope(entity, tabType, req);

    if (!pedagogyRoot) return res.status(404).json({ message: [{ key: 'error', value: 'Pedagogy structure not found' }] });
    if (!pedagogyRoot[tabType]) return res.status(404).json({ message: [{ key: 'error', value: `Pedagogy tab '${tabType}' not found` }] });
    if (!pedagogyRoot[tabType].has(subcategory))
      return res.status(404).json({ message: [{ key: 'error', value: `Subcategory '${subcategory}' not found in ${tabType}` }] });

    const exercises = pedagogyRoot[tabType].get(subcategory);
    const exerciseIndex = exercises.findIndex(ex => ex._id.toString() === exerciseId);

    if (exerciseIndex === -1) {
      return res.status(404).json({
        message: [{ key: 'error', value: `Exercise with ID ${exerciseId} not found in subcategory '${subcategory}'` }]
      });
    }

    const existingExercise = exercises[exerciseIndex].toObject
      ? exercises[exerciseIndex].toObject()
      : { ...exercises[exerciseIndex] };
    delete existingExercise.$__;
    delete existingExercise.$isNew;
    delete existingExercise._doc;

    const finalExerciseType = parsedExerciseType || existingExercise.exerciseType;

    const configTypeSettings = {
      mcqMode: finalExerciseType === 'MCQ' || finalExerciseType === 'Combined',
      programmingMode: finalExerciseType === 'Programming' || finalExerciseType === 'Combined',
      combinedMode: finalExerciseType === 'Combined',
      otherMode: finalExerciseType === 'Other',
      sectionBased: parsedIsSectionBased,
    };

    // ── Re-use question config builders (same logic as addExercise) ────────
    let mcqQuestionConfig = existingExercise.questionConfiguration?.mcqQuestionConfiguration || null;
    let programmingQuestionConfig = existingExercise.questionConfiguration?.programmingQuestionConfiguration || null;
    let othersQuestionConfig = existingExercise.questionConfiguration?.othersQuestionConfiguration || null;
    let mcqTotalMarks = existingExercise.exerciseInformation?.totalMarksMCQ || 0;
    let progTotalMarks = existingExercise.exerciseInformation?.totalMarksProgramming || 0;

    if (parsedQuesConfig) {
      // ── MCQ config ───────────────────────────────────────────────────────
      if (parsedQuesConfig.mcqConfig) {
        const mcqCfg = parsedQuesConfig.mcqConfig;
        const scoreType = mcqCfg.scoreSettings?.scoreType || 'equalDistribution';
        let marksPerQuestion = 0;
        if (scoreType === 'equalDistribution') {
          marksPerQuestion = mcqCfg.scoreSettings?.equalDistribution || 0;
          mcqTotalMarks = (mcqCfg.generalQuestionCount || 0) * marksPerQuestion;
        } else {
          mcqTotalMarks = mcqCfg.scoreSettings?.totalMarks || 0;
        }
        mcqQuestionConfig = {
          totalMcqQuestions: mcqCfg.generalQuestionCount || 0,
          marksPerQuestion,
          mcqTotalMarks,
          attemptLimitEnabled: mcqCfg.attemptLimitEnabled || false,
          submissionAttempts: mcqCfg.submissionAttempts || 1,
          shuffleQuestions: true,
          scoringType: scoreType,
        };
      }

      // ── Programming config ───────────────────────────────────────────────
      if (parsedQuesConfig.programmingConfig) {
        const progCfg = parsedQuesConfig.programmingConfig;
        const qConfigType = progCfg.questionConfigType || 'general';
        let backendType;
        switch (qConfigType) {
          case 'levelBased': backendType = 'levelBased'; break;
          case 'selectionLevel': backendType = 'selectionLevel'; break;
          default: backendType = qConfigType;
        }

        progTotalMarks = 0;
        if (qConfigType === 'general' && progCfg.scoreSettings?.scoreType === 'equalDistribution') {
          progTotalMarks = (progCfg.generalQuestionCount || 0) * (progCfg.scoreSettings.equalDistribution || 0);
        } else if (qConfigType === 'levelBased' || qConfigType === 'selectionLevel') {
          const counts = qConfigType === 'selectionLevel' ? progCfg.selectionLevelCounts : progCfg.levelBasedCounts;
          const levelScoring = progCfg.scoreSettings?.levelScoringConfiguration;
          if (levelScoring) {
            ['easy', 'medium', 'hard'].forEach(l => {
              const c = counts?.[l] || 0; if (!c) return;
              const s = levelScoring[l]; if (!s) return;
              if (s.type === 'level_specific' && s.marksPerQuestion) progTotalMarks += c * s.marksPerQuestion;
              else if (s.type === 'question_specific' && s.totalMarks) progTotalMarks += s.totalMarks;
            });
          }
        }

        let backendScoreType;
        if (qConfigType === 'levelBased' || qConfigType === 'selectionLevel') {
          backendScoreType = 'levelBasedMarks';
        } else {
          switch (progCfg.scoreSettings?.scoreType) {
            case 'equalDistribution': backendScoreType = 'evenMarks'; break;
            case 'questionSpecific': backendScoreType = 'separateMarks'; break;
            case 'levelSpecific': backendScoreType = 'levelBasedMarks'; break;
            default: backendScoreType = progCfg.scoreSettings?.scoreType || 'evenMarks';
          }
        }

        const levelScoringConfig = progCfg.scoreSettings?.levelScoringConfiguration;
        let levelBasedMarks = progCfg.scoreSettings?.levelBasedMarks || { easy: 0, medium: 0, hard: 0 };

        if (levelScoringConfig && (qConfigType === 'levelBased' || qConfigType === 'selectionLevel')) {
          const counts = qConfigType === 'selectionLevel' ? progCfg.selectionLevelCounts : progCfg.levelBasedCounts;
          ['easy', 'medium', 'hard'].forEach(l => {
            const c = counts?.[l] || 0; if (!c) return;
            const s = levelScoringConfig[l];
            if (s?.type === 'level_specific' && s.marksPerQuestion) {
              levelBasedMarks[l] = s.marksPerQuestion;
              if (!levelScoringConfig[l].questionCount) levelScoringConfig[l].questionCount = c;
            } else if (s?.type === 'question_specific' && s.totalMarks) {
              if (!levelScoringConfig[l].questionCount) levelScoringConfig[l].questionCount = c;
            }
          });
        }

        programmingQuestionConfig = {
          questionConfigType: backendType || 'general',
          attemptLimitEnabled: progCfg.attemptLimitEnabled || false,
          submissionAttempts: progCfg.submissionAttempts || 1,
          questionFlow: progCfg.questionFlow || 'freeFlow',
          allowCodeExecution: true,
          enableTestCases: true,
          showSampleCases: true,
          scoreSettings: {
            scoreType: backendScoreType,
            evenMarks: progCfg.scoreSettings?.scoreType === 'equalDistribution' ? (progCfg.scoreSettings.equalDistribution || 0) : 0,
            separateMarks: progCfg.scoreSettings?.questionSpecific || { general: [], levelBased: { easy: [], medium: [], hard: [] } },
            levelBasedMarks,
            levelScoringConfiguration: levelScoringConfig,
            totalMarks: progTotalMarks,
          },
        };
        if (qConfigType === 'general') {
          programmingQuestionConfig.generalQuestionCount = progCfg.generalQuestionCount || 0;
          programmingQuestionConfig.generalMarksPerQuestion = progCfg.scoreSettings?.equalDistribution || progCfg.scoreSettings?.evenMarks || 0;
        } else if (qConfigType === 'levelBased') {
          programmingQuestionConfig.levelBasedCounts = progCfg.levelBasedCounts || { easy: 0, medium: 0, hard: 0 };
        } else if (qConfigType === 'selectionLevel') {
          programmingQuestionConfig.selectionLevelCounts = progCfg.selectionLevelCounts || { easy: 0, medium: 0, hard: 0 };
        }
      }

      // ── Others config ───────────────────────────────────────────────────
      if (parsedQuesConfig.othersQuestionConfiguration || parsedQuesConfig.othersConfig) {
        const othersCfg = parsedQuesConfig.othersQuestionConfiguration || parsedQuesConfig.othersConfig;
        const qConfigType = othersCfg.questionConfigType || 'general';

        let othersTotal = 0;
        if (qConfigType === 'general') {
          const evenMarks = othersCfg.generalMarksPerQuestion || othersCfg.scoreSettings?.evenMarks || 0;
          othersTotal = (othersCfg.generalQuestionCount || 0) * evenMarks;
        } else {
          const counts = qConfigType === 'selectionLevel' ? othersCfg.selectionLevelCounts : othersCfg.levelBasedCounts;
          const levelScoring = othersCfg.scoreSettings?.levelScoringConfiguration;
          if (levelScoring) {
            ['easy', 'medium', 'hard'].forEach(l => {
              const c = counts?.[l] || 0; if (!c) return;
              const s = levelScoring[l]; if (!s) return;
              if (s.type === 'level_specific' && s.marksPerQuestion)
                othersTotal += c * s.marksPerQuestion;
              else if (s.type === 'question_specific' && s.totalMarks)
                othersTotal += s.totalMarks;
            });
          }
        }

        if (!othersTotal) {
          othersTotal = othersCfg.scoreSettings?.totalMarks || parsedExerciseInfo?.totalMarks || existingExercise.exerciseInformation?.totalMarks || 0;
        }

        othersQuestionConfig = {
          questionConfigType: qConfigType,
          ...(qConfigType === 'general' && {
            generalQuestionCount: othersCfg.generalQuestionCount || 0,
            generalMarksPerQuestion: othersCfg.generalMarksPerQuestion || othersCfg.scoreSettings?.evenMarks || 0,
          }),
          ...(qConfigType === 'levelBased' && {
            levelBasedCounts: othersCfg.levelBasedCounts || { easy: 0, medium: 0, hard: 0 },
          }),
          ...(qConfigType === 'selectionLevel' && {
            selectionLevelCounts: othersCfg.selectionLevelCounts || { easy: 0, medium: 0, hard: 0 },
          }),
          scoreSettings: {
            scoreType: qConfigType === 'general' ? 'evenMarks' : 'levelBasedMarks',
            evenMarks: othersCfg.generalMarksPerQuestion || othersCfg.scoreSettings?.evenMarks || 0,
            levelBasedMarks: othersCfg.scoreSettings?.levelBasedMarks || { easy: 0, medium: 0, hard: 0 },
            levelScoringConfiguration: othersCfg.scoreSettings?.levelScoringConfiguration,
            totalMarks: othersTotal,
          },
          questionFlow: othersCfg.questionFlow || 'freeFlow',
          attemptLimitEnabled: othersCfg.attemptLimitEnabled || false,
          submissionAttempts: othersCfg.submissionAttempts || 1,
        };
        progTotalMarks = othersTotal;
      }

      // Direct overrides (if frontend sends already-formatted config objects)
      if (parsedQuesConfig.mcqQuestionConfiguration) {
        mcqQuestionConfig = parsedQuesConfig.mcqQuestionConfiguration;
        mcqTotalMarks = mcqQuestionConfig.mcqTotalMarks || 0;
      }
      if (parsedQuesConfig.programmingQuestionConfiguration) {
        programmingQuestionConfig = parsedQuesConfig.programmingQuestionConfiguration;
        progTotalMarks = programmingQuestionConfig.scoreSettings?.totalMarks || 0;
      }

      if (parsedQuesConfig.questions) {
        if (Array.isArray(parsedQuesConfig.questions)) {
          parsedQuesConfig.questions = parsedQuesConfig.questions.map(q => transformQuestionDescription(q));
        }
      }
    }

    // ── Build updated exercise (spread existing, apply changes) ────────────
    const updatedExercise = {
      ...existingExercise,
      ...(parsedExerciseType && { exerciseType: finalExerciseType }),
      configurationType: configTypeSettings,
      // Persist which steps the user has explicitly saved so the edit sidebar
      // shows them as "Completed" instead of falling back to the stale/empty
      // value preserved by the spread. Keep the existing list when the client
      // doesn't send one (e.g. partial updates that don't touch step progress).
      stepsSaved: Array.isArray(stepsSaved) ? stepsSaved : (existingExercise.stepsSaved || []),
      isGraded: isGraded !== undefined ? isGraded !== false : (existingExercise.isGraded !== false),
      // Phase 2 / 5 / 6 — source choice + custom matrix + save-to-bank flag.
      questionSource: questionSource !== undefined ? questionSource : (existingExercise.questionSource || null),
      customDistribution: customDistribution !== undefined ? customDistribution : (existingExercise.customDistribution || null),
      customSources: Array.isArray(customSources) ? customSources : (existingExercise.customSources || []),
      // Section-based per-section split — merge-or-preserve, same as the
      // aggregate customDistribution above. Empty object is a valid value
      // (non-section flow / trainer cleared it) so use `!== undefined`.
      customDistributionBySection: customDistributionBySection !== undefined
        ? (customDistributionBySection && typeof customDistributionBySection === 'object' ? customDistributionBySection : {})
        : (existingExercise.customDistributionBySection || {}),
      saveToBank: typeof saveToBank === 'boolean' ? saveToBank : !!existingExercise.saveToBank,
      // Combined-only MCQ-part source — merge-or-preserve like the above.
      questionSourceMcq: questionSourceMcq !== undefined ? questionSourceMcq : (existingExercise.questionSourceMcq || null),
      customSourcesMcq: Array.isArray(customSourcesMcq) ? customSourcesMcq : (existingExercise.customSourcesMcq || []),
      customDistributionMcq: customDistributionMcq !== undefined ? customDistributionMcq : (existingExercise.customDistributionMcq || null),
      // Evaluation Method — merge-or-preserve, so a step-scoped save that
      // doesn't own this step leaves the stored config untouched.
      evaluationMethod: evaluationMethod !== undefined
        ? (parseIfNeeded(evaluationMethod) || null)
        : (existingExercise.evaluationMethod || null),
      updatedAt: new Date(),
      updatedBy: req.user?.email || 'system',
      version: (existingExercise.version || 1) + 1,
    };

    // ── Section-based fields ───────────────────────────────────────────────
    if (parsedIsSectionBased !== undefined) {
      updatedExercise.isSectionBased = parsedIsSectionBased;
    }
    if (parsedSections.length > 0) {
      updatedExercise.sections = parsedSections;
    }
    if (Object.keys(parsedSectionConfigs).length > 0) {
      updatedExercise.sectionConfigs = parsedSectionConfigs;
    }
    if (parsedSecuritySettings) {
      updatedExercise.securitySettings = parsedSecuritySettings;
    }

    // ── Select Assessment Content step — topics covered + instructions ─────
    // Spread already preserves the existing values; override only when the
    // client actually sent new ones so editing the step persists correctly.
    if (parsedSelectedTopics !== undefined) {
      updatedExercise.selectedTopics = Array.isArray(parsedSelectedTopics) ? parsedSelectedTopics : [];
    }
    if (parsedInstructions !== undefined) {
      updatedExercise.instructions = typeof parsedInstructions === 'string' ? parsedInstructions : '';
    }

    // ── Exercise information ───────────────────────────────────────────────
    if (parsedExerciseInfo) {
      updatedExercise.exerciseInformation = {
        ...existingExercise.exerciseInformation,
        exerciseId: parsedExerciseInfo.exerciseId || existingExercise.exerciseInformation?.exerciseId,
        exerciseName: parsedExerciseInfo.exerciseName || existingExercise.exerciseInformation?.exerciseName,
        testType: parsedExerciseInfo.testType || existingExercise.exerciseInformation?.testType || 'mock',
        description: parsedExerciseInfo.description !== undefined ? parsedExerciseInfo.description : existingExercise.exerciseInformation?.description,
        exerciseLevel: parsedExerciseInfo.exerciseLevel || existingExercise.exerciseInformation?.exerciseLevel,
        totalDuration: parsedExerciseInfo.totalDuration !== undefined ? parsedExerciseInfo.totalDuration : existingExercise.exerciseInformation?.totalDuration,
        totalMarksMCQ: finalExerciseType === 'MCQ' || finalExerciseType === 'Combined'
          ? (parsedExerciseInfo.totalMarksMCQ !== undefined ? parsedExerciseInfo.totalMarksMCQ : mcqTotalMarks) : 0,
        totalMarksProgramming: finalExerciseType === 'Programming' || finalExerciseType === 'Other' || finalExerciseType === 'Combined'
          ? (parsedExerciseInfo.totalMarksProgramming !== undefined ? parsedExerciseInfo.totalMarksProgramming : progTotalMarks) : 0,
        totalMarks: parsedExerciseInfo.totalMarks || (mcqTotalMarks + progTotalMarks),
        selectedModule: parsedExerciseInfo.selectedModule || existingExercise.exerciseInformation?.selectedModule,
        selectedLanguages: parsedExerciseInfo.selectedLanguages || existingExercise.exerciseInformation?.selectedLanguages || [],
        isSectionBased: parsedIsSectionBased,
        sectionBasedDuration: parsedExerciseInfo.sectionBasedDuration !== undefined ? parsedExerciseInfo.sectionBasedDuration : existingExercise.exerciseInformation?.sectionBasedDuration || false,
      };
    }

    // ── Programming settings ───────────────────────────────────────────────
    if (parsedProgSettings) {
      updatedExercise.programmingSettings = {
        selectedModule: parsedProgSettings.selectedModule || existingExercise.programmingSettings?.selectedModule,
        selectedLanguages: parsedProgSettings.selectedLanguages || existingExercise.programmingSettings?.selectedLanguages || [],
      };
    }

    // ── Question configuration ─────────────────────────────────────────────
    if (parsedQuesConfig) {
      if (!updatedExercise.questionConfiguration) updatedExercise.questionConfiguration = {};
      if (mcqQuestionConfig) updatedExercise.questionConfiguration.mcqQuestionConfiguration = mcqQuestionConfig;
      if (programmingQuestionConfig) updatedExercise.questionConfiguration.programmingQuestionConfiguration = programmingQuestionConfig;
      if (othersQuestionConfig) updatedExercise.questionConfiguration.othersQuestionConfiguration = othersQuestionConfig;
      if (parsedQuesConfig.questions) updatedExercise.questions = parsedQuesConfig.questions;
    }

    // ── Availability period ────────────────────────────────────────────────
    if (parsedAvailPeriod) {
      const safeD = (v) => {
        if (!v || v === 'null' || v === 'undefined') return undefined;
        const d = new Date(v);
        return isNaN(d.getTime()) ? undefined : d;
      };
      const existAvail = existingExercise.availabilityPeriod || {};
      const prev = (f) => existAvail[f] ? new Date(existAvail[f]) : undefined;

      const startDate = safeD(parsedAvailPeriod.startDate) || prev('startDate');
      const endDate = safeD(parsedAvailPeriod.endDate) || prev('endDate');
      const cutOffEnabled = parsedAvailPeriod.cutOffEnabled !== undefined
        ? !!parsedAvailPeriod.cutOffEnabled
        : !!(existAvail.cutOffEnabled ?? false);
      const cutOffDate = cutOffEnabled
        ? (safeD(parsedAvailPeriod.cutOffDate) || prev('cutOffDate'))
        : undefined;
      const remindEnabled = parsedAvailPeriod.remindGradeByEnabled !== undefined
        ? !!parsedAvailPeriod.remindGradeByEnabled
        : !!(existAvail.remindGradeByEnabled ?? false);
      const remindGradeBy = remindEnabled
        ? (safeD(parsedAvailPeriod.remindGradeBy) || prev('remindGradeBy'))
        : undefined;
      const gracePeriodOn = parsedAvailPeriod.gracePeriodAllowed !== undefined
        ? !!(parsedAvailPeriod.gracePeriodAllowed || parsedAvailPeriod.gracePeriodEnabled)
        : !!(existAvail.gracePeriodAllowed || existAvail.gracePeriodEnabled);
      const gracePeriodDate = gracePeriodOn
        ? (safeD(parsedAvailPeriod.gracePeriodDate) || prev('gracePeriodDate'))
        : undefined;

      if (startDate) {
        const ap = {};
        ap.startDate = startDate;
        if (endDate) ap.endDate = endDate;
        if (cutOffDate) ap.cutOffDate = cutOffDate;
        ap.cutOffEnabled = cutOffEnabled;
        if (remindGradeBy) ap.remindGradeBy = remindGradeBy;
        ap.remindGradeByEnabled = remindEnabled;
        ap.gracePeriodAllowed = gracePeriodOn;
        ap.gracePeriodEnabled = gracePeriodOn;
        if (gracePeriodOn && gracePeriodDate) ap.gracePeriodDate = gracePeriodDate;
        ap.extendedDays = parsedAvailPeriod.extendedDays ?? existAvail.extendedDays ?? 0;
        ap.requiresAdminApproval = parsedAvailPeriod.requiresAdminApproval !== undefined
          ? !!parsedAvailPeriod.requiresAdminApproval
          : !!existAvail.requiresAdminApproval;
        const incomingScope = parsedAvailPeriod.approvalScope === 'settings_and_questions'
          ? 'settings_and_questions'
          : parsedAvailPeriod.approvalScope === 'settings'
          ? 'settings'
          : null;
        ap.approvalScope = incomingScope || existAvail.approvalScope || 'settings';
        updatedExercise.availabilityPeriod = ap;

        // ── Approval workflow transitions on toggle change ─────────────────
        const prevApproval = !!existAvail.requiresAdminApproval;
        const nextApproval = !!ap.requiresAdminApproval;
        if (nextApproval && !prevApproval) {
          const courseIdForWorkflow = resolveCourseId(entity);
          const wf = await buildInitialApprovalWorkflow(courseIdForWorkflow);
          if (!wf) {
            return res.status(400).json({
              message: [{
                key: 'error',
                value: 'Approval is required, but no approver could be resolved — the course has no Approval Hierarchy and the institution has no L&D role to default to. Configure the hierarchy on the Approvals page first.'
              }]
            });
          }
          updatedExercise.approvalWorkflow = wf;
        } else if (!nextApproval && prevApproval) {
          updatedExercise.approvalWorkflow = null;
        }
      } else {
        delete updatedExercise.availabilityPeriod;
      }
    }

    // ── Notification settings ──────────────────────────────────────────────
    if (parsedNotifSettings) {
      const ex = existingExercise.notificationSettings || existingExercise.notificatonandGradeSettings || {};
      updatedExercise.notificationSettings = {
        notifyUsers: parsedNotifSettings.notifyUsers !== undefined ? parsedNotifSettings.notifyUsers : (ex.notifyUsers ?? false),
        notifyGmail: parsedNotifSettings.notifyGmail !== undefined ? parsedNotifSettings.notifyGmail : (ex.notifyGmail ?? false),
        notifyWhatsApp: parsedNotifSettings.notifyWhatsApp !== undefined ? parsedNotifSettings.notifyWhatsApp : (ex.notifyWhatsApp ?? false),
        gradeSheet: parsedNotifSettings.gradeSheet !== undefined ? parsedNotifSettings.gradeSheet : (ex.gradeSheet ?? true),
        notifyGradersSubmissions: parsedNotifSettings.notifyGradersSubmissions !== undefined ? parsedNotifSettings.notifyGradersSubmissions : (ex.notifyGradersSubmissions ?? false),
        notifyGradersLateSubmissions: parsedNotifSettings.notifyGradersLateSubmissions !== undefined ? parsedNotifSettings.notifyGradersLateSubmissions : (ex.notifyGradersLateSubmissions ?? false),
        notifyStudent: parsedNotifSettings.notifyStudent !== undefined ? parsedNotifSettings.notifyStudent : (ex.notifyStudent ?? true),
      };
      updatedExercise.notificatonandGradeSettings = {
        notifyUsers: updatedExercise.notificationSettings.notifyUsers,
        notifyGmail: updatedExercise.notificationSettings.notifyGmail,
        notifyWhatsApp: updatedExercise.notificationSettings.notifyWhatsApp,
        gradeSheet: updatedExercise.notificationSettings.gradeSheet,
      };
    }

    // ── Grade settings (include computeAutoGrades if you have it) ──────────
    if (parsedGradeSettings !== null) {
      const exGrade = existingExercise.gradeSettings || {};
      const merged = {
        mcqGrade: parsedGradeSettings?.mcqGrade !== undefined ? Number(parsedGradeSettings.mcqGrade) : exGrade.mcqGrade,
        mcqGradeToPass: parsedGradeSettings?.mcqGradeToPass !== undefined
          ? (parsedGradeSettings.mcqGradeToPass !== null ? Number(parsedGradeSettings.mcqGradeToPass) : null)
          : exGrade.mcqGradeToPass,
        programmingGrade: parsedGradeSettings?.programmingGrade !== undefined ? Number(parsedGradeSettings.programmingGrade) : exGrade.programmingGrade,
        programmingGradeToPass: parsedGradeSettings?.programmingGradeToPass !== undefined
          ? (parsedGradeSettings.programmingGradeToPass !== null ? Number(parsedGradeSettings.programmingGradeToPass) : null)
          : exGrade.programmingGradeToPass,
        combinedGrade: parsedGradeSettings?.combinedGrade !== undefined ? Number(parsedGradeSettings.combinedGrade) : exGrade.combinedGrade,
        combinedGradeToPass: parsedGradeSettings?.combinedGradeToPass !== undefined
          ? (parsedGradeSettings.combinedGradeToPass !== null ? Number(parsedGradeSettings.combinedGradeToPass) : null)
          : exGrade.combinedGradeToPass,
        separateMarks: parsedGradeSettings?.separateMarks !== undefined ? parsedGradeSettings.separateMarks : (exGrade.separateMarks ?? false),
        // Grade-level "Section Based" split (toggle + per-part total/pass marks).
        sectionBased: parsedGradeSettings?.sectionBased !== undefined ? !!parsedGradeSettings.sectionBased : (exGrade.sectionBased ?? false),
        sections: Array.isArray(parsedGradeSettings?.sections) ? parsedGradeSettings.sections : (exGrade.sections ?? []),
        sectionPassMarks: parsedGradeSettings?.sectionPassMarks !== undefined ? parsedGradeSettings.sectionPassMarks : (exGrade.sectionPassMarks ?? {}),
        // Grade bands (labelled % ranges) — incoming wins, else keep existing.
        gradeBands: Array.isArray(parsedGradeSettings?.gradeBands) ? parsedGradeSettings.gradeBands : (exGrade.gradeBands ?? undefined),
      };
      updatedExercise.gradeSettings = merged;
    }

    // ── Additional options ─────────────────────────────────────────────────
    if (parsedAdditOptions) {
      const exAddit = existingExercise.additionalOptions || {};
      updatedExercise.additionalOptions = {
        anonymousSubmissions: parsedAdditOptions.anonymousSubmissions !== undefined ? parsedAdditOptions.anonymousSubmissions : (exAddit.anonymousSubmissions ?? false),
        hideGraderIdentity: parsedAdditOptions.hideGraderIdentity !== undefined ? parsedAdditOptions.hideGraderIdentity : (exAddit.hideGraderIdentity ?? false),
      };
    }

    // ── Persist ────────────────────────────────────────────────────────────
    // Decide notification BEFORE the JSON snapshot so notifiedAt persists in
    // the same save. `updatedExercise` is a partial merge — for the gate check
    // we overlay it on the existing exercise so `approvalScope`, question
    // counts, config etc. all resolve correctly.
    const mergedForGate = { ...existingExercise, ...updatedExercise };
    const willNotifyStep1 = shouldFireStep1Notification(mergedForGate);
    if (willNotifyStep1) {
      if (!updatedExercise.approvalWorkflow) updatedExercise.approvalWorkflow = existingExercise.approvalWorkflow;
      updatedExercise.approvalWorkflow.steps[0].notifiedAt = new Date();
    }
    // Trainer just saved an edit — if the workflow is currently `rejected`,
    // mark it so the approver's UI shows a plain "Approve" instead of
    // "Approve anyway". Applied whether or not the approval scope defers,
    // and irrespective of what fields actually changed (any save counts).
    if (existingExercise?.approvalWorkflow?.overallStatus === 'rejected') {
      if (!updatedExercise.approvalWorkflow) updatedExercise.approvalWorkflow = existingExercise.approvalWorkflow;
      updatedExercise.approvalWorkflow.editedSinceReject = true;
    }
    const cleanExercise = JSON.parse(JSON.stringify(updatedExercise));
    exercises[exerciseIndex] = cleanExercise;
    pedagogyRoot[tabType].set(subcategory, exercises);
    // Same Map-of-Array-of-Subdoc tracking issue as updateExercise above:
    // marking only the Map path does NOT reliably persist changes to deeply
    // nested Date fields like availabilityPeriod.startDate/endDate. Mark each
    // level so Mongoose emits the SET ops. Without this, the Schedule step's
    // Save would return 200 but the new start/end times never reached MongoDB.
    entity.markModified(`${pedagogyPath}.${tabType}`);
    entity.markModified(`${pedagogyPath}.${tabType}.${subcategory}`);
    entity.markModified(`${pedagogyPath}.${tabType}.${subcategory}.${exerciseIndex}`);
    entity.markModified(`${pedagogyPath}.${tabType}.${subcategory}.${exerciseIndex}.availabilityPeriod`);
    entity.markModified(`${pedagogyPath}.${tabType}.${subcategory}.${exerciseIndex}.approvalWorkflow`);
    // customDistributionBySection is a Mixed type (dynamic section-id keys).
    // Mongoose can't auto-detect deep changes on Mixed fields, so without an
    // explicit markModified the update payload is written into memory but
    // .save() skips emitting it to Mongo — trainer edits vanish silently.
    entity.markModified(`${pedagogyPath}.${tabType}.${subcategory}.${exerciseIndex}.customDistributionBySection`);
    entity.updatedBy = req.user?.email || 'system';
    entity.updatedAt = new Date();
    await entity.save();

    // Phase 6 — When the teacher opts in via saveToBank, clone the exercise's
    // attached questions into the institution's Question Bank. Fire-and-forget
    // so an occasional bank failure never breaks the exercise save response.
    if (updatedExercise.saveToBank && Array.isArray(cleanExercise.questions) && cleanExercise.questions.length > 0) {
      const institutionId = req.user?.institution?._id || req.user?.institution;
      cloneQuestionsToBank({
        institutionId,
        exerciseId,
        questions: cleanExercise.questions,
        actorEmail: req.user?.email,
      });
    }

    // Notify step-1 approvers only when the gate said so above. This handles
    // both "settings" scope (fire immediately) and "settings_and_questions"
    // scope (skipped here; fires from addQuestion once complete).
    if (willNotifyStep1) {
      const courseIdForNotify = resolveCourseId(entity);
      const courseDoc = courseIdForNotify
        ? await CourseStructure.findById(courseIdForNotify).select('courseName').lean()
        : null;
      notifyApproversForStep({
        courseId: courseIdForNotify,
        courseName: courseDoc?.courseName,
        step: updatedExercise.approvalWorkflow.steps[0],
        exerciseName: updatedExercise.exerciseInformation?.exerciseName,
        exerciseId: updatedExercise._id,
      }).catch((e) => console.warn('notifyApproversForStep failed:', e.message));
    }

    // ── Build response config ──────────────────────────────────────────────
    let responseConfig = {};
    if (finalExerciseType === 'MCQ') responseConfig = { mode: 'mcq', config: mcqQuestionConfig };
    else if (finalExerciseType === 'Programming') responseConfig = { mode: 'programming', config: programmingQuestionConfig };
    else if (finalExerciseType === 'Other') responseConfig = { mode: 'other', config: othersQuestionConfig };
    else if (finalExerciseType === 'Combined') responseConfig = { mode: 'combined', mcqConfig: mcqQuestionConfig, programmingConfig: programmingQuestionConfig };

    return res.status(200).json({
      message: [{ key: 'success', value: `Exercise updated successfully in ${subcategory}` }],
      data: {
        exercise: cleanExercise,
        configuration: responseConfig,
        gradeSettings: cleanExercise.gradeSettings,
        notificationSettings: cleanExercise.notificationSettings,
        additionalOptions: cleanExercise.additionalOptions,
        securitySettings: cleanExercise.securitySettings,
        subcategory,
        tabType,
        entityType: type,
        entityId: id,
        exerciseId,
        totalExercises: exercises.length,
        location: { section: tabType, subcategory, index: exerciseIndex },
      },
    });

  } catch (err) {
    console.error('❌ Update exercise error:', err);
    console.error('Error stack:', err.stack);
    res.status(500).json({
      message: [{ key: 'error', value: `Internal server error: ${err.message}` }],
    });
  }
};

// GET YOU DO EXERCISES - For Assessment component with Pagination
exports.getYouDoExercises = async (req, res) => {
  try {
    const { type, id } = req.params;
    const {
      tabType,
      subcategory,
      page = 1,
      limit = 10,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    // Validate entity type
    if (!modelMap[type]) {
      return res.status(400).json({
        message: [{ key: "error", value: `Invalid entity type: ${type}` }]
      });
    }

    const { model } = modelMap[type];
    const entity = await model.findById(id);

    if (!entity) {
      return res.status(404).json({
        message: [{ key: "error", value: `${type} not found` }]
      });
    }
    // ── Resources by Batch ───────────────────────────────────────────────
    // Which I_Do/We_Do/You_Do set this request belongs to. For a shared
    // element that is the course-level `pedagogy`; for one ticked batch-wise
    // in Course Setup it is this batch's own `batchPedagogy.<batchId>`.
    // Resolving it here means every lookup and markModified below lands in
    // the right place — without it We Do and You Do would keep reading the
    // course-level set while the batch strip claimed otherwise.
    const { container: pedagogyRoot, basePath: pedagogyPath } =
      await resolvePedagogyScope(entity, tabType, req);


    // Check if pedagogy exists
    if (!pedagogyRoot || !pedagogyRoot[tabType]) {
      return res.json({
        message: [{ key: "success", value: "No exercises found" }],
        data: {
          exercises: [],
          tabType: tabType,
          subcategory: subcategory,
          total: 0,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: 0
        }
      });
    }

    // Get exercises for specific subcategory
    let exercises = [];
    if (subcategory) {
      exercises = pedagogyRoot[tabType].get(subcategory) || [];
    } else {
      // Return all exercises from all subcategories in tabType
      const allExercises = [];
      pedagogyRoot[tabType].forEach((exArray, subcat) => {
        if (Array.isArray(exArray)) {
          exArray.forEach(ex => {
            const exerciseObj = ex.toObject ? ex.toObject() : { ...ex };
            allExercises.push({
              ...exerciseObj,
              subcategory: subcat
            });
          });
        }
      });
      exercises = allExercises;
    }

    // Convert to array and add timestamps for sorting
    // NOTE: must call .toObject() on Mongoose subdocs — spreading a Document directly
    // copies internal props ($__, _doc, ...) instead of the actual data, which made
    // exerciseInformation.exerciseName render as "Untitled Assessment" on the client.
    let exercisesArray = exercises.map(ex => {
      const obj = ex && typeof ex.toObject === 'function' ? ex.toObject() : { ...ex };
      return {
        ...obj,
        sortCreatedAt: obj.createdAt ? new Date(obj.createdAt).getTime() : 0,
        sortUpdatedAt: obj.updatedAt ? new Date(obj.updatedAt).getTime() : 0,
      };
    });

    // Hide exercises gated by an unfinished approval workflow from anyone whose
    // role doesn't match the currently-pending step. Approved (studentVisible)
    // exercises stay visible to everyone. The creator is always allowed to see
    // their own exercise — even mid-approval — so they can track its status
    // via the "Waiting Approval" badge on the client.
    {
      const callerRoleId = req.user?.role?._id?.toString() || req.user?.role?.toString() || null;
      const callerEmail = req.user?.email || null;
      exercisesArray = exercisesArray.filter((ex) => {
        const wf = ex?.approvalWorkflow;
        if (!wf || !wf.steps || wf.steps.length === 0) return true;
        if (wf.studentVisible) return true;
        if (callerEmail && ex.createdBy && ex.createdBy === callerEmail) return true;
        if (!callerRoleId) return false;
        const idx = (wf.currentStep || 1) - 1;
        const step = wf.steps[idx];
        return step && step.roleId?.toString() === callerRoleId;
      });
    }

    // Sort exercises (descending order by default - latest first)
    exercisesArray.sort((a, b) => {
      let aValue, bValue;

      switch (sortBy) {
        case 'createdAt':
          aValue = a.sortCreatedAt;
          bValue = b.sortCreatedAt;
          break;
        case 'updatedAt':
          aValue = a.sortUpdatedAt;
          bValue = b.sortUpdatedAt;
          break;
        case 'exerciseName':
          aValue = a.exerciseInformation?.exerciseName || '';
          bValue = b.exerciseInformation?.exerciseName || '';
          return sortOrder === 'desc'
            ? bValue.localeCompare(aValue)
            : aValue.localeCompare(bValue);
        case 'totalMarks':
          aValue = a.exerciseInformation?.totalMarks || 0;
          bValue = b.exerciseInformation?.totalMarks || 0;
          break;
        default:
          aValue = a.sortCreatedAt;
          bValue = b.sortCreatedAt;
      }

      if (sortOrder === 'desc') {
        return bValue - aValue;
      } else {
        return aValue - bValue;
      }
    });

    // Calculate pagination
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const total = exercisesArray.length;
    const totalPages = Math.ceil(total / limitNum);
    const startIndex = (pageNum - 1) * limitNum;
    const endIndex = startIndex + limitNum;

    // Get paginated exercises
    const paginatedExercises = exercisesArray.slice(startIndex, endIndex);

    // Remove temporary sort fields from response
    const cleanExercises = paginatedExercises.map(({ sortCreatedAt, sortUpdatedAt, ...rest }) => rest);

    // ── Stamp `hasParticipants` on each row ─────────────────────────────
    // One `distinct` over the small page slice — cheap and scales with the
    // page size, not the total ExamSession count. Presence in the returned
    // set means "at least one student has ever joined this test". The client
    // gates the Live Dashboard menu entry on this bit; ExamSession rows are
    // never deleted (submittedAt flips but the row stays), so this is
    // permanently true once flipped — matches the product rule "once
    // started, never hide the Dashboard entry even after the schedule ends".
    try {
      const pageIds = cleanExercises
        .map(ex => String(ex?._id || ex?.id || ""))
        .filter(Boolean);
      if (pageIds.length > 0) {
        const withParticipants = new Set(
          (await ExamSession.distinct("assessmentId", { assessmentId: { $in: pageIds } })).map(String)
        );
        for (const ex of cleanExercises) {
          ex.hasParticipants = withParticipants.has(String(ex._id || ex.id || ""));
        }
      }
    } catch (e) {
      // Never let this enrichment break the primary list response — if the
      // ExamSession lookup fails we ship the exercises without the flag and
      // the client falls back to "Dashboard hidden" (the safer default).
      console.warn("hasParticipants stamp failed:", e.message);
    }

    return res.json({
      message: [{ key: "success", value: "Exercises retrieved successfully" }],
      data: {
        exercises: cleanExercises,
        tabType: tabType,
        subcategory: subcategory,
        pagination: {
          total: total,
          page: pageNum,
          limit: limitNum,
          totalPages: totalPages,
          hasNextPage: pageNum < totalPages,
          hasPrevPage: pageNum > 1
        },
        sorting: {
          sortBy: sortBy,
          sortOrder: sortOrder
        },
        entityType: type,
        entityId: id
      }
    });

  } catch (err) {
    console.error("❌ Get YouDo exercises error:", err);
    res.status(500).json({
      message: [{ key: "error", value: "Internal server error" }]
    });
  }
};

// ============================================================================
// Approval workflow: list pending approvals + approve an exercise step
// ============================================================================

/**
 * GET /courses/:courseId/approvals/overview?tabType=We_Do|You_Do
 * Returns a flat list of all exercises in the course (across Module / SubModule
 * / Topic / SubTopic) for the given tab, with full approvalWorkflow details
 * and a `canApprove` flag for the caller.
 */
exports.getCourseApprovalsOverview = async (req, res) => {
  try {
    const { courseId } = req.params;
    const { tabType } = req.query;
    if (!courseId || !mongoose.Types.ObjectId.isValid(courseId)) {
      return res.status(400).json({ message: [{ key: 'error', value: 'Invalid courseId' }] });
    }
    const targetTab = tabType === 'We_Do' ? 'We_Do' : tabType === 'You_Do' ? 'You_Do' : null;
    if (!targetTab) {
      return res.status(400).json({ message: [{ key: 'error', value: 'tabType must be We_Do or You_Do' }] });
    }
    const callerRoleId = req.user?.role?._id?.toString() || req.user?.role?.toString() || null;
    const callerUserId = (req.user?._id || req.user?.id)?.toString() || null;

    const collections = [
      { Model: Module1, kind: 'modules' },
      { Model: SubModule1, kind: 'submodules' },
      { Model: Topic1, kind: 'topics' },
      { Model: SubTopic1, kind: 'subtopics' },
    ];

    const items = [];
    for (const { Model, kind } of collections) {
      const docs = await Model.find(
        { courses: courseId },
        { _id: 1, name: 1, pedagogy: 1, batchPedagogy: 1 },
      ).lean();
      for (const doc of docs) {
        // Resources by Batch — approval is a CROSS-batch duty, so this queue
        // deliberately does not scope to one batch: it lists every batch's
        // pending items. Each entry carries the `batchId` it came from so the
        // approve/reject call can be scoped back to the right container.
        for (const [subcategory, exercises, entryBatchId] of mergeSectionAcrossBatches(doc, targetTab)) {
          if (!Array.isArray(exercises)) continue;
          for (const ex of exercises) {
            const wf = ex.approvalWorkflow || null;
            // Only list exercises that actually have an approval workflow
            // attached. Items created with requiresAdminApproval=false have
            // no workflow and don't belong on this page.
            if (!wf || !Array.isArray(wf.steps) || wf.steps.length === 0) continue;
            // Hide any "settings_and_questions"-scoped item that isn't yet
            // fully configured, regardless of workflow status. Rule: the
            // approver only ever sees these once the trainer has actually
            // added all questions — the step-1 notification is what surfaces
            // it on this page in the first place.
            {
              const scope = ex.availabilityPeriod?.approvalScope || 'settings';
              if (scope === 'settings_and_questions' && !isExerciseFullyConfigured(ex)) {
                continue;
              }
            }
            let canApprove = false;
            if (wf.overallStatus === 'in_progress') {
              const idx = (wf.currentStep || 1) - 1;
              const step = wf.steps[idx];
              if (step && step.status === 'pending'
                  && (await canUserActOnStep(step, callerUserId, callerRoleId)).ok) {
                canApprove = true;
              }
            } else if (wf.overallStatus === 'rejected' && wf.editedSinceReject) {
              // Rejected but the trainer has since edited/saved — reopen the
              // action buttons for the assigned approver so they can approve
              // (or reject again) against the reworked content. Without an
              // edit, `canApprove` stays false and the approver's UI shows
              // only View (they wait for the trainer to make changes).
              const idx = (wf.currentStep || 1) - 1;
              const step = wf.steps[idx];
              if (step && step.status === 'rejected'
                  && (await canUserActOnStep(step, callerUserId, callerRoleId)).ok) {
                canApprove = true;
              }
            }
            items.push({
              exerciseId: ex._id,
              exerciseName: ex.exerciseInformation?.exerciseName || '',
              exerciseType: ex.exerciseType || ex.exerciseInformation?.exerciseType || '',
              testType: ex.exerciseInformation?.testType || '',
              totalDuration: ex.exerciseInformation?.totalDuration || null,
              totalMarks: ex.exerciseInformation?.totalMarks || null,
              schedule: ex.availabilityPeriod || null,
              entityType: kind,
              entityId: doc._id,
              entityName: doc.name || '',
              subcategory,
              tabType: targetTab,
              // Which batch this item belongs to ("" = the shared, course-level
              // set). The approve/reject call must send it back, or a
              // batch-wise exercise is looked up in the wrong container and
              // reported as not found.
              batchId: entryBatchId || '',
              approvalWorkflow: wf,
              canApprove,
              createdAt: ex.createdAt || null,
              updatedAt: ex.updatedAt || null,
              createdBy: ex.createdBy || null,
              // Full exercise blob so the View dialog can render every section
              // (configuration, grades, notifications, security, etc.) without
              // an extra round-trip.
              exercise: ex,
            });
          }
        }
      }
    }

    items.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    res.status(200).json({ success: true, data: items });
  } catch (err) {
    console.error('getCourseApprovalsOverview error:', err);
    res.status(500).json({ message: [{ key: 'error', value: err.message }] });
  }
};

/**
 * GET /approvals/pending
 * Lists exercises across all courses where the caller's role matches the
 * currently-pending step. Used by approvers to see their queue.
 */
exports.listPendingApprovals = async (req, res) => {
  try {
    const callerRoleId = req.user?.role?._id || req.user?.role;
    const callerUserId = req.user?._id || req.user?.id;
    if (!callerRoleId) {
      return res.status(403).json({ message: [{ key: 'error', value: 'No role on caller' }] });
    }

    const collections = [
      { Model: Module1, kind: 'modules' },
      { Model: SubModule1, kind: 'submodules' },
      { Model: Topic1, kind: 'topics' },
      { Model: SubTopic1, kind: 'subtopics' },
    ];

    // Institution-scoped (was an unfiltered cross-tenant scan of every
    // pedagogy node in the database — verified live that no node doc lacks
    // `institution`, and a step's role/pin can only ever match a caller of
    // the same institution, so the visible result set is identical) and
    // projected down to the two sections this loop reads — I_Do (typically
    // the largest subtree: files/folders/blobs) is never consumed here.
    // The four finds are independent → run concurrently; iteration order
    // stays modules → submodules → topics → subtopics.
    const docLists = await Promise.all(
      collections.map(({ Model }) =>
        Model.find(
          { institution: req.user.institution },
          { _id: 1, name: 1, courses: 1, 'pedagogy.We_Do': 1, 'pedagogy.You_Do': 1, batchPedagogy: 1 },
        ).lean()
      )
    );

    // canUserActOnStep hits User.findById for every pinned step; the same
    // approver is pinned on many exercises, so memoize per request. The
    // pre-filter below (before the await) is provably identical to the
    // function's own logic: it can only return ok when the caller IS the
    // pinned user or HOLDS the step's role — anything else is a guaranteed
    // "no" that needn't cost a query.
    const actCache = new Map();
    const callerUserStr = callerUserId ? String(callerUserId) : '';
    const callerRoleStr = callerRoleId ? String(callerRoleId) : '';
    const canActCached = async (step) => {
      const stepUserStr = step.userId ? String(step.userId) : '';
      const stepRoleStr = step.roleId ? String(step.roleId) : '';
      if (stepUserStr !== callerUserStr && stepRoleStr !== callerRoleStr) {
        return { ok: false };
      }
      const key = `${stepUserStr}|${stepRoleStr}`;
      if (!actCache.has(key)) {
        actCache.set(key, await canUserActOnStep(step, callerUserId, callerRoleId));
      }
      return actCache.get(key);
    };

    const pending = [];
    for (let ci = 0; ci < collections.length; ci++) {
      const { kind } = collections[ci];
      const docs = docLists[ci];
      for (const doc of docs) {
        const courseId = Array.isArray(doc.courses) ? doc.courses[0] : doc.courses;
        // Resources by Batch — cross-batch by design, like the overview above.
        // The `if (!doc.pedagogy) continue` that used to guard this loop also
        // had to go: a node whose We Do / You Do is entirely batch-wise has no
        // `pedagogy` at all, and its pending approvals would never be listed.
        for (const tabType of ['We_Do', 'You_Do']) {
          for (const [subcategory, exercises, entryBatchId] of mergeSectionAcrossBatches(doc, tabType)) {
            if (!Array.isArray(exercises)) continue;
            for (const ex of exercises) {
              const wf = ex.approvalWorkflow;
              if (!wf || wf.overallStatus !== 'in_progress') continue;
              // Same rule as the overview + step-1 notification: a
              // settings_and_questions item isn't reviewable (and its
              // approver was never notified) until the trainer finishes
              // configuring it — don't count it in queues/badges either.
              const exScope = ex.availabilityPeriod?.approvalScope || 'settings';
              if (exScope === 'settings_and_questions' && !isExerciseFullyConfigured(ex)) continue;
              const idx = (wf.currentStep || 1) - 1;
              const step = wf.steps?.[idx];
              if (!step || step.status !== 'pending') continue;
              // Person-specific queue: a step with a pinned userId lists only
              // for THAT user; a legacy role-only step still lists for anyone
              // holding the role — same rule as the approve gate below.
              if (!(await canActCached(step)).ok) continue;
              pending.push({
                exerciseId: ex._id,
                exerciseName: ex.exerciseInformation?.exerciseName,
                courseId,
                entityType: kind,
                entityId: doc._id,
                tabType,
                subcategory,
                // See the overview endpoint — the approve/reject call needs
                // this to find a batch-wise exercise again.
                batchId: entryBatchId || '',
                step: {
                  order: step.order,
                  roleName: step.roleName,
                  userId: step.userId || null,
                  userName: step.userName || '',
                },
                currentStep: wf.currentStep,
                totalSteps: wf.steps?.length || 0,
                initiatedAt: wf.initiatedAt,
                resubmissionCount: wf.resubmissionCount || 0,
                approvalScope: ex.availabilityPeriod?.approvalScope || 'settings',
              });
            }
          }
        }
      }
    }

    res.status(200).json({ success: true, data: pending });
  } catch (err) {
    console.error('listPendingApprovals error:', err);
    res.status(500).json({ message: [{ key: 'error', value: err.message }] });
  }
};

/**
 * POST /exercise/approve
 * Body: { entityType, entityId, tabType, subcategory, exerciseId, comment? }
 * - Verifies caller's role == current step's roleId
 * - Marks step approved, advances chain
 * - Notifies next step (or students if final)
 */
exports.approveExerciseStep = async (req, res) => {
  try {
    const { entityType, entityId, tabType, subcategory, exerciseId, comment } = req.body;
    if (!entityType || !entityId || !tabType || !subcategory || !exerciseId) {
      return res.status(400).json({ message: [{ key: 'error', value: 'entityType, entityId, tabType, subcategory, exerciseId all required' }] });
    }
    if (!modelMap[entityType]) {
      return res.status(400).json({ message: [{ key: 'error', value: `Invalid entityType: ${entityType}` }] });
    }
    const { model } = modelMap[entityType];
    const entity = await model.findById(entityId);
    if (!entity) {
      return res.status(404).json({ message: [{ key: 'error', value: `${entityType} not found` }] });
    }

    const tabKey = tabType === 'I_Do' ? 'I_Do' : tabType === 'We_Do' ? 'We_Do' : 'You_Do';
    // ── Resources by Batch ───────────────────────────────────────────────
    // Locate the exercise BY ID across the shared container and every batch,
    // rather than assuming the actor's own selected batch. The batch is a
    // property of the exercise, not of the person acting on it: an approver
    // works a queue spanning every batch, so scoping to whatever their
    // Resources page happened to have selected would look in the wrong
    // container and report the exercise as missing.
    const located = locateExerciseContainer(entity, tabKey, subcategory, exerciseId);
    if (!located) {
      return res.status(404).json({ message: [{ key: 'error', value: 'Exercise not found' }] });
    }
    const { container: pedagogyRoot, basePath: pedagogyPath, exercises, index: idx, exercise } = located;
    const wf = exercise.approvalWorkflow;
    // Accept both 'in_progress' (normal approval) and 'rejected' (approver
    // overrides their earlier rejection without a trainer resubmit).
    if (!wf || (wf.overallStatus !== 'in_progress' && wf.overallStatus !== 'rejected')) {
      return res.status(400).json({ message: [{ key: 'error', value: 'No active approval workflow on this exercise' }] });
    }
    const stepIdx = (wf.currentStep || 1) - 1;
    const currentStep = wf.steps?.[stepIdx];
    // Same reasoning: the current step is 'pending' in normal flow, or
    // 'rejected' when the same approver is un-rejecting.
    if (!currentStep || (currentStep.status !== 'pending' && currentStep.status !== 'rejected')) {
      return res.status(400).json({ message: [{ key: 'error', value: 'No pending step' }] });
    }
    const isOverridingReject = wf.overallStatus === 'rejected' && currentStep.status === 'rejected';

    const callerUserId = req.user?._id || req.user?.id;
    const callerRoleId = req.user?.role?._id || req.user?.role;
    const gate = await canUserActOnStep(currentStep, callerUserId, callerRoleId);
    if (!gate.ok) {
      return res.status(403).json({ message: [{ key: 'error', value: gate.reason }] });
    }

    // When scope is "settings_and_questions", require every question to be
    // approved before the step can advance.
    const scope = exercise.availabilityPeriod?.approvalScope || 'settings';
    if (scope === 'settings_and_questions') {
      const qs = Array.isArray(exercise.questions) ? exercise.questions : [];
      const notApproved = qs.filter(q => (q?.approval?.status || 'pending') !== 'approved');
      if (qs.length === 0) {
        return res.status(400).json({ message: [{ key: 'error', value: 'This exercise has no questions to approve.' }] });
      }
      if (notApproved.length > 0) {
        return res.status(400).json({
          message: [{
            key: 'error',
            value: `${notApproved.length} of ${qs.length} question(s) still need your approval before this step can advance.`
          }],
        });
      }
    }

    currentStep.status = 'approved';
    currentStep.decidedBy = req.user._id || req.user.id;
    currentStep.decidedAt = new Date();
    // If this is an override, drop the old rejection comment; otherwise take
    // whatever the approver typed (may be empty).
    currentStep.comment = typeof comment === 'string' ? comment : '';
    // Any approve outcome clears the "was edited since reject" marker — the
    // decision has been made on the current content and the flag is stale.
    wf.editedSinceReject = false;

    const isLast = wf.currentStep >= wf.steps.length;
    let nextStep = null;
    if (isLast) {
      wf.overallStatus = 'approved';
      wf.studentVisible = true;
      wf.completedAt = new Date();
    } else {
      wf.currentStep += 1;
      // Reset overallStatus in case we're coming out of 'rejected', and clear
      // the stale completedAt that reject set.
      wf.overallStatus = 'in_progress';
      wf.completedAt = null;
      nextStep = wf.steps[wf.currentStep - 1];
      nextStep.status = 'pending';
      // Reset every question's approval for the new step's clean slate.
      if (scope === 'settings_and_questions' && Array.isArray(exercise.questions)) {
        exercise.questions.forEach((q) => {
          if (!q.approval) q.approval = {};
          q.approval.status = 'pending';
          q.approval.currentStepOrder = nextStep.order;
          q.approval.decidedBy = null;
          q.approval.decidedAt = null;
          q.approval.queries = [];
        });
      }
    }

    exercise.approvalWorkflow = wf;
    exercises[idx] = exercise;
    pedagogyRoot[tabKey].set(subcategory, exercises);
    entity.markModified(`${pedagogyPath}.${tabKey}`);
    entity.markModified(`${pedagogyPath}.${tabKey}.${subcategory}`);
    entity.markModified(`${pedagogyPath}.${tabKey}.${subcategory}.${idx}`);
    entity.markModified(`${pedagogyPath}.${tabKey}.${subcategory}.${idx}.approvalWorkflow`);
    entity.updatedBy = req.user?.email || 'system';
    entity.updatedAt = new Date();
    await entity.save();

    // Notify next step (or students on final approval) — non-blocking.
    const courseIdForNotify = resolveCourseId(entity);
    const courseDoc = courseIdForNotify
      ? await CourseStructure.findById(courseIdForNotify).select('courseName').lean()
      : null;
    if (nextStep) {
      notifyApproversForStep({
        courseId: courseIdForNotify,
        courseName: courseDoc?.courseName,
        step: nextStep,
        exerciseName: exercise.exerciseInformation?.exerciseName,
        exerciseId: exercise._id,
      }).catch((e) => console.warn('notifyApproversForStep failed:', e.message));
    } else {
      notifyStudentsExerciseAvailable({
        courseId: courseIdForNotify,
        courseName: courseDoc?.courseName,
        exerciseName: exercise.exerciseInformation?.exerciseName,
        exerciseId: exercise._id,
      }).catch((e) => console.warn('notifyStudentsExerciseAvailable failed:', e.message));
    }

    res.status(200).json({
      success: true,
      message: isLast ? 'Final approval — exercise is now visible to students.' : 'Step approved. Next approver notified.',
      data: { approvalWorkflow: wf },
    });
  } catch (err) {
    console.error('approveExerciseStep error:', err);
    res.status(500).json({ message: [{ key: 'error', value: err.message }] });
  }
};

/**
 * POST /exercise/reject
 * Body: { entityType, entityId, tabType, subcategory, exerciseId, comment }
 * - Only the current-step approver can call it.
 * - `comment` (the query message) is required — this is what the trainer sees.
 * - Marks the step rejected, sets overallStatus=rejected, and notifies the
 *   creator (trainer) with a deep-link to the assessment list.
 * - Workflow stays "rejected" until the trainer edits and explicitly clicks
 *   Resubmit for Approval (see `resubmitExerciseForApproval` below).
 */
exports.rejectExerciseStep = async (req, res) => {
  try {
    const { entityType, entityId, tabType, subcategory, exerciseId, comment } = req.body;
    if (!entityType || !entityId || !tabType || !subcategory || !exerciseId) {
      return res.status(400).json({ message: [{ key: 'error', value: 'entityType, entityId, tabType, subcategory, exerciseId all required' }] });
    }
    if (typeof comment !== 'string' || !comment.trim()) {
      return res.status(400).json({ message: [{ key: 'error', value: 'A rejection message is required — describe what the trainer should fix.' }] });
    }
    if (!modelMap[entityType]) {
      return res.status(400).json({ message: [{ key: 'error', value: `Invalid entityType: ${entityType}` }] });
    }
    const { model } = modelMap[entityType];
    const entity = await model.findById(entityId);
    if (!entity) {
      return res.status(404).json({ message: [{ key: 'error', value: `${entityType} not found` }] });
    }

    const tabKey = tabType === 'I_Do' ? 'I_Do' : tabType === 'We_Do' ? 'We_Do' : 'You_Do';
    // ── Resources by Batch ───────────────────────────────────────────────
    // Locate the exercise BY ID across the shared container and every batch,
    // rather than assuming the actor's own selected batch. The batch is a
    // property of the exercise, not of the person acting on it: an approver
    // works a queue spanning every batch, so scoping to whatever their
    // Resources page happened to have selected would look in the wrong
    // container and report the exercise as missing.
    const located = locateExerciseContainer(entity, tabKey, subcategory, exerciseId);
    if (!located) {
      return res.status(404).json({ message: [{ key: 'error', value: 'Exercise not found' }] });
    }
    const { container: pedagogyRoot, basePath: pedagogyPath, exercises, index: idx, exercise } = located;
    const wf = exercise.approvalWorkflow;
    // Accept normal 'in_progress' AND the "rejected + editedSinceReject"
    // state — the approver can reject again with a new comment after the
    // trainer's edits. `editedSinceReject` guards against re-rejecting stale
    // rejected content (that button won't be shown on the client either).
    const rejectedAndEdited = wf && wf.overallStatus === 'rejected' && wf.editedSinceReject;
    if (!wf || (wf.overallStatus !== 'in_progress' && !rejectedAndEdited)) {
      return res.status(400).json({ message: [{ key: 'error', value: 'No active approval workflow on this exercise' }] });
    }
    const stepIdx = (wf.currentStep || 1) - 1;
    const currentStep = wf.steps?.[stepIdx];
    if (!currentStep || (currentStep.status !== 'pending' && currentStep.status !== 'rejected')) {
      return res.status(400).json({ message: [{ key: 'error', value: 'No pending step' }] });
    }
    const callerUserId = req.user?._id || req.user?.id;
    const callerRoleId = req.user?.role?._id || req.user?.role;
    const gate = await canUserActOnStep(currentStep, callerUserId, callerRoleId);
    if (!gate.ok) {
      return res.status(403).json({ message: [{ key: 'error', value: gate.reason }] });
    }

    currentStep.status = 'rejected';
    currentStep.decidedBy = req.user._id || req.user.id;
    currentStep.decidedAt = new Date();
    currentStep.comment = comment.trim();
    wf.overallStatus = 'rejected';
    wf.completedAt = new Date();
    // Fresh reject on the reworked content — clear the "edited since reject"
    // marker so the row falls back to View-only until the trainer edits again.
    wf.editedSinceReject = false;

    exercise.approvalWorkflow = wf;
    exercises[idx] = exercise;
    pedagogyRoot[tabKey].set(subcategory, exercises);
    entity.markModified(`${pedagogyPath}.${tabKey}`);
    entity.markModified(`${pedagogyPath}.${tabKey}.${subcategory}`);
    entity.markModified(`${pedagogyPath}.${tabKey}.${subcategory}.${idx}`);
    entity.markModified(`${pedagogyPath}.${tabKey}.${subcategory}.${idx}.approvalWorkflow`);
    entity.updatedBy = req.user?.email || 'system';
    entity.updatedAt = new Date();
    await entity.save();

    // ── Notify the creator (trainer) with the rejection message ────────────
    // Uses `notifySingleUser` (existing) which handles both in-app + email.
    // The metadata carries everything the client needs to build a deep link
    // back to the exact assessment (nodeType, nodeId, tabType, subcategory,
    // exerciseId) so a notification click drops the trainer right on the
    // row for editing.
    const courseIdForNotify = resolveCourseId(entity);
    const courseDoc = courseIdForNotify
      ? await CourseStructure.findById(courseIdForNotify).select('courseName').lean()
      : null;
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    const deepLinkPath = `/lms/pages/courses/uploadcourseresources?courseId=${courseIdForNotify || ''}&nodeId=${entity._id}&activeTab=${tabKey}&activeSubcategory=${encodeURIComponent(subcategory)}&highlightExerciseId=${exercise._id}`;
    const deepLinkAbs = `${baseUrl}${deepLinkPath}`;
    const exerciseName = exercise.exerciseInformation?.exerciseName || 'Your assessment';
    const emailBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color:#dc2626;">Approval rejected</h2>
        <p><strong>${exerciseName}</strong> in <strong>${courseDoc?.courseName || 'your course'}</strong> was rejected by ${currentStep.roleName}.</p>
        <div style="background:#fff7ed; border-left:4px solid #f59e0b; padding:12px 16px; margin:16px 0; color:#1f2937;">
          <p style="margin:0; font-weight:600;">Reviewer's message</p>
          <p style="margin:6px 0 0; white-space:pre-wrap;">${comment.trim().replace(/</g, '&lt;')}</p>
        </div>
        <p>Open the assessment, address the feedback, then click <strong>Resubmit for Approval</strong> to send it back through the chain.</p>
        <p style="margin-top:20px;"><a href="${deepLinkAbs}" style="background:#4f46e5;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;">Open assessment</a></p>
      </div>
    `;
    if (exercise.createdBy) {
      notifySingleUser({
        email: exercise.createdBy, // createdBy is the trainer's email (see createExercise)
        title: 'Approval rejected',
        message: `${exerciseName}: ${comment.trim()}`,
        type: 'warning',
        subject: `Approval rejected: ${exerciseName}`,
        body: emailBody,
        metadata: {
          kind: 'approval_rejected',
          exerciseId: String(exercise._id),
          entityType: entityType,
          entityId: String(entity._id),
          tabType: tabKey,
          subcategory: subcategory,
          courseId: courseIdForNotify ? String(courseIdForNotify) : '',
          redirectUrl: deepLinkPath,
          rejectedByRole: currentStep.roleName || '',
          rejectedAt: currentStep.decidedAt.toISOString(),
        },
      }).catch((e) => console.warn('notifySingleUser (reject) failed:', e.message));
    } else {
      console.warn(`rejectExerciseStep: exercise ${exercise._id} has no createdBy — trainer will not be notified.`);
    }

    res.status(200).json({
      success: true,
      message: 'Exercise rejected. The creator has been notified.',
      data: { approvalWorkflow: wf },
    });
  } catch (err) {
    console.error('rejectExerciseStep error:', err);
    res.status(500).json({ message: [{ key: 'error', value: err.message }] });
  }
};

/**
 * POST /exercise/resubmit
 * Body: { entityType, entityId, tabType, subcategory, exerciseId }
 * - Only the exercise's creator can resubmit.
 * - Only works when overallStatus === 'rejected'.
 * - Rebuilds the workflow at step 1 (all step state cleared, notifiedAt too)
 *   and fires the step-1 notification honoring `approvalScope`.
 */
exports.resubmitExerciseForApproval = async (req, res) => {
  try {
    const { entityType, entityId, tabType, subcategory, exerciseId } = req.body;
    if (!entityType || !entityId || !tabType || !subcategory || !exerciseId) {
      return res.status(400).json({ message: [{ key: 'error', value: 'entityType, entityId, tabType, subcategory, exerciseId all required' }] });
    }
    if (!modelMap[entityType]) {
      return res.status(400).json({ message: [{ key: 'error', value: `Invalid entityType: ${entityType}` }] });
    }
    const { model } = modelMap[entityType];
    const entity = await model.findById(entityId);
    if (!entity) {
      return res.status(404).json({ message: [{ key: 'error', value: `${entityType} not found` }] });
    }
    const tabKey = tabType === 'I_Do' ? 'I_Do' : tabType === 'We_Do' ? 'We_Do' : 'You_Do';
    // ── Resources by Batch ───────────────────────────────────────────────
    // Locate the exercise BY ID across the shared container and every batch,
    // rather than assuming the actor's own selected batch. The batch is a
    // property of the exercise, not of the person acting on it: an approver
    // works a queue spanning every batch, so scoping to whatever their
    // Resources page happened to have selected would look in the wrong
    // container and report the exercise as missing.
    const located = locateExerciseContainer(entity, tabKey, subcategory, exerciseId);
    if (!located) {
      return res.status(404).json({ message: [{ key: 'error', value: 'Exercise not found' }] });
    }
    const { container: pedagogyRoot, basePath: pedagogyPath, exercises, index: idx, exercise } = located;
    const wf = exercise.approvalWorkflow;
    // Resubmit is valid when the workflow itself was rejected OR when the
    // workflow is still open but an approver rejected individual questions
    // (per-question rejects don't flip overallStatus).
    const hasRejectedQuestion = Array.isArray(exercise.questions) &&
      exercise.questions.some((q) => q?.approval?.status === 'rejected');
    if (!wf || (wf.overallStatus !== 'rejected' && !hasRejectedQuestion)) {
      return res.status(400).json({ message: [{ key: 'error', value: 'Only rejected exercises (or exercises with rejected questions) can be resubmitted.' }] });
    }

    // Creator gate — matches the same rule used elsewhere: createdBy is the
    // trainer's email as of exercise creation.
    const callerEmail = req.user?.email || null;
    if (!callerEmail || callerEmail !== exercise.createdBy) {
      return res.status(403).json({ message: [{ key: 'error', value: 'Only the exercise creator can resubmit for approval.' }] });
    }

    // Reset every step so the chain runs fresh; step 1 = pending, rest = waiting.
    (wf.steps || []).forEach((s, i) => {
      s.status = i === 0 ? 'pending' : 'waiting';
      s.decidedBy = null;
      s.decidedAt = null;
      s.comment = '';
      s.notifiedAt = null;
    });
    wf.currentStep = 1;
    wf.overallStatus = 'in_progress';
    wf.studentVisible = false;
    wf.completedAt = null;
    wf.initiatedAt = new Date();
    // Fresh workflow → clear the "was edited since reject" marker so future
    // reject → edit → resubmit cycles start from a clean state.
    wf.editedSinceReject = false;
    // Mark this run as a re-request so approver UIs can badge it.
    wf.resubmissionCount = (wf.resubmissionCount || 0) + 1;
    wf.lastResubmittedAt = new Date();

    // Reset per-question approvals when scope is settings_and_questions so
    // approvers re-check each question against the updated exercise.
    const scope = exercise.availabilityPeriod?.approvalScope || 'settings';
    if (scope === 'settings_and_questions' && Array.isArray(exercise.questions)) {
      exercise.questions.forEach((q) => {
        if (!q.approval) q.approval = {};
        q.approval.status = 'pending';
        q.approval.currentStepOrder = 1;
        q.approval.decidedBy = null;
        q.approval.decidedAt = null;
        q.approval.queries = [];
      });
    }

    // Stamp notifiedAt on step 1 iff the gate says fire — same idempotent
    // pattern as the create/update paths.
    const willNotifyStep1 = shouldFireStep1Notification(exercise);
    if (willNotifyStep1) {
      wf.steps[0].notifiedAt = new Date();
    }

    exercise.approvalWorkflow = wf;
    exercises[idx] = exercise;
    pedagogyRoot[tabKey].set(subcategory, exercises);
    entity.markModified(`${pedagogyPath}.${tabKey}`);
    entity.markModified(`${pedagogyPath}.${tabKey}.${subcategory}`);
    entity.markModified(`${pedagogyPath}.${tabKey}.${subcategory}.${idx}`);
    entity.markModified(`${pedagogyPath}.${tabKey}.${subcategory}.${idx}.approvalWorkflow`);
    entity.updatedBy = req.user?.email || 'system';
    entity.updatedAt = new Date();
    await entity.save();

    if (willNotifyStep1) {
      const courseIdForNotify = resolveCourseId(entity);
      const courseDoc = courseIdForNotify
        ? await CourseStructure.findById(courseIdForNotify).select('courseName').lean()
        : null;
      notifyApproversForStep({
        courseId: courseIdForNotify,
        courseName: courseDoc?.courseName,
        step: wf.steps[0],
        exerciseName: exercise.exerciseInformation?.exerciseName,
        exerciseId: exercise._id,
        isResubmit: true,
      }).catch((e) => console.warn('notifyApproversForStep (resubmit) failed:', e.message));
    }

    res.status(200).json({
      success: true,
      message: willNotifyStep1
        ? 'Resubmitted. Step-1 approver notified.'
        : 'Resubmitted. Approver will be notified once the assessment is fully configured.',
      data: { approvalWorkflow: wf },
    });
  } catch (err) {
    console.error('resubmitExerciseForApproval error:', err);
    res.status(500).json({ message: [{ key: 'error', value: err.message }] });
  }
};

// ============================================================================
// Per-question approval helpers
// ============================================================================

// Walks to the question subdoc by IDs, runs `mutate(question, exercise, wf)`,
// then persists. Common boilerplate for the three endpoints below.
const _withQuestion = async (req, res, mutate) => {
  // IMPORTANT: every early-error path must `return null` AFTER sending the
  // response — res.json() returns the res object (truthy), so `return res...`
  // would defeat the callers' `if (!result) return;` guard and make them
  // respond a second time (ERR_HTTP_HEADERS_SENT → unhandled rejection).
  const { entityType, entityId, tabType, subcategory, exerciseId, questionId } = req.body;
  if (!entityType || !entityId || !tabType || !subcategory || !exerciseId || !questionId) {
    res.status(400).json({ message: [{ key: 'error', value: 'entityType, entityId, tabType, subcategory, exerciseId, questionId all required' }] });
    return null;
  }
  if (!modelMap[entityType]) {
    res.status(400).json({ message: [{ key: 'error', value: `Invalid entityType: ${entityType}` }] });
    return null;
  }
  const { model } = modelMap[entityType];
  const entity = await model.findById(entityId);
  if (!entity) {
    res.status(404).json({ message: [{ key: 'error', value: `${entityType} not found` }] });
    return null;
  }
  const tabKey = tabType === 'I_Do' ? 'I_Do' : tabType === 'We_Do' ? 'We_Do' : 'You_Do';
  // ── Resources by Batch ───────────────────────────────────────────────
  // Locate the exercise BY ID across the shared container and every batch,
  // rather than assuming the actor's own selected batch. The batch is a
  // property of the exercise, not of the person acting on it: an approver
  // works a queue spanning every batch, so scoping to whatever their
  // Resources page happened to have selected would look in the wrong
  // container and report the exercise as missing.
  const located = locateExerciseContainer(entity, tabKey, subcategory, exerciseId);
  if (!located) {
    res.status(404).json({ message: [{ key: 'error', value: 'Exercise not found' }] });
    return null;
  }
  const { container: pedagogyRoot, basePath: pedagogyPath, exercises, index: exIdx, exercise } = located;
  const wf = exercise.approvalWorkflow;
  // Per-question actions are valid whenever the workflow is still live —
  // i.e. not finally approved. That includes 'rejected' state (approver
  // can still touch questions on an assessment they previously rejected,
  // e.g. to reject specific questions after the trainer's edits).
  if (!wf || wf.overallStatus === 'approved') {
    res.status(400).json({ message: [{ key: 'error', value: 'No active approval workflow' }] });
    return null;
  }
  const scope = exercise.availabilityPeriod?.approvalScope || 'settings';
  if (scope !== 'settings_and_questions') {
    res.status(400).json({ message: [{ key: 'error', value: 'This exercise does not require per-question approval.' }] });
    return null;
  }
  const questions = Array.isArray(exercise.questions) ? exercise.questions : [];
  const qIdx = questions.findIndex(q => String(q._id) === String(questionId));
  if (qIdx === -1) {
    res.status(404).json({ message: [{ key: 'error', value: 'Question not found' }] });
    return null;
  }
  const question = questions[qIdx];
  if (!question.approval) question.approval = { status: 'pending', queries: [] };

  await mutate({ question, exercise, exercises, exIdx, qIdx, wf, entity, tabKey, subcategory, courseInfo: { courseId: resolveCourseId(entity) } });

  // Persist
  exercises[exIdx] = exercise;
  pedagogyRoot[tabKey].set(subcategory, exercises);
  entity.markModified(`${pedagogyPath}.${tabKey}`);
  entity.markModified(`${pedagogyPath}.${tabKey}.${subcategory}`);
  entity.markModified(`${pedagogyPath}.${tabKey}.${subcategory}.${exIdx}`);
  entity.markModified(`${pedagogyPath}.${tabKey}.${subcategory}.${exIdx}.questions`);
  entity.updatedBy = req.user?.email || 'system';
  entity.updatedAt = new Date();
  await entity.save();
  return { exercise, question, wf, entity };
};

/**
 * POST /exercise/question/approve
 * Approver marks a question approved. Only allowed when caller's role matches
 * the workflow's current step.
 */
exports.approveQuestion = async (req, res) => {
  try {
    let approvedQuestion = null;
    let theWf = null;
    const result = await _withQuestion(req, res, async (ctx) => {
      const { question, wf } = ctx;
      const stepIdx = (wf.currentStep || 1) - 1;
      const step = wf.steps?.[stepIdx];
      // Per-question approval is valid while the step is still open —
      // 'pending' (normal) or 'rejected' (approver already rejected the
      // assessment step but is still walking questions before the trainer
      // resubmits). Blocks only 'approved' / 'waiting'.
      if (!step || (step.status !== 'pending' && step.status !== 'rejected')) {
        throw Object.assign(new Error('No pending step'), { statusCode: 400 });
      }
      const callerUserId = req.user?._id || req.user?.id;
      const callerRoleId = req.user?.role?._id || req.user?.role;
      const gate = await canUserActOnStep(step, callerUserId, callerRoleId);
      if (!gate.ok) {
        throw Object.assign(new Error(gate.reason), { statusCode: 403 });
      }
      if (question.approval.status === 'queried') {
        throw Object.assign(new Error('This question has an open query. Wait for the trainer to address it before approving.'), { statusCode: 400 });
      }
      // A rejected question can only be approved AFTER the trainer's edit —
      // enforced by `editedSinceReject`. Without an edit, the approver is
      // essentially reversing their own decision on unchanged content, so
      // block it.
      if (question.approval.status === 'rejected' && !question.approval.editedSinceReject) {
        throw Object.assign(new Error('This question is rejected. Wait for the trainer to edit it before approving.'), { statusCode: 400 });
      }
      question.approval.status = 'approved';
      question.approval.currentStepOrder = step.order;
      question.approval.decidedBy = req.user._id || req.user.id;
      question.approval.decidedAt = new Date();
      // Clear the reject state once approved — the row can move on to the
      // next step's clean slate (approveExerciseStep will reset per-question
      // state anyway, but this keeps the current record tidy).
      question.approval.rejectionMessage = '';
      question.approval.editedSinceReject = false;
      approvedQuestion = question;
      theWf = wf;
    });
    if (!result) return; // _withQuestion already wrote a response
    res.status(200).json({
      success: true,
      message: 'Question approved.',
      data: { approval: approvedQuestion.approval, workflow: theWf },
    });
  } catch (err) {
    const status = err.statusCode || 500;
    console.error('approveQuestion error:', err);
    res.status(status).json({ message: [{ key: 'error', value: err.message }] });
  }
};

/**
 * POST /exercise/question/approve-all
 * Bulk companion to approveQuestion — backs the common "Approve all pending"
 * button under the approver's question list. Approves every question whose
 * approval status is 'pending'. Queried and rejected questions are skipped:
 * those states carry a conversation with the trainer and must be decided
 * one by one. Same role/scope gates as the per-question endpoints.
 */
exports.approveAllQuestions = async (req, res) => {
  try {
    const { entityType, entityId, tabType, subcategory, exerciseId } = req.body;
    if (!entityType || !entityId || !tabType || !subcategory || !exerciseId) {
      return res.status(400).json({ message: [{ key: 'error', value: 'entityType, entityId, tabType, subcategory, exerciseId all required' }] });
    }
    if (!modelMap[entityType]) {
      return res.status(400).json({ message: [{ key: 'error', value: `Invalid entityType: ${entityType}` }] });
    }
    const { model } = modelMap[entityType];
    const entity = await model.findById(entityId);
    if (!entity) {
      return res.status(404).json({ message: [{ key: 'error', value: `${entityType} not found` }] });
    }
    const tabKey = tabType === 'I_Do' ? 'I_Do' : tabType === 'We_Do' ? 'We_Do' : 'You_Do';
    const located = locateExerciseContainer(entity, tabKey, subcategory, exerciseId);
    if (!located) {
      return res.status(404).json({ message: [{ key: 'error', value: 'Exercise not found' }] });
    }
    const { container: pedagogyRoot, basePath: pedagogyPath, exercises, index: exIdx, exercise } = located;
    const wf = exercise.approvalWorkflow;
    if (!wf || wf.overallStatus === 'approved') {
      return res.status(400).json({ message: [{ key: 'error', value: 'No active approval workflow' }] });
    }
    const scope = exercise.availabilityPeriod?.approvalScope || 'settings';
    if (scope !== 'settings_and_questions') {
      return res.status(400).json({ message: [{ key: 'error', value: 'This exercise does not require per-question approval.' }] });
    }
    const stepIdx = (wf.currentStep || 1) - 1;
    const step = wf.steps?.[stepIdx];
    if (!step || (step.status !== 'pending' && step.status !== 'rejected')) {
      return res.status(400).json({ message: [{ key: 'error', value: 'No pending step' }] });
    }
    const callerUserId = req.user?._id || req.user?.id;
    const callerRoleId = req.user?.role?._id || req.user?.role;
    const gate = await canUserActOnStep(step, callerUserId, callerRoleId);
    if (!gate.ok) {
      return res.status(403).json({ message: [{ key: 'error', value: gate.reason }] });
    }

    const questions = Array.isArray(exercise.questions) ? exercise.questions : [];
    let approvedCount = 0;
    let skippedQueried = 0;
    let skippedRejected = 0;
    questions.forEach((q) => {
      if (!q.approval) q.approval = { status: 'pending', queries: [] };
      const st = q.approval.status || 'pending';
      if (st === 'pending') {
        q.approval.status = 'approved';
        q.approval.currentStepOrder = step.order;
        q.approval.decidedBy = req.user._id || req.user.id;
        q.approval.decidedAt = new Date();
        q.approval.rejectionMessage = '';
        q.approval.editedSinceReject = false;
        approvedCount += 1;
      } else if (st === 'queried') {
        skippedQueried += 1;
      } else if (st === 'rejected') {
        skippedRejected += 1;
      }
    });
    if (approvedCount === 0) {
      return res.status(400).json({ message: [{ key: 'error', value: 'No pending questions to approve. Queried or rejected questions must be handled individually.' }] });
    }

    exercises[exIdx] = exercise;
    pedagogyRoot[tabKey].set(subcategory, exercises);
    entity.markModified(`${pedagogyPath}.${tabKey}`);
    entity.markModified(`${pedagogyPath}.${tabKey}.${subcategory}`);
    entity.markModified(`${pedagogyPath}.${tabKey}.${subcategory}.${exIdx}`);
    entity.markModified(`${pedagogyPath}.${tabKey}.${subcategory}.${exIdx}.questions`);
    entity.updatedBy = req.user?.email || 'system';
    entity.updatedAt = new Date();
    await entity.save();

    const skippedNote =
      skippedQueried + skippedRejected > 0
        ? ` ${skippedQueried} queried and ${skippedRejected} rejected question(s) still need individual handling.`
        : '';
    res.status(200).json({
      success: true,
      message: `${approvedCount} question(s) approved.${skippedNote}`,
      data: { approvedCount, skippedQueried, skippedRejected },
    });
  } catch (err) {
    const status = err.statusCode || 500;
    console.error('approveAllQuestions error:', err);
    res.status(status).json({ message: [{ key: 'error', value: err.message }] });
  }
};

/**
 * POST /exercise/question/reject
 * Approver rejects a question with a required message. The question's status
 * flips to 'rejected' and its creator is notified. Trainer-side edits on a
 * rejected question flip `approval.editedSinceReject = true` — that's what
 * re-opens the Approve/Reject buttons on the approver's UI.
 *
 * Semantically distinct from raiseQuestionQuery (which stays as-is for the
 * lighter "clarify" flow) — this one is a hard "fix this before we can
 * approve" and blocks the assessment-level approve until fixed.
 */
exports.rejectQuestion = async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ message: [{ key: 'error', value: 'A rejection message is required.' }] });
    }
    let target = null;
    const courseInfo = { courseId: null, courseName: null };
    const exerciseName = { name: '' };
    const result = await _withQuestion(req, res, async (ctx) => {
      const { question, wf, exercise } = ctx;
      const stepIdx = (wf.currentStep || 1) - 1;
      const step = wf.steps?.[stepIdx];
      // Accept pending OR rejected step — see comment in approveQuestion.
      if (!step || (step.status !== 'pending' && step.status !== 'rejected')) {
        throw Object.assign(new Error('No pending step'), { statusCode: 400 });
      }
      const callerUserId = req.user?._id || req.user?.id;
      const callerRoleId = req.user?.role?._id || req.user?.role;
      const gate = await canUserActOnStep(step, callerUserId, callerRoleId);
      if (!gate.ok) {
        throw Object.assign(new Error(gate.reason), { statusCode: 403 });
      }
      // Allow rejecting again (with a new comment) if the trainer already
      // re-edited a previously-rejected question — the approver may still
      // find issues. Fresh reject clears the "edited since reject" marker.
      if (question.approval.status === 'approved') {
        throw Object.assign(new Error('This question is already approved. Reject the assessment step instead if needed.'), { statusCode: 400 });
      }
      question.approval.status = 'rejected';
      question.approval.currentStepOrder = step.order;
      question.approval.decidedBy = req.user._id || req.user.id;
      question.approval.decidedAt = new Date();
      question.approval.rejectionMessage = text.trim();
      question.approval.editedSinceReject = false;

      // Recipient resolution copy of raiseQuestionQuery logic — see comment there.
      const raiserId = (req.user._id || req.user.id || '').toString();
      const raiserEmail = (req.user.email || '').toString();
      const qCreatorId = question.createdBy ? question.createdBy.toString() : '';
      const qCreatorEmail = (question.createdByEmail || '').toString();
      const sameAsRaiser =
        (qCreatorId && qCreatorId === raiserId) ||
        (qCreatorEmail && qCreatorEmail === raiserEmail);
      target = sameAsRaiser
        ? { creatorId: null, creatorEmail: exercise.createdBy || null }
        : { creatorId: question.createdBy || null, creatorEmail: question.createdByEmail || exercise.createdBy || null };

      exerciseName.name = exercise.exerciseInformation?.exerciseName || '';
      courseInfo.courseId = ctx.courseInfo.courseId;
    });
    if (!result) return;

    // Notify creator (best-effort). Same deep-link structure as the
    // assessment-level reject so a click drops the trainer on the row.
    try {
      const course = courseInfo.courseId
        ? await CourseStructure.findById(courseInfo.courseId).select('courseName').lean()
        : null;
      courseInfo.courseName = course?.courseName || '';
      const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
      const deepLinkPath = `/lms/pages/courses/uploadcourseresources?courseId=${courseInfo.courseId || ''}&nodeId=${req.body.entityId}&activeTab=${req.body.tabType}&activeSubcategory=${encodeURIComponent(req.body.subcategory)}&highlightExerciseId=${req.body.exerciseId}`;
      const deepLinkAbs = `${baseUrl}${deepLinkPath}`;
      notifySingleUser({
        userId: target?.creatorId,
        email: target?.creatorEmail,
        title: 'Question rejected',
        message: `A question in "${exerciseName.name}" was rejected: ${text.trim()}`,
        type: 'warning',
        subject: `Question rejected: ${exerciseName.name || 'a question'} (${courseInfo.courseName || ''})`,
        body: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color:#dc2626;">A question was rejected</h2>
            <p>Exercise: <strong>${exerciseName.name || '—'}</strong></p>
            <blockquote style="border-left:4px solid #dc2626; background:#fef2f2; padding:10px 14px; margin:12px 0;">${text.trim().replace(/</g, '&lt;')}</blockquote>
            <p>Open the question, address the feedback, and save. Approvers will then re-review.</p>
            <p style="margin-top:20px;"><a href="${deepLinkAbs}" style="background:#4f46e5;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;">Open assessment</a></p>
          </div>
        `,
        metadata: {
          kind: 'question_rejected',
          exerciseId: String(req.body.exerciseId),
          questionId: String(req.body.questionId),
          entityType: String(req.body.entityType),
          entityId: String(req.body.entityId),
          tabType: String(req.body.tabType),
          subcategory: String(req.body.subcategory),
          courseId: courseInfo.courseId ? String(courseInfo.courseId) : '',
          redirectUrl: deepLinkPath,
        },
      }).catch(() => {});
    } catch (e) { /* swallow */ }

    res.status(200).json({ success: true, message: 'Question rejected. Creator notified.' });
  } catch (err) {
    const status = err.statusCode || 500;
    console.error('rejectQuestion error:', err);
    res.status(status).json({ message: [{ key: 'error', value: err.message }] });
  }
};

/**
 * POST /exercise/question/query
 * Approver raises a query on a question. Notifies the question's creator.
 */
exports.raiseQuestionQuery = async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ message: [{ key: 'error', value: 'Query text is required.' }] });
    }
    let target = null;
    const courseInfo = { courseId: null, courseName: null };
    const exerciseName = { name: '' };
    const result = await _withQuestion(req, res, async (ctx) => {
      const { question, wf, exercise } = ctx;
      const stepIdx = (wf.currentStep || 1) - 1;
      const step = wf.steps?.[stepIdx];
      if (!step || (step.status !== 'pending' && step.status !== 'rejected')) {
        throw Object.assign(new Error('No pending step'), { statusCode: 400 });
      }
      const callerUserId = req.user?._id || req.user?.id;
      const callerRoleId = req.user?.role?._id || req.user?.role;
      const gate = await canUserActOnStep(step, callerUserId, callerRoleId);
      if (!gate.ok) {
        throw Object.assign(new Error(gate.reason), { statusCode: 403 });
      }
      if (!Array.isArray(question.approval.queries)) question.approval.queries = [];
      question.approval.queries.push({
        raisedBy: req.user._id || req.user.id,
        raisedByName: `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || req.user.email,
        raisedAt: new Date(),
        text: text.trim(),
        resolvedBy: null,
        resolvedAt: null,
        resolutionNote: '',
      });
      question.approval.status = 'queried';
      question.approval.currentStepOrder = step.order;
      // Resolve recipient with fallbacks so old questions (created before the
      // createdBy stamp was wired) still notify SOMEONE:
      //   1. question.createdBy (ObjectId) — newest questions
      //   2. question.createdByEmail (String) — same era
      //   3. exercise.createdBy (String, email) — the staff who created the
      //      whole exercise (always populated)
      //
      // Skip the per-question creator when it's the same person raising the
      // query (an approver who also happened to be logged in when the
      // question was originally added) — fall through to the exercise
      // creator instead so the notification reaches a different responsible
      // person, not themselves.
      const raiserId = (req.user._id || req.user.id || '').toString();
      const raiserEmail = (req.user.email || '').toString();
      const qCreatorId = question.createdBy ? question.createdBy.toString() : '';
      const qCreatorEmail = (question.createdByEmail || '').toString();
      const sameAsRaiser =
        (qCreatorId && qCreatorId === raiserId) ||
        (qCreatorEmail && qCreatorEmail === raiserEmail);
      if (sameAsRaiser) {
        target = {
          creatorId: null,
          creatorEmail: exercise.createdBy || null,
        };
      } else {
        target = {
          creatorId: question.createdBy || null,
          creatorEmail: question.createdByEmail || exercise.createdBy || null,
        };
      }
      exerciseName.name = exercise.exerciseInformation?.exerciseName || '';
      courseInfo.courseId = ctx.courseInfo.courseId;
    });
    if (!result) return;

    // Notify question creator (best-effort)
    try {
      const course = courseInfo.courseId
        ? await CourseStructure.findById(courseInfo.courseId).select('courseName').lean()
        : null;
      courseInfo.courseName = course?.courseName || '';
      notifySingleUser({
        userId: target?.creatorId,
        email: target?.creatorEmail,
        title: 'Query raised on your question',
        message: `An approver raised a query on a question in "${exerciseName.name}". Open the question to address it.`,
        type: 'warning',
        subject: `Query: ${exerciseName.name || 'a question'} (${courseInfo.courseName || ''})`,
        body: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color:#1f2937;">A query was raised on your question</h2>
            <p>Exercise: <strong>${exerciseName.name || '—'}</strong></p>
            <blockquote style="border-left:4px solid #f59e0b; background:#fffbeb; padding:10px 14px; margin:12px 0;">${text}</blockquote>
            <p>Open the question in the LMS to address the query and click <strong>Approve</strong> when done.</p>
          </div>
        `,
        metadata: { exerciseId: String(req.body.exerciseId), questionId: String(req.body.questionId) },
      }).catch(() => {});
    } catch (e) { /* swallow */ }

    res.status(200).json({ success: true, message: 'Query sent to the question creator.' });
  } catch (err) {
    const status = err.statusCode || 500;
    console.error('raiseQuestionQuery error:', err);
    res.status(status).json({ message: [{ key: 'error', value: err.message }] });
  }
};

/**
 * POST /exercise/question/resolve-query
 * Trainer marks the latest open query as addressed. Notifies the approver who
 * raised it so they can re-review. Question goes back to "pending".
 */
exports.resolveQuestionQuery = async (req, res) => {
  try {
    const { note } = req.body;
    let raiserId = null;
    let approverEmail = null;
    const courseInfo = { courseId: null, courseName: null };
    const exerciseName = { name: '' };
    const result = await _withQuestion(req, res, async (ctx) => {
      const { question, exercise } = ctx;
      if (question.approval.status !== 'queried' || !Array.isArray(question.approval.queries) || question.approval.queries.length === 0) {
        throw Object.assign(new Error('This question has no open query.'), { statusCode: 400 });
      }
      const openIdx = [...question.approval.queries].reverse().findIndex(q => !q.resolvedAt);
      if (openIdx === -1) {
        throw Object.assign(new Error('No open query to resolve.'), { statusCode: 400 });
      }
      const realIdx = question.approval.queries.length - 1 - openIdx;
      const q = question.approval.queries[realIdx];
      q.resolvedBy = req.user._id || req.user.id;
      q.resolvedByName = `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || req.user.email;
      q.resolvedAt = new Date();
      q.resolutionNote = typeof note === 'string' ? note : '';
      raiserId = q.raisedBy;
      question.approval.status = 'pending';
      question.approval.decidedBy = null;
      question.approval.decidedAt = null;
      exerciseName.name = exercise.exerciseInformation?.exerciseName || '';
      courseInfo.courseId = ctx.courseInfo.courseId;
    });
    if (!result) return;

    // Notify raiser
    try {
      if (raiserId) {
        const raiser = await User.findById(raiserId).select('email firstName lastName').lean();
        approverEmail = raiser?.email || null;
      }
      const course = courseInfo.courseId
        ? await CourseStructure.findById(courseInfo.courseId).select('courseName').lean()
        : null;
      courseInfo.courseName = course?.courseName || '';
      notifySingleUser({
        userId: raiserId,
        email: approverEmail,
        title: 'Your query has been addressed',
        message: `The trainer addressed your query on a question in "${exerciseName.name}". Re-review and approve.`,
        type: 'success',
        subject: `Query addressed: ${exerciseName.name || 'a question'} (${courseInfo.courseName || ''})`,
        body: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color:#1f2937;">A trainer addressed your query</h2>
            <p>Exercise: <strong>${exerciseName.name || '—'}</strong></p>
            ${note ? `<p>Note from the trainer:</p><blockquote style="border-left:4px solid #10b981; background:#ecfdf5; padding:10px 14px;">${note}</blockquote>` : ''}
            <p>Open the View Resources page in the LMS to re-review and approve.</p>
          </div>
        `,
        metadata: { exerciseId: String(req.body.exerciseId), questionId: String(req.body.questionId) },
      }).catch(() => {});
    } catch (e) { /* swallow */ }

    res.status(200).json({ success: true, message: 'Query marked as addressed.' });
  } catch (err) {
    const status = err.statusCode || 500;
    console.error('resolveQuestionQuery error:', err);
    res.status(status).json({ message: [{ key: 'error', value: err.message }] });
  }
};
