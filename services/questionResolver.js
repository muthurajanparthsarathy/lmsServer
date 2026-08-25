// Authoritative question fetch — used by the server judge so the trainer's
// hidden test cases and function name are read from the pedagogy tree, not
// from whatever the browser happens to send.
//
// Mirrors the same lookup the existing `getRerunContext` /
// `rerunSubmissions` controllers use (nodeType + nodeId → live Mongoose
// entity → locateExerciseContainer → exercise.questions[i]). That path is
// already the source of truth for "which test cases belong to this
// question" on the trainer re-run flow; reusing it here keeps student
// submissions judged against the exact same data.
//
// Returns null when the question can't be found so the caller can decide
// how to degrade (fall back to client-sent testCases, log a warning,
// or refuse to score). Never throws for a bad lookup — those are
// legitimate "question was deleted" cases.

const mongoose = require('mongoose');
const { locateExerciseContainer } = require('../utils/pedagogyScope');

const MODEL_MAP_LAZY = () => ({
  module:    mongoose.model('Module1'),
  submodule: mongoose.model('SubModule1'),
  topic:     mongoose.model('Topic1'),
  subtopic:  mongoose.model('SubTopic1'),
});

/**
 * resolveQuestion({ nodeType, nodeId, category, subcategory, exerciseId, questionId })
 *
 * @returns {object|null} the raw question sub-document (with testCases[],
 *                         solutions.functionName, score/points, questionType),
 *                         or null if any lookup step fails.
 */
async function resolveQuestion({
  nodeType,
  nodeId,
  category,
  subcategory,
  exerciseId,
  questionId,
}) {
  if (!nodeType || !nodeId || !category || !exerciseId || !questionId) return null;

  const models = MODEL_MAP_LAZY();
  const Model = models[String(nodeType).toLowerCase()];
  if (!Model) return null;

  let entity;
  try {
    entity = await Model.findById(nodeId);
  } catch (_) {
    return null;
  }
  if (!entity) return null;

  const located = locateExerciseContainer(entity, category, subcategory, exerciseId);
  if (!located || !located.exercise) return null;

  const question = (located.exercise.questions || [])
    .find((q) => q && String(q._id) === String(questionId));
  return question || null;
}

/**
 * Convenience: return only the fields the judge needs, with sensible defaults.
 * Returns null when resolveQuestion returns null.
 */
async function loadForJudge(args) {
  const q = await resolveQuestion(args);
  if (!q) return null;
  return {
    testCases: Array.isArray(q.testCases) ? q.testCases : [],
    functionName: (q.solutions && q.solutions.functionName) || null,
    maxMarks: Number(q.score ?? q.points ?? 10) || 10,
    questionType: q.questionType || null,
    raw: q,
  };
}

module.exports = { resolveQuestion, loadForJudge };
