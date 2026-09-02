// server/utils/topicCompletion.js
// ─────────────────────────────────────────────────────────────────────────────
// Server-authoritative topic-completion aggregator.
//
// Pure functions — no Mongo, no I/O. Given a course tree (as returned by
// `getAllCoursesData`) and a student's `courses[i].answers` shape, computes
// per-node completion across I Do / We Do / You Do so the sidebar tick and
// the "topic complete" rollup have one source of truth.
//
// Semantic rules (mirror the ones documented in the plan file):
//   • I Do resources with 0 configured MCQs → auto-satisfied.
//   • I Do resources with N configured MCQs → complete only when every
//     MCQ id has a matching `answers.I_Do[bucket][*].questions[]` entry
//     with status in {solved, submitted, evaluated}.
//   • We Do exercises → complete when a matching
//     `answers.We_Do[bucket][*]` entry has `status === 'completed'` or
//     `testSubmissions >= 1` (mirrors the client's resolveAssignmentState).
//   • You Do → same as We Do for exercise buckets; MCQ-shaped buckets
//     (test_your_skills, etc.) use the I Do MCQ rule.
//   • Missed / Closed exercises → naturally incomplete (no matching
//     answer entry). No special-cased downgrade.
//   • Empty stage (nothing required) → does NOT block topic completion.
//   • Aggregate: a node's rollup includes its own pedagogy + every
//     descendant's pedagogy, so a module row rolls up its whole subtree.
//
// The result is a `{ [nodeId]: { status, ... } }` map. `status` is one of
// `completed | in_progress | not_started`. Absent nodes → treat as
// `not_started` on the client.

'use strict';

const MCQ_COMPLETE_STATUSES = new Set(['solved', 'submitted', 'evaluated']);

// Same statuses the client's resolveAssignmentState treats as terminal
// "completed". `testSubmissions >= 1` is the other completion path
// (set by answer.js on full test submits).
const EXERCISE_COMPLETE_STATUS = 'completed';

const asId = (v) => (v == null ? '' : String(v));

// The `answers` maps in `user.courses[i].answers` may arrive as Mongoose
// Maps (post-`.lean()` they usually become plain objects, but toObject() +
// Map paths still surface as Map). Normalise to a plain lookup once.
function toPlainMap(mapish) {
  if (!mapish) return {};
  if (mapish instanceof Map) return Object.fromEntries(mapish);
  if (typeof mapish === 'object') return mapish;
  return {};
}

// Recursively collect every file under a pedagogyElement (files +
// folders[].files + nested subfolders).
function collectFilesFromElement(element) {
  if (!element || typeof element !== 'object') return [];
  const files = [];
  const walkFolder = (folder) => {
    if (!folder || typeof folder !== 'object') return;
    if (Array.isArray(folder.files)) files.push(...folder.files);
    // subfolders is Mixed — may be an array or nested folders.
    const sub = folder.subfolders;
    if (Array.isArray(sub)) sub.forEach(walkFolder);
  };
  if (Array.isArray(element.files)) files.push(...element.files);
  if (Array.isArray(element.folders)) element.folders.forEach(walkFolder);
  return files;
}

// A file's REQUIRED MCQ ids — the ones a student must submit for the file
// to count as complete. `isActive: false` MCQs are excluded (matches the
// author's own "hide this question" toggle).
function requiredMcqIdsForFile(file) {
  if (!file || !Array.isArray(file.mcqQuestions)) return [];
  const ids = [];
  for (const mcq of file.mcqQuestions) {
    if (!mcq) continue;
    if (mcq.isActive === false) continue;
    const id = asId(mcq._id);
    if (id) ids.push(id);
  }
  return ids;
}

// Build a Set of every question id the student has submitted (satisfying
// MCQ_COMPLETE_STATUSES) inside a single answer bucket's exerciseProgress
// array. The client stores MCQ answers as questionAnswerSchema entries
// nested under any exerciseProgress in the bucket, so we flatten.
function submittedQuestionIdsInBucket(bucketArr) {
  const set = new Set();
  if (!Array.isArray(bucketArr)) return set;
  for (const progress of bucketArr) {
    if (!progress || !Array.isArray(progress.questions)) continue;
    for (const q of progress.questions) {
      if (!q) continue;
      if (!MCQ_COMPLETE_STATUSES.has(q.status)) continue;
      const id = asId(q.questionId);
      if (id) set.add(id);
    }
  }
  return set;
}

// Union of submitted question ids across every bucket under a stage
// (I_Do, We_Do, or You_Do). File-level MCQs are attached to files, but
// students may answer them from any resource surface, so we don't require
// the bucket key to match — we just look for the question id.
function submittedQuestionIdsInStage(stageAnswers) {
  const total = new Set();
  const map = toPlainMap(stageAnswers);
  for (const key of Object.keys(map)) {
    const bucketSet = submittedQuestionIdsInBucket(map[key]);
    for (const id of bucketSet) total.add(id);
  }
  return total;
}

