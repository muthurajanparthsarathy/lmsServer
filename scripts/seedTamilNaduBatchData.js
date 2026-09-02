/**
 * seedTamilNaduBatchData.js — end-to-end demo dataset created THROUGH the REST APIs
 * (only exception: the admin Bearer token is minted directly, same as login does,
 * because batch@gmail.com's password is unknown to the script).
 *
 * Creates under institution 6909820ad674bf8e94c19ce6 (RVS College, admin batch@gmail.com):
 *   - 3 B2B companies + 2 B2I colleges (Tamil Nadu) with service mappings
 *   - 10 courses (5 Python + 5 other) across all clients; batch + direct-enrol combos
 *   - 1 trainer (all courses) + 14 students (dashboard/courses permissions)
 *   - We_Do "Assignment" + You_Do "Assesment" exercises with every question type
 *   - partial + complete student submissions, 2 trainer evaluations
 *   - feedback forms on the 3 ended courses (open now) + some responses loaded
 *
 * Idempotent: re-runs skip whatever the state file says is done.
 * State: scripts/seed-tn-state.json  (also the input for the Excel deliverable)
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const path = require("path");

const BASE = "https://https://lmsserver-yeve.onrender.com";
const INSTITUTION = "6909820ad674bf8e94c19ce6";
const ADMIN_ID = "6a46063688dae7ba0df3b1cc"; // batch@gmail.com
const ROLE_STUDENT = "690b37c20ebae58e282755fc";
const ROLE_TRAINER = "6a4f8d93aeb945453e9bc06d";
// NOTE: state must live OUTSIDE the server tree — the dev server runs under
// nodemon, and writing any .js/.json inside server/ restarts it mid-seed.
const STATE_FILE = process.env.SEED_STATE_FILE ||
  path.join(require("os").tmpdir(), "seed-tn-state.json");

const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : {};
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ── HTTP helper ──────────────────────────────────────────────────────────────
async function waitForServer() {
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(BASE + "/"); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error("server did not come back up on " + BASE);
}

async function api(method, p, body, token, okExtra = []) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(BASE + p, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      // network-level failure (e.g. nodemon restart) — wait for the server and retry
      if (attempt >= 4) throw new Error(`${method} ${p} -> network failure: ${e.message}`);
      log(`network error on ${method} ${p} (attempt ${attempt}) — waiting for server...`);
      await waitForServer();
      continue;
    }
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok && !okExtra.includes(res.status)) {
      const msg = json ? JSON.stringify(json).slice(0, 500) : res.statusText;
      throw new Error(`${method} ${p} -> ${res.status}: ${msg}`);
    }
    return { status: res.status, json };
  }
}

// ── data design ──────────────────────────────────────────────────────────────
const CLIENTS = [
  { key: "technova", clientCompany: "TechNova Solutions", businessModel: "B2B", type: ["company"],
    clientAddress: "14 OMR IT Highway, Chennai, Tamil Nadu 600096",
    description: "Product engineering company in Chennai — corporate upskilling programs.",
    contact: { name: "Priya Raghavan", email: "priya.r@technova-demo.in", phoneNumber: "9840100001", designation: "L&D Manager", isPrimary: true } },
  { key: "kovaisoft", clientCompany: "KovaiSoft Technologies", businessModel: "B2B", type: ["company"],
    clientAddress: "27 Avinashi Road, Coimbatore, Tamil Nadu 641014",
    description: "Software services firm in Coimbatore — developer enablement.",
    contact: { name: "Senthil Kumar", email: "senthil.k@kovaisoft-demo.in", phoneNumber: "9840100002", designation: "HR Head", isPrimary: true } },
  { key: "vaigai", clientCompany: "Vaigai InfoTech", businessModel: "B2B", type: ["company"],
    clientAddress: "8 Bypass Road, Madurai, Tamil Nadu 625010",
    description: "IT consulting company in Madurai — data and cloud practice training.",
    contact: { name: "Revathi Sundaram", email: "revathi.s@vaigai-demo.in", phoneNumber: "9840100003", designation: "Delivery Manager", isPrimary: true } },
  { key: "cauvery", clientCompany: "Cauvery College of Engineering", businessModel: "B2I", type: ["college"],
    clientAddress: "NH-45 Trichy Main Road, Tiruchirappalli, Tamil Nadu 620015",
    description: "Engineering college in Trichy — campus skilling programs.",
    contact: { name: "Dr Ramesh Annadurai", email: "ramesh.a@cauvery-demo.in", phoneNumber: "9840100004", designation: "Placement Officer", isPrimary: true } },
  { key: "marina", clientCompany: "Marina Arts and Science College", businessModel: "B2I", type: ["college"],
    clientAddress: "3 Beach Road, Mylapore, Chennai, Tamil Nadu 600004",
    description: "Arts and science college in Chennai — employability skilling.",
    contact: { name: "Prof Kalaiselvi Natarajan", email: "kalai.n@marina-demo.in", phoneNumber: "9840100005", designation: "Dean Academics", isPrimary: true } },
];

// batch names each client's mapping should know about
const CLIENT_BATCHES = {
  technova: ["Batch 1", "Batch 2"], kovaisoft: [], vaigai: ["Batch 1"],
  cauvery: ["Batch A", "Batch B"], marina: ["Batch A"],
};

const CATEGORIES = [
  { categoryName: "Software Training", categoryDescription: "Programming and software development courses" },
  { categoryName: "Professional Skills", categoryDescription: "Communication and workplace skills" },
  { categoryName: "Cloud and DevOps", categoryDescription: "Cloud platforms and operations" },
];

// ended: start 2026-07-06, 15h/topic x4 = 60h @6h/day -> ends 2026-07-16 (past)
// active: start 2026-07-27, 22h/topic x4 = 88h @6h/day -> ends ~2026-08-12
const COURSES = [
  { code: "TN-PY-101", name: "Python Programming Fundamentals", client: "cauvery", batches: ["Batch A", "Batch B"], ended: false, lang: { coreProgram: ["python"] }, category: "Software Training", level: "Beginner", pack: "python", desc: "Core Python for first-time programmers: syntax, data types, control flow and functions." },
  { code: "TN-PY-102", name: "Advanced Python Programming", client: "cauvery", batches: null, ended: false, lang: { coreProgram: ["python"] }, category: "Software Training", level: "Advanced", pack: "python", desc: "OOP, iterators, decorators, file handling and testing in Python." },
  { code: "TN-PY-103", name: "Python for Data Analysis", client: "technova", batches: ["Batch 1"], ended: true, lang: { coreProgram: ["python"] }, category: "Software Training", level: "Intermediate", pack: "python", desc: "NumPy, pandas and visualization for corporate analysts." },
  { code: "TN-PY-104", name: "Django Web Development with Python", client: "kovaisoft", batches: null, ended: false, lang: { coreProgram: ["python"] }, category: "Software Training", level: "Intermediate", pack: "python", desc: "Building web applications with Django: models, views, templates and REST." },
  { code: "TN-PY-105", name: "Python Automation and Scripting", client: "marina", batches: ["Batch A"], ended: true, lang: { coreProgram: ["python"] }, category: "Software Training", level: "Beginner", pack: "python", desc: "Everyday automation: files, scheduling, web scraping and reporting scripts." },
  { code: "TN-JV-201", name: "Java Programming Essentials", client: "marina", batches: null, ended: false, lang: { coreProgram: ["java"] }, category: "Software Training", level: "Beginner", pack: "java", desc: "Java syntax, OOP pillars, collections and exception handling." },
  { code: "TN-WD-202", name: "Web Development with React", client: "technova", batches: ["Batch 1", "Batch 2"], ended: false, lang: { frontend: ["js", "react"] }, category: "Software Training", level: "Intermediate", pack: "react", desc: "Modern front-end development with React hooks, routing and state management." },
  { code: "TN-DB-203", name: "SQL and Database Fundamentals", client: "vaigai", batches: null, ended: true, lang: { database: ["mysql"] }, category: "Software Training", level: "Beginner", pack: "sql", desc: "Relational modeling, SQL queries, joins, aggregation and normalization." },
  { code: "TN-SS-204", name: "Soft Skills and Communication", client: "cauvery", batches: ["Batch A"], ended: false, lang: {}, category: "Professional Skills", level: "Beginner", pack: "softskills", desc: "Workplace communication, teamwork, email etiquette and presentations." },
  { code: "TN-CL-205", name: "Cloud Fundamentals with AWS", client: "vaigai", batches: ["Batch 1"], ended: false, lang: {}, category: "Cloud and DevOps", level: "Beginner", pack: "aws", desc: "Core AWS services, IAM, storage, compute and the shared responsibility model." },
];

const TRAINER = { key: "trainer", email: "trainer.ravi@batchdemo.in", firstName: "Ravi", lastName: "Shankar", phone: "9840010001", password: "Trainer@123", role: ROLE_TRAINER };
const STUDENTS = [
  ["bt.s01", "Arjun", "Prakash", "cauvery"], ["bt.s02", "Meera", "Krishnan", "cauvery"],
  ["bt.s03", "Karthik", "Raja", "cauvery"], ["bt.s04", "Divya", "Lakshmi", "cauvery"],
  ["bt.s05", "Sneha", "Ramesh", "marina"], ["bt.s06", "Vignesh", "Murali", "marina"],
  ["bt.s07", "Priya", "Selvam", "marina"], ["bt.s08", "Harish", "Kumar", "marina"],
  ["bt.s09", "Lakshmi", "Narayanan", "technova"], ["bt.s10", "Suresh", "Babu", "technova"],
  ["bt.s11", "Anitha", "Devi", "kovaisoft"], ["bt.s12", "Manoj", "Pandian", "kovaisoft"],
  ["bt.s13", "Kavya", "Subramani", "vaigai"], ["bt.s14", "Ajith", "Varman", "vaigai"],
].map(([key, firstName, lastName, client], i) => ({
  key, firstName, lastName, client, role: ROLE_STUDENT, password: "Student@123",
  email: `${key}@batchdemo.in`, phone: `98400200${String(i + 1).padStart(2, "0")}`,
}));

const STUDENT_PERMS = [
  { permissionName: "Student Dashboard", permissionKey: "studentdashboard", permissionFunctionality: [], icon: "Home", color: "indigo", isActive: true, order: 0 },
  { permissionName: "Courses", permissionKey: "courses", permissionFunctionality: [], icon: "BookOpen", color: "emerald", isActive: true, order: 1 },
  { permissionName: "notifications", permissionKey: "notifications", permissionFunctionality: [], icon: "Bell", color: "amber", isActive: true, order: 2 },
  { permissionName: "My Profile", permissionKey: "profile", permissionFunctionality: [], icon: "GraduationCap", color: "emerald", isActive: true, order: 3 },
];
const TRAINER_PERMS = [
  { permissionName: "Staff Dashboard", permissionKey: "dashboard", permissionFunctionality: ["view_users", "add_users", "edit_users", "delete_users"], icon: "Home", color: "green", isActive: true, order: 0 },
  { permissionName: "Course", permissionKey: "courses", permissionFunctionality: [], icon: "BookOpen", color: "red", isActive: true, order: 1 },
  { permissionName: "Notifications", permissionKey: "notifications", permissionFunctionality: [], icon: "Bell", color: "gray", isActive: true, order: 2 },
  { permissionName: "Grades", permissionKey: "grades", permissionFunctionality: [], icon: "GraduationCap", color: "green", isActive: true, order: 3 },
  { permissionName: "profile", permissionKey: "profile", permissionFunctionality: [], icon: "GraduationCap", color: "green", isActive: true, order: 4 },
  { permissionName: "Attendance Management", permissionKey: "attendancemanagement", permissionFunctionality: [], icon: "UserCheck", color: "purple", isActive: true, order: 5 },
];

// enrolment matrix: courseCode -> { batchName -> [userKeys] } (trainer added to every batch)
const ENROLMENT = {
  "TN-PY-101": { "Batch A": ["bt.s01", "bt.s02"], "Batch B": ["bt.s03", "bt.s04"] },
  "TN-PY-102": { Default: ["bt.s01", "bt.s02", "bt.s03", "bt.s04"] },
  "TN-PY-103": { "Batch 1": ["bt.s09", "bt.s10"] },
  "TN-PY-104": { Default: ["bt.s11", "bt.s12"] },
  "TN-PY-105": { "Batch A": ["bt.s05", "bt.s06", "bt.s07"] },
  "TN-JV-201": { Default: ["bt.s05", "bt.s06", "bt.s07", "bt.s08"] },
  "TN-WD-202": { "Batch 1": ["bt.s09"], "Batch 2": ["bt.s10"] },
  "TN-DB-203": { Default: ["bt.s13", "bt.s14"] },
  "TN-SS-204": { "Batch A": ["bt.s01", "bt.s03"] },
  "TN-CL-205": { "Batch 1": ["bt.s13", "bt.s14"] },
};

// ── question factories (answer = what a correct student submission sends) ────
const mc = (t, opts, correct, score = 2, diff = "easy") => ({
  q: { mcqQuestionTitle: t, mcqQuestionType: "multiple_choice", mcqQuestionOptions: opts.map(o => ({ text: o, isCorrect: o === correct })), mcqQuestionCorrectAnswers: [correct], mcqQuestionScore: score, mcqQuestionDifficulty: diff, mcqQuestionRequired: true },
  answer: correct, score, kind: "mcq" });
const ms = (t, opts, correct, score = 2) => ({
  q: { mcqQuestionTitle: t, mcqQuestionType: "multiple_select", mcqQuestionOptions: opts.map(o => ({ text: o, isCorrect: correct.includes(o) })), mcqQuestionCorrectAnswers: correct, mcqQuestionScore: score, mcqQuestionDifficulty: "medium", mcqQuestionRequired: true },
  answer: JSON.stringify(correct), score, kind: "mcq" });
const dd = (t, opts, correct, score = 2) => ({
  q: { mcqQuestionTitle: t, mcqQuestionType: "dropdown", mcqQuestionOptions: opts.map(o => ({ text: o, isCorrect: o === correct })), mcqQuestionCorrectAnswers: [correct], mcqQuestionScore: score, mcqQuestionDifficulty: "easy", mcqQuestionRequired: true },
  answer: correct, score, kind: "mcq" });
const cb = (t, opts, correct, score = 2) => ({
  q: { mcqQuestionTitle: t, mcqQuestionType: "checkboxes", mcqQuestionOptions: opts.map(o => ({ text: o, isCorrect: correct.includes(o) })), mcqQuestionCorrectAnswers: correct, mcqQuestionScore: score, mcqQuestionDifficulty: "medium", mcqQuestionRequired: true },
  answer: JSON.stringify(correct), score, kind: "mcq" });
const tf = (t, ans, score = 2) => ({
  q: { mcqQuestionTitle: t, mcqQuestionType: "true_false", trueFalseAnswer: ans, mcqQuestionScore: score, mcqQuestionDifficulty: "easy", mcqQuestionRequired: true },
  answer: String(ans), score, kind: "mcq" });
const sa = (t, ans, score = 2) => ({
  q: { mcqQuestionTitle: t, mcqQuestionType: "short_answer", shortAnswer: ans, mcqQuestionScore: score, mcqQuestionDifficulty: "medium", mcqQuestionRequired: true },
  answer: ans, score, kind: "mcq" });
const es = (t, model, score = 5) => ({
  q: { mcqQuestionTitle: t, mcqQuestionType: "essay", essayAnswer: model, mcqQuestionScore: score, mcqQuestionDifficulty: "medium", mcqQuestionRequired: true },
  answer: model, score, kind: "mcq" });
const num = (t, ans, tol = 0, score = 2) => ({
  q: { mcqQuestionTitle: t, mcqQuestionType: "numeric", numericAnswer: ans, numericTolerance: tol, mcqQuestionScore: score, mcqQuestionDifficulty: "easy", mcqQuestionRequired: true },
  answer: String(ans), score, kind: "mcq" });
const match = (t, pairs, score = 3) => ({
  q: { mcqQuestionTitle: t, mcqQuestionType: "matching", matchingPairs: pairs.map(([left, right]) => ({ left, right })), mcqQuestionScore: score, mcqQuestionDifficulty: "medium", mcqQuestionRequired: true },
  answer: JSON.stringify(pairs.map(([left, right]) => ({ left, right }))), score, kind: "mcq" });
const ord = (t, items, score = 3) => ({
  q: { mcqQuestionTitle: t, mcqQuestionType: "ordering", orderingItems: items.map((text, i) => ({ text, order: i + 1 })), mcqQuestionScore: score, mcqQuestionDifficulty: "medium", mcqQuestionRequired: true },
  answer: JSON.stringify(items), score, kind: "mcq" });
const prog = (title, text, cases, solutionCode, score = 10, diff = "easy") => ({
  q: { questionType: "programming", title, description: { text }, difficulty: diff, score,
    constraints: ["Use Python 3 syntax", "Read from standard input, print to standard output"],
    hints: [{ hintText: "Read input with input() and print the result with print().", pointsDeduction: 0, isPublic: true }],
    testCases: cases.map(([input, expectedOutput], i) => ({ input, expectedOutput, isSample: i === 0, isHidden: i !== 0, points: 1 })),
    solutions: { startedCode: "", functionName: "main", language: "python" }, timeLimit: 2000, memoryLimit: 256, source: null },
  answer: solutionCode, score, kind: "programming" });
const dbq = (title, text, sampleQuery, score = 10) => ({
  q: { questionType: "database", title, description: { text }, difficulty: "medium", score, sampleQuery, sampleResult: "", source: null },
  answer: sampleQuery, score, kind: "database" });
const other = (title, html, score = 20) => ({
  q: { questionType: "others", title, description: html, othersQuestionType: "file-upload",
    fileUploadSettings: { allowMultiple: false, maxFiles: 1, maxFileSizeMB: 10, allowedTypes: ["pdf", "pptx"] }, totalMarks: score, source: null },
  answer: null, score, kind: "others" });

const PACKS = {
  python: {
    a1prog: [
      prog("Sum of Two Numbers", "Read two integers, one per line, and print their sum.", [["3\n4", "7"], ["10\n25", "35"]], "a=int(input())\nb=int(input())\nprint(a+b)"),
      prog("Reverse a String", "Read a single word and print it reversed.", [["hello", "olleh"], ["Chennai", "iannehC"]], "s=input()\nprint(s[::-1])"),
    ],
    a2: [
      ms("Which of the following are immutable types in Python?", ["tuple", "str", "list", "dict"], ["tuple", "str"]),
      dd("Which keyword defines a function in Python?", ["def", "function", "define", "fn"], "def"),
      cb("Select all valid ways to create an empty collection in Python:", ["[]", "dict()", "set()", "<empty>"], ["[]", "dict()", "set()"]),
      es("Explain the difference between a list and a tuple in Python.", "A list is mutable and defined with []; a tuple is immutable, defined with (), hashable when its items are, and slightly faster."),
      match("Match each Python value to its type:", [["42", "int"], ["'hello'", "str"], ["True", "bool"], ["3.14", "float"]]),
      ord("Arrange the steps of running a Python program in order:", ["Write the source code", "Interpreter compiles to bytecode", "Bytecode runs on the Python VM", "Program output is produced"]),
    ],
    as1: [
      mc("Which built-in function prints to the console in Python?", ["print()", "echo()", "console.log()", "printf()"], "print()"),
      mc("What is the output of len('Chennai')?", ["7", "6", "8", "Error"], "7"),
      ms("Which of these are loop constructs in Python?", ["for", "while", "do-while", "foreach"], ["for", "while"]),
      tf("Python is a dynamically typed language.", true),
      num("What is the result of 2 ** 3 in Python?", 8),
    ],
    as2prog: [
      prog("Even or Odd", "Read an integer and print 'Even' if it is even, otherwise print 'Odd'.", [["6", "Even"], ["7", "Odd"]], "n=int(input())\nprint('Even' if n%2==0 else 'Odd')"),
      prog("Maximum of Numbers", "Read space-separated integers on one line and print the largest.", [["3 9 2", "9"], ["15 4 8", "15"]], "print(max(map(int,input().split())))", 10, "medium"),
    ],
  },
  java: {
    a1: [
      mc("Which keyword creates a new object in Java?", ["new", "create", "make", "alloc"], "new"),
      tf("Java is platform independent because compiled bytecode runs on the JVM.", true),
      sa("Which company originally developed Java?", "Sun Microsystems"),
      num("How many primitive data types does Java have?", 8),
    ],
    a2: [
      ms("Which of these are OOP pillars in Java?", ["Encapsulation", "Inheritance", "Polymorphism", "Compilation"], ["Encapsulation", "Inheritance", "Polymorphism"]),
      dd("Which access modifier is the most restrictive?", ["private", "public", "protected", "default"], "private"),
      cb("Select all valid Java loop types:", ["for", "while", "do-while", "repeat"], ["for", "while", "do-while"]),
      es("Explain the difference between JDK, JRE and JVM.", "JVM executes bytecode; JRE bundles the JVM with runtime libraries; JDK adds compilers and tools for development."),
      match("Match the Java concept to its meaning:", [["class", "blueprint"], ["object", "instance"], ["method", "behaviour"], ["field", "state"]]),
      ord("Order the Java build-and-run steps:", ["Write the .java source", "Compile with javac", ".class bytecode is generated", "Run on the JVM"]),
    ],
    as1: [
      mc("Which method is the entry point of a Java program?", ["main", "start", "run", "init"], "main"),
      mc("Which keyword prevents a class from being inherited?", ["final", "static", "const", "sealed"], "final"),
      ms("Which of these are Java primitive types?", ["int", "boolean", "String", "char"], ["int", "boolean", "char"]),
      tf("Arrays in Java are objects.", true),
      num("What is the size of an int in Java, in bits?", 32),
    ],
    as2: [
      mc("Which collection maintains insertion order?", ["ArrayList", "HashSet", "HashMap", "TreeSet"], "ArrayList"),
      dd("Which block is used to catch exceptions?", ["catch", "finally", "throw", "static"], "catch"),
      sa("Which interface does ArrayList implement?", "List", 3),
      es("Describe the difference between method overloading and overriding.", "Overloading: same name, different parameter lists in one class, resolved at compile time. Overriding: subclass redefines a superclass method with the same signature, resolved at runtime."),
    ],
  },
  react: {
    a1: [
      mc("Which hook manages local state in a function component?", ["useState", "useEffect", "useContext", "useRef"], "useState"),
      tf("A JSX expression must return a single parent element.", true),
      sa("Which npm command creates a production build?", "npm run build"),
      num("What is the default port of the React development server?", 3000),
    ],
    a2: [
      ms("Which of these are valid React hooks?", ["useState", "useEffect", "useMemo", "useClass"], ["useState", "useEffect", "useMemo"]),
      dd("Which prop uniquely identifies items in a rendered list?", ["key", "id", "ref", "name"], "key"),
      cb("Select all styling approaches usable in React:", ["CSS Modules", "styled-components", "Tailwind classes", "VBScript styles"], ["CSS Modules", "styled-components", "Tailwind classes"]),
      es("Explain the difference between props and state.", "Props are read-only inputs passed from a parent; state is data owned and updated by the component itself, changes to either trigger re-render."),
      match("Match the hook to its purpose:", [["useState", "local state"], ["useEffect", "side effects"], ["useContext", "shared data"], ["useRef", "DOM reference"]]),
      ord("Order the render flow of a function component:", ["Render JSX", "Commit to the DOM", "Run useEffect", "Cleanup on unmount"]),
    ],
    as1: [
      mc("What does the virtual DOM primarily improve?", ["Rendering performance", "Network speed", "Bundle size", "SEO"], "Rendering performance"),
      mc("Which company maintains React?", ["Meta", "Google", "Microsoft", "Amazon"], "Meta"),
      ms("Which are valid ways to share data with a child component?", ["props", "context", "a store like Redux", "global variables"], ["props", "context", "a store like Redux"]),
      tf("useEffect with an empty dependency array runs after every render.", false),
      num("How many top-level elements can a fragment wrap into one?", 1),
    ],
    as2: [
      mc("Which hook memoizes an expensive computed value?", ["useMemo", "useState", "useRef", "useId"], "useMemo"),
      dd("Which library is commonly used for client-side routing in React?", ["react-router", "express", "axios", "jest"], "react-router"),
      sa("What attribute replaces 'class' in JSX?", "className", 3),
      es("When would you lift state up, and why?", "When multiple siblings need the same data, move the state to their closest common ancestor and pass it down via props so there is a single source of truth."),
    ],
  },
  sql: {
    a1: [
      mc("Which SQL statement retrieves data from a table?", ["SELECT", "GET", "FETCH", "PULL"], "SELECT"),
      tf("A PRIMARY KEY column can contain NULL values.", false),
      sa("Which SQL clause filters grouped rows?", "HAVING"),
      num("At most how many rows does 'LIMIT 5' return?", 5),
    ],
    a2: [
      ms("Which of these are aggregate functions?", ["COUNT", "SUM", "AVG", "WHERE"], ["COUNT", "SUM", "AVG"]),
      dd("Which join returns only rows that match in both tables?", ["INNER JOIN", "LEFT JOIN", "RIGHT JOIN", "FULL JOIN"], "INNER JOIN"),
      cb("Select all valid SQL constraints:", ["PRIMARY KEY", "FOREIGN KEY", "UNIQUE", "LOOP"], ["PRIMARY KEY", "FOREIGN KEY", "UNIQUE"]),
      es("Explain database normalization and why 3NF matters.", "Normalization removes redundancy by structuring data into related tables; 3NF ensures non-key columns depend only on the key, reducing update anomalies."),
      match("Match the SQL sub-language to a statement:", [["DDL", "CREATE"], ["DML", "INSERT"], ["DCL", "GRANT"], ["TCL", "COMMIT"]]),
      ord("Order the logical steps of SQL query execution:", ["FROM", "WHERE", "GROUP BY", "SELECT", "ORDER BY"]),
    ],
    lab: [
      mc("Which keyword removes duplicate rows from a result?", ["DISTINCT", "UNIQUE", "SINGLE", "ONLY"], "DISTINCT"),
      tf("An INDEX always speeds up INSERT operations.", false),
      dbq("List adult students", "Table: students(name VARCHAR, age INT). Write a query that returns the names of all students older than 20.", "SELECT name FROM students WHERE age > 20;"),
    ],
    as1: [
      mc("Which statement adds a new row?", ["INSERT INTO", "ADD ROW", "APPEND", "CREATE ROW"], "INSERT INTO"),
      mc("Which function returns the number of rows?", ["COUNT(*)", "SUM(*)", "TOTAL()", "ROWS()"], "COUNT(*)"),
      ms("Which are valid SQL data types in MySQL?", ["VARCHAR", "INT", "DATE", "ARRAYLIST"], ["VARCHAR", "INT", "DATE"]),
      tf("The WHERE clause runs before GROUP BY logically.", true),
      num("How many tables does a single INNER JOIN clause combine?", 2),
    ],
    as2: [
      mc("Which clause sorts the result set?", ["ORDER BY", "SORT BY", "GROUP BY", "ARRANGE BY"], "ORDER BY"),
      dd("Which statement modifies existing rows?", ["UPDATE", "ALTER", "MODIFY", "CHANGE"], "UPDATE"),
      sa("Which keyword combines the results of two SELECTs removing duplicates?", "UNION", 3),
      es("Explain the difference between DELETE and TRUNCATE.", "DELETE removes rows one by one, can have WHERE and is fully logged/rollback-able; TRUNCATE deallocates all rows at once, no WHERE, resets identity, faster."),
    ],
  },
  aws: {
    a1: [
      mc("Which AWS service provides object storage?", ["S3", "EC2", "RDS", "Lambda"], "S3"),
      tf("AWS EC2 is a serverless compute service.", false),
      sa("What does IAM stand for?", "Identity and Access Management"),
      num("What minimum number of Availability Zones should a highly available deployment span?", 2),
    ],
    a2: [
      ms("Which of these are AWS compute services?", ["EC2", "Lambda", "ECS", "S3"], ["EC2", "Lambda", "ECS"]),
      dd("Which service is a managed relational database?", ["RDS", "DynamoDB", "S3", "CloudFront"], "RDS"),
      cb("Select all benefits of cloud computing:", ["Elasticity", "Pay-as-you-go pricing", "High availability", "Manual scaling"], ["Elasticity", "Pay-as-you-go pricing", "High availability"]),
      es("Explain the AWS shared responsibility model.", "AWS secures the cloud infrastructure (hardware, facilities, managed services); the customer secures what runs in the cloud — data, IAM, OS patching and network configuration."),
      match("Match the AWS service to its purpose:", [["S3", "Object storage"], ["EC2", "Virtual servers"], ["RDS", "Relational database"], ["CloudFront", "Content delivery"]]),
      ord("Order the steps to launch an EC2 instance:", ["Choose an AMI", "Choose an instance type", "Configure the security group", "Launch the instance"]),
    ],
    as1: [
      mc("Which service runs code without provisioning servers?", ["Lambda", "EC2", "Lightsail", "EKS"], "Lambda"),
      mc("Which storage class is cheapest for rarely accessed archives?", ["S3 Glacier", "S3 Standard", "EBS", "EFS"], "S3 Glacier"),
      ms("Which are AWS database services?", ["RDS", "DynamoDB", "Aurora", "Nginx"], ["RDS", "DynamoDB", "Aurora"]),
      tf("An S3 bucket name must be globally unique.", true),
      num("How many 9s of durability does S3 Standard advertise (count of nines)?", 11),
    ],
    as2: [
      mc("Which service distributes traffic across instances?", ["Elastic Load Balancer", "Route 53", "VPC", "SNS"], "Elastic Load Balancer"),
      dd("Which service provides DNS?", ["Route 53", "CloudWatch", "IAM", "SQS"], "Route 53"),
      sa("What does VPC stand for?", "Virtual Private Cloud", 3),
      es("Describe when you would choose DynamoDB over RDS.", "Choose DynamoDB for key-value access at massive scale with single-digit-ms latency and flexible schema; RDS for relational integrity, joins and complex SQL."),
    ],
  },
  softskills: {
    a1: [
      mc("Which is an example of non-verbal communication?", ["Body language", "Email", "Phone call", "Memo"], "Body language"),
      tf("Active listening involves interrupting the speaker to show engagement.", false),
      sa("What does the 'S' in SMART goals stand for?", "Specific"),
      num("In the 7-38-55 communication rule, what percentage is attributed to body language?", 55),
    ],
    a2: [
      ms("Which of these are elements of effective teamwork?", ["Trust", "Communication", "Accountability", "Micromanagement"], ["Trust", "Communication", "Accountability"]),
      dd("Which conflict-resolution style seeks a win-win outcome?", ["Collaborating", "Avoiding", "Competing", "Accommodating"], "Collaborating"),
      cb("Select all good email etiquette practices:", ["Clear subject line", "Proofreading before sending", "Concise body", "Writing in all caps"], ["Clear subject line", "Proofreading before sending", "Concise body"]),
      es("Describe a situation where you resolved a conflict within a team.", "In a group project two members disagreed on approach; I facilitated a discussion, listed pros and cons objectively, and we agreed on a hybrid that met the deadline."),
      match("Match the skill to its description:", [["Empathy", "Understanding feelings"], ["Feedback", "Constructive input"], ["Delegation", "Assigning tasks"], ["Negotiation", "Reaching agreement"]]),
      ord("Order Tuckman's stages of team formation:", ["Forming", "Storming", "Norming", "Performing"]),
    ],
    upload: [other("Self-introduction presentation", "Prepare and upload a 5-slide presentation introducing yourself, your strengths and your career goals. Accepted formats: PDF or PPTX.")],
    as1: [
      mc("Which of these best demonstrates active listening?", ["Paraphrasing the speaker's point", "Checking your phone", "Planning your reply while they talk", "Interrupting with solutions"], "Paraphrasing the speaker's point"),
      mc("What is the recommended structure for constructive feedback?", ["Situation-Behaviour-Impact", "Blame-Explain-Repeat", "Praise only", "Criticise first"], "Situation-Behaviour-Impact"),
      ms("Which are effective presentation practices?", ["Eye contact", "Story-driven structure", "Reading slides verbatim", "Rehearsing beforehand"], ["Eye contact", "Story-driven structure", "Rehearsing beforehand"]),
      tf("Open-ended questions encourage richer conversation than yes/no questions.", true),
      num("What is the ideal maximum number of key points per presentation slide?", 5, 2),
    ],
    as2: [
      mc("Which time-management technique uses 25-minute focus blocks?", ["Pomodoro", "Kanban", "Scrum", "GTD"], "Pomodoro"),
      dd("Which matrix prioritises tasks by urgency and importance?", ["Eisenhower Matrix", "SWOT", "RACI", "BCG"], "Eisenhower Matrix"),
      sa("What does the 'A' in SMART goals stand for?", "Achievable", 3),
      es("Explain why written communication matters in remote teams.", "Remote teams depend on clear, asynchronous written records — good writing avoids ambiguity, keeps decisions traceable and includes teammates across time zones."),
    ],
  },
};

// exercise plan per course: key -> {tab, subcat, node, type, name, testType, questions}
function exercisesFor(c) {
  const P = PACKS[c.pack];
  const list = [];
  const isPy = !!P.a1prog;
  // subcategory = normalizeKey(catalog label): the admin UI stores exercises
  // under the lowercased/underscored label ('assignment', 'assesment'), and
  // several client pages read those buckets by literal lowercase key.
  list.push({ key: "A1", tab: "We_Do", subcat: "assignment", node: "m1t1",
    type: isPy ? "Programming" : "MCQ", testType: "practice",
    name: `Assignment 1 — ${c.name.split(" ")[0]} Basics`, defs: isPy ? P.a1prog : P.a1 });
  list.push({ key: "A2", tab: "We_Do", subcat: "assignment", node: "m1t2",
    type: "MCQ", testType: "practice", name: "Assignment 2 — Core Concepts", defs: P.a2 });
  if (c.pack === "sql") list.push({ key: "LAB", tab: "We_Do", subcat: "assignment", node: "m2t1",
    type: "Combined", testType: "practice", name: "SQL Query Lab", defs: P.lab });
  if (c.pack === "softskills") list.push({ key: "UPL", tab: "We_Do", subcat: "assignment", node: "m2t1",
    type: "Other", testType: "practice", name: "Presentation Upload", defs: P.upload });
  list.push({ key: "AS1", tab: "You_Do", subcat: "assesment", node: "m2t1",
    type: "MCQ", testType: "mock", name: "Mock Assessment 1", defs: P.as1 });
  list.push({ key: "AS2", tab: "You_Do", subcat: "assesment", node: "m2t2",
    type: isPy ? "Programming" : "MCQ", testType: "final",
    name: "Final Assessment", defs: isPy ? P.as2prog : P.as2 });
  return list;
}

// submissions: [courseCode, studentKey, exerciseKeys, mode]
const SUBMISSIONS = [
  ["TN-PY-101", "bt.s01", ["A1", "AS1"], "complete"],
  ["TN-PY-101", "bt.s02", ["A1"], "partial"],
  ["TN-PY-101", "bt.s03", ["A2"], "complete"],
  ["TN-PY-102", "bt.s01", ["A1"], "partial"],
  ["TN-PY-103", "bt.s09", ["A1", "A2", "AS1"], "complete"],
  ["TN-PY-103", "bt.s10", ["A1", "AS1"], "complete"],
  ["TN-PY-104", "bt.s11", ["A1", "AS1"], "complete"],
  ["TN-PY-105", "bt.s05", ["A1", "AS1"], "complete"],
  ["TN-PY-105", "bt.s06", ["A1"], "partial"],
  ["TN-JV-201", "bt.s05", ["A1"], "complete"],
  ["TN-WD-202", "bt.s09", ["A1", "AS1"], "complete"],
  ["TN-DB-203", "bt.s13", ["A1", "AS1"], "complete"],
  ["TN-DB-203", "bt.s14", ["A1"], "complete"],
  ["TN-SS-204", "bt.s01", ["A1"], "complete"],
  ["TN-CL-205", "bt.s13", ["A1"], "partial"],
];

const FEEDBACK_QUESTIONS = [
  { questionText: "How would you rate the overall course content?", questionType: "rating", isRequired: true, order: 1, ratingConfig: { minRating: 1, maxRating: 5, ratingLabels: ["Poor", "Fair", "Good", "Very Good", "Excellent"] }, ratingStyle: "star", category: "Course Content" },
  { questionText: "How effective were the trainer's explanations?", questionType: "rating", isRequired: true, order: 2, ratingConfig: { minRating: 1, maxRating: 5, ratingLabels: ["Poor", "Fair", "Good", "Very Good", "Excellent"] }, ratingStyle: "number", category: "Trainer" },
  { questionText: "How satisfied are you with the hands-on practice?", questionType: "rating", isRequired: true, order: 3, ratingConfig: { minRating: 1, maxRating: 5, ratingLabels: ["Very Unsatisfied", "Unsatisfied", "Neutral", "Satisfied", "Very Satisfied"] }, ratingStyle: "emoji", category: "Practice" },
  { questionText: "How likely are you to recommend this course?", questionType: "rating", isRequired: true, order: 4, ratingConfig: { minRating: 1, maxRating: 5, ratingLabels: ["Not at all", "Unlikely", "Maybe", "Likely", "Definitely"] }, ratingStyle: "star", category: "Overall" },
  { questionText: "What did you like the most about the course?", questionType: "text", isRequired: true, order: 5, placeholder: "Tell us what worked well...", maxLength: 500, category: "Overall" },
  { questionText: "What can we improve for future batches?", questionType: "text", isRequired: false, order: 6, placeholder: "Suggestions...", maxLength: 500, category: "Overall" },
];

// responder plan for the 3 ended courses: [courseCode, studentKey, ratings[4], liked, improve, anonymous]
const FEEDBACK_RESPONSES = [
  ["TN-PY-103", "bt.s09", [5, 4, 5, 5], "The pandas sessions with real datasets were excellent.", "A little more time on visualization would help.", false],
  ["TN-PY-105", "bt.s05", [4, 4, 3, 4], "Automating boring file tasks felt immediately useful.", "More scraping examples please.", false],
  ["TN-PY-105", "bt.s06", [5, 5, 4, 5], "The trainer explained every script line by line.", "", true],
  ["TN-DB-203", "bt.s13", [4, 3, 4, 4], "Joins finally make sense after the lab exercises.", "Slides could include more ER diagrams.", false],
];

// ── phases ───────────────────────────────────────────────────────────────────
async function mintAdminToken() {
  await mongoose.connect(process.env.MONGOURI, { serverSelectionTimeoutMS: 30000 });
  const key = require("../config/default.json").JWT_TOKEN_KEY;
  const token = jwt.sign({ id: ADMIN_ID }, key, { expiresIn: 3 * 24 * 60 * 60 });
  await mongoose.connection.db.collection("lms-tokens").insertOne({ token, createdAt: new Date() });
  await mongoose.disconnect();
  return token;
}

async function login(email, password) {
  for (let i = 0; i < 3; i++) {
    const r = await api("POST", "/user/login", { email, password }, null, [400, 401, 403, 404, 500]);
    if (r.status === 201 && r.json?.token) return r.json.token;
    await new Promise(r2 => setTimeout(r2, 1500));
  }
  throw new Error(`login failed for ${email}`);
}

async function run() {
  const admin = await mintAdminToken();
  log("admin token ready");
  state.clients = state.clients || {};
  state.mappings = state.mappings || {};
  state.users = state.users || {};
  state.courses = state.courses || {};
  state.exercises = state.exercises || {};
  state.submissionsDone = state.submissionsDone || {};
  state.feedback = state.feedback || {};
  state.feedbackResponses = state.feedbackResponses || {};

  // 1 ─ clients
  const existingClients = (await api("GET", "/client-management/getAll", undefined, admin)).json.data || [];
  for (const c of CLIENTS) {
    let doc = existingClients.find(x => x.clientCompany.toLowerCase() === c.clientCompany.toLowerCase());
    if (!doc) {
      const r = await api("POST", "/client-management/create", {
        clientCompany: c.clientCompany, businessModel: c.businessModel, type: c.type,
        description: c.description, clientAddress: c.clientAddress, clientLogo: "",
        status: "active", services: [], contactPersons: [c.contact],
      }, admin);
      doc = r.json.data;
      log(`client created: ${c.clientCompany} (${doc._id})`);
    } else log(`client exists: ${c.clientCompany}`);
    state.clients[c.key] = { id: doc._id, name: c.clientCompany, businessModel: c.businessModel };
    save();
  }

  // 2 ─ service mappings (before any /service-mapping/getAll to avoid ghost migration)
  for (const c of CLIENTS) {
    const cur = (await api("GET", `/service-mapping/getByClient/${state.clients[c.key].id}`, undefined, admin)).json.data || [];
    let doc = cur[0];
    if (!doc) {
      const isB2B = c.businessModel === "B2B";
      const batchVals = CLIENT_BATCHES[c.key];
      const myCourses = COURSES.filter(x => x.client === c.key).map(x => ({
        category: x.category, courseName: x.name, path: "",
        batchesEnabled: !!x.batches, batches: x.batches || [],
      }));
      const r = await api("POST", "/service-mapping/create", {
        client: state.clients[c.key].id,
        service: isB2B ? "business to business" : "business to institution",
        serviceModels: [isB2B ? "Skilling" : "skilling"],
        year: "2026",
        hierarchy: [{ level: "Batch", enabled: true, mandatory: false }],
        masterData: batchVals.length ? [{ level: "Batch", values: batchVals }] : [],
        courseName: myCourses[0]?.courseName || "", category: myCourses[0]?.category || "",
        courses: myCourses,
        batchConfigs: batchVals.map(name => ({ name, degree: "", departments: [], phases: [] })),
        prtMode: "", status: "active",
      }, admin);
      doc = r.json.data;
      log(`mapping created: ${c.clientCompany} -> ${doc.serviceCode}`);
    } else log(`mapping exists: ${c.clientCompany} -> ${doc.serviceCode}`);
    state.mappings[c.key] = { id: doc._id, serviceCode: doc.serviceCode, service: doc.service, serviceModal: doc.serviceModels?.[0] || "" };
    save();
  }

  // 3 ─ categories
  const cats = (await api("GET", "/categories/getAll", undefined, admin)).json.data || [];
  for (const cat of CATEGORIES) {
    if (!cats.find(x => x.categoryName === cat.categoryName)) {
      await api("POST", "/categories/create", cat, admin, [400]);
      log(`category ensured: ${cat.categoryName}`);
    }
  }

  // 4 ─ users (+ permissions + logins)  — BEFORE courses so autoEnrollUser finds nothing
  let existingUsers = [];
  {
    const r = await api("GET", `/getAll/userAccess/${INSTITUTION}`, undefined, admin, [404]);
    existingUsers = r.json?.Users || [];
  }
  const allUsers = [{ ...TRAINER, client: null }, ...STUDENTS];
  for (const u of allUsers) {
    let doc = existingUsers.find(x => x.email === u.email);
    if (!doc && state.users[u.key]?.id) doc = { _id: state.users[u.key].id };
    if (!doc) {
      const body = {
        email: u.email, firstName: u.firstName, lastName: u.lastName,
        password: u.password, phone: u.phone, role: u.role, gender: "", status: "active",
      };
      if (u.client) {
        body.clientName = state.clients[u.client].name;
        body.clientId = state.clients[u.client].id;
        body.serviceModel = state.mappings[u.client].serviceModal;
        body.serviceMappingId = state.mappings[u.client].id;
      }
      const r = await api("POST", "/add/users", body, admin, [403]);
      if (r.status === 403) { log(`user already exists (403): ${u.email}`); }
      else { doc = r.json.user; log(`user created: ${u.email} (${doc.userId})`); }
    } else log(`user exists: ${u.email}`);
    if (doc) {
      state.users[u.key] = { id: doc._id, email: u.email, password: u.password, name: `${u.firstName} ${u.lastName}`, client: u.client || null, role: u.role === ROLE_TRAINER ? "Trainer" : "Student" };
      save();
    }
  }
  // permissions (bulk, replace-all semantics per user)
  const userPermissions = allUsers.map(u => ({
    userId: state.users[u.key].id,
    permissions: u.role === ROLE_TRAINER ? TRAINER_PERMS : STUDENT_PERMS,
  }));
  const pr = await api("PUT", "/user-permission/bulk-update", { userPermissions }, admin);
  const summ = pr.json?.data?.summary;
  log(`permissions bulk-update: ${JSON.stringify(summ)}`);
  if (summ && summ.failed > 0) throw new Error("permission update failures: " + JSON.stringify(pr.json.data.errors));
  // logins
  state.tokens = state.tokens || {};
  for (const u of allUsers) {
    state.tokens[u.key] = await login(u.email, u.password);
    log(`login ok: ${u.email}`);
  }
  save();

  // 5 ─ courses
  const existingCourses = (await api("GET", "/courses-structure/getAll", undefined, admin)).json?.data || [];
  for (const c of COURSES) {
    let doc = existingCourses.find(x => x.courseCode === c.code);
    if (!doc) {
      const body = {
        clientId: state.clients[c.client].id,
        clientName: state.clients[c.client].name,
        serviceType: state.mappings[c.client].service,
        serviceModal: state.mappings[c.client].serviceModal,
        category: c.category, courseCode: c.code, mappingId: state.mappings[c.client].id,
        coursePath: "", courseName: c.name, courseDescription: c.desc,
        courseLevel: c.level, courseDuration: c.ended ? "60 hours" : "88 hours",
        studentType: "skilling", aiChatGlobal: "true",
      };
      if (c.batches) body.batches = JSON.stringify(c.batches);
      (c.lang.coreProgram || []).forEach((v, i) => { body[`testConfiguration[coreProgram][${i}]`] = v; });
      (c.lang.frontend || []).forEach((v, i) => { body[`testConfiguration[frontend][${i}]`] = v; });
      (c.lang.database || []).forEach((v, i) => { body[`testConfiguration[database][${i}]`] = v; });
      const r = await api("POST", "/courses-structure/create", body, admin);
      doc = r.json.data;
      log(`course created: ${c.code} ${c.name} (${doc._id}) testConfig=${JSON.stringify(doc.testConfiguration)}`);
    } else log(`course exists: ${c.code}`);
    state.courses[c.code] = state.courses[c.code] || {};
    Object.assign(state.courses[c.code], { id: doc._id, name: c.name, client: c.client, ended: c.ended, batches: c.batches });
    save();
  }

  // 6 ─ modules + topics + pedagogy hours + program calendar
  for (const c of COURSES) {
    const sc = state.courses[c.code];
    if (!sc.structure) {
      const subject = c.name.replace(/ with .*| and .*| Fundamentals| Essentials| Programming/gi, "").trim() || c.name;
      const mods = [
        { title: `${subject} Foundations`, topics: ["Getting Started", "Core Concepts"] },
        { title: `Applied ${subject}`, topics: ["Hands-on Practice", "Capstone and Review"] },
      ];
      sc.structure = {};
      for (let mi = 0; mi < mods.length; mi++) {
        const m = (await api("POST", "/module/create", { courses: sc.id, title: mods[mi].title, description: `${mods[mi].title} module`, duration: c.ended ? 30 : 44, level: c.level, index: mi }, admin)).json.module;
        for (let ti = 0; ti < mods[mi].topics.length; ti++) {
          const t = (await api("POST", "/topic/create", { courses: sc.id, moduleId: m._id, title: mods[mi].topics[ti], description: `${mods[mi].topics[ti]} — ${c.name}`, duration: c.ended ? 15 : 22, index: ti }, admin)).json.topic;
          sc.structure[`m${mi + 1}t${ti + 1}`] = { topicId: t._id, moduleId: m._id, title: t.title };
        }
      }
      log(`structure created: ${c.code} (2 modules / 4 topics)`);
      save();
    }
    if (!sc.pedagogy) {
      const hrs = c.ended ? { iDo: 5, weDo: 6, youDo: 4 } : { iDo: 8, weDo: 9, youDo: 5 };
      // topic-only node ids: PUT /pedagogy-view/update merges rows that share ANY
      // node id, so rows carrying the module id collapse into one row per module
      // (halving the course's total hours). Topic ids are unique per row.
      const pedagogies = Object.values(sc.structure).map(n => ({
        module: [], subModule: [], topic: [n.topicId], subTopic: [],
        iDo: [{ type: "Video", duration: hrs.iDo }],
        weDo: [{ type: "Practice", duration: hrs.weDo }],
        youDo: [{ type: "Assessment", duration: hrs.youDo }],
      }));
      await api("PUT", `/pedagogy-view/update/${sc.id}`, { courses: sc.id, pedagogies }, admin, [201]);
      sc.pedagogy = true;
      log(`pedagogy hours set: ${c.code} (${c.ended ? 60 : 88}h)`);
      save();
    }
    if (!sc.calendar) {
      await api("POST", "/program-calendar/save", {
        courseId: sc.id, startDate: c.ended ? "2026-07-06" : "2026-07-27",
        sessions: [
          { slotId: "s1", kind: "session", name: "Morning Session", startTime: "09:30", endTime: "12:30" },
          { slotId: "b1", kind: "break", name: "Lunch Break", startTime: "12:30", endTime: "13:30" },
          { slotId: "s2", kind: "session", name: "Afternoon Session", startTime: "13:30", endTime: "16:30" },
        ],
        deviations: [], status: "published",
      }, admin, [201]);
      sc.calendar = true;
      log(`calendar saved: ${c.code} (start ${c.ended ? "2026-07-06" : "2026-07-27"})`);
      save();
    }
  }

  // 7 ─ enrolment (trainer into every batch, students per matrix)
  for (const c of COURSES) {
    const sc = state.courses[c.code];
    if (sc.enrolled) continue;
    for (const [batchName, studentKeys] of Object.entries(ENROLMENT[c.code])) {
      const ids = [state.users.trainer.id, ...studentKeys.map(k => state.users[k].id)];
      const r = await api("POST", `/add-participants/${sc.id}`, { batchName, participantIds: ids }, admin);
      const d = r.json.data;
      log(`enrolled ${c.code}/${batchName}: added=${d.totalAdded} already=${(d.alreadyEnrolled || []).length} skipped=${(d.skippedOtherBatch || []).length}`);
      if ((d.skippedOtherBatch || []).length) throw new Error(`unexpected skips in ${c.code}/${batchName}: ${d.skippedOtherBatch}`);
    }
    // capture batch subdoc ids for feedback
    const full = (await api("GET", `/courses-structure/getById/${sc.id}`, undefined, admin)).json.data;
    sc.batchIds = {};
    for (const b of full.batchAndParticipants || []) sc.batchIds[b.batchName] = b._id;
    sc.enrolled = true;
    save();
  }

  // 8 ─ We_Do / You_Do exercises + questions
  for (const c of COURSES) {
    const sc = state.courses[c.code];
    state.exercises[c.code] = state.exercises[c.code] || {};
    for (const ex of exercisesFor(c)) {
      if (state.exercises[c.code][ex.key]) continue;
      const node = sc.structure[ex.node];
      const mcqDefs = ex.defs.filter(d => d.kind === "mcq");
      const progDefs = ex.defs.filter(d => d.kind === "programming");
      const dbDefs = ex.defs.filter(d => d.kind === "database");
      const otherDefs = ex.defs.filter(d => d.kind === "others");
      const mcqMarks = mcqDefs.reduce((s, d) => s + d.score, 0);
      const progMarks = progDefs.reduce((s, d) => s + d.score, 0) + dbDefs.reduce((s, d) => s + d.score, 0);
      const otherMarks = otherDefs.reduce((s, d) => s + d.score, 0);
      const totalMarks = mcqMarks + progMarks + otherMarks;
      const info = {
        exerciseId: `${c.code}-${ex.key}`, exerciseName: ex.name,
        description: `${ex.name} for ${c.name}.`,
        exerciseLevel: "beginner", testType: ex.testType,
        totalDuration: ex.tab === "You_Do" ? 60 : 45,
        totalMarks, totalMarksMCQ: mcqMarks, totalMarksProgramming: progMarks,
        selectedModule: "Core Programming",
        selectedLanguages: c.lang.coreProgram ? ["Python"] : [],
        isSectionBased: false,
      };
      const payload = {
        tabType: ex.tab, subcategory: ex.subcat, exerciseType: ex.type,
        exerciseInformation: info,
        questionConfiguration: {
          ...(mcqDefs.length ? { mcqConfig: { generalQuestionCount: mcqDefs.length, scoreSettings: { scoreType: "questionSpecific", totalMarks: mcqMarks }, attemptLimitEnabled: false, submissionAttempts: 1 } } : {}),
          ...(progDefs.length || dbDefs.length ? { programmingConfig: { questionConfigType: "general", generalQuestionCount: progDefs.length + dbDefs.length, scoreSettings: { scoreType: "equalDistribution", equalDistribution: 10 }, questionFlow: "freeFlow", compilerFileMode: "single", attemptLimitEnabled: false, submissionAttempts: 1 } } : {}),
        },
        ...(progDefs.length ? { programmingSettings: { selectedModule: "Core Programming", selectedLanguages: ["Python"] } } : {}),
        availabilityPeriod: { startDate: "2026-07-01T00:00:00.000Z", endDate: "2026-12-31T23:59:59.000Z", cutOffEnabled: false, gracePeriodEnabled: false, requiresAdminApproval: false, approvalScope: "settings" },
        notificationSettings: { notifyUsers: false, notifyStudent: false, gradeSheet: true },
        isGraded: true,
        stepsSaved: ["Exercise Details", "Question Configuration", "Schedule", "Notifications", "Grade Settings"],
        questionSource: null, saveToBank: false, instructions: "",
        ...(ex.tab === "You_Do" ? { securitySettings: { requireFullscreen: false, preventTabSwitch: false, shuffleQuestions: false, maxAttempts: 3 } } : {}),
      };
      const base = ex.tab === "You_Do" ? "/you-do/exercise/add" : "/exercise/add";
      const r = await api("PUT", `${base}/topics/${node.topicId}`, payload, admin);
      const exerciseId = r.json?.data?.exercise?._id || r.json?.data?._id;
      if (!exerciseId) throw new Error(`no exercise id for ${c.code}/${ex.key}: ${JSON.stringify(r.json).slice(0, 300)}`);
      // add questions
      const qmeta = [];
      if (mcqDefs.length) {
        const qr = await api("POST", `/mcq-question-add/topics/${node.topicId}/exercise/${exerciseId}`,
          { tabType: ex.tab, subcategory: ex.subcat, questionsData: mcqDefs.map(d => d.q) }, admin);
        const added = qr.json?.data?.addedQuestions || [];
        if (added.length !== mcqDefs.length) throw new Error(`mcq add mismatch ${c.code}/${ex.key}: ${added.length}/${mcqDefs.length}`);
        added.forEach((a, i) => qmeta.push({ questionId: a.questionId || a._id, answer: mcqDefs[i].answer, score: mcqDefs[i].score, kind: "mcq", type: mcqDefs[i].q.mcqQuestionType, title: typeof mcqDefs[i].q.mcqQuestionTitle === "string" ? mcqDefs[i].q.mcqQuestionTitle : "" }));
      }
      const nonMcq = [...progDefs, ...dbDefs, ...otherDefs];
      if (nonMcq.length) {
        const qr = await api("POST", `/question-add/topics/${node.topicId}/exercise/${exerciseId}`,
          { tabType: ex.tab, subcategory: ex.subcat, questionsData: nonMcq.map(d => d.q) }, admin);
        const added = qr.json?.data?.addedQuestions || [];
        if (added.length !== nonMcq.length) throw new Error(`question add mismatch ${c.code}/${ex.key}: ${added.length}/${nonMcq.length}`);
        added.forEach((a, i) => qmeta.push({ questionId: a.questionId || a._id, answer: nonMcq[i].answer, score: nonMcq[i].score, kind: nonMcq[i].kind, type: nonMcq[i].q.questionType, title: nonMcq[i].q.title }));
      }
      state.exercises[c.code][ex.key] = {
        exerciseId, name: ex.name, tab: ex.tab, subcat: ex.subcat, type: ex.type, testType: ex.testType,
        topicId: node.topicId, topicTitle: node.title, questions: qmeta, totalMarks,
      };
      log(`exercise ready: ${c.code}/${ex.key} "${ex.name}" (${qmeta.length} questions, ${totalMarks} marks)`);
      save();
    }
  }

  // 9 ─ student submissions
  for (const [code, studentKey, exKeys, mode] of SUBMISSIONS) {
    for (const exKey of exKeys) {
      const doneKey = `${code}|${studentKey}|${exKey}`;
      if (state.submissionsDone[doneKey]) continue;
      const ex = state.exercises[code][exKey];
      const sc = state.courses[code];
      const token = state.tokens[studentKey];
      const answerable = ex.questions.filter(q => q.kind !== "others");
      const list = mode === "partial" ? answerable.slice(0, Math.max(1, Math.ceil(answerable.length / 2))) : answerable;
      for (let i = 0; i < list.length; i++) {
        const q = list[i];
        const isLast = i === list.length - 1;
        const finalize = mode === "complete" && isLast;
        const partialMiss = mode === "partial" && isLast; // last partial answer is a wrong/attempted one
        await api("POST", "/courses/answers/submit", {
          courseId: sc.id, exerciseId: ex.exerciseId, questionId: q.questionId,
          category: ex.tab, subcategory: ex.subcat,
          code: partialMiss ? "" : q.answer,
          score: partialMiss ? 0 : q.score,
          status: partialMiss ? "attempted" : "solved",
          language: q.kind === "programming" ? "python" : q.kind === "database" ? "sql" : "text",
          ...(q.kind === "programming" ? { selectedProgrammingLanguage: "python" } : {}),
          nodeId: ex.topicId, nodeName: ex.name, nodeType: "topic",
          ...(finalize ? { isTestSubmission: "true", submitType: "USER" } : {}),
        }, token);
      }
      state.submissionsDone[doneKey] = mode;
      log(`submission ${mode}: ${studentKey} -> ${code}/${exKey} (${list.length}/${answerable.length} questions)`);
      save();
    }
  }

  // 9b ─ trainer evaluations (two examples)
  if (!state.evaluations) {
    const evals = [
      { code: "TN-PY-101", exKey: "A1", student: "bt.s02", score: 60, feedback: "Good start — finish the remaining questions and mind the input parsing." },
      { code: "TN-DB-203", exKey: "A1", student: "bt.s14", score: 85, feedback: "Well done. Revise the HAVING clause once more." },
    ];
    for (const e of evals) {
      const ex = state.exercises[e.code][e.exKey];
      const q = ex.questions[0];
      await api("POST", "/users/update/submission-score", {
        courseId: state.courses[e.code].id, exerciseId: ex.exerciseId, questionId: q.questionId,
        participantId: state.users[e.student].id, score: e.score, totalScore: 100,
        feedback: e.feedback, status: "evaluated", category: ex.tab, subcategory: ex.subcat,
        exerciseName: ex.name, questionTitle: q.title || "Question 1",
      }, state.tokens.trainer);
      log(`evaluated: ${e.student} ${e.code}/${e.exKey} -> ${e.score}`);
    }
    state.evaluations = true;
    save();
  }

  // 10 ─ feedback forms on ended courses (+ responses)
  const endedCourses = COURSES.filter(c => c.ended);
  for (const c of endedCourses) {
    const sc = state.courses[c.code];
    if (!state.feedback[c.code]) {
      const existing = (await api("GET", `/getAll/feedback?courseId=${sc.id}`)).json?.getAllFeedback || [];
      const title = `End of Course Feedback — ${c.name}`;
      let doc = existing.find(f => f.feedbackTitle === title);
      if (!doc) {
        const batchName = Object.keys(ENROLMENT[c.code])[0];
        const r = await api("POST", "/create/feedback", {
          courseId: sc.id, feedbackTitle: title,
          feedbackDescription: `Your course "${c.name}" ended on 16 Jul 2026. Please share your feedback.`,
          batchName, batchId: sc.batchIds?.[batchName] || null,
          questions: FEEDBACK_QUESTIONS,
          startDate: "2026-07-17T00:00:00.000Z", endDate: "2026-09-30T23:59:59.000Z",
          isAnonymousAllowed: true, maxAttempts: 1,
          trainerId: state.users.trainer.id, trainerName: state.users.trainer.name, trainerEmail: state.users.trainer.email,
        });
        doc = r.json.data;
        log(`feedback form created: ${c.code} (${doc._id}) published=${doc.isPublished} active=${doc.isActive}`);
      } else log(`feedback form exists: ${c.code}`);
      state.feedback[c.code] = { id: doc._id, title };
      save();
    }
  }
  for (const [code, studentKey, ratings, liked, improve, anonymous] of FEEDBACK_RESPONSES) {
    const doneKey = `${code}|${studentKey}`;
    if (state.feedbackResponses[doneKey]) continue;
    const answers = [
      { questionText: FEEDBACK_QUESTIONS[0].questionText, answer: ratings[0], reason: "" },
      { questionText: FEEDBACK_QUESTIONS[1].questionText, answer: ratings[1], reason: "" },
      { questionText: FEEDBACK_QUESTIONS[2].questionText, answer: ratings[2], reason: "" },
      { questionText: FEEDBACK_QUESTIONS[3].questionText, answer: ratings[3], reason: "" },
      { questionText: FEEDBACK_QUESTIONS[4].questionText, answer: liked, reason: "" },
      ...(improve ? [{ questionText: FEEDBACK_QUESTIONS[5].questionText, answer: improve, reason: "" }] : []),
    ];
    const r = await api("POST", `/student/submit/feedback/${state.feedback[code].id}`,
      { answers, isAnonymous: anonymous, overallReason: liked }, state.tokens[studentKey], [400]);
    if (r.status === 400) log(`feedback response already there: ${studentKey} -> ${code}`);
    else log(`feedback response: ${studentKey} -> ${code}${anonymous ? " (anonymous)" : ""}`);
    state.feedbackResponses[doneKey] = true;
    save();
  }

  log("SEED COMPLETE");
}

run().then(() => process.exit(0)).catch(e => { console.error("FAILED:", e.message); save(); process.exit(1); });
