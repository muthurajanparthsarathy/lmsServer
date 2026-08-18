const express = require("express");
const router = express.Router();
const { userAuth } = require("../../middlewares/userAuth");
const { userRole } = require("../../middlewares/userRole");
const {
  getAllQuestionsbank,
  getAllOtherPlatformQuestions,
  getQuestionBankById,
  createQuestionBank,
  updateQuestionBank,
  deleteQuestionBank,
  toggleQuestionStatus,
  createOtherPlatformQuestion,
  updateOtherPlatformQuestion,
  deleteOtherPlatformQuestion,
  toggleOtherPlatformQuestionStatus,
} = require("../../controllers/courses/questionBank");

router.get("/getAll/question-bank", userAuth, getAllQuestionsbank);

// Other Platform bank — GLOBAL (shared by every institution). Read is open to
// any authenticated user (the picker consumes it); writes are gated to admin
// / super_admin because a bad edit here affects every tenant.
router.get("/getAll/other-platform-bank", userAuth, getAllOtherPlatformQuestions);
router.post(
  "/create/other-platform-bank",
  userAuth,
  userRole(["admin", "super_admin"]),
  createOtherPlatformQuestion,
);
router.put(
  "/update/other-platform-bank/:id",
  userAuth,
  userRole(["admin", "super_admin"]),
  updateOtherPlatformQuestion,
);
router.delete(
  "/deletes/other-platform-bank/:id",
  userAuth,
  userRole(["admin", "super_admin"]),
  deleteOtherPlatformQuestion,
);
router.put(
  "/toggle-status/other-platform-bank/:id",
  userAuth,
  userRole(["admin", "super_admin"]),
  toggleOtherPlatformQuestionStatus,
);

router.get("/getById/question-bank/:id", userAuth, getQuestionBankById);

router.post("/create/question-bank", userAuth, createQuestionBank);

router.put("/update/question-bank/:id", userAuth, updateQuestionBank);

router.delete("/deletes/question-bank/:id", userAuth, deleteQuestionBank);

router.put('/toggle-status/question-bank/:questionId',userAuth, toggleQuestionStatus);

module.exports = router;