// Whether an exercise has been completed (as We Do / You Do exercises are).
// Mirrors the client's rule: `status === 'completed'` OR `testSubmissions >= 1`.
function exerciseIsComplete(exerciseId, stageAnswers) {
  const targetId = asId(exerciseId);
  if (!targetId) return false;
  const map = toPlainMap(stageAnswers);
  for (const key of Object.keys(map)) {
    const arr = map[key];
    if (!Array.isArray(arr)) continue;
    for (const progress of arr) {
      if (!progress) continue;
      const pid = asId(progress.exerciseId) || asId(progress._id);
      if (pid !== targetId) continue;
      if (progress.status === EXERCISE_COMPLETE_STATUS) return true;
      if ((progress.testSubmissions || 0) >= 1) return true;
    }
  }
  return false;
}

// Approval gate — matches the same rule getAllCoursesData / getNodePedagogy
// apply. An exercise whose workflow exists and hasn't flipped studentVisible
// stays hidden from students, so the aggregator must not require it either.
function isStudentRequired(exercise) {
  if (!exercise || typeof exercise !== 'object') return false;
  const wf = exercise.approvalWorkflow;
  if (!wf || !Array.isArray(wf.steps) || wf.steps.length === 0) return true;
  return !!wf.studentVisible;
}

// ─── Per-stage completion ───────────────────────────────────────────────────

// I Do: count every required MCQ across every resource in every bucket.
// Resources without an MCQ are auto-satisfied and contribute nothing to
// the totals — they can never block completion, matching the spec.
function computeIDoStage(pedagogy, answers) {
  const iDoAnswers = toPlainMap(answers && answers.I_Do);
  const submittedIds = submittedQuestionIdsInStage(iDoAnswers);
  let total = 0;
  let completed = 0;
  const buckets = toPlainMap(pedagogy && pedagogy.I_Do);
  for (const bucketKey of Object.keys(buckets)) {
    const element = buckets[bucketKey];
    const files = collectFilesFromElement(element);
    for (const file of files) {
      const required = requiredMcqIdsForFile(file);
      for (const id of required) {
        total += 1;
        if (submittedIds.has(id)) completed += 1;
      }
    }
  }
  return { total, completed, complete: total === 0 || completed === total };
}

// We Do / You Do exercise arrays.
function computeExerciseStageBucket(bucketArr, stageAnswers) {
  let total = 0;
  let completed = 0;
  if (!Array.isArray(bucketArr)) return { total, completed };
  for (const exercise of bucketArr) {
    if (!isStudentRequired(exercise)) continue;
    total += 1;
    if (exerciseIsComplete(exercise && exercise._id, stageAnswers)) completed += 1;
  }
  return { total, completed };
}

// A You Do bucket may be either:
//   • an array of exercises (Assessment lists), OR
//   • an object with `questions[]` (test_your_skills / quick quiz), OR
//   • an object whose values are arrays of exercises.
// This covers each shape while staying strict enough not to double-count.
function computeYouDoBucket(bucketValue, stageAnswers, submittedIds) {
  if (Array.isArray(bucketValue)) {
    return computeExerciseStageBucket(bucketValue, stageAnswers);
  }
  if (!bucketValue || typeof bucketValue !== 'object') {
    return { total: 0, completed: 0 };
  }
  // MCQ-shaped bucket (test_your_skills): treat like I Do MCQs.
  if (Array.isArray(bucketValue.questions)) {
    let total = 0;
    let completed = 0;
    for (const q of bucketValue.questions) {
      if (!q) continue;
      if (q.isActive === false) continue;
      const id = asId(q._id) || asId(q.questionId);
      if (!id) continue;
      total += 1;
      if (submittedIds.has(id)) completed += 1;
    }
    return { total, completed };
  }
  // Nested object of exercise arrays.
  let total = 0;
  let completed = 0;
  for (const key of Object.keys(bucketValue)) {
    const value = bucketValue[key];
    if (Array.isArray(value)) {
      const c = computeExerciseStageBucket(value, stageAnswers);
      total += c.total;
      completed += c.completed;
    }
  }
  return { total, completed };
}

function computeWeDoStage(pedagogy, answers) {
  const stageAnswers = toPlainMap(answers && answers.We_Do);
  const buckets = toPlainMap(pedagogy && pedagogy.We_Do);
  let total = 0;
  let completed = 0;
  for (const key of Object.keys(buckets)) {
    const c = computeExerciseStageBucket(buckets[key], stageAnswers);
    total += c.total;
    completed += c.completed;
  }
  return { total, completed, complete: total === 0 || completed === total };
}

function computeYouDoStage(pedagogy, answers) {
  const stageAnswers = toPlainMap(answers && answers.You_Do);
  const submittedIds = submittedQuestionIdsInStage(stageAnswers);
  const buckets = toPlainMap(pedagogy && pedagogy.You_Do);
  let total = 0;
  let completed = 0;
  for (const key of Object.keys(buckets)) {
    const c = computeYouDoBucket(buckets[key], stageAnswers, submittedIds);
    total += c.total;
    completed += c.completed;
  }
  return { total, completed, complete: total === 0 || completed === total };
}

