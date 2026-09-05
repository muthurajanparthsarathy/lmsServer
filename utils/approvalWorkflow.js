// Approval workflow helpers — used by exerciseAndQuestion controllers to
// snapshot the parent Course's approvalHierarchy onto an exercise document
// and to notify approvers as the chain advances.
//
// One snapshot per exercise: changes to the course-level template after an
// exercise is created do NOT propagate (intentional — keeps in-flight
// approvals stable).

const mongoose = require("mongoose");
const CourseStructure = require("../models/Courses/courseStructureModal");
const User = require("../models/UserModel");
const Role = require("../models/RoleModel");
const emailUtil = require("./sendEmail");

/**
 * Given the parent entity (Module1 / SubModule1 / Topic1 / SubTopic1 instance
 * or a plain object that has a `courses` field), return the first courseId.
 * All four entity types store a `courses` field pointing back to the course.
 */
const resolveCourseId = (entity) => {
  if (!entity) return null;
  const c = entity.courses;
  if (!c) return null;
  if (Array.isArray(c)) return c[0] || null;
  return c;
};

/**
 * The institution's L&D role is the DEFAULT single-step approval chain for
 * any course whose approvalHierarchy hasn't been configured. Matched by the
 * seeded roleValue "ldhead" first, falling back to an "L&D" name match.
 * Returns { roleId, roleName } or null when the institution has no L&D role.
 */
const findDefaultApproverRole = async (institutionId) => {
  if (!institutionId) return null;
  let role = await Role.findOne({ institution: institutionId, roleValue: "ldhead" }).lean();
  if (!role) {
    role = await Role.findOne({
      institution: institutionId,
      $or: [
        { originalRole: { $regex: /^l\s*&\s*d\b/i } },
        { renameRole: { $regex: /^l\s*&\s*d\b/i } },
      ],
    }).lean();
  }
  if (!role) return null;
  return { roleId: role._id, roleName: role.renameRole || role.originalRole || "L&D" };
};

/**
 * Steps an exercise snapshot should be built from: the course's own chain
 * when configured, else the L&D default.
 * Returns { steps, source: 'course' | 'default' | 'none' }.
 * `course` needs `approvalHierarchy` and `institution` selected.
 */
const getEffectiveHierarchySteps = async (course) => {
  const configured = course?.approvalHierarchy?.steps || [];
  if (configured.length > 0) return { steps: configured, source: "course" };
  const ldRole = await findDefaultApproverRole(course?.institution);
  if (!ldRole) return { steps: [], source: "none" };
  return {
    steps: [{ order: 1, roleId: ldRole.roleId, roleName: ldRole.roleName }],
    source: "default",
  };
};

/**
 * Build an initial approvalWorkflow object from the parent course, falling
 * back to the institution's L&D role when the course has no hierarchy.
 * Returns null only when neither exists (caller decides whether to reject
 * the request or proceed without workflow).
 *
 * `submittedBy` — optional; when provided, its user id / name / email are
 * snapshotted on the workflow so the pending-approvals endpoint can render
 * "Submitted by …" without a per-row user lookup. Kept optional so
 * historical call sites (which don't have the caller in scope) still
 * function; they store the workflow without the submitter and the
 * endpoint falls back to the exercise's own createdBy.
 */
const buildInitialApprovalWorkflow = async (courseId, submittedBy = null) => {
  if (!courseId) return null;
  const course = await CourseStructure.findById(courseId)
    .select("approvalHierarchy institution")
    .lean();
  const { steps } = await getEffectiveHierarchySteps(course);
  if (steps.length === 0) return null;

  // Person-specific snapshot: userId/userName come from the template step and
  // freeze onto the runtime so a course-template edit made after the request
  // was raised doesn't change who approves it. Legacy template rows without a
  // userId snapshot as null and fall back to role-based behaviour downstream.
  const snapshot = steps
    .slice()
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .map((s, idx) => ({
      order: idx + 1,
      roleId: s.roleId,
      roleName: s.roleName,
      userId: s.userId || null,
      userName: s.userName || "",
      status: idx === 0 ? "pending" : "waiting",
      decidedBy: null,
      decidedAt: null,
      comment: "",
    }));

  return {
    steps: snapshot,
    currentStep: 1,
    overallStatus: "in_progress",
    studentVisible: false,
    initiatedAt: new Date(),
    initiatedByUserId: submittedBy?.userId || null,
    initiatedByName: submittedBy?.name || "",
    initiatedByEmail: submittedBy?.email || "",
    completedAt: null,
  };
};

/**
 * True when the request's user holds the Student role. Plain `userAuth`
 * leaves `role` as a raw ObjectId while `userAuthOptional` populates it —
 * handle both, hitting the Role collection only when needed.
 */
