const express = require("express");
const connectDB = require("./config/db");
const cors = require("cors");
const compression = require("compression");
const app = express();
const path = require("path");
const cookieParser = require("cookie-parser");
const http = require('http');
const socketIO = require('./utils/socket');   // ← shared utility only; NO second socketIo import
const jwt = require('jsonwebtoken');
const config = require('config');
// Socket auth MUST use the same secret that signs tokens (config/secretToken.js
// + middlewares/userAuth.js both use JWT_TOKEN_KEY). process.env.JWT_SECRET was
// a different/undefined value, so every socket was unauthenticated.
const JWT_TOKEN_KEY = config.get('JWT_TOKEN_KEY');

const fileUpload = require("express-fileupload");
const userAuth = require("./routes/userAuth");
const institutionRoutes = require("./routes/institutionRoutes");
const dynamicContentRoutes = require("./routes/dynamicContent/courseStructureDynamicRoutes");
const clientManagementRoutes = require("./routes/clientManagementRoutes");
const serviceMappingRoutes = require("./routes/serviceMappingRoutes");
const pedagogyStructureRoutes = require("./routes/dynamicContent/pedagogyStructureRoutes");
const courseStructureRoutes = require("./routes/courses/courseStructureRoutes");
const moduleStructureRoutes = require("./routes/courses/moduleStructureRoutes");
const moduleRoutes = require("./routes/courses/moduleStructure/moduleRoutes");
const topicRoutes = require("./routes/courses/moduleStructure/topicRoutes");
const subTopicRoutes = require("./routes/courses/moduleStructure/subTopicRoutes");
const subModuleRoutes = require("./routes/courses/moduleStructure/subModuleRoutes");
const pedagogViewyRoutes = require("./routes/courses/moduleStructure/pedagogyViewRoutes");
const CalendarScheduleRoutes = require("./routes/courses/calendarScheduleRoutes");
const levelRoutes = require("./routes/courses/moduleStructure/levelsRoutes");
const printSettingRoutes = require("./routes/dynamicContent/printSettingRoutes");
const compilerRoutes = require("./routes/compilerRoutes");
const studentWorkspaceRoutes = require("./routes/studentWorkspaceRoutes");
const questionDraftRoutes = require("./routes/questionDraftRoutes");
const documentExtractionRoutes = require("./routes/documentExtractionRoutes");
const videoTranscriptionRoutes = require("./routes/videoTranscriptionRoutes");
const roleRoutes = require("./routes/roleRoutes");
const NoteRoutes = require("./routes/noteRoutes");
const chatHistoryRoutes = require('./routes/chatHistoryRoutes');
const GroupParticipantsRoutes = require("./routes/courses/groupParticipantsRoutes");
const AnswerRoutes = require("./routes/courses/moduleStructure/answerRoutes");
const notificationRoutes = require('./routes/notificationRoutes');
const exceriseandQuestionRoutes = require('./routes/courses/moduleStructure/exerciseAndQuestionRoutes');
const QuestionbankRoutes = require('./routes/courses/questionBankRoutes');
const liveQuestionRoutes = require('./routes/courses/moduleStructure/liveQuestionRoutes');
const liveDashboardRoutes = require('./routes/courses/moduleStructure/liveDashboardRoutes');
const liveScreensRoutes = require('./routes/courses/moduleStructure/liveScreensRoutes');
const { registerLiveDashboardHandlers } = require('./utils/liveDashboardSocket');
const { registerLiveScreenHandlers } = require('./utils/liveScreenSocket');
const { registerMessagingHandlers } = require('./utils/messagingSocket');
// Import progress routes
const progressRoutes = require('./routes/progressRoutes')
const activityLogRoutes = require('./routes/activityLogRoutes')
const pptConversionRoutes = require('./routes/courses/pptConversionRoutes');
const testYourSkillsRoutes = require('./routes/courses/moduleStructure/testYourSkillsRoutes');
const retestRoutes = require('./routes/courses/moduleStructure/retestRoutes');
const feedbackRoutes = require('./routes/feedbackRoutes');  // Import feedback routes
const { startStatusSyncCron } = require("./cron/feedbackStatusSync");

