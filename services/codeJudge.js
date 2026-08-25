// Server-authoritative code judge.
//
// Replaces the client-side test-case loops that used to live in
// multi-file-code-editor.tsx and code-editor.tsx. The score a student sees
// is now computed here from the actual Piston output — the submit endpoint
// discards any score the client sends.
//
// Flow per submission:
//   1. Pick an entry file. For a single-file submission that's the only file;
//      for a multi-file project the explicit isEntryPoint file wins, else the
//      first file that matches the language, else file[0]. Mirrors the
//      existing pistonClient.ts pickEntryIndex() logic 1-for-1 so nothing
//      about which file executes changes when we move to the server.
//   2. Run driverInjector.decide() on the entry file's content. When the
//      student wrote a bare function (LeetCode-style), we append a driver
//      that reads stdin and prints the return value — the rest of the project
//      files ride along unchanged. When the student wrote a full program
//      (has input()/Scanner/cin), decide() returns stdio mode and nothing
//      is appended.
//   3. Loop the question's testCases[] and call Piston with stdin = tc.input
//      each time. A 300ms gap between calls matches the soft rate-limit the
//      old client-side loop used against public emkc.org — cheap on the
//      self-hosted container and lets us swap to emkc as fallback later.
//   4. compare(stdout, tc.expectedOutput, { type: tc.expectedType }) →
//      per-case pass/fail. Aggregate for score + status + breakdown.
//
// The breakdown shape matches what submitAnswer's sanitizer already expects
// (method: 'testcase', testcase: { passed, total, cases: [...] }) so the
// controller's persistence path is untouched — we swap the client-computed
// object for a server-computed one and everything downstream keeps working.

const { compare } = require('./compare');
const { decide } = require('./driverInjector');

// Match pistonClient.ts's pinned runtime versions so a submission judged on
// the server behaves identically to what the "Run" button did previously.
const PISTON_RUNTIMES = {
  python:     { language: 'python',     version: '3.10.0' },
  javascript: { language: 'javascript', version: '18.15.0' },
  typescript: { language: 'typescript', version: '5.0.3' },
  java:       { language: 'java',       version: '15.0.2' },
  cpp:        { language: 'cpp',        version: '10.2.0' },
  c:          { language: 'c',          version: '10.2.0' },
  go:         { language: 'go',         version: '1.16.2' },
  csharp:     { language: 'csharp',     version: '6.12.0' },
};

const PISTON_URL =
  process.env.PISTON_INTERNAL_URL
    ? `${process.env.PISTON_INTERNAL_URL.replace(/\/$/, '')}/api/v2/execute`
    : 'http://localhost:2000/api/v2/execute';

// Language filename hint. Java is the exception because Piston insists the
// filename match the public class — we peek at the source for the class name.
function pistonFilename(language, path, content) {
  const clean = String(path || '').replace(/^\/+/, '');
  const lang = (language || '').toLowerCase();
  if (lang === 'java') {
    const m = String(content || '').match(/public\s+class\s+(\w+)/);
    if (m) {
      const dir = clean.includes('/') ? clean.slice(0, clean.lastIndexOf('/') + 1) : '';
      return `${dir}${m[1]}.java`;
    }
    return 'Main.java';
  }
  const extByLang = {
    python: 'py', javascript: 'js', typescript: 'ts',
    cpp: 'cpp', c: 'c', go: 'go', csharp: 'cs',
  };
  if (clean) return clean;
  return `main.${extByLang[lang] || 'txt'}`;
}

// Same entry-point selection rule as pistonClient.ts. Kept in sync so an
// existing multi-file question runs the same file server-side as it did
// client-side pre-migration.
function pickEntryIndex(files, language) {
  if (!Array.isArray(files) || files.length === 0) return -1;
  const explicit = files.findIndex((f) => f.isEntryPoint);
  if (explicit >= 0) return explicit;
  const conventional = {
    python: 'main.py', javascript: 'main.js', typescript: 'main.ts',
    java: 'Main.java', cpp: 'main.cpp', c: 'main.c', go: 'main.go', csharp: 'main.cs',
  }[(language || '').toLowerCase()];
  if (conventional) {
    const byName = files.findIndex((f) => String(f.path || f.filename || '').split('/').pop()?.toLowerCase() === conventional.toLowerCase());
    if (byName >= 0) return byName;
  }
  return 0;
}

