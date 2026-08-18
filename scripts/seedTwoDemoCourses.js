// Seed TWO complete demo courses — "abc skilling" and "abc degree program" —
// with everything the coursestructure pages need:
//
//   • Two demo clients in Dynamic Field Settings:
//       ABC Technologies        (type: skilling,  batches 2026-A / 2026-B / 2026-C)
//       ABC Engineering College (type: degree program, batch 2023-2027,
//                                B.E → Computer Science → sections A & B, sem 5)
//   • A "B.E" Degree doc (8 semesters, CSE department) so the client wizard
//     dropdowns keep working when the demo client is edited.
//   • Course "abc skilling":  3 batches × 10 students, a DIFFERENT trainer per
//     batch (3 trainers).
//   • Course "abc degree program": batch 2023-2027 with 20 students — 10 in
//     section A, 10 in section B (section stored on the user doc, which is
//     what the section-scoped participants page filters on) + 2 trainers
//     (one per section).
//   • 4 modules per course (course structure).
//   • A program calendar per course (daily session template, holidays,
//     published).
//   • Feedback forms — one per trainer per batch/section, with ~70% of that
//     batch/section's students responding (ratings skew 3–5 + comments).
//
// Idempotent: safe to re-run; existing clients/courses/users/forms are reused.
// Run from the server folder:  node scripts/seedTwoDemoCourses.js

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const User = require("../models/UserModel");
const Role = require("../models/RoleModel");
const Institution = require("../models/InstitutionModal");
const CourseStructure = require("../models/Courses/courseStructureModal");
const CourseStructureDynamic = require("../models/dynamicContent/courseStructureDynamicModal");
const Degree = require("../models/dynamicContent/DegreeAndDepartmentModel");
const Feedback = require("../models/FeedbackModal");
const ProgramCalendar = require("../models/Courses/ProgramCalendarModel");
const Module1 = require("../models/Courses/moduleStructure/moduleModal");

const PASSWORD = "123";
const EMAIL_DOMAIN = "lmsdemo.in";
const SEED_BY = "seed-two-demo-courses";

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

