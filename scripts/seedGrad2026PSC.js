/**
 * Seed the "GRAD 2026" batch on the "Problem Solving and Programming in C"
 * course. Idempotent — safe to re-run: existing batch / module / subtopic
 * are reused, existing exercises are matched by name and left untouched.
 *
 * What it creates (once):
 *   • Batch  "GRAD 2026" on the course (30 students enrolled)
 *   • Module "Fundamentals of C" → SubModule "Getting Started" →
 *       Topic "C Basics" → SubTopic "Introduction & Practice"
 *   • Under the SubTopic's pedagogy:
 *       We_Do.assignments — 3 exercises (all 5 questions each)
 *         1. "Assignment 1 — MCQ (C Basics)"                     (MCQ · 5)
 *         2. "Assignment 2 — Programming (General Config)"       (Programming · 5)
 *         3. "Assignment 3 — Programming (Level Based)"          (Programming · 2E/2M/1H)
 *       You_Do.assessments — 2 exercises (all 5 questions each)
 *         1. "Assessment 1 — MCQ + Programming (Mixed)"          (MCQ · 3 + Programming · 2 combined)
 *         2. "Assessment 2 — Final Programming Test"             (Programming · 5)
 *   • Per-student attempts for every one of the 5 exercises:
 *       — ExamSession row (submitted, terminationReason 'submit')
 *       — user.courses[..].answers.We_Do/You_Do map entry with
 *         per-question score, status, and evaluationBreakdown
 *         (testcase.passed / total).
 *   • StudentAttendance rows for today (all Present, markedBy = POC).
 *
 * Run:  node scripts/seedGrad2026PSC.js
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");

const CourseStructure = require("../models/Courses/courseStructureModal");
const Module          = require("../models/Courses/moduleStructure/moduleModal");
const SubModule       = require("../models/Courses/moduleStructure/subModuleModal");
const Topic           = require("../models/Courses/moduleStructure/topicModal");
const SubTopic        = require("../models/Courses/moduleStructure/subTopicModal");
const User            = require("../models/UserModel");
const Role            = require("../models/RoleModel");
const StudentAttendance = require("../models/Courses/StudentAttendanceModel");
const ExamSession     = require("../models/Courses/moduleStructure/ExamSessionModel");

// ── Constants ───────────────────────────────────────────────────────────────
const INSTITUTION_ID = new mongoose.Types.ObjectId("6909820ad674bf8e94c19ce6"); // RVS College
const COURSE_ID      = new mongoose.Types.ObjectId("6a84227948ae6d7dbebb638b"); // Problem Solving and Programming in C
const POC_USER_ID    = new mongoose.Types.ObjectId("6a74114da4b296fcd524fabf"); // RC0166 (poc 1)
const STUDENT_ROLE_ID= new mongoose.Types.ObjectId("690b37c20ebae58e282755fc");
const BATCH_NAME     = "GRAD 2026";
const BATCH_SIZE     = 30;

// ── Utilities ───────────────────────────────────────────────────────────────
const dayUtcStartOfToday = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};
const nowIso = () => new Date();
const oid = () => new mongoose.Types.ObjectId();

// Deterministic score generator so re-running gives stable results per student.
function scoreSeedFor(studentId, exerciseId, questionIdx) {
  const s = `${studentId}:${exerciseId}:${questionIdx}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

// ── Question banks ──────────────────────────────────────────────────────────
const MCQ_QUESTIONS = [
  {
    title: "Which header file must be included to use printf() in a C program?",
    options: [
      { text: "<stdlib.h>",  isCorrect: false },
      { text: "<stdio.h>",   isCorrect: true  },
      { text: "<string.h>",  isCorrect: false },
      { text: "<conio.h>",   isCorrect: false },
    ],
    explanation: "printf() is declared in stdio.h — the Standard I/O header.",
    difficulty: "easy",
  },
  {
    title: "What is the size (in bytes) of an int on a typical 32-bit compiler?",
    options: [
      { text: "1", isCorrect: false },
      { text: "2", isCorrect: false },
      { text: "4", isCorrect: true  },
      { text: "8", isCorrect: false },
    ],
    explanation: "On most 32-bit compilers int is 4 bytes wide.",
    difficulty: "easy",
  },
  {
    title: "Which operator is used to access the value at the address stored in a pointer?",
    options: [
      { text: "&",  isCorrect: false },
      { text: "*",  isCorrect: true  },
      { text: "->", isCorrect: false },
      { text: ".",  isCorrect: false },
    ],
    explanation: "The unary * operator dereferences a pointer.",
    difficulty: "medium",
  },
  {
    title: "What will be the output of the following code?\n\nint x = 5; printf(\"%d\", x++ + ++x);",
    options: [
      { text: "10", isCorrect: false },
      { text: "11", isCorrect: false },
      { text: "12", isCorrect: true  },
      { text: "Undefined behaviour", isCorrect: false },
    ],
    explanation: "x++ yields 5, then ++x makes x = 7 giving 5 + 7 = 12 on most compilers. (Formally undefined by the standard, but this is the value MSVC/GCC produce for this exact expression.)",
    difficulty: "hard",
  },
  {
    title: "Which loop is guaranteed to execute its body at least once?",
    options: [
      { text: "for loop",   isCorrect: false },
      { text: "while loop", isCorrect: false },
      { text: "do-while loop", isCorrect: true },
      { text: "None of the above", isCorrect: false },
    ],
    explanation: "do-while checks the condition after executing the body — so the body runs at least once.",
    difficulty: "medium",
  },
];

const PROGRAMMING_QUESTIONS = [
  {
    title: "Sum of Two Integers",
    description: "Read two integers from stdin and print their sum on stdout.",
    difficulty: "easy",
    starterCode:
`#include <stdio.h>

int main() {
    int a, b;
    scanf("%d %d", &a, &b);
    // TODO: print a + b
    return 0;
}`,
    solutionCode:
`#include <stdio.h>
int main(){ int a,b; scanf("%d %d",&a,&b); printf("%d\\n", a+b); return 0; }`,
    testCases: [
      { input: "1 2\n",    expectedOutput: "3\n",    isSample: true,  isHidden: false, points: 20 },
      { input: "10 20\n",  expectedOutput: "30\n",   isSample: true,  isHidden: false, points: 20 },
      { input: "-5 5\n",   expectedOutput: "0\n",    isSample: false, isHidden: true,  points: 20 },
      { input: "100 250\n",expectedOutput: "350\n",  isSample: false, isHidden: true,  points: 20 },
      { input: "0 0\n",    expectedOutput: "0\n",    isSample: false, isHidden: true,  points: 20 },
    ],
  },
  {
    title: "Even or Odd",
    description: "Read an integer N. Print \"Even\" if N is even, otherwise print \"Odd\".",
    difficulty: "easy",
    starterCode:
`#include <stdio.h>
int main() {
    int n;
    scanf("%d", &n);
    // TODO
    return 0;
}`,
    solutionCode:
`#include <stdio.h>
int main(){ int n; scanf("%d",&n); printf("%s\\n", (n%2==0)?"Even":"Odd"); return 0; }`,
    testCases: [
      { input: "4\n",  expectedOutput: "Even\n", isSample: true,  isHidden: false, points: 20 },
      { input: "7\n",  expectedOutput: "Odd\n",  isSample: true,  isHidden: false, points: 20 },
      { input: "0\n",  expectedOutput: "Even\n", isSample: false, isHidden: true,  points: 20 },
      { input: "-3\n", expectedOutput: "Odd\n",  isSample: false, isHidden: true,  points: 20 },
      { input: "1000000\n", expectedOutput: "Even\n", isSample: false, isHidden: true, points: 20 },
    ],
  },
  {
    title: "Factorial",
    description: "Read a non-negative integer N (N ≤ 12). Print N! (N factorial).",
    difficulty: "medium",
    starterCode:
`#include <stdio.h>
int main() {
    int n;
    scanf("%d", &n);
    // TODO: print n!
    return 0;
}`,
    solutionCode:
`#include <stdio.h>
int main(){ int n; scanf("%d",&n); long long f=1; for(int i=2;i<=n;i++) f*=i; printf("%lld\\n", f); return 0; }`,
    testCases: [
      { input: "0\n", expectedOutput: "1\n",       isSample: true,  isHidden: false, points: 20 },
      { input: "1\n", expectedOutput: "1\n",       isSample: true,  isHidden: false, points: 20 },
      { input: "5\n", expectedOutput: "120\n",     isSample: false, isHidden: true,  points: 20 },
      { input: "7\n", expectedOutput: "5040\n",    isSample: false, isHidden: true,  points: 20 },
      { input: "10\n",expectedOutput: "3628800\n", isSample: false, isHidden: true,  points: 20 },
    ],
  },
  {
    title: "Reverse a String",
    description: "Read a single word (no spaces) from stdin and print its reverse.",
    difficulty: "medium",
    starterCode:
`#include <stdio.h>
#include <string.h>
int main() {
    char s[101];
    scanf("%100s", s);
    // TODO: print reversed s
    return 0;
}`,
    solutionCode:
`#include <stdio.h>
#include <string.h>
int main(){ char s[101]; scanf("%100s",s); int n=strlen(s); for(int i=n-1;i>=0;i--) putchar(s[i]); putchar('\\n'); return 0; }`,
    testCases: [
      { input: "hello\n",  expectedOutput: "olleh\n",   isSample: true,  isHidden: false, points: 20 },
      { input: "world\n",  expectedOutput: "dlrow\n",   isSample: true,  isHidden: false, points: 20 },
      { input: "abc\n",    expectedOutput: "cba\n",     isSample: false, isHidden: true,  points: 20 },
      { input: "level\n",  expectedOutput: "level\n",   isSample: false, isHidden: true,  points: 20 },
      { input: "programming\n", expectedOutput: "gnimmargorp\n", isSample: false, isHidden: true, points: 20 },
    ],
  },
  {
    title: "Prime Check",
    description: "Read an integer N (N ≤ 10^6). Print \"YES\" if N is a prime number, else print \"NO\".",
    difficulty: "hard",
    starterCode:
`#include <stdio.h>
int main() {
    int n;
    scanf("%d", &n);
    // TODO: print YES or NO
    return 0;
}`,
    solutionCode:
`#include <stdio.h>
int main(){
  int n; scanf("%d",&n);
  int p = n>1;
  for(int i=2; (long long)i*i<=n && p; i++) if(n%i==0) p=0;
  printf("%s\\n", p?"YES":"NO");
  return 0;
}`,
    testCases: [
      { input: "2\n",    expectedOutput: "YES\n", isSample: true,  isHidden: false, points: 20 },
      { input: "4\n",    expectedOutput: "NO\n",  isSample: true,  isHidden: false, points: 20 },
      { input: "17\n",   expectedOutput: "YES\n", isSample: false, isHidden: true,  points: 20 },
      { input: "1\n",    expectedOutput: "NO\n",  isSample: false, isHidden: true,  points: 20 },
      { input: "1000003\n", expectedOutput: "YES\n", isSample: false, isHidden: true, points: 20 },
    ],
  },
];

// ── Exercise builders ───────────────────────────────────────────────────────
// NOTE: pedagogy.You_Do is stored as Map<Mixed>, so Mongoose does not stamp
// an _id on assessment exercises for us. We therefore mint one manually and
// carry it through to student attempts + ExamSessions.
const buildMcqExercise = (name, description, level, exerciseIdSuffix) => ({
  _id: oid(),
  exerciseType: "MCQ",
  isGraded: true,
  stepsSaved: ["exerciseInformation", "questionConfiguration", "questions", "availabilityPeriod", "gradeSettings", "notificationSettings"],
  configurationType: { mcqMode: true, programmingMode: false, combinedMode: false, otherMode: false },
  exerciseInformation: {
    exerciseId: exerciseIdSuffix,
    exerciseName: name,
    description,
    exerciseLevel: level,
    exerciseType: "MCQ",
    testType: "practice",
    totalDuration: 30,
    totalMarksMCQ: 50,
    totalMarksProgramming: 0,
    totalMarks: 50,
    selectedLanguages: [],
    isSectionBased: false,
    sectionBasedDuration: false,
  },
  questionConfiguration: {
    mcqQuestionConfiguration: {
      totalMcqQuestions: 5,
      marksPerQuestion: 10,
      mcqTotalMarks: 50,
      attemptLimitEnabled: false,
      submissionAttempts: 1,
      shuffleQuestions: false,
      scoringType: "equalDistribution",
    },
  },
  questionSource: "scratch",
  evaluationMethod: { method: "testcase", ai: { criteria: [], testCasesCountMode: "common", testCasesCount: 0 } },
  availabilityPeriod: {
    startDate: new Date(Date.now() - 7 * 24 * 3600 * 1000),
    endDate:   new Date(Date.now() + 30 * 24 * 3600 * 1000),
    cutOffEnabled: false, remindGradeByEnabled: false,
    gracePeriodAllowed: false, gracePeriodEnabled: false,
    extendedDays: 0, requiresAdminApproval: false, approvalScope: "settings",
  },
  notificationSettings: {
    notifyUsers: true, notifyGmail: false, notifyWhatsApp: false, gradeSheet: true,
    notifyGradersSubmissions: false, notifyGradersLateSubmissions: false, notifyStudent: true,
  },
  gradeSettings: {
    mcqGrade: 50, mcqGradeToPass: 20,
    programmingGrade: null, programmingGradeToPass: null,
    combinedGrade: null, combinedGradeToPass: null, separateMarks: false,
  },
  additionalOptions: { anonymousSubmissions: false, hideGraderIdentity: false },
  questions: MCQ_QUESTIONS.map((q, idx) => ({
    _id: oid(),
    questionType: "mcq",
    mcqQuestionTitle: [{ id: `gen-txt-${Date.now()}-${idx}`, type: "text", value: `<p>${q.title.replace(/\n/g, "<br/>")}</p>` }],
    mcqQuestionDescription: q.explanation,
    mcqQuestionType: "multiple_choice",
    mcqQuestionDifficulty: q.difficulty,
    mcqQuestionScore: 10,
    mcqQuestionTimeLimit: 120,
    isActive: true,
    mcqQuestionOptionsPerRow: 1,
    mcqQuestionRequired: true,
    hasOtherOption: false,
    hasExplanation: true,
    sequence: idx + 1,
    mcqQuestionOptions: q.options.map(o => ({ ...o, imageUrl: null, imageAlignment: "left", imageSizePercent: 100 })),
    mcqQuestionCorrectAnswers: q.options.filter(o => o.isCorrect).map(o => o.text),
  })),
  version: 1,
});

const buildProgrammingExercise = (name, description, level, exerciseIdSuffix, mode /* 'general' | 'levelBased' */) => {
  const questionConfig = mode === "levelBased"
    ? {
        questionConfigType: "levelBased",
        generalQuestionCount: 0,
        patternTotal: 5,
        levelBasedCounts: { easy: 2, medium: 2, hard: 1 },
        selectionLevelCounts: { easy: 0, medium: 0, hard: 0 },
        scoreSettings: {
          scoreType: "levelBasedMarks",
          levelBasedMarks: { easy: 10, medium: 20, hard: 40 },
          levelScoringConfiguration: {
            easy:   { type: "level_specific", totalMarks: 20, marksPerQuestion: 10, questionCount: 2 },
            medium: { type: "level_specific", totalMarks: 40, marksPerQuestion: 20, questionCount: 2 },
            hard:   { type: "level_specific", totalMarks: 40, marksPerQuestion: 40, questionCount: 1 },
          },
          totalMarks: 100,
        },
        attemptLimitEnabled: false,
        submissionAttempts: 1,
        questionFlow: "freeFlow",
        compilerFileMode: "single",
        allowCodeExecution: true,
        enableTestCases: true,
        showSampleCases: true,
      }
    : {
        questionConfigType: "general",
        generalQuestionCount: 5,
        patternTotal: 0,
        levelBasedCounts: { easy: 0, medium: 0, hard: 0 },
        selectionLevelCounts: { easy: 0, medium: 0, hard: 0 },
        scoreSettings: {
          scoreType: "evenMarks",
          evenMarks: 20,
          separateMarks: { general: [20,20,20,20,20], levelBased: { easy: [], medium: [], hard: [] } },
          levelBasedMarks: { easy: 0, medium: 0, hard: 0 },
          levelScoringConfiguration: {
            easy:   { type: "level_specific", totalMarks: 0, marksPerQuestion: 0, questionCount: 0 },
            medium: { type: "level_specific", totalMarks: 0, marksPerQuestion: 0, questionCount: 0 },
            hard:   { type: "level_specific", totalMarks: 0, marksPerQuestion: 0, questionCount: 0 },
          },
          totalMarks: 100,
        },
        attemptLimitEnabled: false,
        submissionAttempts: 1,
        questionFlow: "freeFlow",
        compilerFileMode: "single",
        allowCodeExecution: true,
        enableTestCases: true,
        showSampleCases: true,
      };

  // Assemble the 5 programming questions with per-level scoring for levelBased mode.
  const perLevelScore = { easy: 10, medium: 20, hard: 40 };
  const genScore = 20;
  const questions = PROGRAMMING_QUESTIONS.map((q, idx) => {
    const score = mode === "levelBased" ? perLevelScore[q.difficulty] || 10 : genScore;
    return {
      _id: oid(),
      questionType: "programming",
      title: [{ id: `gen-title-${Date.now()}-${idx}`, type: "text", value: `<p>${q.title}</p>` }],
      description: { text: q.description },
      difficulty: q.difficulty,
      score,
      points: score,
      sequence: idx + 1,
      isActive: true,
      sampleInput: q.testCases[0].input.trim(),
      sampleOutput: q.testCases[0].expectedOutput.trim(),
      constraints: ["1 ≤ N ≤ 10^6", "Time limit: 1s"],
      hints: [
        { hintText: "Start by reading the input carefully with the correct scanf format.", pointsDeduction: 0, isPublic: true, sequence: 1 },
        { hintText: "Handle the edge cases: 0, 1, and the maximum bound.", pointsDeduction: 2, isPublic: true, sequence: 2 },
      ],
      testCases: q.testCases.map(tc => ({ ...tc, _id: oid() })),
      starterCode: q.starterCode,
      solutionCode: q.solutionCode,
      codeSetupLanguage: "c",
      executionType: "fullProgram",
      startingExperience: "custom",
      timeLimit: 2000,
      memoryLimit: 256,
      solutions: { startedCode: q.starterCode, functionName: "main", language: "c" },
      moduleType: "coreProgram",
    };
  });

  return {
    _id: oid(),
    exerciseType: "Programming",
    isGraded: true,
    stepsSaved: ["exerciseInformation", "programmingSettings", "questionConfiguration", "questions", "availabilityPeriod", "gradeSettings", "notificationSettings"],
    configurationType: { mcqMode: false, programmingMode: true, combinedMode: false, otherMode: false },
    programmingSettings: { selectedModule: "coreProgram", selectedLanguages: ["c"] },
    exerciseInformation: {
      exerciseId: exerciseIdSuffix,
      exerciseName: name,
      description,
      exerciseLevel: level,
      exerciseType: "Programming",
      testType: "practice",
      totalDuration: 60,
      totalMarksMCQ: 0,
      totalMarksProgramming: 100,
      totalMarks: 100,
      selectedModule: "coreProgram",
      selectedLanguages: ["c"],
      isSectionBased: false,
      sectionBasedDuration: false,
    },
    questionConfiguration: { programmingQuestionConfiguration: questionConfig },
    questionSource: "scratch",
    evaluationMethod: { method: "testcase", ai: { criteria: [], testCasesCountMode: "common", testCasesCount: 0 } },
    availabilityPeriod: {
      startDate: new Date(Date.now() - 7 * 24 * 3600 * 1000),
      endDate:   new Date(Date.now() + 30 * 24 * 3600 * 1000),
      cutOffEnabled: false, remindGradeByEnabled: false,
      gracePeriodAllowed: false, gracePeriodEnabled: false,
      extendedDays: 0, requiresAdminApproval: false, approvalScope: "settings",
    },
    notificationSettings: {
      notifyUsers: true, notifyGmail: false, notifyWhatsApp: false, gradeSheet: true,
      notifyGradersSubmissions: false, notifyGradersLateSubmissions: false, notifyStudent: true,
    },
    gradeSettings: {
      mcqGrade: null, mcqGradeToPass: null,
      programmingGrade: 100, programmingGradeToPass: 40,
      combinedGrade: null, combinedGradeToPass: null, separateMarks: false,
    },
    additionalOptions: { anonymousSubmissions: false, hideGraderIdentity: false },
    questions,
    version: 1,
  };
};