const isStudentRequester = async (reqUser) => {
  if (!reqUser || !reqUser.role) return false;
  let roleDoc = reqUser.role;
  if (!roleDoc.originalRole && !roleDoc.renameRole && !roleDoc.roleValue) {
    try {
      roleDoc = await Role.findById(reqUser.role).lean();
    } catch {
      return false;
    }
  }
  if (!roleDoc) return false;
  const name = `${roleDoc.roleValue || ""} ${roleDoc.renameRole || ""} ${roleDoc.originalRole || ""}`.toLowerCase();
  return name.includes("student");
};

/**
 * Server-side mirror of the student visibility rule: an exercise carrying an
 * unfinished approval workflow is hidden from students until the final step
 * flips `studentVisible`.
 */
const isExerciseStudentVisible = (ex) => {
  const wf = ex?.approvalWorkflow;
  if (!wf || !Array.isArray(wf.steps) || wf.steps.length === 0) return true;
  return wf.overallStatus === "approved" || wf.studentVisible === true;
};

/**
 * Is the step's PINNED user still a valid, usable approver at act time?
 *
 * Pins go stale: the picked user can be deleted from LMS-Users, marked
 * inactive (can't log in), or have their role changed after the snapshot
 * was taken. When any of those happen, the pin is effectively broken and
 * the step must fall back to role-based fan-out so the workflow doesn't
 * park forever with an unreachable approver.
 *
 * A single async predicate is used by BOTH `findApproversForStep` and
 * `canUserActOnStep`, so notification targeting and the accept-decision
 * gate can never drift — a bug the initial rework had, where the
 * notifier fell back on deletion but the gate did not, leaving every
 * fallback recipient with a 403.
 *
 * Returns `{ usable: true, user }` when the pin holds, or
 * `{ usable: false, reason }` when the caller should fall back to the
 * step's role. Callers may cache the User doc from `user` when they need
 * it (findApproversForStep uses it as the sole approver).
 */
const resolvePinnedApprover = async (step) => {
  if (!step?.userId) return { usable: false, reason: "no-pin" };
  let user = null;
  try {
    user = await User.findById(step.userId)
      .select("_id firstName lastName email role status")
      .lean();
  } catch {
    return { usable: false, reason: "lookup-failed" };
  }
  if (!user) return { usable: false, reason: "user-deleted" };
  if (user.status && user.status !== "active") {
    return { usable: false, reason: "user-inactive" };
  }
  // The step's role is a hard constraint on the pinned person — losing the
  // role after the snapshot means the pin is no longer meaningful. Falling
  // back to role fan-out then finds whoever inherited the responsibility.
  if (step.roleId && (!user.role || user.role.toString() !== step.roleId.toString())) {
    return { usable: false, reason: "role-changed" };
  }
  return { usable: true, user };
};

/**
 * Resolve the actual people to notify / accept an approval from for a step.
 *
 * When the pinned user is USABLE (see resolvePinnedApprover), only that one
 * person is returned — the whole point of the person-specific rework.
 * Otherwise we fall back to role-based discovery: enrolled participants
 * first, then institution-wide role holders (approver roles like L&D
 * usually aren't on the course roster).
 *
 * The historical signature (courseId, roleId) is still accepted so older
 * call sites don't break; they behave exactly as before.
 */
const findApproversForStep = async (courseId, stepOrRoleId) => {
  if (!courseId || !stepOrRoleId) return [];

  // Normalize to a step-like object so resolvePinnedApprover can inspect it.
  const step =
    typeof stepOrRoleId === "object" && stepOrRoleId
      ? stepOrRoleId
      : { roleId: stepOrRoleId, userId: null };
  const roleId = step.roleId || null;

  const pin = await resolvePinnedApprover(step);
  if (pin.usable) return [pin.user];
  // pin.reason !== 'no-pin' falls through to role fan-out on purpose — a
  // broken pin should still find someone (the fallback role holders) rather
  // than leave the workflow parked forever.

  if (!roleId) return [];

  const course = await CourseStructure.findById(courseId)
    .select("batchAndParticipants institution")
    .populate({ path: "batchAndParticipants.users.user", select: "_id firstName lastName email role" })
    .lean();
  const participants = (course?.batchAndParticipants || []).flatMap(
    (batch) => batch.users || []
  );
  const targetRole = roleId.toString();
  const approvers = participants
    .map((p) => p?.user)
    .filter((u) => u && u.role && u.role.toString() === targetRole);
  // A user may sit in several batches — notify them once only.
  const uniqueApprovers = new Map(approvers.map((u) => [u._id.toString(), u]));
  if (uniqueApprovers.size > 0) return Array.from(uniqueApprovers.values());

  // Approver roles like L&D usually aren't enrolled in the course roster —
  // fall back to every institution user holding the role.
  if (!course?.institution) return [];
  const institutionApprovers = await User.find({
    institution: course.institution,
    role: roleId,
  })
    .select("_id firstName lastName email role")
    .lean();
  return institutionApprovers;
};

