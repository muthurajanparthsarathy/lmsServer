const express = require("express");
const { saveCompiler, getUserIdCompiler } = require("../controllers/compiler");
const { userAuth } = require("../middlewares/userAuth");
const router = express.Router();

// Save or submit code
router.post("/save/compiler",userAuth, saveCompiler);

// Get latest submission
router.get("/get/compiler/:userId/:courseId", getUserIdCompiler);

module.exports = router;
