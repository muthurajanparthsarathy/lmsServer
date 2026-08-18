const express = require("express");
const router = express.Router();
const { userAuth } = require("../../middlewares/userAuth");
const {
  createTerm,
  listByCourse,
  updateTerm,
  deleteTerm,
  extractLesson,
  lessonTerms,
  defineWord,
  lessonWords,
} = require("../../controllers/courses/glossary");

// Per-course glossary management
router.post("/glossary/create", userAuth, createTerm);
router.get("/glossary/getByCourse/:courseId", userAuth, listByCourse);
router.put("/glossary/update/:termId", userAuth, updateTerm);
router.delete("/glossary/delete/:termId", userAuth, deleteTerm);

// One-time lesson preparation (backfill / manual trigger)
router.post("/glossary/extract", userAuth, extractLesson);

// The viewer's hotspot feed
router.get("/glossary/lesson-terms", userAuth, lessonTerms);

// Dictionary mode: every word's box + on-hover definition lookup
router.get("/glossary/lesson-words", userAuth, lessonWords);
router.get("/glossary/define", userAuth, defineWord);

module.exports = router;