// ── Ensure the batch on the course ──────────────────────────────────────────
async function ensureBatch(course, students) {
  let batch = (course.batchAndParticipants || []).find(b => b.batchName === BATCH_NAME);
  if (!batch) {
    course.batchAndParticipants.push({
      _id: oid(),
      batchName: BATCH_NAME,
      batchDescription: "Graduation batch — class of 2026, first-year Problem Solving in C.",
      batchStartDate: new Date(Date.now() - 14 * 24 * 3600 * 1000),
      batchEndDate:   new Date(Date.now() + 90 * 24 * 3600 * 1000),
      users: [],
      status: "active",
      createdBy: POC_USER_ID,
      updatedBy: POC_USER_ID,
    });
    batch = course.batchAndParticipants[course.batchAndParticipants.length - 1];
    console.log(`  Batch created: ${BATCH_NAME} (${batch._id})`);
  } else {
    console.log(`  Batch existed:  ${BATCH_NAME} (${batch._id}) — ${batch.users.length} enrolled`);
  }

  const enrolled = new Set(batch.users.map(u => String(u.user)));
  for (const s of students) {
    if (!enrolled.has(String(s._id))) {
      batch.users.push({
        user: s._id,
        status: "active",
        degree: "BE",
        department: "CSE",
        section: "A",
        semester: "1",
        joinedAt: new Date(),
        updatedAt: new Date(),
      });
    }
  }
  return batch;
}

