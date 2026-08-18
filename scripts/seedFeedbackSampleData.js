// Seed sample feedback data for a course.
//
// For each batch on the course, every trainer in that batch gets their own
// feedback form (4 forms total with the seeded data: Batch 2026-A has two
// trainers, B and C one each). The students of the SAME batch then submit
// responses to their batch trainer's form(s). Statistics are recomputed by
// the Feedback model's pre-save hook.
//
// Idempotent: existing forms (same courseId + trainerId) are reused, and a
// student never gets a duplicate response.
//
// Run from the server folder:  node scripts/seedFeedbackSampleData.js

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");

const CourseStructure = require("../models/Courses/courseStructureModal");
const Feedback = require("../models/FeedbackModal");
require("../models/RoleModel");
require("../models/UserModel");

const COURSE_ID = "6a47a581b7bb4fec8e89a4bd";
const CREATED_BY = "batch@gmail.com"; // the course creator, so forms look owned

// ── Question set used on every form ──────────────────────────────────────────
const QUESTIONS = [
  {
    questionText: "How would you rate the trainer's subject knowledge?",
    questionType: "rating",
    isRequired: true,
    order: 1,
    ratingConfig: { minRating: 1, maxRating: 5, ratingLabels: ["Poor", "Fair", "Good", "Very Good", "Excellent"] },
    ratingStyle: "star",
    category: "Teaching",
  },
  {
    questionText: "How clear were the trainer's explanations?",
    questionType: "rating",
    isRequired: true,
    order: 2,
    ratingConfig: { minRating: 1, maxRating: 5, ratingLabels: ["Poor", "Fair", "Good", "Very Good", "Excellent"] },
    ratingStyle: "star",
    category: "Teaching",
  },
  {
    questionText: "How engaging were the training sessions?",
    questionType: "rating",
    isRequired: true,
    order: 3,
    ratingConfig: { minRating: 1, maxRating: 5, ratingLabels: ["Poor", "Fair", "Good", "Very Good", "Excellent"] },
    ratingStyle: "emoji",
    category: "Engagement",
  },
  {
    questionText: "How helpful was the trainer in resolving doubts?",
    questionType: "rating",
    isRequired: true,
    order: 4,
    ratingConfig: { minRating: 1, maxRating: 5, ratingLabels: ["Poor", "Fair", "Good", "Very Good", "Excellent"] },
    ratingStyle: "number",
    category: "Support",
  },
  {
    questionText: "What did you like most about the trainer's sessions?",
    questionType: "text",
    isRequired: true,
    order: 5,
    placeholder: "Share what worked well for you...",
    maxLength: 500,
    category: "General",
  },
  {
    questionText: "Any suggestions for improvement?",
    questionType: "text",
    isRequired: false,
    order: 6,
    placeholder: "Optional — what could be better?",
    maxLength: 500,
    category: "General",
  },
];

const LIKED_ANSWERS = [
  "The hands-on coding sessions were really practical and easy to follow.",
  "Real-world examples made the concepts click for me.",
  "The pace was comfortable and doubts were cleared patiently.",
  "Live debugging sessions taught me how to think through problems.",
  "The mini projects after each module helped me apply what I learned.",
  "Clear structure — every session built nicely on the previous one.",
  "The trainer encouraged questions and never rushed explanations.",
  "Good balance between theory and practice throughout the batch.",
  "Assignments were challenging but well aligned with the sessions.",
  "The recap at the start of each class kept everything fresh.",
];

const SUGGESTION_ANSWERS = [
  "A few more practice problems after each topic would help.",
  "Slightly slower pace on the advanced topics please.",
  "Would love more real project case studies.",
  "Share session notes a bit earlier before class.",
  "More one-on-one doubt clearing time would be great.",
  "",
  "",
  "Nothing much — sessions were great overall.",
];

const OVERALL_REASONS = [
  "Really enjoyed the batch, learned a lot.",
  "Great teaching style and very approachable.",
  "Sessions were consistently useful.",
  "",
  "Helped me build confidence in the subject.",
];

// Deterministic-ish pseudo random so re-runs feel stable per student index.
const pick = (arr, seed) => arr[seed % arr.length];
// Ratings skew positive (3–5) the way real feedback usually does.
const ratingFor = (seed, offset) => 3 + ((seed + offset) % 3);

const roleNameOf = (user) => {
  const r = user?.role;
  if (!r) return "";
  return (r.roleValue || r.renameRole || r.originalRole || "").toLowerCase();
};