// ── Same default permissions the app's Addusers flow assigns ────────────────
const getDefaultPermissions = (roleName) => {
  if (roleName === "student") {
    return [{
      permissionName: "Student Dashboard",
      permissionKey: "studentdashboard",
      permissionFunctionality: ["view_courses", "view_grades", "submit_assignments"],
      icon: "Home",
      color: "green",
      description: "Student Dashboard Access",
      isActive: true,
      order: 0,
    }];
  }
  return [{
    permissionName: "Staff Dashboard",
    permissionKey: "dashboard",
    permissionFunctionality: ["view_users", "add_users", "edit_users", "delete_users"],
    icon: "Home",
    color: "green",
    description: "Staff Dashboard Management",
    isActive: true,
    order: 0,
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
];

const TRAINER_NAMES = [
  ["Ramesh", "Kumar"], ["Sunita", "Raghavan"], ["Vikram", "Anand"],
  ["Deepa", "Lakshman"], ["Arvind", "Swaminathan"],
];

// ── Feedback question set (same shape the app's feedback form creates) ──────
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
const ratingFor = (seed, offset) => 3 + ((seed + offset) % 3); // 3–5, skews positive

// ── Course modules (structure) ───────────────────────────────────────────────
const MODULE_TITLES = [
  ["Programming Fundamentals", "Variables, control flow, functions and problem solving basics."],
  ["Data Structures", "Arrays, lists, stacks, queues, trees and when to use each."],
  ["Web Development Essentials", "HTML, CSS, JavaScript and building responsive pages."],
  ["Database & SQL", "Relational modelling, joins, indexing and query optimisation."],
];

// resourcesType in the current nested pedagogy shape
const buildResourcesType = () => {
  const fileResource = (maxSize, formats) => ({
    enabled: true, maxSize, aiChat: false, aiSummary: false, allowedFormats: formats,
  });
  const section = () => ({
    video: fileResource(50, ["mp4", "mov", "avi", "webm"]),
    ppt: fileResource(20, ["ppt", "pptx"]),
    pdf: fileResource(10, ["pdf"]),
    url: { enabled: true },
    aiChat: { enabled: false },
    aiSummary: { enabled: false },
    notes: { enabled: false },
  });
  return { iDo: section(), weDo: section(), youDo: section() };
};

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
    // Keep demo attributes (section/semester/batch) in sync on re-runs.
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

// ── Clients (Dynamic Field Settings) ─────────────────────────────────────────
const ensureClient = async (dyn, clientData) => {
  let client = dyn.client.find(
    (c) => (c.clientCompany || "").toLowerCase() === clientData.clientCompany.toLowerCase()
  );
  if (client) {
    console.log(`exists  client ${client.clientCompany}`);
    return client;
  }
  dyn.client.push(clientData);
  await dyn.save();
  client = dyn.client[dyn.client.length - 1];
  console.log(`created client ${client.clientCompany}`);
  return client;
};

// ── Courses ──────────────────────────────────────────────────────────────────
const ensureCourse = async (institution, fields) => {
  let course = await CourseStructure.findOne({
    institution, courseName: fields.courseName,
  });
  if (course) {
    console.log(`exists  course ${course.courseName}`);
    return course;
  }
  course = new CourseStructure({
    institution,
    resourcesType: buildResourcesType(),
    courseHierarchy: ["Module"],
    I_Do: ["Video", "PPT"],
    We_Do: ["Discussion"],
    You_Do: ["Assignment"],
    batchAndParticipants: [],
    ...fields,
  });
  await course.save();
  console.log(`created course ${course.courseName} (${course._id})`);
  return course;
};

// ── Batches on a course ──────────────────────────────────────────────────────
const ensureBatch = (course, def, seedAdmin) => {
  let batch = course.batchAndParticipants.find(
    (b) => b.batchName && b.batchName.toLowerCase() === def.batchName.toLowerCase()
  );
  if (!batch) {
    course.batchAndParticipants.push({
      batchName: def.batchName,
      batchDescription: def.batchDescription || "",
      batchStartDate: def.batchStartDate || null,
      batchEndDate: def.batchEndDate || null,
      users: [],
      status: "active",
      createdAt: new Date(),
      createdBy: seedAdmin,
      updatedAt: new Date(),
      updatedBy: seedAdmin,
    });
    batch = course.batchAndParticipants[course.batchAndParticipants.length - 1];
    console.log(`  created batch ${def.batchName}`);
  }
  return batch;
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

// ── Modules ──────────────────────────────────────────────────────────────────
const ensureModules = async (course) => {
  for (let i = 0; i < MODULE_TITLES.length; i++) {
    const [title, description] = MODULE_TITLES[i];
    const existing = await Module1.findOne({ courses: course._id, title });
    if (existing) continue;
    await Module1.create({
      institution: course.institution,
      courses: course._id,
      title,
      description,
      duration: 10,     // hours
      index: i + 1,
      level: "Intermediate",
      createdBy: SEED_BY,
    });
    console.log(`  created module ${i + 1}. ${title}`);
  }
};

// ── Program calendar ─────────────────────────────────────────────────────────
const ensureProgramCalendar = async (course, client, trainerNames) => {
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
      clientName: client.clientCompany,
    },
    startDate: "2026-07-06",
    endDate: "2026-12-18",
    workingDays: [1, 2, 3, 4, 5], // Mon–Fri
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

// ── Feedback (one form per trainer, responses from their students) ──────────
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
      createdBy: SEED_BY,
      updatedBy: SEED_BY,
    });
    console.log(`  created form: ${form.feedbackTitle}`);
  } else {
    console.log(`  exists  form: ${form.feedbackTitle}`);
  }

  let responsesAdded = 0;
  students.forEach((student, idx) => {
    if (form.hasStudentResponded(student._id)) return;
    if (idx % 10 >= 7) return; // ~70% response rate — realistic cohort

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
      idx % 7 === 3, // every 7th response anonymous
      pick(OVERALL_REASONS, seed)
    );
    responsesAdded++;
  });

  await form.save(); // pre-save hook recomputes statistics
  console.log(`  saved: ${form.studentResponses.length} responses, avg ${form.statistics.averageRating}`);
  return responsesAdded;
};