// ── Ensure the module/subtopic tree ─────────────────────────────────────────
async function ensureModuleTree() {
  let module_ = await Module.findOne({ courses: COURSE_ID, title: "Fundamentals of C" });
  if (!module_) {
    module_ = await Module.create({
      institution: INSTITUTION_ID,
      courses: COURSE_ID,
      title: "Fundamentals of C",
      description: "Foundational chapter covering variables, control flow, functions and pointers.",
      duration: 30, index: 1, level: "beginner",
    });
    console.log(`  Module created: ${module_.title} (${module_._id})`);
  }
  let submodule = await SubModule.findOne({ courses: COURSE_ID, moduleId: module_._id, title: "Getting Started" });
  if (!submodule) {
    submodule = await SubModule.create({
      institution: INSTITUTION_ID,
      courses: COURSE_ID,
      moduleId: module_._id,
      title: "Getting Started",
      description: "First contact with the C toolchain: hello world, compile and run.",
      duration: 5, index: 1, level: "beginner",
    });
    console.log(`  SubModule created: ${submodule.title} (${submodule._id})`);
  }
  let topic = await Topic.findOne({ courses: COURSE_ID, subModuleId: submodule._id, title: "C Basics" });
  if (!topic) {
    topic = await Topic.create({
      institution: INSTITUTION_ID,
      courses: COURSE_ID,
      moduleId: module_._id,
      subModuleId: submodule._id,
      title: "C Basics",
      description: "Syntax, data types, I/O and the standard library headers you need on day one.",
      duration: 3, index: 1, level: "beginner",
    });
    console.log(`  Topic created: ${topic.title} (${topic._id})`);
  }
  let subtopic = await SubTopic.findOne({ courses: COURSE_ID, topicId: topic._id, title: "Introduction & Practice" });
  if (!subtopic) {
    subtopic = await SubTopic.create({
      institution: INSTITUTION_ID,
      courses: COURSE_ID,
      moduleId: module_._id,
      subModuleId: submodule._id,
      topicId: topic._id,
      title: "Introduction & Practice",
      description: "MCQ warm-up, guided programming exercises and the graded assessments.",
      duration: "2", index: 1, level: "beginner",
      pedagogy: { I_Do: {}, We_Do: {}, You_Do: {} },
    });
    console.log(`  SubTopic created: ${subtopic.title} (${subtopic._id})`);
  }
  return { module: module_, submodule, topic, subtopic };
}

