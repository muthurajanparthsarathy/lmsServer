// ─────────────────────────────────────────────────────────────────────────────
// Coding-platform read-only proxies.
//
// Each handler fetches PUBLIC profile data for a handle and returns it in a
// per-platform raw-ish shape; the client's adapter normalises further. Probed
// live on 2026-08-11:
//   • LeetCode  — leetcode.com/graphql direct (the free alfa proxy 429s).
//   • CodeChef  — profile page scrape (the community API now returns 402).
//   • HackerRank— /rest/hackers/:u/badges + /scores_elo work; profile 404s,
//                 so name comes from badges/scores context or the handle.
//   • AtCoder   — kenkoooo Problems API (all submissions) + official
//                 /users/:u/history/json (contest history).
//
// All fetches use Node 18+ global fetch. 60s outer timeout per upstream call.
// ─────────────────────────────────────────────────────────────────────────────

const UA = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

const fetchJson = async (url, opts = {}, timeoutMs = 60000) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, headers: { ...UA, ...(opts.headers || {}) }, signal: ctrl.signal });
    const text = await res.text();
    try { return { status: res.status, json: JSON.parse(text), text: null }; }
    catch { return { status: res.status, json: null, text }; }
  } finally { clearTimeout(t); }
};

const bad = (res, code, msg) => res.status(code).json({ error: msg });

// ── LeetCode ────────────────────────────────────────────────────────────────

const LC_QUERY = `
query userReport($username: String!) {
  allQuestionsCount { difficulty count }
  matchedUser(username: $username) {
    username
    profile { realName userAvatar ranking reputation }
    submitStats: submitStatsGlobal {
      acSubmissionNum { difficulty count submissions }
      totalSubmissionNum { difficulty count submissions }
    }
    tagProblemCounts {
      advanced { tagName problemsSolved }
      intermediate { tagName problemsSolved }
      fundamental { tagName problemsSolved }
    }
    userCalendar { submissionCalendar streak totalActiveDays }
  }
  userContestRanking(username: $username) {
    attendedContestsCount rating globalRanking topPercentage
  }
  recentAcSubmissionList(username: $username, limit: 20) {
    title titleSlug timestamp lang
  }
}`;

exports.leetcodeReport = async (req, res) => {
  try {
    const username = String(req.params.username || "").trim();
    if (!username) return bad(res, 400, "username required");
    const r = await fetchJson("https://leetcode.com/graphql/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Referer: `https://leetcode.com/u/${username}/`,
        Origin: "https://leetcode.com",
      },
      body: JSON.stringify({ query: LC_QUERY, variables: { username } }),
    });
    const d = r.json && r.json.data;
    if (!d || !d.matchedUser) return bad(res, 404, `LeetCode user "${username}" not found`);
    return res.json(d);
  } catch (e) {
    return bad(res, 502, `LeetCode fetch failed: ${e.message}`);
  }
};

// ── CodeChef (profile-page scrape) ──────────────────────────────────────────