const programCalendarRoutes = require("./routes/courses/programCalendarRoutes");
const instituteHolidayCalendarRoutes = require("./routes/instituteHolidayCalendarRoutes");
const degreeAndDepartmentRoutes = require("./routes/dynamicContent/degreeAndDepartmentRoutes");
const attendanceRoutes = require("./routes/courses/attendanceRoutes");
const glossaryRoutes = require("./routes/courses/glossaryRoutes");
// Use progress routes
// Connect Database
connectDB();
app.use('/Developers Backup/LMS', express.static('\\\\192.168.1.4\\Developers Backup\\LMS'));

// Init Middleware
// gzip every compressible response. The big JSON list endpoints (users
// directory, courses analytics) are highly repetitive and shrink ~85-90%;
// no streaming/SSE endpoints exist in this app (checked), so buffering is
// safe. Binary uploads/downloads are skipped by the default content-type
// filter.
app.use(compression());
app.use(express.json({ extended: false }));
app.use(cors({
  origin: ["https://lms-client-five-theta.vercel.app", "https://lms-smartcliff-71ug4ew5q-muthurajanparthsarathys-projects.vercel.app", "http://localhost:3000","http://localhost:3001", "http://localhost:3002"],
  methods: ["GET", "POST", "PUT", "DELETE","PATCH"],
  credentials: true,
  exposedHeaders: ["Content-Length", "Authorization"],
}));
app.use(cookieParser());
app.use(express.json());
app.use(fileUpload({
  limits: { fileSize: 100 * 1024 * 1024 },
  abortOnLimit: true,
  createParentPath: true,
  useTempFiles: false,
  safeFileNames: true,
  preserveExtension: true,
}));
app.use(express.urlencoded({ extended: true }));

// ─── Create HTTP server ───────────────────────────────────────────────────────
const server = http.createServer(app);

// ─── Init socket utility (ONE instance, used everywhere) ─────────────────────
socketIO.init(server);

// ─── Attach auth middleware + room handlers to the SAME io instance ───────────
const io = socketIO.getIO();
startStatusSyncCron();

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) {
    socket.userId = null;
    socket.userName = 'Anonymous';
    return next(); // allow unauthenticated (students via public link)
  }
  try {
    const decoded = jwt.verify(token, JWT_TOKEN_KEY);
    socket.userId = decoded.id;
    socket.userName = decoded.name || decoded.firstName || 'User';
    socket.userEmail = decoded.email;
    next();
  } catch {
    socket.userId = null;
    socket.userName = 'Anonymous';
    next(); // still allow, just not authenticated
  }
});

