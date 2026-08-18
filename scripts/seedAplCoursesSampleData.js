// Seed sample data onto the user's OWN two courses (created via the UI):
//
//   APL-TM-T-002 "abc skilling"  (skilling)  — batches 2022-2026 & 2023-2027:
//       10 fresh students per batch + a DIFFERENT trainer per batch.
//   APL-TM-T-001 "abc"           (degree)    — batch 2023-2027, BE/me/sem 2,
//       sections A & B: 10 fresh students per section (section stored on the
//       user doc) + a different trainer per section.
//
// Both courses also get: 4 modules (course structure), a published program
// calendar, and feedback forms (one per trainer) with ~70% of that
// batch/section's seeded students responding.
//
// Existing users already enrolled in the batches are left untouched.
// Institution/roles are derived FROM the courses themselves (not findOne()).
//
// Idempotent: safe to re-run.  Run from the server folder:
//   node scripts/seedAplCoursesSampleData.js

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const User = require("../models/UserModel");
const Role = require("../models/RoleModel");
const Institution = require("../models/InstitutionModal");
const CourseStructure = require("../models/Courses/courseStructureModal");
const CourseStructureDynamic = require("../models/dynamicContent/courseStructureDynamicModal");
const Feedback = require("../models/FeedbackModal");
const ProgramCalendar = require("../models/Courses/ProgramCalendarModel");
const Module1 = require("../models/Courses/moduleStructure/moduleModal");

const SKILLING_CODE = "APL-TM-T-002";
const DEGREE_CODE = "APL-TM-T-001";
const PASSWORD = "123";
const EMAIL_DOMAIN = "lmsdemo.in";
const SEED_BY = "seed-apl-sample-data";
const FEEDBACK_CREATED_BY = "batch@gmail.com"; // the course creator, so forms look owned

// ── Same userId generation the app's Addusers flow uses ─────────────────────
const buildInstitutionPrefix = (instName) => {
  const words = String(instName || "INST").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "INST";
  if (words.length > 1) {
    return words.map((w) => w[0].toUpperCase()).join("").slice(0, 4);
  }
  return words[0].slice(0, 3).toUpperCase();
};

const generateUserIdForInstitution = async (institutionId) => {
  if (!institutionId) return null;
  const updated = await Institution.findOneAndUpdate(
    { _id: institutionId },
    { $inc: { userIdCounter: 1 } },
    { new: true }
  );
  if (!updated) return null;
  const prefix = buildInstitutionPrefix(updated.inst_name);
  const seq = String(updated.userIdCounter).padStart(4, "0");
  return `${prefix}${seq}`;
};

const getDefaultPermissions = (roleName) => {
  if (roleName === "student") {
    return [{
      permissionName: "Student Dashboard",
      permissionKey: "studentdashboard",
      permissionFunctionality: ["view_courses", "view_grades", "submit_assignments"],
      icon: "Home", color: "green",
      description: "Student Dashboard Access",
      isActive: true, order: 0,
    }];
  }
  return [{
    permissionName: "Staff Dashboard",
    permissionKey: "dashboard",
    permissionFunctionality: ["view_users", "add_users", "edit_users", "delete_users"],
    icon: "Home", color: "green",
    description: "Staff Dashboard Management",
    isActive: true, order: 0,
  }];
};

const roleNameOf = (role) =>
  (role.roleValue || role.renameRole || role.originalRole || "").toLowerCase();

const findRole = async (institutionId, wanted) => {
  const roles = await Role.find({ institution: institutionId }).lean();
  return {
    match: roles.find((r) => roleNameOf(r) === wanted) ||
           roles.find((r) => roleNameOf(r).includes(wanted)),
    all: roles,
  };
};

