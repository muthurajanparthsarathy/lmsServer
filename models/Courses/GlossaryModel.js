const mongoose = require("mongoose");

// One glossary TERM of one course. The glossary is per-course: the same word
// can mean different things in a C course and a networking course, and a
// trainer must be able to curate their own list without stepping on others.
const glossarySchema = new mongoose.Schema(
  {
    institution: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LMS-Institution",
      required: true,
    },
    courseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Course-Structure",
      required: true,
    },
    term: {
      type: String,
      required: true,
      trim: true,
    },
    // Lowercased match key — matching against OCR/extracted words is always
    // case-insensitive, and an index on the normalized form keeps it cheap.
    termKey: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    definition: {
      type: String,
      required: true,
      trim: true,
    },
    createdBy: String,
    updatedBy: String,
  },
  { timestamps: true }
);

// A term exists once per course.
glossarySchema.index({ courseId: 1, termKey: 1 }, { unique: true });

module.exports = mongoose.model("Lesson-Glossary", glossarySchema);