// ─────────────────────────────────────────────────────────────────────────────
const main = async () => {
  if (!process.env.MONGOURI) throw new Error("MONGOURI not found in server/.env");
  await mongoose.connect(process.env.MONGOURI);
  console.log("MongoDB connected");

  const institution = await Institution.findOne().sort({ _id: 1 });
  if (!institution) throw new Error("No institution found in the database");
  console.log(`Institution: ${institution.inst_name} (${institution._id})`);

  // ── Roles ──────────────────────────────────────────────────────────────────
  const { match: studentRole, all: allRoles } = await findRole(institution._id, "student");
  if (!studentRole) {
    console.error("Available roles:", allRoles.map((r) => roleNameOf(r)));
    throw new Error(`Missing student role for institution ${institution._id}`);
  }
  let { match: trainerRole } = await findRole(institution._id, "trainer");
  if (!trainerRole) {
    trainerRole = await Role.create({
      institution: institution._id,
      originalRole: "Trainer", renameRole: "Trainer", roleValue: "trainer",
      createdBy: SEED_BY,
    });
    console.log(`created Trainer role ${trainerRole._id}`);
  }

  // ── Degree doc (keeps the client wizard dropdowns working) ────────────────
  let degreeDoc = await Degree.findOne({ institution: institution._id, degreeName: "B.E" });
  if (!degreeDoc) {
    degreeDoc = await Degree.create({
      institution: institution._id,
      degreeName: "B.E",
      degreeCode: "BE",
      numberOfSemesters: 8,
      description: "Bachelor of Engineering — seeded demo degree",
      departments: [
        { departmentName: "Computer Science", departmentCode: "CSE", description: "CSE department", createdBy: SEED_BY, updatedBy: SEED_BY },
      ],
      createdBy: SEED_BY,
    });
    console.log(`created degree B.E (${degreeDoc._id})`);
  } else {
    console.log("exists  degree B.E");
  }

  // ── Clients ────────────────────────────────────────────────────────────────
  let dyn = await CourseStructureDynamic.findOne({ institution: institution._id });
  if (!dyn) {
    dyn = new CourseStructureDynamic({ institution: institution._id, client: [], category: [], service: [], createdBy: SEED_BY });
    await dyn.save();
    console.log("created Course-Structure-Dynamic doc for institution");
  }

  const skillingClient = await ensureClient(dyn, {
    clientCompany: "ABC Technologies",
    description: "Demo skilling client — seeded",
    clientAddress: "12 Tech Park Road, Coimbatore",
    status: "active",
    type: ["skilling"],
    skillingBatches: ["2026-A", "2026-B", "2026-C"],
    degreeBatches: [],
    contactPersons: [
      { name: "Rajesh Kannan", email: "rajesh@abctech.example", phoneNumber: "9876500011", isPrimary: true },
    ],
    createdBy: SEED_BY,
  });

  const degreeClient = await ensureClient(dyn, {
    clientCompany: "ABC Engineering College",
    description: "Demo degree-program client — seeded",
    clientAddress: "45 College Road, Chennai",
    status: "active",
    type: ["degree program"],
    skillingBatches: [],
    degreeBatches: [{
      batch: "2023-2027",
      degree: "B.E",
      semester: "5",
      departments: [{ department: "Computer Science", sections: ["A", "B"] }],
      semesterDetails: Array.from({ length: 8 }, (_, i) => ({
        semesterNumber: i + 1,
        startMonth: i % 2 === 0 ? "August" : "January",
        endMonth: i % 2 === 0 ? "December" : "May",
      })),
    }],
    contactPersons: [
      { name: "Prof. Meenakshi Sundaram", email: "meenakshi@abccollege.example", phoneNumber: "9876500022", isPrimary: true },
    ],
    createdBy: SEED_BY,
  });

  // Category entry so course filters look right
  if (!dyn.category.some((c) => (c.categoryName || "").toLowerCase() === "software training")) {
    dyn.category.push({ categoryName: "Software Training", categoryDescription: "Seeded demo category", createdBy: SEED_BY });
    await dyn.save();
    console.log("created category Software Training");
  }

  // ── Courses ────────────────────────────────────────────────────────────────
  console.log("\n── Course: abc skilling ──");
  const skillingCourse = await ensureCourse(institution._id, {
    clientName: skillingClient._id,
    serviceType: "Corporate Training",
    serviceModal: "Offline",
    category: "Software Training",
    courseCode: "ABC-SKL-001",
    courseName: "abc skilling",
    courseDescription: "Demo skilling course — full-stack fundamentals for ABC Technologies batches.",
    courseDuration: "40 hours",
    courseLevel: "Intermediate",
    studentType: "skilling",
    skillingBatches: ["2026-A", "2026-B", "2026-C"],
  });

  console.log("\n── Course: abc degree program ──");
  const degreeCourse = await ensureCourse(institution._id, {
    clientName: degreeClient._id,
    serviceType: "Degree Program",
    serviceModal: "Offline",
    category: "Software Training",
    courseCode: "ABC-DEG-001",
    courseName: "abc degree program",
    courseDescription: "Demo degree-program course — B.E CSE semester 5, sections A & B, batch 2023-2027.",
    courseDuration: "40 hours",
    courseLevel: "Intermediate",
    studentType: "degree-program",
    batch: "2023-2027",
    degree: "B.E",
    department: "Computer Science",
    semester: "5",
    sections: ["A", "B"],
  });

  // ── Users: skilling (30 students, 3 trainers — one per batch) ──────────────
  console.log("\n── Users: abc skilling ──");
  const skStudents = [];
  for (let i = 0; i < 30; i++) {
    const [firstName, lastName] = STUDENT_NAMES[i];
    const batchName = i < 10 ? "2026-A" : i < 20 ? "2026-B" : "2026-C";
    const { user, created } = await ensureUser({
      firstName, lastName,
      email: emailFor("abcsk", "student", i),
      role: studentRole, roleName: "student",
      institution: institution._id, courseId: skillingCourse._id,
      extra: {
        studentType: "skilling",
        clientName: "ABC Technologies",
        batch: batchName,
      },
    });
    skStudents.push(user);
    if (created) console.log(`created ${user.email} (${batchName})`);
  }
  const skTrainers = [];
  for (let i = 0; i < 3; i++) {
    const [firstName, lastName] = TRAINER_NAMES[i];
    const { user, created } = await ensureUser({
      firstName, lastName,
      email: emailFor("abcsk", "trainer", i),
      role: trainerRole, roleName: "trainer",
      institution: institution._id, courseId: skillingCourse._id,
      extra: { department: "Training" },
    });
    skTrainers.push(user);
    if (created) console.log(`created ${user.email}`);
  }

  // ── Users: degree (20 students in 2 sections, 2 trainers — one per section) ─
  console.log("\n── Users: abc degree program ──");
  const degStudents = [];
  for (let i = 0; i < 20; i++) {
    const [firstName, lastName] = STUDENT_NAMES[i + 10]; // different slice for variety
    const section = i < 10 ? "A" : "B";
    const { user, created } = await ensureUser({
      firstName, lastName,
      email: emailFor("abcdeg", "student", i),
      role: studentRole, roleName: "student",
      institution: institution._id, courseId: degreeCourse._id,
      extra: {
        studentType: "degree-program",
        clientName: "ABC Engineering College",
        degree: "B.E",
        department: "Computer Science",
        year: "III",
        semester: "5",
        section,                    // ← what the section-scoped pages filter on
        batch: "2023-2027",
      },
    });
    degStudents.push(user);
    if (created) console.log(`created ${user.email} (Section ${section})`);
  }
  const degTrainers = [];
  for (let i = 0; i < 2; i++) {
    const [firstName, lastName] = TRAINER_NAMES[i + 3];
    const { user, created } = await ensureUser({
      firstName, lastName,
      email: emailFor("abcdeg", "trainer", i),
      role: trainerRole, roleName: "trainer",
      institution: institution._id, courseId: degreeCourse._id,
      extra: { department: "Computer Science" },
    });
    degTrainers.push(user);
    if (created) console.log(`created ${user.email}`);
  }

  // ── Batches: skilling — a DIFFERENT trainer per batch ──────────────────────
  console.log("\n── Batches: abc skilling ──");
  const SK_BATCHES = [
    { batchName: "2026-A", batchDescription: "Morning batch — seeded", batchStartDate: new Date("2026-07-06"), batchEndDate: new Date("2026-12-18T23:59:59Z"), students: skStudents.slice(0, 10), trainer: skTrainers[0] },
    { batchName: "2026-B", batchDescription: "Afternoon batch — seeded", batchStartDate: new Date("2026-07-06"), batchEndDate: new Date("2026-12-18T23:59:59Z"), students: skStudents.slice(10, 20), trainer: skTrainers[1] },
    { batchName: "2026-C", batchDescription: "Weekend batch — seeded", batchStartDate: new Date("2026-08-01"), batchEndDate: new Date("2027-01-15T23:59:59Z"), students: skStudents.slice(20, 30), trainer: skTrainers[2] },
  ];
  const seedAdminSk = skTrainers[0]._id;
  for (const def of SK_BATCHES) {
    const batch = ensureBatch(skillingCourse, def, seedAdminSk);
    const added = enrollMembers(batch, [...def.students, def.trainer]);
    console.log(`  ${def.batchName}: +${added} members (total ${batch.users.length}), trainer ${def.trainer.firstName}`);
  }
  await CourseStructure.updateOne(
    { _id: skillingCourse._id },
    { $set: { batchAndParticipants: skillingCourse.batchAndParticipants, updatedAt: new Date(), updatedBy: SEED_BY } }
  );

  // ── Batches: degree — one batch, both sections' students inside ────────────
  console.log("\n── Batches: abc degree program ──");
  const degBatchDef = {
    batchName: "2023-2027",
    batchDescription: "B.E CSE 2023-2027 — sections A & B (seeded)",
    batchStartDate: new Date("2026-07-06"),
    batchEndDate: new Date("2026-12-18T23:59:59Z"),
  };
  const seedAdminDeg = degTrainers[0]._id;
  const degBatch = ensureBatch(degreeCourse, degBatchDef, seedAdminDeg);
  const degAdded = enrollMembers(degBatch, [...degStudents, ...degTrainers]);
  console.log(`  2023-2027: +${degAdded} members (total ${degBatch.users.length})`);
  await CourseStructure.updateOne(
    { _id: degreeCourse._id },
    { $set: { batchAndParticipants: degreeCourse.batchAndParticipants, updatedAt: new Date(), updatedBy: SEED_BY } }
  );

  // ── Modules ────────────────────────────────────────────────────────────────
  console.log("\n── Modules ──");
  await ensureModules(skillingCourse);
  await ensureModules(degreeCourse);

  // ── Program calendars ──────────────────────────────────────────────────────
  console.log("\n── Program calendars ──");
  await ensureProgramCalendar(skillingCourse, skillingClient, skTrainers.map((t) => `${t.firstName} ${t.lastName}`));
  await ensureProgramCalendar(degreeCourse, degreeClient, degTrainers.map((t) => `${t.firstName} ${t.lastName}`));

  // ── Feedback ───────────────────────────────────────────────────────────────
  console.log("\n── Feedback: abc skilling ──");
  for (const def of SK_BATCHES) {
    const batch = skillingCourse.batchAndParticipants.find((b) => b.batchName === def.batchName);
    await ensureFeedback({
      course: skillingCourse, batch, trainer: def.trainer,
      students: def.students, titleSuffix: `Batch ${def.batchName}`,
    });
  }

  console.log("\n── Feedback: abc degree program ──");
  await ensureFeedback({
    course: degreeCourse, batch: degBatch, trainer: degTrainers[0],
    students: degStudents.slice(0, 10), titleSuffix: "Sem 5 · Section A",
  });
  await ensureFeedback({
    course: degreeCourse, batch: degBatch, trainer: degTrainers[1],
    students: degStudents.slice(10, 20), titleSuffix: "Sem 5 · Section B",
  });

  // ── Verify a login works ───────────────────────────────────────────────────
  const probe = await User.findOne({ email: emailFor("abcsk", "student", 0) });
  const ok = await bcrypt.compare(PASSWORD, probe.password);
  if (!ok) throw new Error("Password verification failed — check the pre-save hook");

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log("\n──────── Summary ────────");
  console.log(`Course "abc skilling" (${skillingCourse._id})`);
  for (const def of SK_BATCHES) {
    const b = skillingCourse.batchAndParticipants.find((x) => x.batchName === def.batchName);
    console.log(`  ${def.batchName}: ${b.users.length} members, trainer ${def.trainer.firstName} ${def.trainer.lastName}`);
  }
  console.log(`Course "abc degree program" (${degreeCourse._id})`);
  console.log(`  2023-2027: ${degBatch.users.length} members — Sec A: ${degTrainers[0].firstName}, Sec B: ${degTrainers[1].firstName}`);
  console.log(`\nLogins (password "${PASSWORD}"):`);
  console.log(`  skilling students: abcsk.student01@${EMAIL_DOMAIN} … abcsk.student30@${EMAIL_DOMAIN}`);
  console.log(`  skilling trainers: abcsk.trainer01@${EMAIL_DOMAIN} … abcsk.trainer03@${EMAIL_DOMAIN}`);
  console.log(`  degree students:   abcdeg.student01@${EMAIL_DOMAIN} … abcdeg.student20@${EMAIL_DOMAIN} (01-10 Sec A, 11-20 Sec B)`);
  console.log(`  degree trainers:   abcdeg.trainer01@${EMAIL_DOMAIN} (Sec A), abcdeg.trainer02@${EMAIL_DOMAIN} (Sec B)`);
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
