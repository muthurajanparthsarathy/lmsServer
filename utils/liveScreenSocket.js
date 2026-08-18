// ─── Live Screen Monitoring socket handlers ─────────────────────────────────
// Attached to the EXISTING io instance (see server.js) — never creates a new
// socket server. Pure WebRTC *signaling* relay (mesh topology): the student is
// the broadcaster (sends 1 screen track), each coordinator/proctor is a viewer.
// Media flows peer-to-peer; only SDP offers/answers + ICE candidates pass
// through here.
//
// Rooms:  assessment_{assessmentId}_screens  → all proctors watching that test.
// Relays are addressed to per-user rooms `user-{userId}` (joined in server.js).
//
// Access control: only non-student users may join as viewers (isProctorUser).

const ExamSession = require("../models/Courses/moduleStructure/ExamSessionModel");
const ScreenViolation = require("../models/Courses/moduleStructure/ScreenViolationModel");
const User = require("../models/UserModel");
const { isProctorUser } = require("./proctorAccess");

const screensRoom = (assessmentId) => `assessment_${assessmentId}_screens`;

// ── In-memory presence (per process) ────────────────────────────────────────
// sharers:  assessmentId -> Map(studentUserId -> { socketId, name, email, startedAt })
// viewers:  assessmentId -> Map(proctorUserId -> socketId)
const sharers = new Map();
const viewers = new Map();

function sharerMap(assessmentId) {
  if (!sharers.has(assessmentId)) sharers.set(assessmentId, new Map());
  return sharers.get(assessmentId);
}
function viewerMap(assessmentId) {
  if (!viewers.has(assessmentId)) viewers.set(assessmentId, new Map());
  return viewers.get(assessmentId);
}

async function bumpWarning(assessmentId, studentId, type, detail) {
  try {
    await ExamSession.updateOne(
      { assessmentId, studentId },
      { $inc: { warningCount: 1 }, $set: { lastActivityAt: new Date() } }
    );
    await ScreenViolation.create({ assessmentId, studentId, type: type || "other", detail: detail || "" });
  } catch (e) {
    console.error("bumpWarning error:", e.message);
  }
  const session = await ExamSession.findOne({ assessmentId, studentId }).select("warningCount").lean().catch(() => null);
  return session?.warningCount || 0;
}

