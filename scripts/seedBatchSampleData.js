// Seed sample batch data for a course.
//
// Creates (idempotently):
//   • 30 students + 4 trainers in LMS-Users (password "123", hashed by the
//     UserModel pre-save hook, status active — so they can log in normally)
//   • 3 batches on the course's batchAndParticipants:
//       Batch 2026-A → 10 students + 2 trainers
//       Batch 2026-B → 10 students + 1 trainer
//       Batch 2026-C → 10 students + 1 trainer
//
// Users also get a `courses: [{ courseId }]` entry so analytics/review pages
// (which skip batch users without a matching courses[] entry) count them.
//
// Run from the server folder:  node scripts/seedBatchSampleData.js

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const User = require("../models/UserModel");
const Role = require("../models/RoleModel");
const Institution = require("../models/InstitutionModal");
const CourseStructure = require("../models/Courses/courseStructureModal");

const COURSE_ID = "692d21f0a00585bfd3cb8c63";
const PASSWORD = "123";
const EMAIL_DOMAIN = "lmsdemo.in";

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
  // Trainers (and every non-student, non-admin role) get staff permissions.
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
  ["Ramesh", "Kumar"], ["Sunita", "Raghavan"], ["Vikram", "Anand"], ["Deepa", "Lakshman"],
];

// Batch layout: 10 students each; A gets 2 trainers, B and C one each.
const BATCHES = [
  {
    batchName: "Batch 2026-A",
    batchDescription: "Morning batch — sample data",
    batchStartDate: new Date("2026-07-01T00:00:00.000Z"),
    batchEndDate: new Date("2026-12-20T23:59:59.000Z"),
    studentSlice: [0, 10],
    trainerSlice: [0, 2],
  },
  {
    batchName: "Batch 2026-B",
    batchDescription: "Afternoon batch — sample data",
    batchStartDate: new Date("2026-06-15T00:00:00.000Z"),
    batchEndDate: new Date("2026-11-30T23:59:59.000Z"),
    studentSlice: [10, 20],
    trainerSlice: [2, 3],
  },
  {
    batchName: "Batch 2026-C",
    batchDescription: "Weekend batch — sample data",
    batchStartDate: new Date("2026-08-01T00:00:00.000Z"),
    batchEndDate: new Date("2027-01-15T23:59:59.000Z"),
    studentSlice: [20, 30],
    trainerSlice: [3, 4],
  },
];

const emailFor = (kind, index) =>
  `${kind}${String(index + 1).padStart(2, "0")}@${EMAIL_DOMAIN}`;

// Create the user if the email is new; otherwise reuse the existing doc.
const ensureUser = async ({ firstName, lastName, email, role, roleName, institution, courseId, extra = {} }) => {
  const existing = await User.findOne({ email });
  if (existing) {
    // Make sure the sample user can still log in and counts as enrolled.
    let dirty = false;
    if (existing.status !== "active") { existing.status = "active"; dirty = true; }
    const hasCourse = (existing.courses || []).some(
      (c) => c.courseId && c.courseId.toString() === courseId.toString()
    );
    if (!hasCourse) { existing.courses.push({ courseId }); dirty = true; }
    if (dirty) await existing.save();
    return { user: existing, created: false };
  }

  const userId = await generateUserIdForInstitution(institution);
  const user = new User({
    email,
    firstName,
    lastName,
    phone: `90000${String(Math.floor(100000 + Math.random() * 899999))}`,
    gender: Math.random() > 0.5 ? "Male" : "Female",
    password: PASSWORD, // hashed by the pre-save hook
    role: role._id,
    status: "active",
    permissions: getDefaultPermissions(roleName),
    institution,
    userId,
    createdBy: "seed-script",
    courses: [{ courseId }],
    ...extra,
  });
  await user.save();
  return { user, created: true };
};

