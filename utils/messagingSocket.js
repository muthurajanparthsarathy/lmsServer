// ─── Proctor ↔ Student messaging socket handlers ────────────────────────────
// Attached to the EXISTING io instance (see server.js) — never creates a new
// socket server. Kept separate from liveDashboardSocket so the working dashboard
// handlers are untouched.
//
// Rooms:
//   user-{studentId}                 → one student (auto-joined in server.js).
//   assessment_{id}_students         → all students taking that assessment
//                                      (joined via `student:join_messages`),
//                                      used for broadcast.
//   assessment_{id}_teachers         → proctors on the dashboard (existing) —
//                                      echoed to so the sender UI can confirm.
//
// Access control: only non-student users may send (isProctorUser).

const ProctorMessage = require("../models/Courses/moduleStructure/ProctorMessageModel");
const ExamSession = require("../models/Courses/moduleStructure/ExamSessionModel");
const User = require("../models/UserModel");
const { isProctorUser } = require("./proctorAccess");

const studentsRoom = (assessmentId) => `assessment_${assessmentId}_students`;
const teachersRoom = (assessmentId) => `assessment_${assessmentId}_teachers`;

async function resolveSenderName(userId) {
  if (!userId) return "Proctor";
  try {
    const u = await User.findById(userId).select("firstName lastName email").lean();
    if (!u) return "Proctor";
    return `${u.firstName || ""} ${u.lastName || ""}`.trim() || u.email || "Proctor";
  } catch {
    return "Proctor";
  }
}

function toPayload(doc) {
  return {
    _id: String(doc._id),
    assessmentId: doc.assessmentId,
    studentId: doc.studentId,
    senderName: doc.senderName,
    message: doc.message,
    scope: doc.scope,
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : new Date().toISOString(),
  };
}

function registerMessagingHandlers(io, socket) {
  // ── STUDENT: join the broadcast room for their assessment ───────────────────
  socket.on("student:join_messages", ({ assessmentId } = {}) => {
    if (!assessmentId) return;
    socket.join(studentsRoom(assessmentId));
  });

  // ── PROCTOR: send a message to ONE student ──────────────────────────────────
  socket.on("proctor:send_message", async ({ assessmentId, studentId, message } = {}, ack) => {
    try {
      const text = (message || "").toString().trim().slice(0, 1000);
      if (!assessmentId || !studentId || !text) {
        if (typeof ack === "function") ack({ ok: false, error: "missing fields" });
        return;
      }
      if (!(await isProctorUser(socket.userId))) {
        if (typeof ack === "function") ack({ ok: false, error: "not authorized" });
        return;
      }

      const senderName = await resolveSenderName(socket.userId);

      // EPHEMERAL test notification — NOT persisted. Delivered live only.
      const payload = {
        _id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        assessmentId: String(assessmentId),
        studentId: String(studentId),
        senderName,
        message: text,
        scope: "individual",
        createdAt: new Date().toISOString(),
      };
      io.to(`user-${studentId}`).emit("student:message", payload);
      io.to(teachersRoom(assessmentId)).emit("dashboard:message_sent", payload);
      if (typeof ack === "function") ack({ ok: true, message: payload });
    } catch (e) {
      console.error("proctor:send_message error:", e.message);
      if (typeof ack === "function") ack({ ok: false, error: "server error" });
    }
  });

  // ── PROCTOR: broadcast to ALL live students in the assessment ────────────────
  socket.on("proctor:broadcast_message", async ({ assessmentId, message } = {}, ack) => {
    try {
      const text = (message || "").toString().trim().slice(0, 1000);
      if (!assessmentId || !text) {
        if (typeof ack === "function") ack({ ok: false, error: "missing fields" });
        return;
      }
      if (!(await isProctorUser(socket.userId))) {
        if (typeof ack === "function") ack({ ok: false, error: "not authorized" });
        return;
      }

      const senderName = await resolveSenderName(socket.userId);

      // Recipients = students still taking this assessment (for the ack count only).
      const sessions = await ExamSession.find({ assessmentId: String(assessmentId), submittedAt: null })
        .select("studentId")
        .lean();
      const ids = [...new Set(sessions.map((s) => String(s.studentId)))];

      // EPHEMERAL — broadcast is delivered live only, never persisted.

      // Real-time fan-out to everyone currently connected in the room.
      const payload = {
        _id: `bcast-${Date.now()}`,
        assessmentId: String(assessmentId),
        senderName,
        message: text,
        scope: "broadcast",
        createdAt: new Date().toISOString(),
      };
      io.to(studentsRoom(assessmentId)).emit("student:message", payload);
      io.to(teachersRoom(assessmentId)).emit("dashboard:message_sent", payload);
      if (typeof ack === "function") ack({ ok: true, recipients: ids.length });
    } catch (e) {
      console.error("proctor:broadcast_message error:", e.message);
      if (typeof ack === "function") ack({ ok: false, error: "server error" });
    }
  });
}

module.exports = { registerMessagingHandlers };
