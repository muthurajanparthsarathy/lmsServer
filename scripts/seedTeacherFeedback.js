// server/scripts/seedTeacherFeedback.js
//
// One-shot seed: replaces the `questions` array on a specific Feedback
// document with the Teacher Feedback layout (4 categories x 5 rating
// questions). Safe to re-run — it overwrites the questions array.
//
// Run from the server folder:
//   node scripts/seedTeacherFeedback.js
//
// To target a different document, pass an _id as the first arg:
//   node scripts/seedTeacherFeedback.js 6a423a742552854c6fc34ccf

const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const Feedback = require("../models/FeedbackModal");

const TARGET_ID = process.argv[2] || "6a423a742552854c6fc34ccf";

const RATING_LABELS = ["Poor", "Fair", "Good", "Very Good", "Excellent"];

const rating = (questionText, category, order) => ({
  questionText,
  questionType: "rating",
  isRequired: true,
  order,
  ratingConfig: {
    minRating: 1,
    maxRating: 5,
    ratingLabels: RATING_LABELS,
  },
  category,
});

const QUESTIONS = [
  // 1. Teaching Quality
  rating("Subject knowledge", "Teaching Quality", 1),
  rating("Explanation clarity", "Teaching Quality", 2),
  rating("Use of examples", "Teaching Quality", 3),
  rating("Communication skills", "Teaching Quality", 4),
  rating("Doubt solving ability", "Teaching Quality", 5),

  // 2. Student Engagement
  rating("Encourages participation", "Student Engagement", 6),
  rating("Makes class interactive", "Student Engagement", 7),
  rating("Keeps students attentive", "Student Engagement", 8),
  rating("Motivates learning", "Student Engagement", 9),
  rating("Encourages questions", "Student Engagement", 10),

  // 3. Assessment & Support
  rating("Quality of assignments", "Assessment & Support", 11),
  rating("Feedback on assignments", "Assessment & Support", 12),
  rating("Fair evaluation", "Assessment & Support", 13),
  rating("Availability outside class", "Assessment & Support", 14),
  rating("Support for weak students", "Assessment & Support", 15),

  // 4. Class Management
  rating("Punctuality", "Class Management", 16),
  rating("Time management", "Class Management", 17),
  rating("Completes syllabus on time", "Class Management", 18),
  rating("Maintains discipline", "Class Management", 19),
  rating("Classroom organization", "Class Management", 20),
];

(async () => {
  if (!process.env.MONGOURI) {
    console.error("MONGOURI not set in server/.env");
    process.exit(1);
  }

  try {
    await mongoose.connect(process.env.MONGOURI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("Connected to MongoDB");

    const doc = await Feedback.findById(TARGET_ID);
    if (!doc) {
      console.error(`Feedback document ${TARGET_ID} not found.`);
      process.exit(1);
    }

    doc.questions = QUESTIONS;
    if (!doc.feedbackTitle) doc.feedbackTitle = "Teacher Feedback Form";
    if (!doc.feedbackDescription) {
      doc.feedbackDescription = "Your feedback helps us improve the teaching quality.";
    }

    await doc.save();

    console.log(
      `Updated ${TARGET_ID} — ${QUESTIONS.length} questions across 4 categories.`
    );
  } catch (err) {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected.");
  }
})();
