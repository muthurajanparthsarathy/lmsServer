// routes/testYourSkillsRoutes.js
const express = require("express");
const router = express.Router();
// `userAuthOptional` identifies the caller without rejecting anonymous ones.
//
// These routes carried NO auth at all, which made Test Your Skills the one You
// Do feature that ignored batches: with `req.user` undefined the batch resolver
// treats the caller as unidentified and hands back the shared, course-level
// container every time — so every batch saw one merged list.
//
// Optional rather than required, because these routes have always been open and
// tightening them is a separate decision. It populates `role`, which the
// resolver needs to tell a student (pinned to their enrolled batch) from staff
// (free to pick one).
const { userAuth, userAuthOptional } = require("../../../middlewares/userAuth");
const {
  TestYourSkillsAddMCQ,
  TestYourSkillsGetAllMCQs,
  TestYourSkillsGetMCQById,
  TestYourSkillsUpdateMCQ,
  TestYourSkillsDeleteMCQ,
  TestYourSkillsBulkAddMCQs,
  TestYourSkillsGetStats,
  addMcqToYouDo,
  getYouDoItems,
  getYouDoItem,
  deleteYouDoItem,
  deleteQuestionFromYouDo,
  updateQuestionInYouDo
} = require("../../../controllers/courses/moduleStructure/testYourSkillsController");

// Every route below is batch-scoped through `resolvePedagogyScope` in the
// controller, which needs `req.user` to decide whose batch applies — hence
// `userAuthOptional` on all of them.
router.post("/createquestion/:type/:id/you-do/:itemKey/mcq", userAuthOptional, addMcqToYouDo);

// Get all You_Do items
router.get("/getAllQuestions/:type/:id/you-do", userAuthOptional, getYouDoItems);

// Get specific You_Do item
router.get("/getQuestion/:type/:id/you-do/:itemKey", userAuthOptional, getYouDoItem);

// Delete You_Do item
router.delete("/deleteQuestion/:type/:id/you-do/:itemKey", userAuthOptional, deleteYouDoItem);

// Delete specific question from You_Do item
router.delete("/deleteQuestion/:type/:id/you-do/:itemKey/question/:questionId", userAuthOptional, deleteQuestionFromYouDo);
router.put("/updateQuestion/:type/:id/you-do/:itemKey/question/:questionId", userAuthOptional, updateQuestionInYouDo);

module.exports = router;