/**
 * Decide whether the calling user is authorized to act on this workflow step.
 * Returns { ok: true } or { ok: false, reason }.
 *
 * The rule mirrors the recipient logic in `findApproversForStep`:
 *  • If the step names a specific person AND that pin is still usable
 *    (resolvePinnedApprover), ONLY that user may act.
 *  • If the pin is broken (user deleted / deactivated / role changed) or
 *    the step is legacy role-only, any user of the institution holding
 *    the step's role may act — the same fall-back the notifier uses so
 *    every notified recipient is also authorized.
 *
 * `callerRoleId` is what the existing controllers already compute as
 * `req.user?.role?._id || req.user?.role` — pass whatever is truthy.
 */
const canUserActOnStep = async (step, callerUserId, callerRoleId) => {
  if (!step) return { ok: false, reason: "No workflow step to act on" };
  const stepRoleId = step.roleId ? step.roleId.toString() : null;
  const cRole = callerRoleId ? callerRoleId.toString() : null;
  const cUser = callerUserId ? callerUserId.toString() : null;

  if (step.userId) {
    const pin = await resolvePinnedApprover(step);
    if (pin.usable) {
      if (!cUser || cUser !== step.userId.toString()) {
        return {
          ok: false,
          reason: `Only ${step.userName || "the assigned approver"} can approve at this level`,
        };
      }
      return { ok: true };
    }
    // Pin is broken → identical rule to legacy role-only: whoever holds
    // the step's role may act.
  }

  if (stepRoleId && cRole === stepRoleId) return { ok: true };
  return { ok: false, reason: "You do not hold the approver role for this step" };
};

/**
 * Notify approvers of a step that's now pending: in-app notification + email.
 * Errors per-user are logged but don't abort the chain.
 */
const notifyApproversForStep = async ({ courseId, courseName, step, exerciseName, exerciseId, isResubmit = false }) => {
  if (!step) return;
  // Pass the whole step so findApproversForStep can honour a pinned userId.
  const approvers = await findApproversForStep(courseId, step);
  if (approvers.length === 0) return;

  const headline = isResubmit ? "Approval re-requested" : "Approval requested";
  const subject = `${isResubmit ? "Approval re-requested" : "Approval needed"}: ${exerciseName || "Exercise"} (${courseName || "Course"})`;
  const baseUrl = process.env.BASE_URL || "http://localhost:3000";
  const emailBody = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #1f2937;">${headline}</h2>
      <p>Hello,</p>
      <p>An exercise is ${isResubmit ? "back for your review — the trainer addressed the feedback and re-requested approval" : "awaiting your approval"} as <strong>${step.roleName}</strong> in <strong>${courseName || "the course"}</strong>.</p>
      <div style="background:#f9fafb; border-left:4px solid #6366f1; padding:12px 16px; margin:16px 0;">
        <p style="margin:0;"><strong>${exerciseName || "Exercise"}</strong></p>
        <p style="margin:4px 0 0; color:#6b7280; font-size:13px;">Step ${step.order} of the approval chain${isResubmit ? " · Re-request" : ""}</p>
      </div>
      <p>Open the LMS to review and approve this exercise.</p>
      <p style="margin-top:20px;"><a href="${baseUrl}" style="background:#4f46e5;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;">Open LMS</a></p>
      <p style="color:#9ca3af; font-size:12px; margin-top:24px;">If you're not the right approver, you can ignore this message — another approver in your role will receive the same notification.</p>
    </div>
  `;

  await Promise.all(
    approvers.map(async (approver) => {
      // In-app notification (best-effort; non-fatal)
      try {
        const userDoc = await User.findById(approver._id);
        if (userDoc && typeof userDoc.addNotification === "function") {
          await userDoc.addNotification({
            title: headline,
            message: isResubmit
              ? `${exerciseName || "An exercise"} was re-submitted after your feedback and needs re-review as ${step.roleName} in ${courseName || "the course"}.`
              : `${exerciseName || "An exercise"} needs your approval as ${step.roleName} in ${courseName || "the course"}.`,
            type: "info",
            relatedEntity: "course",
            relatedEntityId: courseId,
            metadata: new Map([
              ["exerciseId", String(exerciseId || "")],
              ["stepOrder", String(step.order)],
              ["stepRole", step.roleName],
              ["isResubmit", isResubmit ? "true" : "false"],
            ]),
          });
        }
      } catch (err) {
        console.warn("approvalWorkflow notify failed for", approver._id?.toString(), err.message);
      }

      // Email (best-effort; non-fatal)
      try {
        if (approver.email) {
          await emailUtil.sendEmail({
            receiverEmails: approver.email,
            subject,
            body: emailBody,
          });
        }
      } catch (err) {
        console.warn("approvalWorkflow email failed for", approver.email, err.message);
      }
    })
  );
};

/**
 * Notify all enrolled students once an exercise becomes available
 * (last step approved).
 */
const notifyStudentsExerciseAvailable = async ({ courseId, courseName, exerciseName, exerciseId }) => {
  const course = await CourseStructure.findById(courseId)
    .select("batchAndParticipants")
    .populate({
      path: "batchAndParticipants.users.user",
      select: "_id email firstName role",
      populate: { path: "role", select: "renameRole originalRole" },
    })
    .lean();
  const participants = (course?.batchAndParticipants || []).flatMap(
    (batch) => batch.users || []
  );
  const allStudents = participants
    .map((p) => p?.user)
    .filter((u) => {
      const rn = u?.role?.renameRole || u?.role?.originalRole || "";
      return rn.toLowerCase() === "student";
    });
  // A user may sit in several batches — notify them once only.
  const uniqueStudents = new Map(allStudents.map((u) => [u._id.toString(), u]));
  const students = Array.from(uniqueStudents.values());
  if (students.length === 0) return;

  const subject = `New exercise available: ${exerciseName || "Exercise"} (${courseName || "Course"})`;
  const emailBody = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color:#1f2937;">A new exercise is available</h2>
      <p>The exercise <strong>${exerciseName || "an exercise"}</strong> in <strong>${courseName || "your course"}</strong> has been approved and is now visible in your dashboard.</p>
      <p>Sign in to attempt it before the deadline.</p>
    </div>
  `;

  await Promise.all(
    students.map(async (s) => {
      try {
        const userDoc = await User.findById(s._id);
        if (userDoc && typeof userDoc.addNotification === "function") {
          await userDoc.addNotification({
            title: "New exercise available",
            message: `${exerciseName || "An exercise"} in ${courseName || "your course"} is now available.`,
            type: "success",
            relatedEntity: "course",
            relatedEntityId: courseId,
            metadata: new Map([["exerciseId", String(exerciseId || "")]]),
          });
        }
        if (s.email) {
          await emailUtil.sendEmail({
            receiverEmails: s.email,
            subject,
            body: emailBody,
          });
        }
      } catch (err) {
        console.warn("notifyStudentsExerciseAvailable failed for", s._id?.toString(), err.message);
      }
    })
  );
};