function registerLiveScreenHandlers(io, socket) {
  // ── PROCTOR: join the screens room ──────────────────────────────────────────
  socket.on("proctor:join_screens", async ({ assessmentId }) => {
    try {
      if (!assessmentId || !socket.userId) return;
      const allowed = await isProctorUser(socket.userId);
      if (!allowed) {
        socket.emit("screen:access_denied", { assessmentId });
        return;
      }
      const proctorId = String(socket.userId);
      socket.join(screensRoom(assessmentId));
      viewerMap(assessmentId).set(proctorId, socket.id);

      // 1. Hand the proctor the list of students currently sharing (placeholder cards).
      const list = Array.from(sharerMap(assessmentId).entries()).map(([studentId, info]) => ({
        studentId,
        studentName: info.name,
        email: info.email,
        startedAt: info.startedAt,
      }));
      socket.emit("screen:active_students", { students: list });

      // 2. Ask every current sharer to send THIS viewer an offer.
      for (const studentId of sharerMap(assessmentId).keys()) {
        io.to(`user-${studentId}`).emit("screen:viewer_joined", { viewerId: proctorId });
      }
    } catch (e) {
      console.error("proctor:join_screens error:", e.message);
    }
  });

  // ── PROCTOR: leave the screens room ─────────────────────────────────────────
  socket.on("proctor:leave_screens", ({ assessmentId }) => {
    if (!assessmentId || !socket.userId) return;
    const proctorId = String(socket.userId);
    socket.leave(screensRoom(assessmentId));
    viewerMap(assessmentId).delete(proctorId);
    // Tell sharers to tear down the peer connection for this viewer.
    for (const studentId of sharerMap(assessmentId).keys()) {
      io.to(`user-${studentId}`).emit("screen:viewer_left", { viewerId: proctorId });
    }
  });

  // ── PROCTOR: warn a student ─────────────────────────────────────────────────
  socket.on("proctor:warn", async ({ assessmentId, studentId, message }) => {
    try {
      if (!assessmentId || !studentId) return;
      if (!(await isProctorUser(socket.userId))) return;
      const warningCount = await bumpWarning(assessmentId, studentId, "manual_warning", message || "Proctor warning");
      io.to(`user-${studentId}`).emit("screen:warning", {
        message: message || "Please follow the exam rules and keep your full screen shared.",
      });
      io.to(screensRoom(assessmentId)).emit("screen:student_violation", {
        studentId, type: "manual_warning", detail: message || "", warningCount,
      });
    } catch (e) {
      console.error("proctor:warn error:", e.message);
    }
  });

  // ── PROCTOR: request a quality tier for a student (low grid / high zoom) ─────
  socket.on("proctor:set_quality", ({ studentId, quality }) => {
    if (!studentId || !socket.userId) return;
    io.to(`user-${studentId}`).emit("screen:set_quality", {
      viewerId: String(socket.userId),
      quality: quality === "high" ? "high" : "low",
    });
  });

  // ── STUDENT: begin sharing ──────────────────────────────────────────────────
  socket.on("screen:start", async ({ assessmentId }) => {
    try {
      if (!assessmentId || !socket.userId) return;
      const studentId = String(socket.userId);

      const user = await User.findById(studentId).select("firstName lastName email").lean().catch(() => null);
      const name = user ? `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email : "Student";
      const email = user?.email || "";
      const startedAt = Date.now();

      sharerMap(assessmentId).set(studentId, { socketId: socket.id, name, email, startedAt });
      await ExamSession.updateOne(
        { assessmentId, studentId },
        { $set: { isSharingScreen: true, lastActivityAt: new Date() } }
      ).catch(() => {});

      const session = await ExamSession.findOne({ assessmentId, studentId }).select("warningCount").lean().catch(() => null);

      // Notify proctors that a new live screen is available.
      io.to(screensRoom(assessmentId)).emit("screen:student_available", {
        studentId, studentName: name, email, startedAt, warningCount: session?.warningCount || 0,
      });

      // Tell the student which viewers are already watching → it offers to each.
      const viewerIds = Array.from(viewerMap(assessmentId).keys());
      socket.emit("screen:viewers", { viewerIds });
    } catch (e) {
      console.error("screen:start error:", e.message);
    }
  });

  // ── WebRTC signaling relays (addressed to a specific user) ──────────────────
  socket.on("screen:offer", ({ toUserId, sdp }) => {
    if (!toUserId || !socket.userId) return;
    io.to(`user-${toUserId}`).emit("screen:offer", { fromUserId: String(socket.userId), sdp });
  });

  socket.on("screen:answer", ({ toUserId, sdp }) => {
    if (!toUserId || !socket.userId) return;
    io.to(`user-${toUserId}`).emit("screen:answer", { fromUserId: String(socket.userId), sdp });
  });

  socket.on("screen:ice", ({ toUserId, candidate }) => {
    if (!toUserId || !socket.userId) return;
    io.to(`user-${toUserId}`).emit("screen:ice", { fromUserId: String(socket.userId), candidate });
  });

  // ── STUDENT: stopped sharing (counts as a violation) ────────────────────────
  socket.on("screen:stopped", async ({ assessmentId, reason }) => {
    try {
      if (!assessmentId || !socket.userId) return;
      const studentId = String(socket.userId);
      sharerMap(assessmentId).delete(studentId);
      await ExamSession.updateOne(
        { assessmentId, studentId },
        { $set: { isSharingScreen: false, lastActivityAt: new Date() } }
      ).catch(() => {});
      const warningCount = await bumpWarning(assessmentId, studentId, "share_stopped", reason || "Screen sharing stopped");
      io.to(screensRoom(assessmentId)).emit("screen:student_stopped", {
        studentId, reason: reason || "stopped", warningCount,
      });
    } catch (e) {
      console.error("screen:stopped error:", e.message);
    }
  });

  // ── STUDENT: finished normally (test submitted / unmounted) — NOT a violation ─
  socket.on("screen:end", async ({ assessmentId }) => {
    try {
      if (!assessmentId || !socket.userId) return;
      const studentId = String(socket.userId);
      sharerMap(assessmentId).delete(studentId);
      await ExamSession.updateOne(
        { assessmentId, studentId },
        { $set: { isSharingScreen: false, lastActivityAt: new Date() } }
      ).catch(() => {});
      io.to(screensRoom(assessmentId)).emit("screen:student_stopped", {
        studentId, reason: "ended", warningCount: undefined,
      });
    } catch (e) {
      console.error("screen:end error:", e.message);
    }
  });

  // ── STUDENT: self-reported violation (e.g. shared a window, not the screen) ──
  socket.on("screen:violation", async ({ assessmentId, type, detail }) => {
    try {
      if (!assessmentId || !socket.userId) return;
      const studentId = String(socket.userId);
      const warningCount = await bumpWarning(assessmentId, studentId, type, detail);
      io.to(screensRoom(assessmentId)).emit("screen:student_violation", {
        studentId, type: type || "other", detail: detail || "", warningCount,
      });
    } catch (e) {
      console.error("screen:violation error:", e.message);
    }
  });

  // ── Disconnect: clean up presence + notify the other side ───────────────────
  socket.on("disconnect", async () => {
    const uid = String(socket.userId || "");
    if (!uid) return;

    // As a viewer: drop from every assessment + tell sharers to close that PC.
    for (const [assessmentId, map] of viewers) {
      if (map.get(uid) === socket.id || map.has(uid)) {
        map.delete(uid);
        for (const studentId of sharerMap(assessmentId).keys()) {
          io.to(`user-${studentId}`).emit("screen:viewer_left", { viewerId: uid });
        }
      }
    }

    // As a sharer: only act if THIS socket was the active sharer (ignore stale tabs).
    for (const [assessmentId, map] of sharers) {
      const info = map.get(uid);
      if (info && info.socketId === socket.id) {
        map.delete(uid);
        await ExamSession.updateOne(
          { assessmentId, studentId: uid },
          { $set: { isSharingScreen: false, lastActivityAt: new Date() } }
        ).catch(() => {});
        io.to(screensRoom(assessmentId)).emit("screen:student_stopped", {
          studentId: uid, reason: "disconnected", warningCount: undefined,
        });
      }
    }
  });
}

module.exports = { registerLiveScreenHandlers };