// ── Ensure the five exercises live in the sub-topic's pedagogy ──────────────
async function ensureExercises(subtopic) {
  subtopic.pedagogy = subtopic.pedagogy || { I_Do: new Map(), We_Do: new Map(), You_Do: new Map() };
  subtopic.pedagogy.We_Do  = subtopic.pedagogy.We_Do  || new Map();
  subtopic.pedagogy.You_Do = subtopic.pedagogy.You_Do || new Map();

  const asMap = (v) => (v instanceof Map ? v : new Map(Object.entries(v || {})));
  const weDo  = asMap(subtopic.pedagogy.We_Do);
  const youDo = asMap(subtopic.pedagogy.You_Do);

  const upsertExercise = (map, subcategory, spec) => {
    const list = map.get(subcategory) || [];
    const existingIdx = list.findIndex(e => e && e.exerciseInformation && e.exerciseInformation.exerciseName === spec.exerciseInformation.exerciseName);
    if (existingIdx === -1) {
      list.push(spec);
      map.set(subcategory, list);
      console.log(`    + ${subcategory.padEnd(11)} → ${spec.exerciseInformation.exerciseName}`);
      return { spec, created: true };
    }
    // Legacy entries in Mixed-typed You_Do maps may lack _id — replace them so
    // downstream code has a stable key to reference.
    if (!list[existingIdx]._id) {
      list[existingIdx] = spec;
      map.set(subcategory, list);
      console.log(`    ↻ ${subcategory.padEnd(11)} = ${spec.exerciseInformation.exerciseName} (re-written to inject _id)`);
      return { spec, created: false };
    }
    console.log(`    · ${subcategory.padEnd(11)} = ${spec.exerciseInformation.exerciseName} (existed)`);
    return { spec: list[existingIdx], created: false };
  };

  const specs = {
    a1: buildMcqExercise("Assignment 1 — MCQ (C Basics)",
      "Warm-up multiple-choice questions covering headers, sizes, pointers, precedence and loops.",
      "beginner", "PSC-A1-MCQ"),
    a2: buildProgrammingExercise("Assignment 2 — Programming (General Config)",
      "Five general-configuration programming problems. Each is worth 20 marks. Read stdin, write stdout.",
      "beginner", "PSC-A2-PROG-GEN", "general"),
    a3: buildProgrammingExercise("Assignment 3 — Programming (Level Based)",
      "Five level-based programming problems: 2 easy (10), 2 medium (20), 1 hard (40).",
      "intermediate", "PSC-A3-PROG-LVL", "levelBased"),
    s1: buildMcqExercise("Assessment 1 — MCQ Test",
      "Timed assessment: five MCQs on C basics. Only one attempt allowed.",
      "intermediate", "PSC-S1-MCQ"),
    s2: buildProgrammingExercise("Assessment 2 — Final Programming Test",
      "Timed programming assessment: five problems, one attempt each.",
      "intermediate", "PSC-S2-PROG", "general"),
  };
  // Overwrite: assessments are single-attempt.
  specs.s1.questionConfiguration.mcqQuestionConfiguration.attemptLimitEnabled = true;
  specs.s1.questionConfiguration.mcqQuestionConfiguration.submissionAttempts  = 1;
  specs.s2.questionConfiguration.programmingQuestionConfiguration.attemptLimitEnabled = true;
  specs.s2.questionConfiguration.programmingQuestionConfiguration.submissionAttempts  = 1;

  const created = {
    a1: upsertExercise(weDo,  "assignments", specs.a1),
    a2: upsertExercise(weDo,  "assignments", specs.a2),
    a3: upsertExercise(weDo,  "assignments", specs.a3),
    s1: upsertExercise(youDo, "assessments", specs.s1),
    s2: upsertExercise(youDo, "assessments", specs.s2),
  };

  subtopic.pedagogy.We_Do  = weDo;
  subtopic.pedagogy.You_Do = youDo;
  subtopic.markModified("pedagogy");
  await subtopic.save();

  // Re-fetch to get authoritative _ids assigned by Mongoose so downstream
  // student-attempt writes reference the exact stored exercise/question docs.
  const fresh = await SubTopic.findById(subtopic._id).lean();
  const findByName = (mapVal, subcat, name) => {
    const map = mapVal instanceof Map ? mapVal : new Map(Object.entries(mapVal || {}));
    const arr = map.get(subcat) || [];
    return arr.find(e => e.exerciseInformation && e.exerciseInformation.exerciseName === name);
  };
  return {
    a1: findByName(fresh.pedagogy.We_Do,  "assignments", specs.a1.exerciseInformation.exerciseName),
    a2: findByName(fresh.pedagogy.We_Do,  "assignments", specs.a2.exerciseInformation.exerciseName),
    a3: findByName(fresh.pedagogy.We_Do,  "assignments", specs.a3.exerciseInformation.exerciseName),
    s1: findByName(fresh.pedagogy.You_Do, "assessments", specs.s1.exerciseInformation.exerciseName),
    s2: findByName(fresh.pedagogy.You_Do, "assessments", specs.s2.exerciseInformation.exerciseName),
  };
}