/**
 * Notify a single user — used for per-question query/resolve threads.
 */
const notifySingleUser = async ({ userId, email, title, message, type = "info", subject, body, metadata }) => {
  // If neither userId nor email is set, log loudly — this is almost always
  // the "old document without createdBy" case.
  if (!userId && !email) {
    console.warn(
      "notifySingleUser: BOTH userId and email are missing — notification dropped.",
      { title }
    );
    return;
  }

  // If userId is missing but email is set, try to look up the user by email
  // so the in-app notification still reaches them.
  let userDoc = null;
  try {
    if (userId) {
      userDoc = await User.findById(userId);
    } else if (email) {
      userDoc = await User.findOne({ email });
    }
  } catch (err) {
    console.warn("notifySingleUser: user lookup failed:", err.message);
  }

  // In-app notification
  try {
    if (userDoc && typeof userDoc.addNotification === "function") {
      await userDoc.addNotification({
        title,
        message,
        type,
        relatedEntity: "course",
        metadata: metadata instanceof Map ? metadata : new Map(Object.entries(metadata || {})),
      });
      console.log(`notifySingleUser: in-app notification sent → ${userDoc.email}`);
    } else if (!userDoc) {
      console.warn(
        `notifySingleUser: no user found for { userId: ${userId}, email: ${email} } — in-app notification skipped.`
      );
    }
  } catch (err) {
    console.warn("notifySingleUser (notification) failed:", err.message);
  }

  // Email
  const targetEmail = email || userDoc?.email;
  try {
    if (targetEmail) {
      await emailUtil.sendEmail({
        receiverEmails: targetEmail,
        subject: subject || title,
        body: body || `<p>${message}</p>`,
      });
      console.log(`notifySingleUser: email queued → ${targetEmail}`);
    } else {
      console.warn("notifySingleUser: no email address — email skipped.");
    }
  } catch (err) {
    console.warn("notifySingleUser (email) failed:", err.message);
  }
};

module.exports = {
  resolveCourseId,
  findDefaultApproverRole,
  getEffectiveHierarchySteps,
  buildInitialApprovalWorkflow,
  findApproversForStep,
  canUserActOnStep,
  isStudentRequester,
  isExerciseStudentVisible,
  notifyApproversForStep,
  notifyStudentsExerciseAvailable,
  notifySingleUser,
};
