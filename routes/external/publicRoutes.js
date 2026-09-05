// PUBLIC external-assessment routes. Mounted at /api/external.
//
// ⚠ NO `userAuth` ON ANY ROUTE IN THIS FILE, AND NONE SHOULD BE ADDED.
// External participants are not LMS users and hold no token of the kind
// userAuth understands. Their invitation token is the credential, and every
// handler re-validates it (and the assessment window) on its own — see
// utils/external/assessmentAccess.js.
//
// Anything that needs an authenticated admin belongs in adminRoutes.js.

const express = require("express");
const router = express.Router();

const publicAccess = require("../../controllers/external/publicAccessController");

// Landing screen — resolves the token and reports one of:
// not_started · available · expired · already_submitted · invalid_token ·
// revoked · not_published · not_scheduled · no_questions
router.get("/assessment/access/:token", publicAccess.getAccess);

// Begin (or resume) the sitting. Returns the paper with every correct answer
// stripped, plus a server-authoritative deadline.
router.post("/assessment/start/:token", publicAccess.startAttempt);

// Grade and close the sitting. Idempotent — a retried submit returns the
// existing result rather than regrading.
router.post("/assessment/submit/:token", publicAccess.submitAttempt);

module.exports = router;
