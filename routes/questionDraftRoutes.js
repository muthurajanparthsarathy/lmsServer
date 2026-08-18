const express = require("express");
const { userAuth } = require("../middlewares/userAuth");
const {
  saveDraft,
  loadDraft,
  clearDraft,
} = require("../controllers/questionDraft");

const router = express.Router();

// All draft endpoints require a logged-in student. The userId is taken from
// the JWT inside userAuth — never trusted from the request body — so students
// can only read and write their own per-question drafts.
router.post("/draft/save", userAuth, saveDraft);
router.get("/draft/load", userAuth, loadDraft);
router.delete("/draft/clear", userAuth, clearDraft);

module.exports = router;