// ── Sample people ────────────────────────────────────────────────────────────
const STUDENT_NAMES = [
  ["Aarav", "Sharma"], ["Diya", "Patel"], ["Vihaan", "Reddy"], ["Ananya", "Iyer"],
  ["Arjun", "Nair"], ["Ishita", "Menon"], ["Rohan", "Gupta"], ["Sneha", "Krishnan"],
  ["Karthik", "Rao"], ["Priya", "Verma"],
  ["Aditya", "Kulkarni"], ["Meera", "Joshi"], ["Nikhil", "Pillai"], ["Kavya", "Das"],
  ["Siddharth", "Bose"], ["Riya", "Chatterjee"], ["Varun", "Mehta"], ["Lakshmi", "Srinivasan"],
  ["Harish", "Shetty"], ["Pooja", "Hegde"],
  ["Manoj", "Naidu"], ["Divya", "Raman"], ["Suresh", "Babu"], ["Nandini", "Prasad"],
  ["Vignesh", "Murthy"], ["Aishwarya", "Venkatesh"], ["Rahul", "Desai"], ["Swathi", "Ganesan"],
  ["Pranav", "Bhat"], ["Keerthana", "Subramanian"],
  ["Gautham", "Rajan"], ["Anjali", "Pandey"], ["Tarun", "Saxena"], ["Bhavana", "Kutty"],
  ["Yash", "Agarwal"], ["Sindhu", "Balan"], ["Deepak", "Mishra"], ["Ramya", "Sekar"],
  ["Ajay", "Thomas"], ["Janani", "Vel"],
];

const TRAINER_NAMES = [
  ["Ramesh", "Kumar"], ["Sunita", "Raghavan"], ["Vikram", "Anand"], ["Deepa", "Lakshman"],
];

