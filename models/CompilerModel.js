const mongoose = require("mongoose");

// Each submission inside a course
const SubmissionSchema = new mongoose.Schema({
  language: { type: String, required: true },
  code: { type: String, required: true },
  version: { type: Number, default: 1 },
  createdAt: { type: Date, default: Date.now }
});

// Each course for a user has multiple submissions
const CourseCompilerSchema = new mongoose.Schema({
  courseId: { type: mongoose.Schema.Types.ObjectId, ref: "Course-Structure", required: true },
  submissions: [SubmissionSchema]
});

// Final structure: One user → multiple courses → submissions
const CompilerSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "LMS-User", required: true },
  courses: [CourseCompilerSchema],
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Compiler12", CompilerSchema);
