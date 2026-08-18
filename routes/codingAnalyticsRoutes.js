const express = require("express");
const router = express.Router();
const {
  leetcodeReport,
  codechefReport,
  hackerrankReport,
  atcoderReport,
} = require("../controllers/codingAnalytics");

// Read-only proxies over PUBLIC coding-platform profile data. They exist
// because the browser can't call these origins directly (CORS / anti-bot),
// and so no third-party base URLs live in the frontend. No credentials of
// any kind are involved — handles are public profile identifiers.
// (Codeforces is NOT proxied: its official API is CORS-open, the client
// calls it directly.)
router.get("/coding-analytics/leetcode/:username", leetcodeReport);
router.get("/coding-analytics/codechef/:username", codechefReport);
router.get("/coding-analytics/hackerrank/:username", hackerrankReport);
router.get("/coding-analytics/atcoder/:username", atcoderReport);

module.exports = router;