// ── Feedback question set ────────────────────────────────────────────────────
const QUESTIONS = [
  {
    questionText: "How would you rate the trainer's subject knowledge?",
    questionType: "rating", isRequired: true, order: 1,
    ratingConfig: { minRating: 1, maxRating: 5, ratingLabels: ["Poor", "Fair", "Good", "Very Good", "Excellent"] },
    ratingStyle: "star", category: "Teaching",
  },
  {
    questionText: "How clear were the trainer's explanations?",
    questionType: "rating", isRequired: true, order: 2,
    ratingConfig: { minRating: 1, maxRating: 5, ratingLabels: ["Poor", "Fair", "Good", "Very Good", "Excellent"] },
    ratingStyle: "star", category: "Teaching",
  },
  {
    questionText: "How engaging were the training sessions?",
    questionType: "rating", isRequired: true, order: 3,
    ratingConfig: { minRating: 1, maxRating: 5, ratingLabels: ["Poor", "Fair", "Good", "Very Good", "Excellent"] },
    ratingStyle: "emoji", category: "Engagement",
  },
  {
    questionText: "How helpful was the trainer in resolving doubts?",
    questionType: "rating", isRequired: true, order: 4,
    ratingConfig: { minRating: 1, maxRating: 5, ratingLabels: ["Poor", "Fair", "Good", "Very Good", "Excellent"] },
    ratingStyle: "number", category: "Support",
  },
  {
    questionText: "What did you like most about the trainer's sessions?",
    questionType: "text", isRequired: true, order: 5,
    placeholder: "Share what worked well for you...", maxLength: 500, category: "General",
  },
  {
    questionText: "Any suggestions for improvement?",
    questionType: "text", isRequired: false, order: 6,
    placeholder: "Optional — what could be better?", maxLength: 500, category: "General",
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
  "", "",
  "Nothing much — sessions were great overall.",
];

const OVERALL_REASONS = [
  "Really enjoyed the batch, learned a lot.",
  "Great teaching style and very approachable.",
  "Sessions were consistently useful.",
  "",
  "Helped me build confidence in the subject.",
];

const pick = (arr, seed) => arr[seed % arr.length];
const ratingFor = (seed, offset) => 3 + ((seed + offset) % 3); // 3–5

const MODULE_TITLES = [
  ["Programming Fundamentals", "Variables, control flow, functions and problem solving basics."],
  ["Data Structures", "Arrays, lists, stacks, queues, trees and when to use each."],
  ["Web Development Essentials", "HTML, CSS, JavaScript and building responsive pages."],
  ["Database & SQL", "Relational modelling, joins, indexing and query optimisation."],
];

const emailFor = (prefix, kind, index) =>
  `${prefix}.${kind}${String(index + 1).padStart(2, "0")}@${EMAIL_DOMAIN}`;

// Create the user if the email is new; otherwise reuse (and top up) the doc.
const ensureUser = async ({ firstName, lastName, email, role, roleName, institution, courseId, extra = {} }) => {
  const existing = await User.findOne({ email });
  if (existing) {
    let dirty = false;
    if (existing.status !== "active") { existing.status = "active"; dirty = true; }
    const hasCourse = (existing.courses || []).some(
      (c) => c.courseId && c.courseId.toString() === courseId.toString()
    );
    if (!hasCourse) { existing.courses.push({ courseId }); dirty = true; }
    for (const [k, v] of Object.entries(extra)) {
      if (existing[k] !== v) { existing[k] = v; dirty = true; }
    }
    if (dirty) await existing.save();
    return { user: existing, created: false };
  }

  const userId = await generateUserIdForInstitution(institution);
  const user = new User({
    email, firstName, lastName,
    phone: `90000${String(Math.floor(100000 + Math.random() * 899999))}`,
    gender: Math.random() > 0.5 ? "Male" : "Female",
    password: PASSWORD, // hashed by the pre-save hook
    role: role._id,
    status: "active",
    permissions: getDefaultPermissions(roleName),
    institution,
    userId,
    createdBy: SEED_BY,
    courses: [{ courseId }],
    ...extra,
  });
  await user.save();
  return { user, created: true };
};

const enrollMembers = (batch, members) => {
  let added = 0;
  for (const member of members) {
    const already = (batch.users || []).some(
      (u) => u.user && u.user.toString() === member._id.toString()
    );
    if (already) continue;
    batch.users.push({ user: member._id, status: "active", joinedAt: new Date(), updatedAt: new Date() });
    added++;
  }
  batch.updatedAt = new Date();
  return added;
};

const ensureModules = async (course) => {
  for (let i = 0; i < MODULE_TITLES.length; i++) {
    const [title, description] = MODULE_TITLES[i];
    const existing = await Module1.findOne({ courses: course._id, title });
    if (existing) continue;
    await Module1.create({
      institution: course.institution,
      courses: course._id,
      title, description,
      duration: 10,
      index: i + 1,
      level: "Intermediate",
      createdBy: SEED_BY,
    });
    console.log(`  created module ${i + 1}. ${title}`);
  }
};

const ensureProgramCalendar = async (course, clientCompany, trainerNames) => {
  const existing = await ProgramCalendar.findOne({ courseId: course._id });
  if (existing) {
    console.log(`  exists  program calendar for ${course.courseName}`);
    return;
  }
  await ProgramCalendar.create({
    courseId: course._id,
    courseName: course.courseName,
    courseCode: course.courseCode || "",
    courseDetails: {
      category: course.category || "",
      courseLevel: course.courseLevel || "",
      courseDuration: course.courseDuration || "",
      serviceType: course.serviceType || "",
      serviceModal: course.serviceModal || "",
      clientName: clientCompany || "",
    },
    startDate: "2026-07-06",
    endDate: "2026-12-18",
    workingDays: [1, 2, 3, 4, 5],
    dailyHours: 6,
    totalHours: 40,
    estimatedDays: 115,
    sessions: [
      { slotId: "seed-s1", kind: "session", name: "Session 1 — Concepts", startTime: "09:30", endTime: "11:00", trainer: trainerNames[0] || "", sessionType: "Theory" },
      { slotId: "seed-b1", kind: "break", name: "Tea Break", startTime: "11:00", endTime: "11:15" },
      { slotId: "seed-s2", kind: "session", name: "Session 2 — Hands-on Lab", startTime: "11:15", endTime: "13:00", trainer: trainerNames[1] || trainerNames[0] || "", sessionType: "Practical" },
      { slotId: "seed-b2", kind: "break", name: "Lunch Break", startTime: "13:00", endTime: "13:45" },
      { slotId: "seed-s3", kind: "session", name: "Session 3 — Practice & Doubts", startTime: "13:45", endTime: "15:30", trainer: trainerNames[0] || "", sessionType: "Practical" },
    ],
    holidays: [
      { holidayId: "seed-h1", name: "Independence Day", date: "2026-08-15", duration: "full" },
      { holidayId: "seed-h2", name: "Ayudha Pooja", date: "2026-10-19", duration: "full" },
      { holidayId: "seed-h3", name: "Diwali", date: "2026-11-08", duration: "full" },
    ],
    assessmentDays: [
      { asmtId: "seed-a1", name: "Mid Assessment", date: "2026-09-21", days: 2 },
    ],
    status: "published",
    createdBy: SEED_BY,
    updatedBy: SEED_BY,
  });
  console.log(`  created program calendar for ${course.courseName}`);
};

const ensureFeedback = async ({ course, batch, trainer, students, titleSuffix }) => {
  const trainerName = `${trainer.firstName} ${trainer.lastName || ""}`.trim();
  let form = await Feedback.findOne({ courseId: course._id, trainerId: trainer._id });
  if (!form) {
    form = new Feedback({
      courseId: course._id,
      feedbackTitle: `Trainer Feedback — ${trainerName} (${titleSuffix})`,
      feedbackDescription:
        `Feedback for ${trainerName}'s sessions (${titleSuffix}). ` +
        `Your responses help us improve the training quality.`,
      questions: QUESTIONS,
      studentResponses: [],
      isActive: true,
      isPublished: true,
      startDate: new Date("2026-07-06T00:00:00.000Z"),
      endDate: new Date("2026-12-31T23:59:59.000Z"),
      isAnonymousAllowed: true,
      maxAttempts: 1,
      batchId: batch._id,
      batchName: batch.batchName,
      trainerId: trainer._id,
      trainerName,
      trainerEmail: trainer.email,
      createdBy: FEEDBACK_CREATED_BY,
      updatedBy: FEEDBACK_CREATED_BY,
    });
    console.log(`  created form: ${form.feedbackTitle}`);
  } else {
    console.log(`  exists  form: ${form.feedbackTitle}`);
  }

  students.forEach((student, idx) => {
    if (form.hasStudentResponded(student._id)) return;
    if (idx % 10 >= 7) return; // ~70% response rate

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

    form.addStudentResponse(
      student._id,
      `${student.firstName} ${student.lastName || ""}`.trim(),
      student.email,
      answers,
      idx % 7 === 3,
      pick(OVERALL_REASONS, seed)
    );
  });

  await form.save();
  console.log(`  saved: ${form.studentResponses.length} responses, avg ${form.statistics.averageRating}`);
};

// ─────────────────────────────────────────────────────────────────────────────
const main = async () => {
  if (!process.env.MONGOURI) throw new Error("MONGOURI not found in server/.env");
  await mongoose.connect(process.env.MONGOURI);
  console.log("MongoDB connected");

  const skCourse = await CourseStructure.findOne({ courseCode: SKILLING_CODE });
  const degCourse = await CourseStructure.findOne({ courseCode: DEGREE_CODE });
  if (!skCourse) throw new Error(`Course ${SKILLING_CODE} not found`);
  if (!degCourse) throw new Error(`Course ${DEGREE_CODE} not found`);
  console.log(`Skilling course: ${skCourse.courseName} (${skCourse._id})`);
  console.log(`Degree course:   ${degCourse.courseName} (${degCourse._id})`);

  // Institution comes FROM the courses (both are on the same one).
  const institutionId = skCourse.institution;
  const institution = await Institution.findById(institutionId);
  console.log(`Institution: ${institution?.inst_name || institutionId}`);

  // Client company name (for the calendar snapshot)
  const dyn = await CourseStructureDynamic.findOne({ "client._id": skCourse.clientName });
  const client = dyn?.client?.find((c) => c._id.toString() === skCourse.clientName.toString());
  const clientCompany = client?.clientCompany || "";
  console.log(`Client: ${clientCompany || "(not found)"}`);

  // ── Roles ──────────────────────────────────────────────────────────────────
  const { match: studentRole, all: allRoles } = await findRole(institutionId, "student");
  if (!studentRole) {
    console.error("Available roles:", allRoles.map((r) => roleNameOf(r)));
    throw new Error(`Missing student role for institution ${institutionId}`);
  }
  let { match: trainerRole } = await findRole(institutionId, "trainer");
  if (!trainerRole) {
    trainerRole = await Role.create({
      institution: institutionId,
      originalRole: "Trainer", renameRole: "Trainer", roleValue: "trainer",
      createdBy: SEED_BY,
    });
    console.log(`created Trainer role ${trainerRole._id}`);
  }

  // ══ SKILLING: APL-TM-T-002 — 10 students + 1 distinct trainer per batch ════
  console.log(`\n── ${SKILLING_CODE} users & batches ──`);
  const skBatchNames = (skCourse.batchAndParticipants || []).map((b) => b.batchName);
  const skStudents = [];
  for (let i = 0; i < 20; i++) {
    const [firstName, lastName] = STUDENT_NAMES[i];
    const batchName = skBatchNames[Math.floor(i / 10)] || skBatchNames[0];
    const { user, created } = await ensureUser({
      firstName, lastName,
      email: emailFor("aplsk", "student", i),
      role: studentRole, roleName: "student",
      institution: institutionId, courseId: skCourse._id,
      extra: {
        studentType: "skilling",
        clientName: clientCompany,
        batch: batchName,
      },
    });
    skStudents.push(user);
    if (created) console.log(`created ${user.email} (${batchName})`);
  }
  const skTrainers = [];
  for (let i = 0; i < 2; i++) {
    const [firstName, lastName] = TRAINER_NAMES[i];
    const { user, created } = await ensureUser({
      firstName, lastName,
      email: emailFor("aplsk", "trainer", i),
      role: trainerRole, roleName: "trainer",
      institution: institutionId, courseId: skCourse._id,
      extra: { department: "Training" },
    });
    skTrainers.push(user);
    if (created) console.log(`created ${user.email}`);
  }

  const skBatchPlans = skCourse.batchAndParticipants.map((batch, i) => ({
    batch,
    students: skStudents.slice(i * 10, i * 10 + 10),
    trainer: skTrainers[i] || skTrainers[0],
  }));
  for (const plan of skBatchPlans) {
    // Give undated batches a schedule so the Batches page shows a real status.
    if (!plan.batch.batchStartDate) plan.batch.batchStartDate = new Date("2026-07-06");
    if (!plan.batch.batchEndDate) plan.batch.batchEndDate = new Date("2026-12-18T23:59:59Z");
    const added = enrollMembers(plan.batch, [...plan.students, plan.trainer]);
    console.log(`  ${plan.batch.batchName}: +${added} members (total ${plan.batch.users.length}), trainer ${plan.trainer.firstName}`);
  }
  await CourseStructure.updateOne(
    { _id: skCourse._id },
    { $set: { batchAndParticipants: skCourse.batchAndParticipants, updatedAt: new Date() } }
  );

  // ══ DEGREE: APL-TM-T-001 — 10 students per section + trainer per section ═══
  console.log(`\n── ${DEGREE_CODE} users & batch ──`);
  const degBatch = degCourse.batchAndParticipants.find(
    (b) => b.batchName === (degCourse.batch || "").trim()
  ) || degCourse.batchAndParticipants[0];
  if (!degBatch) throw new Error(`No batch found on ${DEGREE_CODE}`);

  const sections = (degCourse.sections || []).filter(Boolean);
  const degStudents = [];
  for (let i = 0; i < sections.length * 10; i++) {
    const [firstName, lastName] = STUDENT_NAMES[i + 20]; // different names than skilling
    const section = sections[Math.floor(i / 10)];
    const { user, created } = await ensureUser({
      firstName, lastName,
      email: emailFor("apldeg", "student", i),
      role: studentRole, roleName: "student",
      institution: institutionId, courseId: degCourse._id,
      extra: {
        studentType: "degree-program",
        clientName: clientCompany,
        degree: degCourse.degree || "",
        department: degCourse.department || "",
        year: "I",
        semester: degCourse.semester || "",
        section,                       // ← what the section-scoped pages filter on
        batch: degCourse.batch || degBatch.batchName,
      },
    });
    degStudents.push(user);
    if (created) console.log(`created ${user.email} (Section ${section})`);
  }
  const degTrainers = [];
  for (let i = 0; i < Math.max(sections.length, 1); i++) {
    const [firstName, lastName] = TRAINER_NAMES[i + 2];
    const { user, created } = await ensureUser({
      firstName, lastName,
      email: emailFor("apldeg", "trainer", i),
      role: trainerRole, roleName: "trainer",
      institution: institutionId, courseId: degCourse._id,
      extra: { department: degCourse.department || "" },
    });
    degTrainers.push(user);
    if (created) console.log(`created ${user.email}`);
  }

  if (!degBatch.batchStartDate) degBatch.batchStartDate = new Date("2026-07-06");
  if (!degBatch.batchEndDate) degBatch.batchEndDate = new Date("2026-12-18T23:59:59Z");
  const degAdded = enrollMembers(degBatch, [...degStudents, ...degTrainers]);
  console.log(`  ${degBatch.batchName}: +${degAdded} members (total ${degBatch.users.length})`);
  await CourseStructure.updateOne(
    { _id: degCourse._id },
    { $set: { batchAndParticipants: degCourse.batchAndParticipants, updatedAt: new Date() } }
  );

  // ── Modules ────────────────────────────────────────────────────────────────
  console.log("\n── Modules ──");
  await ensureModules(skCourse);
  await ensureModules(degCourse);

  // ── Program calendars ──────────────────────────────────────────────────────
  console.log("\n── Program calendars ──");
  await ensureProgramCalendar(skCourse, clientCompany, skTrainers.map((t) => `${t.firstName} ${t.lastName}`));
  await ensureProgramCalendar(degCourse, clientCompany, degTrainers.map((t) => `${t.firstName} ${t.lastName}`));

  // ── Feedback ───────────────────────────────────────────────────────────────
  console.log(`\n── Feedback: ${SKILLING_CODE} ──`);
  for (const plan of skBatchPlans) {
    await ensureFeedback({
      course: skCourse, batch: plan.batch, trainer: plan.trainer,
      students: plan.students, titleSuffix: `Batch ${plan.batch.batchName}`,
    });
  }

  console.log(`\n── Feedback: ${DEGREE_CODE} ──`);
  for (let i = 0; i < sections.length; i++) {
    await ensureFeedback({
      course: degCourse, batch: degBatch, trainer: degTrainers[i] || degTrainers[0],
      students: degStudents.slice(i * 10, i * 10 + 10),
      titleSuffix: `Sem ${degCourse.semester || "?"} · Section ${sections[i]}`,
    });
  }

  // ── Verify a login works ───────────────────────────────────────────────────
  const probe = await User.findOne({ email: emailFor("aplsk", "student", 0) });
  const ok = await bcrypt.compare(PASSWORD, probe.password);
  if (!ok) throw new Error("Password verification failed — check the pre-save hook");

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log("\n──────── Summary ────────");
  console.log(`${SKILLING_CODE} "${skCourse.courseName}"`);
  for (const plan of skBatchPlans) {
    console.log(`  ${plan.batch.batchName}: ${plan.batch.users.length} members, trainer ${plan.trainer.firstName} ${plan.trainer.lastName}`);
  }
  console.log(`${DEGREE_CODE} "${degCourse.courseName}"`);
  console.log(`  ${degBatch.batchName}: ${degBatch.users.length} members — sections ${sections.join(", ")}`);
  sections.forEach((s, i) => {
    const t = degTrainers[i] || degTrainers[0];
    console.log(`    Section ${s}: trainer ${t.firstName} ${t.lastName}`);
  });
  console.log(`\nLogins (password "${PASSWORD}"):`);
  console.log(`  skilling students: aplsk.student01@${EMAIL_DOMAIN} … aplsk.student20@${EMAIL_DOMAIN}`);
  console.log(`  skilling trainers: aplsk.trainer01@${EMAIL_DOMAIN}, aplsk.trainer02@${EMAIL_DOMAIN}`);
  console.log(`  degree students:   apldeg.student01@${EMAIL_DOMAIN} … apldeg.student${String(sections.length * 10).padStart(2, "0")}@${EMAIL_DOMAIN}`);
  console.log(`  degree trainers:   ${degTrainers.map((t) => t.email).join(", ")}`);
};

main()
  .then(() => mongoose.disconnect())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error("\nSeed failed:", err.message);
    console.error(err.stack);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