async function callPiston({ language, files, stdin, runTimeoutMs = 5000 }) {
  const rt = PISTON_RUNTIMES[(language || '').toLowerCase()] || PISTON_RUNTIMES.python;
  const body = {
    language: rt.language,
    version: rt.version,
    files: files.map((f) => ({ name: f.name, content: f.content })),
    stdin: stdin || '',
    args: [],
    compile_timeout: 10000,
    run_timeout: runTimeoutMs,
    compile_memory_limit: -1,
    run_memory_limit: -1,
  };
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(PISTON_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { networkError: e?.message || String(e), timeMs: Date.now() - t0 };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { httpError: `Piston HTTP ${res.status}: ${text.slice(0, 300)}`, timeMs: Date.now() - t0 };
  }
  const data = await res.json();
  const run = data.run || {};
  const compile = data.compile || null;
  return {
    stdout: run.stdout || '',
    stderr: run.stderr || '',
    exitCode: typeof run.code === 'number' ? run.code : null,
    signal: run.signal || null,
    compileError: compile && compile.code ? (compile.stderr || compile.output || '') : '',
    timeMs: Date.now() - t0,
  };
}

/**
 * Judge a submission.
 *
 * @param {object} opts
 * @param {string} opts.language           "python" | "javascript" | ...
 * @param {Array}  opts.files              [{ path, content, isEntryPoint }]
 * @param {Array}  opts.testCases          [{ input, expectedOutput, isHidden, expectedType?, epsilon?, points? }]
 * @param {number} [opts.maxMarks=10]      question's total marks
 * @param {string} [opts.functionName]     explicit function name (from solutions.functionName)
 * @param {number} [opts.runTimeoutMs=5000]
 *
 * @returns {object} {
 *   passed, total, score, maxMarks, status,           ← headline numbers
 *   perCase: [ { index, passed, hidden, input, expectedOutput, actualOutput, timeMs, verdict } ],
 *   mode: 'stdio' | 'function',   fnName,   injected,
 *   log: [ ...human-readable lines for the terminal panel ],
 * }
 */