const main = async () => {
  if (!process.env.MONGOURI) throw new Error("MONGOURI not found in server/.env");
  await mongoose.connect(process.env.MONGOURI);
  console.log("MongoDB connected");

  const course = await CourseStructure.findById(COURSE_ID)
    .populate({
      path: "batchAndParticipants.users.user",
      select: "firstName lastName email role",
      populate: { path: "role", select: "originalRole renameRole roleValue" },
    })
    .lean();
  if (!course) throw new Error(`Course ${COURSE_ID} not found`);
  console.log(`Course: ${course.courseName} (${course.batchAndParticipants?.length || 0} batches)`);

  let formsCreated = 0;
  let responsesAdded = 0;

  for (const batch of course.batchAndParticipants || []) {
    const members = (batch.users || []).map((u) => u.user).filter(Boolean);
    const trainers = members.filter((u) => roleNameOf(u) === "trainer");
    const students = members.filter((u) => roleNameOf(u) === "student");
    console.log(`\n${batch.batchName}: ${trainers.length} trainer(s), ${students.length} student(s)`);

    for (const trainer of trainers) {
      const trainerName = `${trainer.firstName} ${trainer.lastName || ""}`.trim();

      // One form per trainer per course — reuse if the seed already made it.
      let form = await Feedback.findOne({ courseId: course._id, trainerId: trainer._id });
      if (!form) {
        form = new Feedback({
          courseId: course._id,
          feedbackTitle: `Trainer Feedback — ${trainerName} (${batch.batchName})`,
          feedbackDescription:
            `Feedback for ${trainerName}'s sessions in ${batch.batchName}. ` +
            `Your responses help us improve the training quality.`,
          questions: QUESTIONS,
          studentResponses: [],
          isActive: true,
          isPublished: true,
          startDate: new Date("2026-07-01T00:00:00.000Z"),
          endDate: new Date("2026-12-31T23:59:59.000Z"),
          isAnonymousAllowed: true,
          maxAttempts: 1,
          trainerId: trainer._id,
          trainerName,
          trainerEmail: trainer.email,
          createdBy: CREATED_BY,
          updatedBy: CREATED_BY,
        });
        formsCreated++;
        console.log(`  created form: ${form.feedbackTitle}`);
      } else {
        console.log(`  exists  form: ${form.feedbackTitle}`);
      }

      // Same batch's students respond to their trainer's form.
      students.forEach((student, idx) => {
        if (form.hasStudentResponded(student._id)) return;

        const seed = idx + trainerName.length;
        const answers = [
          { questionText: QUESTIONS[0].questionText, questionType: "rating", answer: ratingFor(seed, 0) },
          { questionText: QUESTIONS[1].questionText, questionType: "rating", answer: ratingFor(seed, 1) },
          { questionText: QUESTIONS[2].questionText, questionType: "rating", answer: ratingFor(seed, 2) },
          { questionText: QUESTIONS[3].questionText, questionType: "rating", answer: ratingFor(seed, 4) },
          { questionText: QUESTIONS[4].questionText, questionType: "text", answer: pick(LIKED_ANSWERS, seed) },
        ];
        const suggestion = pick(SUGGESTION_ANSWERS, seed);
        if (suggestion) {
          answers.push({ questionText: QUESTIONS[5].questionText, questionType: "text", answer: suggestion });
        }

        // Every 7th response is anonymous, like real cohorts.
        const isAnonymous = idx % 7 === 3;
        form.addStudentResponse(
          student._id,
          `${student.firstName} ${student.lastName || ""}`.trim(),
          student.email,
          answers,
          isAnonymous,
          pick(OVERALL_REASONS, seed)
        );
        responsesAdded++;
      });

      await form.save(); // pre-save hook recomputes statistics
      console.log(`  saved: ${form.studentResponses.length} responses, avg rating ${form.statistics.averageRating}`);
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const forms = await Feedback.find({ courseId: COURSE_ID })
    .select("feedbackTitle trainerName statistics.averageRating studentResponses isPublished")
    .lean();
  console.log("\n──────── Summary ────────");
  forms.forEach((f) =>
    console.log(
      `${f.feedbackTitle}\n  responses: ${(f.studentResponses || []).length}, avg: ${f.statistics?.averageRating}, published: ${f.isPublished}`
    )
  );
  console.log(`\nforms created this run: ${formsCreated}, responses added this run: ${responsesAdded}`);
};

main()
  .then(() => mongoose.disconnect())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error("\nSeed failed:", err.message);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