io.on('connection', (socket) => {
  if (socket.userId) {
    console.log(`User connected: ${socket.userId}`);
    socket.join(`user-${socket.userId}`);
  }

  // ── Live Dashboard (assessment progress) — teacher rooms + student events ──
  registerLiveDashboardHandlers(io, socket);

  // ── Live Screen Monitoring — WebRTC signaling relay (proctor ↔ student) ────
  registerLiveScreenHandlers(io, socket);

  // ── Proctor ↔ Student messaging (individual + broadcast) ───────────────────
  registerMessagingHandlers(io, socket);

  // ── Live MCQ room — teacher joins to receive real-time student events ──────
  socket.on('join-liveq', (liveQuestionId) => {
    if (!liveQuestionId) return;
    socket.join(`liveq-${liveQuestionId}`);
    console.log(`Socket ${socket.id} joined liveq-${liveQuestionId}`);
  });

  socket.on('leave-liveq', (liveQuestionId) => {
    if (!liveQuestionId) return;
    socket.leave(`liveq-${liveQuestionId}`);
    console.log(`Socket ${socket.id} left liveq-${liveQuestionId}`);
  });

  // ── Existing events ───────────────────────────────────────────────────────
  socket.on('join-user-room', () => {
    if (socket.userId) {
      socket.join(`user-${socket.userId}`);
      socket.emit('room-joined', { room: `user-${socket.userId}` });
    }
  });

  socket.on('user-added', (data) => {
    io.emit('user-added', {
      newUserId: data.userId,
      addedBy: { id: socket.userId, name: socket.userName, email: socket.userEmail },
      timestamp: new Date().toISOString(),
    });
  });

  socket.on('enrollment-created', (data) => {
    io.to('admin-room').emit('enrollment-created', {
      enrollmentId: data.enrollmentId,
      userId: data.userId,
      courseId: data.courseId,
      enrolledBy: { id: socket.userId, name: socket.userName, email: socket.userEmail },
      enrollmentDate: new Date().toISOString(),
    });
    io.to(`user-${data.userId}`).emit('new-notification', {
      _id: `enrollment-${data.enrollmentId}`,
      title: 'Course Enrollment',
      message: `You have been enrolled in a new course by ${socket.userName}`,
      type: 'success',
      relatedEntity: 'enrollment',
      isRead: false,
      createdAt: new Date().toISOString(),
    });
  });

  socket.on('disconnect', () => {
    console.log(`Socket disconnected: ${socket.id} (user: ${socket.userId || 'anonymous'})`);
  });
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("API Running"));

app.use("/", institutionRoutes);
app.use("/", userAuth);
app.use("/", dynamicContentRoutes);
app.use("/", clientManagementRoutes);
app.use("/", serviceMappingRoutes);
app.use("/", pedagogyStructureRoutes);
app.use("/", courseStructureRoutes);
app.use("/", moduleStructureRoutes);
app.use("/", moduleRoutes);
app.use("/", topicRoutes);
app.use("/", subTopicRoutes);
app.use("/", subModuleRoutes);
app.use("/", pedagogViewyRoutes);
app.use("/", CalendarScheduleRoutes);
app.use("/", levelRoutes);
app.use("/", printSettingRoutes);
app.use("/", compilerRoutes);
app.use("/", studentWorkspaceRoutes);
app.use("/", questionDraftRoutes);
app.use("/", roleRoutes);
app.use('/', NoteRoutes);
app.use('/', GroupParticipantsRoutes);
app.use('/', AnswerRoutes);
app.use('/', notificationRoutes);
app.use('/', exceriseandQuestionRoutes);
app.use('/', QuestionbankRoutes);
app.use('/', liveQuestionRoutes);
app.use('/', liveDashboardRoutes);
app.use('/', liveScreensRoutes);
app.use('/', retestRoutes);

app.use("/api/chat", chatHistoryRoutes);
app.use("/api/extract-doc", documentExtractionRoutes)
app.use('/', pptConversionRoutes);
app.use("/api/video", videoTranscriptionRoutes);
app.use('/', progressRoutes);
app.use('/', activityLogRoutes);
app.use('/you-do', testYourSkillsRoutes);
app.use('/', feedbackRoutes);
app.use("/", programCalendarRoutes);
app.use("/", instituteHolidayCalendarRoutes);
app.use("/", degreeAndDepartmentRoutes);
app.use("/", attendanceRoutes);
app.use("/", glossaryRoutes);
// Read-only proxies over public coding-platform profile data (LeetCode,
// CodeChef, HackerRank, AtCoder) for the Coding Analytics dashboard.
app.use("/", require("./routes/codingAnalyticsRoutes"));

// ─── Piston proxy (auth-gated; replaces the direct browser→Piston path) ──────
app.use("/api", require("./routes/executionRoutes"));

// ─── Super Admin module (independent, namespaced under /superadmin) ──────────
app.use(require("./routes/superadmin"));



// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5533;
server.listen(PORT, () => console.log(`Server started on port ${PORT}`));