const main = async () => {
  if (!process.env.MONGOURI) {
    throw new Error("MONGOURI not found in server/.env");
  }
  await mongoose.connect(process.env.MONGOURI);
  console.log("MongoDB connected");

  const course = await CourseStructure.findById(COURSE_ID);
  if (!course) throw new Error(`Course ${COURSE_ID} not found`);
  console.log(`Course: ${course.courseName} (institution ${course.institution})`);

  // Student role must already exist; the Trainer role is created on demand
  // (this institution ships without one).
  const { match: studentRole, all: allRoles } = await findRole(course.institution, "student");
  if (!studentRole) {
    console.error(
      "Available roles for this institution:",
      allRoles.map((r) => `${r._id} → ${r.originalRole || ""}/${r.renameRole || ""}/${r.roleValue || ""}`)
    );
    throw new Error(`Missing student role for institution ${course.institution}`);
  }

  let { match: trainerRole } = await findRole(course.institution, "trainer");
  if (!trainerRole) {
    trainerRole = await Role.create({
      institution: course.institution,
      originalRole: "Trainer",
      renameRole: "Trainer",
      roleValue: "trainer",
      createdBy: "seed-script",
    });
    console.log(`created Trainer role ${trainerRole._id}`);
  }
  console.log(`Student role: ${studentRole._id}, Trainer role: ${trainerRole._id}`);

  // ── Create users ──────────────────────────────────────────────────────────
  const students = [];
  for (let i = 0; i < STUDENT_NAMES.length; i++) {
    const [firstName, lastName] = STUDENT_NAMES[i];
    const { user, created } = await ensureUser({
      firstName,
      lastName,
      email: emailFor("student", i),
      role: studentRole,
      roleName: "student",
      institution: course.institution,
      courseId: course._id,
      extra: {
        degree: "B.E",
        department: "Computer Science",
        year: "III",
        semester: "V",
        batch: "2026",
      },
    });
    students.push(user);
    console.log(`${created ? "created" : "exists "} student ${user.email} (${user.userId || "-"})`);
  }

  const trainers = [];
  for (let i = 0; i < TRAINER_NAMES.length; i++) {
    const [firstName, lastName] = TRAINER_NAMES[i];
    const { user, created } = await ensureUser({
      firstName,
      lastName,
      email: emailFor("trainer", i),
      role: trainerRole,
      roleName: "trainer",
      institution: course.institution,
      courseId: course._id,
      extra: { department: "Training" },
    });
    trainers.push(user);
    console.log(`${created ? "created" : "exists "} trainer ${user.email} (${user.userId || "-"})`);
  }

  // ── Build batches on the course ───────────────────────────────────────────
  if (!course.batchAndParticipants) course.batchAndParticipants = [];
  const seedAdmin = trainers[0]._id; // audit fields need an LMS-User ref

  for (const def of BATCHES) {
    let batch = course.batchAndParticipants.find(
      (b) => b.batchName && b.batchName.toLowerCase() === def.batchName.toLowerCase()
    );
    if (!batch) {
      course.batchAndParticipants.push({
        batchName: def.batchName,
        batchDescription: def.batchDescription,
        batchStartDate: def.batchStartDate,
        batchEndDate: def.batchEndDate,
        users: [],
        status: "active",
        createdAt: new Date(),
        createdBy: seedAdmin,
        updatedAt: new Date(),
        updatedBy: seedAdmin,
      });
      batch = course.batchAndParticipants[course.batchAndParticipants.length - 1];
      console.log(`created batch ${def.batchName}`);
    } else {
      console.log(`exists  batch ${def.batchName}`);
    }

    const members = [
      ...students.slice(def.studentSlice[0], def.studentSlice[1]),
      ...trainers.slice(def.trainerSlice[0], def.trainerSlice[1]),
    ];

    let added = 0;
    for (const member of members) {
      const already = (batch.users || []).some(
        (u) => u.user && u.user.toString() === member._id.toString()
      );
      if (already) continue;
      batch.users.push({
        user: member._id,
        status: "active",
        joinedAt: new Date(),
        updatedAt: new Date(),
      });
      added++;
    }
    batch.updatedAt = new Date();
    batch.updatedBy = seedAdmin;
    console.log(`  ${def.batchName}: +${added} members (total ${batch.users.length})`);
  }

  // This course may carry a legacy array-format `resourcesType` (e.g.
  // ['PPT','PDF','Video']) that predates the nested pedagogy schema — a full
  // document save() fails casting on it. Convert it once to the current
  // shape so the app's own save()-based endpoints work on this course too.
  const rawCourse = await CourseStructure.collection.findOne({ _id: course._id });
  if (Array.isArray(rawCourse.resourcesType)) {
    const enabledTypes = rawCourse.resourcesType.map((t) => String(t).toLowerCase());
    const fileResource = (type, maxSize, formats) => ({
      enabled: enabledTypes.includes(type),
      maxSize,
      aiChat: false,
      aiSummary: false,
      allowedFormats: formats,
    });
    const section = () => ({
      video: fileResource("video", 50, ["mp4", "mov", "avi", "webm"]),
      ppt: fileResource("ppt", 20, ["ppt", "pptx"]),
      pdf: fileResource("pdf", 10, ["pdf"]),
      url: { enabled: enabledTypes.includes("url") },
      aiChat: { enabled: false },
      aiSummary: { enabled: false },
      notes: { enabled: false },
    });
    await CourseStructure.collection.updateOne(
      { _id: course._id },
      { $set: { resourcesType: { iDo: section(), weDo: section(), youDo: section() } } }
    );
    console.log(`converted legacy resourcesType [${rawCourse.resourcesType}] to the current schema`);
  }

  // Write only the batches — atomic $set, no full-document validation.
  await CourseStructure.updateOne(
    { _id: course._id },
    {
      $set: {
        batchAndParticipants: course.batchAndParticipants,
        updatedAt: new Date(),
        updatedBy: "seed-script",
      },
    }
  );
  console.log("Course saved");

  // ── Verify a login would succeed ──────────────────────────────────────────
  const probe = await User.findOne({ email: emailFor("student", 0) });
  const ok = await bcrypt.compare(PASSWORD, probe.password);
  console.log(`\nPassword check for ${probe.email}: ${ok ? "OK — '123' logs in" : "FAILED"}`);
  if (!ok) throw new Error("Password verification failed — check the pre-save hook");

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n──────── Summary ────────");
  console.log(`Course: ${course.courseName}`);
  for (const def of BATCHES) {
    const b = course.batchAndParticipants.find((x) => x.batchName === def.batchName);
    console.log(`${def.batchName}: ${b.users.length} members`);
  }
  console.log(`\nLogins (password "${PASSWORD}"):`);
  console.log(`  students: student01@${EMAIL_DOMAIN} … student30@${EMAIL_DOMAIN}`);
  console.log(`  trainers: trainer01@${EMAIL_DOMAIN} … trainer04@${EMAIL_DOMAIN}`);
};

main()
  .then(() => mongoose.disconnect())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error("\nSeed failed:", err.message);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