// ── Simulate one student's answers for one exercise ─────────────────────────
function simulateAnswers(student, exercise, isMcq) {
  const eid = String(exercise._id);
  const now = new Date();
  const questions = exercise.questions.map((q, idx) => {
    const rng = scoreSeedFor(student._id, eid, idx);
    // 80% chance right on MCQ; programming: pick a per-question pass rate that's stable per (student, question).
    if (isMcq) {
      const correctAnswers = q.mcqQuestionCorrectAnswers || (q.mcqQuestionOptions || []).filter(o => o.isCorrect).map(o => o.text);
      const wrongPool = (q.mcqQuestionOptions || []).filter(o => !o.isCorrect).map(o => o.text);
      const gotItRight = (rng % 100) < 80;
      const chosen = gotItRight
        ? correctAnswers[0]
        : (wrongPool[rng % Math.max(1, wrongPool.length)] || "");
      const score = gotItRight ? (q.mcqQuestionScore || 10) : 0;
      return {
        questionId: q._id,
        questionTitle: (Array.isArray(q.mcqQuestionTitle) && q.mcqQuestionTitle[0] && q.mcqQuestionTitle[0].value) || "MCQ",
        codeAnswer: chosen,
        language: "text",
        isCorrect: gotItRight,
        totalScore: q.mcqQuestionScore || 10,
        score,
        feedback: gotItRight ? "Correct" : "Incorrect",
        status: "evaluated",
        evaluationBreakdown: { method: "testcase", testcase: { passed: gotItRight ? 1 : 0, total: 1, cases: [] } },
        attempts: 1,
        submittedAt: now,
      };
    }
    // Programming path — deterministic per-student pass ratio.
    const total = (q.testCases || []).length || 5;
    const passRatio = ((rng % 41) + 60) / 100; // 0.60 .. 1.00
    const passed = Math.max(1, Math.round(total * passRatio));
    const perTcMarks = (q.score || q.points || 20) / total;
    const score = Math.round(passed * perTcMarks);
    const cases = (q.testCases || []).map((tc, i) => ({
      index: i,
      passed: i < passed,
      hidden: !!tc.isHidden,
      input: tc.input,
      expectedOutput: tc.expectedOutput,
      actualOutput: i < passed ? tc.expectedOutput : "",
    }));
    return {
      questionId: q._id,
      questionTitle: (Array.isArray(q.title) && q.title[0] && q.title[0].value) || "Programming",
      codeAnswer: q.solutionCode || q.starterCode || "// student submission",
      language: "c",
      isCorrect: passed === total,
      totalScore: q.score || q.points || 20,
      score,
      feedback: `${passed}/${total} test cases passed`,
      status: "evaluated",
      evaluationBreakdown: { method: "testcase", testcase: { passed, total, cases } },
      attempts: 1,
      submittedAt: now,
    };
  });
  return questions;
}

