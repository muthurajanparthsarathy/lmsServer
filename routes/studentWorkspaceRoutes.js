const express = require("express");
const { saveWorkspace, getWorkspace } = require("../controllers/studentWorkspace");
const router = express.Router();

// Persist a student's multi-file code editor workspace to Mongo. Called by
// Vercel after the Railway agent has written the files to the container disk.
// Intentionally unauthenticated at this layer — Vercel is the only caller and
// the route lives behind the same network boundary as the rest of the API.
router.post("/save/student-workspace", saveWorkspace);

// Read the most recent saved workspace for a (userId, courseId). Used to
// restore files on agent cold start / Volume wipe.
router.get("/get/student-workspace/:userId/:courseId", getWorkspace);

module.exports = router;
