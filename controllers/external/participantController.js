// External Assessment participants — add, list, bulk-upload, invite.
//
// NOTHING HERE TOUCHES `lms-users`. There is no User import in this file by
// design: an external participant is created in `externalparticipants` and
// nowhere else, gets no Role, no password and no LMS session, and never
// appears in User Management. Their only credential is the invitation token.

const ExternalAssessment = require("../../models/external/ExternalAssessmentModel");
const ExternalParticipant = require("../../models/external/ExternalParticipantModel");
const ExternalInvitation = require("../../models/external/ExternalInvitationModel");
const ExternalAttempt = require("../../models/external/ExternalAttemptModel");
const { sendInvitationEmail, invitationLink } = require("../../utils/external/invitationEmail");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isValidEmail = (e) => EMAIL_RE.test(String(e || "").trim());

/**
 * Mint (or re-mint) a participant's invitation and email it.
 *
 * Re-inviting REPLACES the token, which invalidates whatever was mailed
 * before — that is what makes "Resend" also act as a revoke of the old link.
 *
 * Never throws: the invitation row is written first and the send outcome is
 * recorded on the participant, so a mailer failure leaves a resendable
 * participant rather than losing them.
 */
async function issueInvitation(participant, assessment) {
  const token = ExternalInvitation.generateToken();

  // The link outlives the assessment by a week so a late click lands on the
  // "Assessment Expired" screen (which says when it closed) instead of a bare
  // "invalid link". Falls back to 30 days when the window is not set yet.
  const expiresAt = assessment.endAt
    ? new Date(new Date(assessment.endAt).getTime() + 7 * 24 * 60 * 60 * 1000)
    : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await ExternalInvitation.findOneAndUpdate(
    { participant: participant._id },
    {
      $set: {
        assessment: assessment._id,
        participant: participant._id,
        token,
        expiresAt,
        revokedAt: null,
        accessCount: 0,
        firstAccessedAt: null,
        lastAccessedAt: null,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const result = await sendInvitationEmail({ participant, assessment, token });

  participant.invitationStatus = result.success ? "sent" : "failed";
  participant.invitationSentAt = result.success ? new Date() : participant.invitationSentAt;
  participant.invitationError = result.success ? "" : String(result.error || "Send failed");
  participant.invitationAttempts = (participant.invitationAttempts || 0) + 1;
  await participant.save();

  return { token, emailed: !!result.success, error: result.error };
}

// GET /api/admin/external/assessments/:id/participants
exports.listParticipants = async (req, res) => {
  try {
    const { search = "", attemptStatus = "" } = req.query;
    const filter = { assessment: req.params.id };

    if (attemptStatus && ["not_started", "in_progress", "submitted", "expired"].includes(attemptStatus)) {
      filter.attemptStatus = attemptStatus;
    }
    if (search.trim()) {
      const safe = search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.$or = [
        { firstName: { $regex: safe, $options: "i" } },
        { lastName: { $regex: safe, $options: "i" } },
        { email: { $regex: safe, $options: "i" } },
      ];
    }

    const participants = await ExternalParticipant.find(filter).sort({ createdAt: -1 }).lean();
    return res.status(200).json({
      success: true,
      data: { participants, total: participants.length },
    });
  } catch (error) {
    console.error("listParticipants error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/admin/external/assessments/:id/participants
// Add ONE participant via the form, then invite them.
exports.addParticipant = async (req, res) => {
  try {
    const assessment = await ExternalAssessment.findOne({ _id: req.params.id, isDeleted: false });
    if (!assessment) {
      return res.status(404).json({ success: false, message: "Assessment not found" });
    }

    const { firstName, lastName = "", email, phone = "" } = req.body || {};
    if (!String(firstName || "").trim()) {
      return res.status(400).json({ success: false, message: "First name is required" });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, message: "A valid email address is required" });
    }

    const normalisedEmail = String(email).trim().toLowerCase();
    const existing = await ExternalParticipant.findOne({
      assessment: assessment._id,
      email: normalisedEmail,
    }).lean();
    if (existing) {
      return res.status(409).json({
        success: false,
        message: "This participant has already been added to this assessment",
      });
    }

    const participant = await ExternalParticipant.create({
      assessment: assessment._id,
      firstName: String(firstName).trim(),
      lastName: String(lastName).trim(),
      email: normalisedEmail,
      phone: String(phone).trim(),
      source: "form",
      addedBy: req.user?._id,
    });

    await ExternalAssessment.updateOne({ _id: assessment._id }, { $inc: { participantCount: 1 } });

    // Invitations only go out for a live assessment — mailing a link for a
    // draft would send someone to a paper that cannot be opened.
    let invite = { emailed: false, error: "Assessment is not published yet" };
    if (assessment.status === "published") {
      invite = await issueInvitation(participant, assessment);
    }

    return res.status(201).json({
      success: true,
      message: invite.emailed
        ? "Participant added and invitation sent"
        : `Participant added, but the invitation was not sent: ${invite.error || "unknown error"}`,
      data: { participant, emailed: invite.emailed },
    });
  } catch (error) {
    // The unique index is the real duplicate guard — two concurrent adds both
    // pass the pre-check above, and only one survives here.
    if (error?.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "This participant has already been added to this assessment",
      });
    }
    console.error("addParticipant error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Column aliases accepted from an uploaded sheet. Header matching is
// case-insensitive and ignores spaces/underscores, so "First Name", "firstname"
// and "first_name" are all the same column.
const COLUMN_ALIASES = {
  firstname: "firstName",
  fname: "firstName",
  first: "firstName",
  lastname: "lastName",
  lname: "lastName",
  last: "lastName",
  surname: "lastName",
  email: "email",
  emailaddress: "email",
  mail: "email",
  phone: "phone",
  phonenumber: "phone",
  mobile: "phone",
  contact: "phone",
};

const normaliseRow = (row) => {
  const out = {};
  for (const [rawKey, value] of Object.entries(row || {})) {
    const key = String(rawKey).toLowerCase().replace(/[\s_-]+/g, "");
    const mapped = COLUMN_ALIASES[key];
    if (mapped) out[mapped] = typeof value === "string" ? value.trim() : value;
  }
  return out;
};

// POST /api/admin/external/assessments/:id/participants/bulk-upload
//
// Two-phase by design: `?mode=validate` returns the parse result WITHOUT
// writing, so the admin sees exactly which rows will land and which are
// rejected before committing. Default mode imports.
exports.bulkUploadParticipants = async (req, res) => {
  try {
    const assessment = await ExternalAssessment.findOne({ _id: req.params.id, isDeleted: false });
    if (!assessment) {
      return res.status(404).json({ success: false, message: "Assessment not found" });
    }

    const file = req.files?.file || req.files?.document;
    if (!file) {
      return res.status(400).json({
        success: false,
        message: "No file uploaded. The form field must be named 'file'.",
      });
    }

    const name = String(file.name || "");
    const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
    if (!["xlsx", "xls", "csv"].includes(ext)) {
      return res.status(400).json({
        success: false,
        message: `Unsupported file type .${ext}. Upload an .xlsx, .xls or .csv file.`,
      });
    }

    // Read straight from the in-memory buffer — express-fileupload runs with
    // useTempFiles:false, so there is no disk round-trip to clean up.
    const xlsx = require("xlsx");
    let rows;
    try {
      const workbook = xlsx.read(file.data, { type: "buffer" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      if (!sheet) throw new Error("The file has no readable sheet");
      rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });
    } catch (parseError) {
      return res.status(422).json({
        success: false,
        message: `Could not read the file: ${parseError.message}`,
      });
    }

    if (!rows.length) {
      return res.status(422).json({ success: false, message: "The file has no data rows" });
    }
    if (rows.length > 500) {
      return res.status(400).json({
        success: false,
        message: `Too many rows (${rows.length}). Upload at most 500 participants at a time.`,
      });
    }

    // Everyone already on this assessment — the "existing participant" check.
    const existing = await ExternalParticipant.find({ assessment: assessment._id }, "email").lean();
    const existingEmails = new Set(existing.map((p) => p.email));

    const seenInFile = new Set();
    const valid = [];
    const errors = [];

    rows.forEach((raw, i) => {
      // +2: sheet rows are 1-based AND row 1 is the header, so data starts at
      // 2 — the number reported must match what the admin sees in Excel.
      const rowNumber = i + 2;
      const row = normaliseRow(raw);
      const email = String(row.email || "").trim().toLowerCase();

      if (!String(row.firstName || "").trim()) {
        errors.push({ row: rowNumber, email, reason: "First name is required" });
        return;
      }
      if (!email) {
        errors.push({ row: rowNumber, email: "", reason: "Email is required" });
        return;
      }
      if (!isValidEmail(email)) {
        errors.push({ row: rowNumber, email, reason: "Invalid email format" });
        return;
      }
      if (seenInFile.has(email)) {
        errors.push({ row: rowNumber, email, reason: "Duplicate email in this file" });
        return;
      }
      if (existingEmails.has(email)) {
        errors.push({ row: rowNumber, email, reason: "Already a participant in this assessment" });
        return;
      }

      seenInFile.add(email);
      valid.push({
        assessment: assessment._id,
        firstName: String(row.firstName).trim(),
        lastName: String(row.lastName || "").trim(),
        email,
        phone: String(row.phone || "").trim(),
        source: "bulk_upload",
        addedBy: req.user?._id,
      });
    });

    const summary = { total: rows.length, valid: valid.length, invalid: errors.length };

    // Dry run — show the admin what would happen, write nothing.
    if (String(req.query.mode) === "validate") {
      return res.status(200).json({
        success: true,
        message: `Checked ${rows.length} rows — ${valid.length} ready to import, ${errors.length} with problems`,
        data: { summary, errors, preview: valid.slice(0, 20) },
      });
    }

    if (!valid.length) {
      return res.status(422).json({
        success: false,
        message: "No valid rows to import",
        data: { summary, errors },
      });
    }

    // ordered:false so one late duplicate cannot abort the rest of the batch.
    let inserted = [];
    try {
      inserted = await ExternalParticipant.insertMany(valid, { ordered: false });
    } catch (bulkError) {
      inserted = bulkError?.insertedDocs || [];
      for (const writeError of bulkError?.writeErrors || []) {
        const email = writeError?.err?.op?.email || writeError?.op?.email || "";
        errors.push({ row: null, email, reason: "Already a participant in this assessment" });
      }
    }

    await ExternalAssessment.updateOne(
      { _id: assessment._id },
      { $inc: { participantCount: inserted.length } }
    );

    // Invite everyone who landed. Sequential rather than Promise.all: Gmail
    // rate-limits a burst, and a 500-row blast would get the account throttled.
    let emailed = 0;
    if (assessment.status === "published") {
      for (const participant of inserted) {
        const result = await issueInvitation(participant, assessment);
        if (result.emailed) emailed += 1;
      }
    }

    return res.status(201).json({
      success: true,
      message: `Imported ${inserted.length} participant${inserted.length === 1 ? "" : "s"}`
        + (assessment.status === "published"
          ? `, ${emailed} invitation${emailed === 1 ? "" : "s"} sent`
          : " — publish the assessment to send invitations"),
      data: {
        summary: { ...summary, imported: inserted.length, emailed },
        errors,
      },
    });
  } catch (error) {
    console.error("bulkUploadParticipants error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/admin/external/assessments/:id/participants/:participantId/invite
// Resend (and rotate) one participant's invitation.
exports.resendInvitation = async (req, res) => {
  try {
    const assessment = await ExternalAssessment.findOne({ _id: req.params.id, isDeleted: false });
    if (!assessment) {
      return res.status(404).json({ success: false, message: "Assessment not found" });
    }
    if (assessment.status !== "published") {
      return res.status(400).json({
        success: false,
        message: "Publish the assessment before sending invitations",
      });
    }
    const participant = await ExternalParticipant.findOne({
      _id: req.params.participantId,
      assessment: assessment._id,
    });
    if (!participant) {
      return res.status(404).json({ success: false, message: "Participant not found" });
    }

    const result = await issueInvitation(participant, assessment);
    return res.status(result.emailed ? 200 : 502).json({
      success: result.emailed,
      message: result.emailed
        ? `Invitation sent to ${participant.email}`
        : `Could not send the invitation: ${result.error || "unknown error"}`,
      data: { participant },
    });
  } catch (error) {
    console.error("resendInvitation error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/admin/external/assessments/:id/invitations
// Invite everyone who has not been successfully invited yet.
exports.sendPendingInvitations = async (req, res) => {
  try {
    const assessment = await ExternalAssessment.findOne({ _id: req.params.id, isDeleted: false });
    if (!assessment) {
      return res.status(404).json({ success: false, message: "Assessment not found" });
    }
    if (assessment.status !== "published") {
      return res.status(400).json({
        success: false,
        message: "Publish the assessment before sending invitations",
      });
    }

    const pending = await ExternalParticipant.find({
      assessment: assessment._id,
      invitationStatus: { $in: ["pending", "failed"] },
    });

    let emailed = 0;
    const failures = [];
    for (const participant of pending) {
      const result = await issueInvitation(participant, assessment);
      if (result.emailed) emailed += 1;
      else failures.push({ email: participant.email, reason: result.error });
    }

    return res.status(200).json({
      success: true,
      message: `Sent ${emailed} of ${pending.length} pending invitation${pending.length === 1 ? "" : "s"}`,
      data: { attempted: pending.length, emailed, failures },
    });
  } catch (error) {
    console.error("sendPendingInvitations error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// DELETE /api/admin/external/assessments/:id/participants/:participantId
exports.deleteParticipant = async (req, res) => {
  try {
    const participant = await ExternalParticipant.findOne({
      _id: req.params.participantId,
      assessment: req.params.id,
    });
    if (!participant) {
      return res.status(404).json({ success: false, message: "Participant not found" });
    }

    // Removing the participant must also close their link, or a mailed URL
    // would outlive the row it authenticates.
    await Promise.all([
      ExternalInvitation.deleteOne({ participant: participant._id }),
      ExternalAttempt.deleteMany({ participant: participant._id }),
      participant.deleteOne(),
    ]);
    await ExternalAssessment.updateOne(
      { _id: req.params.id },
      { $inc: { participantCount: -1 } }
    );

    return res.status(200).json({ success: true, message: "Participant removed" });
  } catch (error) {
    console.error("deleteParticipant error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/admin/external/assessments/:id/participants/:participantId/link
// The participant's live link, for an admin who needs to share it by hand.
exports.getParticipantLink = async (req, res) => {
  try {
    const invitation = await ExternalInvitation.findOne({
      participant: req.params.participantId,
      assessment: req.params.id,
    }).lean();
    if (!invitation || invitation.revokedAt) {
      return res.status(404).json({ success: false, message: "No active invitation for this participant" });
    }
    return res.status(200).json({
      success: true,
      data: { link: invitationLink(invitation.token), expiresAt: invitation.expiresAt },
    });
  } catch (error) {
    console.error("getParticipantLink error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

module.exports.issueInvitation = issueInvitation;
