// server/scripts/createTeacherFeedback.js
//
// Creates a NEW Feedback document with the Teacher Feedback layout
// (4 categories x 5 rating questions). Prints the new document _id on
// success — copy that id into the URL ?feedbackId=... if you want to open it.
//
// Usage:
//   node scripts/createTeacherFeedback.js <courseId>
//
// If <courseId> is omitted, it copies the courseId from an existing reference
// document so the new feedback lands on the same course.
//   node scripts/createTeacherFeedback.js
//
// Override the reference document with --ref=<feedbackId>:
//   node scripts/createTeacherFeedback.js --ref=6a423a742552854c6fc34ccf

const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const Feedback = require("../models/FeedbackModal");

// ── Args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const refArg = args.find((a) => a.startsWith("--ref="));
const REF_ID = refArg ? refArg.split("=")[1] : "6a423a742552854c6fc34ccf";
const COURSE_ID_ARG = args.find((a) => !a.startsWith("--"));

const TITLE = "Teacher Feedback Form";
const DESCRIPTION = "Your feedback helps us improve the teaching quality.";

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
  rating("Subject knowledge", "Teaching Quality", 1),
  rating("Explanation clarity", "Teaching Quality", 2),
  rating("Use of examples", "Teaching Quality", 3),
  rating("Communication skills", "Teaching Quality", 4),
  rating("Doubt solving ability", "Teaching Quality", 5),

  rating("Encourages participation", "Student Engagement", 6),
  rating("Makes class interactive", "Student Engagement", 7),
  rating("Keeps students attentive", "Student Engagement", 8),
  rating("Motivates learning", "Student Engagement", 9),
  rating("Encourages questions", "Student Engagement", 10),

  rating("Quality of assignments", "Assessment & Support", 11),
  rating("Feedback on assignments", "Assessment & Support", 12),
  rating("Fair evaluation", "Assessment & Support", 13),
  rating("Availability outside class", "Assessment & Support", 14),
  rating("Support for weak students", "Assessment & Support", 15),

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

    // Resolve courseId + createdBy (both copied from the reference doc
    // unless a courseId is passed explicitly).
    let courseId = COURSE_ID_ARG;
    const ref = await Feedback.findById(REF_ID).select("courseId createdBy").lean();
    if (!courseId) {
      if (!ref) {
        console.error(
          `No courseId argument and reference feedback ${REF_ID} not found. ` +
            `Pass courseId as the first arg: node scripts/createTeacherFeedback.js <courseId>`
        );
        process.exit(1);
      }
      courseId = ref.courseId.toString();
      console.log(`Using courseId ${courseId} (copied from ${REF_ID})`);
    }

    const createdBy = ref?.createdBy || "seed-script";
    if (ref?.createdBy) {
      console.log(`Using createdBy ${createdBy} (copied from ${REF_ID})`);
    } else {
      console.log(`Using createdBy "${createdBy}" (fallback)`);
    }

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

    console.log(
      `\n✓ Created new Feedback document` +
        `\n   _id          : ${doc._id}` +
        `\n   feedback_id  : ${doc.feedback_id}` +
        `\n   courseId     : ${doc.courseId}` +
        `\n   questions    : ${doc.questions.length} (4 categories x 5)` +
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
