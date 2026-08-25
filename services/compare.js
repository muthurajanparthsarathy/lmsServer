// Output comparator for the code judge.
//
// Handles the messy edge cases that a naive === would false-fail on:
//   • Piston-returned trailing newline vs authored expectedOutput without one
//   • CRLF/LF mismatch when authored on Windows
//   • Boolean case (Python "True" vs authored "true")
//   • Numeric-tolerance (float problems don't round-trip exactly across langs)
//   • Whitespace inside JSON-array outputs ([0, 1] vs [0,1])
//
// Every question stores `expectedType` (default "exact") on the test case; a
// question authored today keeps working because "exact" mirrors the previous
// client-side normalise() logic 1-for-1.

// Collapse trailing whitespace per line, normalise line endings, trim edges —
// matches the client normalise() in code-editor.tsx / multi-file-code-editor.tsx.
const normLines = (s) =>
  String(s ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .trim();

// Python prints booleans as "True"/"False"; JS prints "true"/"false"; the bank
// stores expectedOutput as "true"/"false". Normalise both sides so a Python
// student solving Palindrome doesn't fail on the boolean literal alone.
const normBool = (s) => {
  const t = String(s ?? '').trim();
  if (/^true$/i.test(t)) return 'true';
  if (/^false$/i.test(t)) return 'false';
  return t;
};

const looksJson = (s) => {
  const t = String(s ?? '').trim();
  return (t.startsWith('[') && t.endsWith(']')) || (t.startsWith('{') && t.endsWith('}'));
};

const tryParse = (s) => {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch (_) {
    return { ok: false };
  }
};

// Deep-equal for JSON values with array-order preserved (LeetCode-style).
// Set-mode (order-insensitive) is a future addition.
const deepEqual = (a, b) => {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!deepEqual(a[k], b[k])) return false;
  return true;
};

/**
 * Compare a Piston stdout string against a test case's expectedOutput.
 * Returns true if the student's output should count as passing this case.
 *
 * @param {string} actual   raw stdout from Piston
 * @param {string} expected authored expectedOutput
 * @param {object} [opts]
 * @param {"exact"|"float"|"json"} [opts.type="exact"]
 * @param {number} [opts.epsilon=1e-6] used when type === "float"
 */
function compare(actual, expected, opts = {}) {
  const type = opts.type || 'exact';
  const epsilon = opts.epsilon ?? 1e-6;
  const a = normLines(actual);
  const e = normLines(expected);

  if (type === 'float') {
    const na = parseFloat(a), ne = parseFloat(e);
    if (Number.isFinite(na) && Number.isFinite(ne)) return Math.abs(na - ne) <= epsilon;
    // fall through to text compare
  }

  if (type === 'json' || (type === 'exact' && looksJson(a) && looksJson(e))) {
    const pa = tryParse(a), pe = tryParse(e);
    if (pa.ok && pe.ok) return deepEqual(pa.value, pe.value);
  }

  // Boolean-aware exact compare. Applied AFTER JSON check so a JSON string
  // "true" inside an array isn't mangled.
  return normBool(a) === normBool(e);
}

module.exports = { compare, normLines, normBool, deepEqual };