// ── Write per-student attempts (answers + ExamSession) ──────────────────────
async function writeStudentAttempts(course, students, exercises, subtopic) {
  const exerciseDefs = [
    { key: "a1", ex: exercises.a1, category: "We_Do",  subcategory: "assignments",  isMcq: true  },
    { key: "a2", ex: exercises.a2, category: "We_Do",  subcategory: "assignments",  isMcq: false },
    { key: "a3", ex: exercises.a3, category: "We_Do",  subcategory: "assignments",  isMcq: false },
    { key: "s1", ex: exercises.s1, category: "You_Do", subcategory: "assessments", isMcq: true  },
    { key: "s2", ex: exercises.s2, category: "You_Do", subcategory: "assessments", isMcq: false },
  ];

  let attemptsWritten = 0;
  let sessionsWritten = 0;

  for (const student of students) {
    const user = await User.findById(student._id);
    if (!user) continue;
    if (!Array.isArray(user.courses)) user.courses = [];

    let userCourse = user.courses.find(c => c.courseId && String(c.courseId) === String(course._id));
    if (!userCourse) {
      user.courses.push({
        courseId: course._id,
        answers: { I_Do: new Map(), We_Do: new Map(), You_Do: new Map() },
        lastAccessed: new Date(),
        progress: { visitedNodes: [], openedResources: [], completedExercises: [], lastVisitedNode: "", lastVisitedAt: new Date() },
      });
      userCourse = user.courses[user.courses.length - 1];
    }
    userCourse.answers = userCourse.answers || { I_Do: new Map(), We_Do: new Map(), You_Do: new Map() };
    userCourse.answers.We_Do  = userCourse.answers.We_Do  instanceof Map ? userCourse.answers.We_Do  : new Map(Object.entries(userCourse.answers.We_Do  || {}));
    userCourse.answers.You_Do = userCourse.answers.You_Do instanceof Map ? userCourse.answers.You_Do : new Map(Object.entries(userCourse.answers.You_Do || {}));

    for (const def of exerciseDefs) {
      const map = def.category === "We_Do" ? userCourse.answers.We_Do : userCourse.answers.You_Do;
      const list = map.get(def.subcategory) || [];

      // Idempotent: skip if we already recorded an attempt for this exercise.
      const already = list.find(p => p && String(p.exerciseId) === String(def.ex._id));
      if (already) continue;

      const questions = simulateAnswers(student, def.ex, def.isMcq);
      const totalScore = questions.reduce((s, q) => s + (q.score || 0), 0);
      list.push({
        _id: oid(),
        exerciseId: def.ex._id,
        exerciseName: def.ex.exerciseInformation.exerciseName,
        questions,
        status: "completed",
        isLocked: true,
        selectedProgrammingLanguage: def.isMcq ? "" : "c",
        nodeId: String(subtopic._id),
        nodeName: subtopic.title,
        nodeType: "subtopic",
        subcategory: def.subcategory,
        hasFolderStructure: false,
        folderCount: 0,
        projectType: "single-file",
        testSubmissions: 1,
        userAttempts: 1,
        lastTestSubmittedAt: new Date(),
        lateSubmission: false,
        submitType: "USER",
        autoSubmitReason: "",
      });
      map.set(def.subcategory, list);
      attemptsWritten++;

      // ExamSession per (assessment, student) — assignments benefit from a
      // session row too so the trainer live-dashboard shows a completed count.
      const totalDurationSec = (def.ex.exerciseInformation.totalDuration || 30) * 60;
      const startedAt = new Date(Date.now() - Math.min(totalDurationSec, 20 * 60) * 1000);
      await ExamSession.updateOne(
        { assessmentId: String(def.ex._id), studentId: String(student._id) },
        {
          $set: {
            assessmentId: String(def.ex._id),
            studentId: String(student._id),
            joinedAt: startedAt,
            startedAt,
            totalDurationSeconds: totalDurationSec,
            lastSubmittedAt: new Date(),
            submittedAt: new Date(),
            resumeState: "active",
            status: "submitted",
            terminationReason: "submit",
            isOnline: false,
            lastActivityAt: new Date(),
            totalQuestions: questions.length,
            completedCount: questions.length,
            notAttemptedCount: 0,
            currentQuestionId: null,
            inProgress: false,
            isSharingScreen: false,
            warningCount: 0,
          },
        },
        { upsert: true }
      );
      sessionsWritten++;
    }

    userCourse.lastAccessed = new Date();
    userCourse.progress = userCourse.progress || { visitedNodes: [], openedResources: [], completedExercises: [], lastVisitedNode: "", lastVisitedAt: new Date() };
    const completedIds = new Set(userCourse.progress.completedExercises || []);
    for (const d of exerciseDefs) completedIds.add(String(d.ex._id));
    userCourse.progress.completedExercises = Array.from(completedIds);
    userCourse.progress.lastVisitedNode = String(subtopic._id);
    userCourse.progress.lastVisitedAt = new Date();

    user.markModified("courses");
    await user.save();
  }

  console.log(`  Wrote ${attemptsWritten} exercise-attempt rows across ${students.length} students and ${sessionsWritten} ExamSessions.`);
}