async function judge(opts) {
  const {
    language,
    files = [],
    testCases = [],
    maxMarks = 10,
    functionName = null,
    // 10s ceiling — matches the /api/run/piston clamp, covers Java cold-JVM
    // (~1.5s typical, up to ~5s under Piston queue contention), and still
    // leaves an intentionally-tight bound to catch student infinite loops.
    runTimeoutMs = 10000,
  } = opts || {};

  const log = [];
  const push = (t, s) => log.push({ type: t, text: s });

  if (!files.length) {
    push('error', 'No code files to judge.');
    return {
      passed: 0, total: 0, score: 0, maxMarks, status: 'submitted',
      perCase: [], mode: 'stdio', fnName: null, injected: false, log,
    };
  }
  if (!testCases.length) {
    push('info', 'No test cases configured on this question — code saved without an auto-score.');
    return {
      passed: 0, total: 0, score: 0, maxMarks, status: 'submitted',
      perCase: [], mode: 'stdio', fnName: null, injected: false, log,
    };
  }

  const entryIdx = pickEntryIndex(files, language);
  const entryFile = files[entryIdx];
  const decision = decide({
    language,
    code: entryFile.content || '',
    functionName,
  });
  push('system', decision.reason);

  // Build the Piston file set once. Entry file first (Piston runs files[0]),
  // entry content is the driver-augmented version when we injected one.
  const buildPistonFiles = () => {
    const ordered = [entryFile, ...files.filter((_, i) => i !== entryIdx)];
    return ordered.map((f, i) => ({
      name: pistonFilename(language, f.path || f.filename, i === 0 ? decision.fullCode : (f.content || '')),
      content: i === 0 ? decision.fullCode : (f.content || ''),
    }));
  };

  const pistonFiles = buildPistonFiles();
  const perCase = [];
  let passed = 0;

  push('system', `🧪 Running ${testCases.length} test case${testCases.length > 1 ? 's' : ''}…`);

  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i];
    const label = tc.isHidden ? `Hidden test #${i + 1}` : `Test #${i + 1}`;
    const stdin = String(tc.input ?? '');
    const expected = String(tc.expectedOutput ?? '');

    let r = await callPiston({ language, files: pistonFiles, stdin, runTimeoutMs });
    // Piston queue-under-load can SIGKILL a Java/JVM process that would
    // normally finish in ~1s. Retry ONCE on TLE with a fresh call — if the
    // student's code really is looping, the second attempt SIGKILLs too and
    // the verdict stays TLE, so an infinite loop still fails cleanly.
    if (r.signal === 'SIGKILL' && !r.stdout) {
      const retry = await callPiston({ language, files: pistonFiles, stdin, runTimeoutMs });
      if (retry.signal !== 'SIGKILL' || retry.stdout) r = retry;
    }

    let ok = false;
    let actual = '';
    let verdict = 'WA';

    if (r.networkError) {
      verdict = 'JE'; // judge error
      actual = `(judge error: ${r.networkError})`;
      push('error', `✗ ${label} — ${actual}`);
    } else if (r.httpError) {
      verdict = 'JE';
      actual = `(judge error: ${r.httpError})`;
      push('error', `✗ ${label} — ${actual}`);
    } else if (r.compileError) {
      verdict = 'CE';
      actual = `compile: ${r.compileError.split('\n')[0]}`;
      push('error', `✗ ${label} failed — ${actual}`);
    } else if (r.signal === 'SIGKILL') {
      verdict = 'TLE';
      actual = '(time limit exceeded)';
      push('error', `✗ ${label} — Time Limit Exceeded`);
    } else if (r.exitCode !== 0 && r.exitCode !== null && !r.stdout) {
      verdict = 'RE';
      // Pull the LAST non-empty stderr line — Python throws that as the
      // exception name+message ("NameError: name 'isEven' is not defined"),
      // which is what the student needs. First line ("Traceback (most
      // recent call last):") is noise.
      if (r.stderr) {
        const lines = r.stderr.split('\n').map((l) => l.trim()).filter(Boolean);
        actual = lines[lines.length - 1] || r.stderr.split('\n')[0] || `runtime error (exit ${r.exitCode})`;
      } else {
        actual = `runtime error (exit ${r.exitCode})`;
      }
      push('error', `✗ ${label} — Runtime Error: ${actual}`);
    } else {
      ok = compare(r.stdout, expected, {
        type: tc.expectedType || 'exact',
        epsilon: tc.epsilon,
      });
      // When there's a runtime error mixed with test output, surface the LAST
      // non-empty stderr line — for Python that's the exception name+message
      // ("NameError: name 'isEven' is not defined"), which is what the
      // student actually needs to see to debug. The first line of a
      // traceback is always the useless "Traceback (most recent call
      // last):" header.
      const trimmedStdout = (r.stdout || '').trim();
      let stderrTail = '';
      if (r.stderr) {
        const lines = r.stderr.split('\n').map((l) => l.trim()).filter(Boolean);
        stderrTail = lines[lines.length - 1] || '';
      }
      actual = trimmedStdout || stderrTail || '';
      verdict = ok ? 'AC' : 'WA';
      if (ok) {
        passed++;
        push('success', `✓ ${label} passed`);
      } else if (tc.isHidden) {
        push('error', `✗ ${label} failed`);
      } else {
        push('error', `✗ ${label} failed — expected: ${expected} | got: ${actual || '(no output)'}`);
      }
    }

    perCase.push({
      index: i,
      passed: ok,
      hidden: !!tc.isHidden,
      input: stdin,
      expectedOutput: expected,
      actualOutput: actual,
      timeMs: r.timeMs || 0,
      verdict,
    });

    // Soft pacing between cases — matches the previous client-loop behaviour
    // (300ms cheap on self-hosted, useful if we ever proxy to public emkc).
    if (i < testCases.length - 1) await new Promise((r) => setTimeout(r, 300));
  }

  const score = Math.round((passed / testCases.length) * maxMarks * 100) / 100;
  const status = passed === testCases.length ? 'solved' : 'submitted';

  push(
    passed === testCases.length ? 'success' : 'info',
    `🏁 Passed ${passed}/${testCases.length} — Score: ${score}/${maxMarks}`,
  );

  return {
    passed,
    total: testCases.length,
    score,
    maxMarks,
    status,
    perCase,
    mode: decision.mode,
    fnName: decision.fnName,
    injected: decision.injected,
    log,
  };
}

module.exports = { judge, callPiston, pickEntryIndex, pistonFilename, PISTON_URL };
