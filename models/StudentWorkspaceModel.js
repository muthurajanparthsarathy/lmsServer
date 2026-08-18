const mongoose = require("mongoose");

// One file inside a student's saved workspace (multi-file code editor).
const WorkspaceFileSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },     // basename, e.g. "main.py"
    path: { type: String, required: true },     // "/main.py" or "/dir/util.py"
    content: { type: String, default: "" },
  },
  { _id: false }
);

// One document per (userId, courseId). The agent on Railway is the source of
// truth between requests; this collection is the durable copy that survives
// container restarts / Volume wipes.
const StudentWorkspaceSchema = new mongoose.Schema({
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: "LMS-User", required: true },
  courseId: { type: String, default: "default" },   // string (not ObjectId) so callers can pass "default"
  language: { type: String, default: "python" },
  files:    { type: [WorkspaceFileSchema], default: [] },
  updatedAt:{ type: Date, default: Date.now },
});

StudentWorkspaceSchema.index({ userId: 1, courseId: 1 }, { unique: true });

module.exports = mongoose.model("StudentWorkspace", StudentWorkspaceSchema);