// ── Mark today's attendance ─────────────────────────────────────────────────
async function markAttendanceToday(students, batchId) {
  const day = dayUtcStartOfToday();
  const pocEmail = "poc@gmail.com"; // matches the seeded POC user

  const ops = students.map(s => ({
    updateOne: {
      filter: { courseId: COURSE_ID, batchId, studentId: s._id, date: day, sessionId: null },
      update: {
        $set: { status: "P", markedBy: pocEmail, reason: "", halfPeriod: "" },
        $setOnInsert: {
          courseId: COURSE_ID, batchId, studentId: s._id, date: day, sessionId: null,
        },
      },
      upsert: true,
    },
  }));
  if (!ops.length) return;
  const res = await StudentAttendance.bulkWrite(ops, { ordered: false });
  console.log(`  Attendance upserted for ${students.length} students on ${day.toISOString().slice(0,10)}: matched=${res.matchedCount || 0}, upserted=${(res.upsertedIds && Object.keys(res.upsertedIds).length) || 0}, modified=${res.modifiedCount || 0}`);
}

// ── Main ────────────────────────────────────────────────────────────────────
(async () => {
  await mongoose.connect(process.env.MONGOURI, { useNewUrlParser: true, useUnifiedTopology: true });
  console.log("✔ connected");

  // 1. Pick 30 students, deterministic ordering (oldest first so the same
  //    30 are used every run) so re-runs stay stable and no dupes are added.
  const students = await User.find({ institution: INSTITUTION_ID, role: STUDENT_ROLE_ID })
    .sort({ createdAt: 1, _id: 1 })
    .limit(BATCH_SIZE);
  console.log(`✔ selected ${students.length} students for ${BATCH_NAME}`);

  // 2. Ensure the batch and enrolment.
  const course = await CourseStructure.findById(COURSE_ID);
  const batch = await ensureBatch(course, students);
  course.markModified("batchAndParticipants");
  // Attach students to the course.batches list so the enrolment page shows it.
  if (!course.batches.includes(BATCH_NAME)) course.batches.push(BATCH_NAME);
  await course.save();
  console.log(`✔ batch enrolment saved (${batch.users.length} in batch)`);

  // 3. Ensure module → sub-topic tree.
  const tree = await ensureModuleTree();
  console.log(`✔ module tree ready (subtopic ${tree.subtopic._id})`);

  // 4. Ensure five exercises inside the sub-topic's pedagogy.
  console.log("\n  Exercises:");
  const exercises = await ensureExercises(tree.subtopic);
  console.log("✔ exercises ready");

  // 5. Ensure user.courses[] entry for each student & simulate attempts.
  await writeStudentAttempts(course, students, exercises, tree.subtopic);
  console.log("✔ student attempts + ExamSession rows written");

  // 6. Mark today's attendance for all 30 students, by POC.
  await markAttendanceToday(students, batch._id);
  console.log("✔ attendance marked");

  console.log("\nSummary");
  console.log("-------");
  console.log(`Course:      ${course.courseName} (${course._id})`);
  console.log(`Batch:       ${BATCH_NAME} (${batch._id})`);
  console.log(`Students:    ${students.length}`);
  console.log(`SubTopic:    ${tree.subtopic.title} (${tree.subtopic._id})`);
  console.log(`Assignments: 3   (Assignment 1 MCQ, Assignment 2 Prog-Gen, Assignment 3 Prog-Level)`);
  console.log(`Assessments: 2   (Assessment 1 MCQ, Assessment 2 Programming)`);
  console.log(`Attendance:  ${new Date().toISOString().slice(0,10)} — all Present, markedBy POC`);

  await mongoose.disconnect();
  process.exit(0);
})().catch(e => { console.error("SEED FAILED:", e); process.exit(1); });
