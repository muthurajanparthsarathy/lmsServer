// Hide the trainer's HIDDEN test cases from the browser.
//
// The pedagogy tree ships to the browser through /getAll/courses-data/... and
// /getAll/courses-data/node-pedagogy/... endpoints. Every programming question
// carries testCases[{ input, expectedOutput, isHidden, ... }]. Before this
// filter, the whole array — hidden cases included — arrived in the student's
// browser, so a DevTools → Network peek would leak the exact inputs the
// trainer meant to withhold.
//
// We keep the row so the UI can still render "Hidden test #3 failed" (index
// preserved), and we keep the isHidden flag so the front end knows the row
// is hidden — but we blank out `input` and `expectedOutput`, which is the
// only fresh material that shouldn't leave the server.
//
// Author-side flows (trainer editing questions) call different endpoints
// (updateEntity / addQuestion), so this strip does not interfere with the
// authoring surface. The role gate below is a safety net: if the trainer
// somehow lands on the student read path with an author role, they still
// see the real inputs.

// Roles that MAY see hidden test cases in read responses. Anything else
// (student, no role, unauth) has hidden fields stripped.
const AUTHOR_LIKE = new Set([
  'admin', 'superadmin', 'staff', 'trainer', 'ld', 'l&d', 'coordinator', 'poc',
]);

function isStudentLike(user) {
  // Unauth reader → treat as student. Better a stripped false-negative for a
  // trainer viewing via anon than leaking hidden fields to the public.
  if (!user) return true;
  const raw = user.role;
  if (!raw) return true;
  // userAuthOptional populates role, so we expect an object with roleValue.
  if (typeof raw === 'object') {
    const v = String(raw.roleValue || raw.renameRole || raw.name || '').toLowerCase().trim();
    if (!v) return true;
    return !AUTHOR_LIKE.has(v);
  }
  // Legacy shape: role stored as a raw string on the user doc.
  if (typeof raw === 'string') {
    const v = raw.toLowerCase().trim();
    return !AUTHOR_LIKE.has(v);
  }
  return true;
}

// Mutate a single question object in place — blank the sensitive fields of
// any test case marked isHidden, plus the Code Setup solution (always, not
// just when hidden — Solution Code is author-only reference material and
// must never reach a student response). Idempotent. Only called from the
// student-strip paths below, so the caller has already confirmed the reader
// is student-like — no role check needed here.
function stripHiddenOnQuestion(q) {
  if (!q) return;
  if (q.solutionCode !== undefined) {
    q.solutionCode = typeof q.solutionCode === 'string' ? '' : { html: '', css: '', javascript: '' };
  }
  if (!Array.isArray(q.testCases)) return;
  for (let i = 0; i < q.testCases.length; i++) {
    const tc = q.testCases[i];
    if (tc && tc.isHidden) {
      // Preserve index / isHidden / points; blank the material.
      tc.input = '';
      tc.expectedOutput = '';
      if (tc.explanation) tc.explanation = '';
    }
  }
}

// Walk one pedagogy container ({ I_Do, We_Do, You_Do }) and hit every
// question. Handles both Map and plain-object containers (Mongoose Map fields
// come out as Map after .lean() only if leanVirtuals is off — the codebase
// mostly uses .lean() and gets plain objects).
function stripPedagogyContainer(container) {
  if (!container) return;
  for (const section of ['I_Do', 'We_Do', 'You_Do']) {
    const map = container[section];
    if (!map) continue;
    const entries = typeof map.entries === 'function'
      ? Array.from(map.entries())
      : Object.entries(map);
    for (const [, list] of entries) {
      if (!Array.isArray(list)) continue;
      for (const ex of list) {
        if (!ex || !Array.isArray(ex.questions)) continue;
        for (const q of ex.questions) stripHiddenOnQuestion(q);
      }
    }
  }
}

/**
 * Strip hidden testCases from a node document (from getNodePedagogy) that is
 * about to be sent to the student. Walks pedagogy + every batchPedagogy
 * bucket. Mutates in place.
 */
function stripHiddenForStudent(node, user) {
  if (!node || !isStudentLike(user)) return;
  stripPedagogyContainer(node.pedagogy);
  const bp = node.batchPedagogy;
  if (bp) {
    const buckets = typeof bp.entries === 'function'
      ? Array.from(bp.entries()).map(([, v]) => v)
      : Object.values(bp);
    for (const bucket of buckets) stripPedagogyContainer(bucket);
  }
}

// Deep variant for getAllCoursesData shape (modules → topics → subTopics …)
// where each node may carry its own `pedagogy` and `batchPedagogy`. Recurses
// via the arrays that Mongoose emits at each level. Cheap because it only
// dives into arrays whose names match the well-known child buckets.
function stripHiddenForStudentDeep(root, user) {
  if (!root || !isStudentLike(user)) return;
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.pedagogy) stripPedagogyContainer(node.pedagogy);
    if (node.batchPedagogy) {
      const bp = node.batchPedagogy;
      const buckets = typeof bp.entries === 'function'
        ? Array.from(bp.entries()).map(([, v]) => v)
        : Object.values(bp);
      for (const b of buckets) stripPedagogyContainer(b);
    }
    // Standard child buckets used across the pedagogy tree.
    for (const key of ['modules', 'subModules', 'topics', 'subTopics']) {
      const arr = node[key];
      if (Array.isArray(arr)) for (const child of arr) visit(child);
    }
  };
  visit(root);
  // Also handle common outer wrappers: { modules: [...] } or an array root.
  if (Array.isArray(root)) for (const item of root) visit(item);
}

module.exports = {
  stripHiddenForStudent,
  stripHiddenForStudentDeep,
  stripHiddenOnQuestion,
  isStudentLike,
};
