// server/scripts/createMixedStyleFeedback.js
//
// Creates a NEW Feedback document with 20 rating questions across 4 categories,
// mixing all three rating styles (number, star, emoji) so you can eyeball the
// student-facing renderer end-to-end.
//
// Distribution:
//   Teaching Quality      → number
//   Student Engagement    → star
//   Assessment & Support  → emoji
//   Class Management      → number
//
// Usage (from server/):
//   node scripts/createMixedStyleFeedback.js
//   node scripts/createMixedStyleFeedback.js <courseId>
//   node scripts/createMixedStyleFeedback.js --ref=<feedbackId>

const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const Feedback = require("../models/FeedbackModal");

const args = process.argv.slice(2);
const refArg = args.find((a) => a.startsWith("--ref="));
const REF_ID = refArg ? refArg.split("=")[1] : "6a423a742552854c6fc34ccf";
const COURSE_ID_ARG = args.find((a) => !a.startsWith("--"));

const TITLE = "Teacher Feedback Form — Mixed Styles";
const DESCRIPTION =
  "Rate the trainer across four parameters. This form demonstrates all three rating styles: numbers, stars, and emojis.";

const RATING_LABELS = ["Poor", "Fair", "Good", "Very Good", "Excellent"];

const rating = (questionText, category, style, order) => ({
  questionText,
  questionType: "rating",
  isRequired: true,
  order,
  ratingConfig: {
    minRating: 1,
    maxRating: 5,
    ratingLabels: RATING_LABELS,
  },
  ratingStyle: style,
  category,
});

const QUESTIONS = [
  // 1. Teaching Quality — number
  rating("Subject knowledge", "Teaching Quality", "number", 1),
  rating("Explanation clarity", "Teaching Quality", "number", 2),
  rating("Use of examples", "Teaching Quality", "number", 3),
  rating("Communication skills", "Teaching Quality", "number", 4),
  rating("Doubt solving ability", "Teaching Quality", "number", 5),

  // 2. Student Engagement — star
  rating("Encourages participation", "Student Engagement", "star", 6),
  rating("Makes class interactive", "Student Engagement", "star", 7),
  rating("Keeps students attentive", "Student Engagement", "star", 8),
  rating("Motivates learning", "Student Engagement", "star", 9),
  rating("Encourages questions", "Student Engagement", "star", 10),

  // 3. Assessment & Support — emoji
  rating("Quality of assignments", "Assessment & Support", "emoji", 11),
  rating("Feedback on assignments", "Assessment & Support", "emoji", 12),
  rating("Fair evaluation", "Assessment & Support", "emoji", 13),
  rating("Availability outside class", "Assessment & Support", "emoji", 14),
  rating("Support for weak students", "Assessment & Support", "emoji", 15),

  // 4. Class Management — number (repeat to fill 20)
  rating("Punctuality", "Class Management", "number", 16),
  rating("Time management", "Class Management", "number", 17),
  rating("Completes syllabus on time", "Class Management", "number", 18),
  rating("Maintains discipline", "Class Management", "number", 19),
  rating("Classroom organization", "Class Management", "number", 20),
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

    let courseId = COURSE_ID_ARG;
    const ref = await Feedback.findById(REF_ID).select("courseId createdBy").lean();
    if (!courseId) {
      if (!ref) {
        console.error(
          `No courseId argument and reference feedback ${REF_ID} not found. ` +
            `Pass courseId as the first arg: node scripts/createMixedStyleFeedback.js <courseId>`
        );
        process.exit(1);
      }
      courseId = ref.courseId.toString();
      console.log(`Using courseId ${courseId} (copied from ${REF_ID})`);
    }

    const createdBy = ref?.createdBy || "seed-script";
    console.log(
      ref?.createdBy
        ? `Using createdBy ${createdBy} (copied from ${REF_ID})`
        : `Using createdBy "${createdBy}" (fallback)`
    );

    const doc = await Feedback.create({
      courseId,
      feedbackTitle: TITLE,
      feedbackDescription: DESCRIPTION,
      questions: QUESTIONS,
      isAnonymousAllowed: true,
      maxAttempts: 1,
      isPublished: false,
      isActive: true,
      createdBy,
      updatedBy: createdBy,
    });

    // Group counts by style for a quick sanity check in the log.
    const styleCounts = QUESTIONS.reduce((acc, q) => {
      acc[q.ratingStyle] = (acc[q.ratingStyle] || 0) + 1;
      return acc;
    }, {});

    console.log(
      `\n✓ Created new Feedback document` +
        `\n   _id          : ${doc._id}` +
        `\n   feedback_id  : ${doc.feedback_id}` +
        `\n   courseId     : ${doc.courseId}` +
        `\n   questions    : ${doc.questions.length}` +
        `\n   styles       : ${JSON.stringify(styleCounts)}` +
        `\n   isPublished  : ${doc.isPublished}\n`
    );
  } catch (err) {
    console.error("Create failed:", err);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected.");
  }
})();
