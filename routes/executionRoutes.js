// Server-side Piston proxy.
//
// Two reasons this exists:
//   1. The self-hosted Piston container sits on localhost:2000 with no CORS,
//      and the previous same-origin rewrite in next.config.ts let the browser
//      hit it directly. That path bypasses any per-user throttling — if a
//      student pastes an infinite loop and keeps clicking Run they can pin
//      the container. This proxy gates every call through auth + a small
//      rate limit.
//   2. The judge now runs on the server (codeJudge). Keeping the "Run"
//      button on the same server endpoint means the whole coding surface
//      talks to Piston through ONE choke-point we can observe and tune.
//
// The response shape mirrors what pistonClient.ts expected from Piston
// directly (stdout / stderr / output / code / signal / time), so the client
// keeps working after we just repoint the URL.

const express = require('express');
const { userAuth } = require('../middlewares/userAuth');
const { callPiston, judge } = require('../services/codeJudge');

const router = express.Router();

// Very small in-process limiter: at most 1 in-flight run per user and 10
// runs / minute per user. Enough to blunt accidental hot-loops from the
// browser without needing Redis on day one; move to a real store when we
// add the submission queue in Phase 3.
const inflight = new Map();     // userId → number of active runs
const window = new Map();       // userId → [timestamps within last 60s]
const MAX_INFLIGHT = 1;
const MAX_PER_MINUTE = 10;

function throttle(userId) {
  const now = Date.now();
  const flightN = inflight.get(userId) || 0;
  if (flightN >= MAX_INFLIGHT) return 'busy';
  const recent = (window.get(userId) || []).filter((t) => now - t < 60_000);
  if (recent.length >= MAX_PER_MINUTE) return 'rate';
  recent.push(now);
  window.set(userId, recent);
  inflight.set(userId, flightN + 1);
  return null;
}
function release(userId) {
  const n = inflight.get(userId) || 0;
  if (n <= 1) inflight.delete(userId);
  else inflight.set(userId, n - 1);
}

router.post('/run/piston', userAuth, async (req, res) => {
  const userId = String(req.user?._id || 'anon');
  const gate = throttle(userId);
  if (gate === 'busy') {
    return res.status(429).json({ error: 'A previous run is still in progress.' });
  }
  if (gate === 'rate') {
    return res.status(429).json({ error: 'Too many runs — try again in a minute.' });
  }

  try {
    const {
      language,
      files = [],
      stdin = '',
      run_timeout,           // client may pass; capped below
    } = req.body || {};

    if (!language || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'language and files[] are required.' });
    }

    // Trust the client to hand us { name, content } — that's the shape
    // pistonClient.ts already sends. Cap total payload as a cheap DoS guard.
    const totalBytes = files.reduce((n, f) => n + (f?.content?.length || 0), 0);
    if (totalBytes > 200_000) {
      return res.status(413).json({ error: 'Total code exceeds 200KB limit.' });
    }
    if (stdin.length > 200_000) {
      return res.status(413).json({ error: 'stdin exceeds 200KB limit.' });
    }

    const runTimeoutMs = Math.min(Math.max(Number(run_timeout) || 5000, 1000), 10000);

    // callPiston normalises the Piston response into a flat shape; convert
    // back into what the pre-migration Piston endpoint returned so
    // client/src/lib/pistonClient.ts keeps parsing it unchanged.
    const r = await callPiston({ language, files, stdin, runTimeoutMs });
    if (r.networkError) return res.status(502).json({ error: r.networkError });
    if (r.httpError)    return res.status(502).json({ error: r.httpError });

    const stdout = r.stdout || '';
    const stderr = r.stderr || '';
    return res.json({
      language,
      run: {
        stdout,
        stderr,
        output: stdout + (stderr ? (stdout ? '\n' : '') + stderr : ''),
        code: r.exitCode,
        signal: r.signal,
        time: r.timeMs,
      },
      compile: r.compileError ? { stderr: r.compileError, code: 1 } : null,
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Piston proxy error.' });
  } finally {
    release(userId);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /run/judge — trainer's "Run Testcases" button on the Review page.
//
// Why this exists: the review page needs to re-run the SUBMITTED code against
// the trainer's authoritative test cases and see the SAME per-case verdicts
// the student saw at submit time. It cannot just call /run/piston per case
// because that path sends the RAW student code — a bare-function solution
// (`def isEven(n): ...` with no `input()` / `print()`) produces empty stdout
// on Piston and reads as "all failed" even though the stored evaluation is
// "all passed". The submit-time judge auto-injects a stdin→call→print driver
// for bare-function code (see driverInjector), and that's what the student
// saw. This endpoint reuses the SAME judge() so the trainer sees an
// identical verdict without duplicating the driver logic in the browser.
//
// Response mirrors the shape stored on the answer.evaluationBreakdown.testcase
// object (perCase[], passed, total, score, maxMarks, log[]) so the client can
// print the same ✓/✗ trace it already knows how to render.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/run/judge', userAuth, async (req, res) => {
  const userId = String(req.user?._id || 'anon');
  const gate = throttle(userId);
  if (gate === 'busy') return res.status(429).json({ error: 'A previous run is still in progress.' });
  if (gate === 'rate') return res.status(429).json({ error: 'Too many runs — try again in a minute.' });

  try {
    const {
      language,
      files = [],
      testCases = [],
      functionName = null,
      maxMarks = 10,
      run_timeout,
    } = req.body || {};

    if (!language || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'language and files[] are required.' });
    }
    if (!Array.isArray(testCases) || testCases.length === 0) {
      return res.status(400).json({ error: 'testCases[] is required and must be non-empty.' });
    }
    const totalBytes = files.reduce((n, f) => n + (f?.content?.length || 0), 0);
    if (totalBytes > 200_000) return res.status(413).json({ error: 'Total code exceeds 200KB limit.' });

    const runTimeoutMs = Math.min(Math.max(Number(run_timeout) || 5000, 1000), 10000);

    const result = await judge({
      language,
      files,
      testCases,
      maxMarks: Number(maxMarks) || 10,
      functionName,
      runTimeoutMs,
    });
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Judge error.' });
  } finally {
    release(userId);
  }
});

module.exports = router;