// ─── Per-node local + rollup ────────────────────────────────────────────────

function computeNodeLocal(node, answers) {
  const pedagogy = node && node.pedagogy;
  const iDo = computeIDoStage(pedagogy, answers);
  const weDo = computeWeDoStage(pedagogy, answers);
  const youDo = computeYouDoStage(pedagogy, answers);
  const total = iDo.total + weDo.total + youDo.total;
  const completed = iDo.completed + weDo.completed + youDo.completed;
  return { iDo, weDo, youDo, total, completed };
}

function statusFrom(total, completed) {
  if (total === 0) return 'not_started';
  if (completed >= total) return 'completed';
  if (completed > 0) return 'in_progress';
  return 'not_started';
}

function makeEntry(local, rolledIDo, rolledWeDo, rolledYouDo) {
  const total = rolledIDo.total + rolledWeDo.total + rolledYouDo.total;
  const completed = rolledIDo.completed + rolledWeDo.completed + rolledYouDo.completed;
  return {
    status: statusFrom(total, completed),
    completedRequiredItems: completed,
    totalRequiredItems: total,
    iDoComplete: rolledIDo.total === 0 || rolledIDo.completed === rolledIDo.total,
    weDoComplete: rolledWeDo.total === 0 || rolledWeDo.completed === rolledWeDo.total,
    youDoComplete: rolledYouDo.total === 0 || rolledYouDo.completed === rolledYouDo.total,
    iDo: { total: rolledIDo.total, completed: rolledIDo.completed },
    weDo: { total: rolledWeDo.total, completed: rolledWeDo.completed },
    youDo: { total: rolledYouDo.total, completed: rolledYouDo.completed },
  };
}

// Depth-first walk. Adds each node's own local counts to its descendants'
// rollups, and writes ONE entry per visited node id into `out`.
function walk(node, answers, out) {
  if (!node || typeof node !== 'object') {
    return {
      iDo: { total: 0, completed: 0 },
      weDo: { total: 0, completed: 0 },
      youDo: { total: 0, completed: 0 },
    };
  }
  const local = computeNodeLocal(node, answers);
  let rolled = {
    iDo: { ...local.iDo },
    weDo: { ...local.weDo },
    youDo: { ...local.youDo },
  };
  const children = []
    .concat(Array.isArray(node.subModules) ? node.subModules : [])
    .concat(Array.isArray(node.topics) ? node.topics : [])
    .concat(Array.isArray(node.subTopics) ? node.subTopics : []);
  for (const child of children) {
    const childRolled = walk(child, answers, out);
    rolled.iDo.total += childRolled.iDo.total;
    rolled.iDo.completed += childRolled.iDo.completed;
    rolled.weDo.total += childRolled.weDo.total;
    rolled.weDo.completed += childRolled.weDo.completed;
    rolled.youDo.total += childRolled.youDo.total;
    rolled.youDo.completed += childRolled.youDo.completed;
  }
  const nodeId = asId(node._id);
  if (nodeId) {
    out[nodeId] = makeEntry(local, rolled.iDo, rolled.weDo, rolled.youDo);
  }
  return rolled;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Compute a `{ [nodeId]: entry }` map for every node in a structured course
 * that has an `_id`. Safe to call with `answers = null` (returns
 * everything as `not_started`).
 */
function computeCourseTopicProgress(structuredCourse, answers) {
  const out = {};
  if (!structuredCourse) return out;
  const modules = Array.isArray(structuredCourse.modules)
    ? structuredCourse.modules
    : [];
  for (const module of modules) walk(module, answers, out);
  return out;
}

/**
 * Locate the requesting student's answers on a fully-populated course
 * document (as `getAllCoursesData` returns it). Returns `null` when the
 * caller is anonymous or not enrolled.
 */
function findStudentAnswers(course, userId) {
  if (!course || !userId) return null;
  const target = String(userId);
  const batches = Array.isArray(course.batchAndParticipants)
    ? course.batchAndParticipants
    : [];
  const courseId = asId(course._id);
  for (const batch of batches) {
    const users = Array.isArray(batch && batch.users) ? batch.users : [];
    for (const p of users) {
      const inner = p && p.user;
      if (!inner) continue;
      const innerId = asId(inner._id);
      if (innerId !== target) continue;
      const enrollments = Array.isArray(inner.courses) ? inner.courses : [];
      const match = enrollments.find(
        (c) => c && asId(c.courseId) === courseId,
      );
      return (match && match.answers) || null;
    }
  }
  return null;
}

module.exports = {
  computeCourseTopicProgress,
  findStudentAnswers,
  // Exported for tests + future callers that already have answers in hand.
  computeIDoStage,
  computeWeDoStage,
  computeYouDoStage,
  computeNodeLocal,
  isStudentRequired,
  MCQ_COMPLETE_STATUSES,
};