exports.codechefReport = async (req, res) => {
  try {
    const username = String(req.params.username || "").trim();
    if (!username) return bad(res, 400, "username required");
    const r = await fetchJson(`https://www.codechef.com/users/${encodeURIComponent(username)}`);
    const html = r.text || "";
    if (r.status !== 200 || !html) return bad(res, 404, `CodeChef profile "${username}" unreachable (${r.status})`);

    const grab = (re) => { const m = html.match(re); return m ? m[1] : null; };
    const rating = Number(grab(/class="rating-number"[^>]*>\s*(\d+)/)) || null;
    const highest = Number(grab(/Highest Rating\s*(\d+)/) || grab(/highest-rating[^>]*>[^0-9]*(\d+)/i)) || null;
    const stars = (html.match(/class="rating"[^>]*>\s*([\d]+)\s*★/) || [])[1] || (grab(/(\d)★/) ?? null);
    const name = grab(/<h1[^>]*class="h2-style"[^>]*>\s*([^<]+)/) || username;
    const globalRank = Number(grab(/Global Rank[\s\S]{0,200}?<strong>\s*([\d]+)/i)) || null;
    const countryRank = Number(grab(/Country Rank[\s\S]{0,200}?<strong>\s*([\d]+)/i)) || null;
    const fullySolved = Number(grab(/Fully Solved[^0-9]*(\d+)/i) || grab(/Total Problems Solved:\s*(\d+)/i)) || null;
    // Rating history is embedded as `all_rating = [...]` JSON in a script tag.
    let ratingHistory = null;
    const rh = html.match(/all_rating\s*=\s*(\[[\s\S]*?\]);/);
    if (rh) { try { ratingHistory = JSON.parse(rh[1]); } catch { ratingHistory = null; } }

    if (rating === null && fullySolved === null && !rh) {
      return bad(res, 404, `Could not read CodeChef profile "${username}" (page layout changed or profile hidden)`);
    }

    // ── Recent submissions feed (public, paginated HTML fragments) ──────────
    // Best-effort: a layout change here must never break the profile numbers.
    let recent = [];
    try {
      for (let page = 0; page < 5; page++) {
        const rr = await fetchJson(`https://www.codechef.com/recent/user?user_handle=${encodeURIComponent(username)}&page=${page}`, {
          headers: { "X-Requested-With": "XMLHttpRequest", Accept: "application/json" },
        }, 30000);
        const content = rr.json && rr.json.content;
        if (!content || typeof content !== "string") break;
        // Rows: <tr>...<td ... title="TIMESTAMP">ago</td><td><a href="/problems/CODE">..</a></td>
        //       <td><span title="RESULT">..</span> (or img)</td> ... <td>LANG</td>
        // NOTE: CodeChef emits SINGLE-quoted attributes (title='…', href='…').
        const rows = content.split(/<tr[^>]*>/).slice(1);
        for (const row of rows) {
          const problem = (row.match(/href=['"]\/(?:[A-Z0-9-]+\/)?problems\/([A-Z0-9_]+)['"]/i) || [])[1];
          if (!problem) continue;
          // First td's title is the timestamp, e.g. "03:57 PM 06/11/25".
          const time = (row.match(/title=['"]([^'"]+)['"]/) || [])[1] || "";
          const resultTitle = (row.match(/<span[^>]*title=['"]([^'"]*)['"]/) || [])[1]
            || (row.match(/<td[^>]*title=['"](\([^'"]*\))['"]/) || [])[1] || "";
          const tds = row.split(/<td[^>]*>/).map((t) => t.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
          // Columns: Time | Problem | Result | Lang | Solution — lang is the 4th.
          const lang = (tds[4] || "").split(" ")[0] || "";
          recent.push({ problem, time, result: resultTitle, lang });
        }
        if (!rr.json || rr.json.max_page === undefined || page >= Number(rr.json.max_page) - 1) break;
      }
    } catch { recent = []; }

    // ── Tags for recently-ACCEPTED problems (per-problem JSON, cached — tags
    //    are a property of the problem, not the user, so the cache is global).
    let problemTags = {};
    try {
      const accepted = [...new Set(
        recent.filter((r) => /accepted|\(100\)/i.test(r.result)).map((r) => r.problem)
      )].slice(0, 10);
      for (const code of accepted) {
        if (ccTagCache.has(code)) { problemTags[code] = ccTagCache.get(code); continue; }
        const pr = await fetchJson(`https://www.codechef.com/api/contests/PRACTICE/problems/${code}`, {
          headers: { Accept: "application/json" },
        }, 20000);
        const rawTags = (pr.json && (pr.json.tags || pr.json.user_tags)) || "";
        const names = typeof rawTags === "string"
          ? [...rawTags.matchAll(/>([^<>]+)<\/a>/g)].map((m) => m[1].trim())
          : Array.isArray(rawTags) ? rawTags.map(String) : [];
        ccTagCache.set(code, names);
        problemTags[code] = names;
      }
    } catch { problemTags = {}; }

    return res.json({
      username, name: name.trim(), rating, highest,
      stars: stars ? String(stars) : null,
      globalRank, countryRank, fullySolved, ratingHistory,
      recent, problemTags,
    });
  } catch (e) {
    return bad(res, 502, `CodeChef fetch failed: ${e.message}`);
  }
};

// Problem-code → tag names. Tags never change per user, so one lookup serves
// every student who solved that problem for the server's lifetime.
const ccTagCache = new Map();

// ── HackerRank ──────────────────────────────────────────────────────────────

exports.hackerrankReport = async (req, res) => {
  try {
    const username = String(req.params.username || "").trim();
    if (!username) return bad(res, 400, "username required");
    const [badges, scores, profile, recentCh] = await Promise.all([
      fetchJson(`https://www.hackerrank.com/rest/hackers/${encodeURIComponent(username)}/badges`),
      fetchJson(`https://www.hackerrank.com/rest/hackers/${encodeURIComponent(username)}/scores_elo`),
      // Known-flaky (probed 404) — kept as best-effort for name/avatar.
      fetchJson(`https://www.hackerrank.com/rest/contests/master/hackers/${encodeURIComponent(username)}/profile`),
      // Solved challenges with names + dates (probed 200).
      fetchJson(`https://www.hackerrank.com/rest/hackers/${encodeURIComponent(username)}/recent_challenges?limit=50`),
    ]);
    const badgeModels = (badges.json && badges.json.models) || [];
    const scoreModels = (scores.json && scores.json.models) || [];
    if (badges.status !== 200 && scores.status !== 200) {
      return bad(res, 404, `HackerRank user "${username}" not found`);
    }
    return res.json({
      username,
      profile: (profile.json && profile.json.model) || null,
      badges: badgeModels.map((b) => ({
        name: b.badge_name || b.badge_type, stars: b.stars || 0, solved: b.solved || 0,
        totalChallenges: b.total_challenges || 0, category: b.category_name || "",
      })),
      scores: scoreModels.map((s) => ({
        track: s.name || s.slug, practiceScore: (s.practice && s.practice.score) || 0,
        contestRating: (s.contest && s.contest.rating) || null, level: (s.practice && s.practice.level) || 0,
      })),
      recentChallenges: ((recentCh.json && recentCh.json.models) || []).map((c) => ({
        name: c.name, slug: c.ch_slug, createdAt: c.created_at,
        url: c.url ? `https://www.hackerrank.com${c.url}` : undefined,
      })),
    });
  } catch (e) {
    return bad(res, 502, `HackerRank fetch failed: ${e.message}`);
  }
};

// ── AtCoder ─────────────────────────────────────────────────────────────────

exports.atcoderReport = async (req, res) => {
  try {
    const username = String(req.params.username || "").trim();
    if (!username) return bad(res, 400, "username required");
    const [subs, hist] = await Promise.all([
      fetchJson(`https://kenkoooo.com/atcoder/atcoder-api/v3/user/submissions?user=${encodeURIComponent(username)}&from_second=0`),
      fetchJson(`https://atcoder.jp/users/${encodeURIComponent(username)}/history/json`),
    ]);
    const submissions = Array.isArray(subs.json) ? subs.json : [];
    const history = Array.isArray(hist.json) ? hist.json : [];
    // kenkoooo returns [] for unknown users too — a 404 history page is the
    // "user doesn't exist" signal; an empty [] with 200 means a real but
    // inactive account.
    if (hist.status === 404) return bad(res, 404, `AtCoder user "${username}" not found`);
    return res.json({
      username,
      submissions: submissions.map((s) => ({
        id: s.id, problemId: s.problem_id, contestId: s.contest_id, result: s.result,
        language: s.language, epochSecond: s.epoch_second, point: s.point,
      })),
      history: history.map((h) => ({
        contest: h.ContestName, place: h.Place, oldRating: h.OldRating, newRating: h.NewRating,
        endTime: h.EndTime, performance: h.Performance,
      })),
    });
  } catch (e) {
    return bad(res, 502, `AtCoder fetch failed: ${e.message}`);
  }
};
