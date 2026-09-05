// Invitation email for an external assessment participant.
//
// Follows the house pattern (utils/approvalWorkflow.js): an inline HTML
// template literal, sent through utils/sendEmail.js, which NEVER throws — it
// returns { success, error }. Callers branch on that and record the outcome on
// the participant rather than failing the request: losing the participant row
// because Gmail hiccupped would be far worse than a resendable invite.

const emailUtil = require("../sendEmail");

// The frontend origin. `BASE_URL` is not in .env, so every call site in this
// codebase falls through to the localhost default — matched here deliberately
// so invitation links behave like every other emailed link in the app.
const baseUrl = () => process.env.BASE_URL || "http://localhost:3000";

/** The participant-facing URL. The token is the whole credential. */
const invitationLink = (token) => `${baseUrl()}/assessment/${token}`;

// "10 September 2026" — spelled out, because an invitation crosses locales and
// 10/09/2026 reads as two different days on either side of the Atlantic.
const formatDate = (date) => {
  if (!date) return "—";
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
};

// "10:00 AM" from a stored "HH:mm".
const formatTime = (time) => {
  if (!time) return "—";
  const [h, m] = String(time).split(":");
  const hours = Number(h);
  const mins = Number(m);
  if (!Number.isFinite(hours) || !Number.isFinite(mins)) return "—";
  const suffix = hours >= 12 ? "PM" : "AM";
  const h12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${h12}:${String(mins).padStart(2, "0")} ${suffix}`;
};

// Minimal escaping — assessment names and instructions are admin-authored, but
// they still land inside an HTML document, so a stray "<" must not open a tag.
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c)
  );

/**
 * Build the invitation HTML.
 *
 * Table-based layout with inline styles: Outlook and Gmail both strip <style>
 * blocks and neither supports flex/grid, so the schedule grid is a real
 * <table> — the same reason every other transactional template here is.
 */
function buildInvitationHtml({ participant, assessment, token }) {
  const link = invitationLink(token);
  const name = `${participant.firstName || ""} ${participant.lastName || ""}`.trim() || "there";

  const row = (label, value) => `
    <tr>
      <td style="padding:6px 0;color:#6b7280;font-size:13px;width:130px;">${esc(label)}</td>
      <td style="padding:6px 0;color:#111827;font-size:13px;font-weight:600;">${esc(value)}</td>
    </tr>`;

  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#111827;">
    <h2 style="color:#111827;margin:0 0 4px;font-size:20px;">You have been invited to an assessment</h2>
    <p style="color:#6b7280;font-size:14px;margin:0 0 20px;">Hello ${esc(name)}, you have been invited to take the assessment below.</p>

    <div style="background-color:#f8f9fa;padding:20px;border-radius:8px;margin:0 0 20px;">
      <h3 style="color:#111827;margin:0 0 12px;font-size:16px;">${esc(assessment.assessmentName)}</h3>
      ${assessment.description ? `<p style="color:#374151;font-size:13px;margin:0 0 14px;line-height:1.5;">${esc(assessment.description)}</p>` : ""}
      <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">
        ${row("Start Date", formatDate(assessment.startDate))}
        ${row("Start Time", formatTime(assessment.startTime))}
        ${row("End Date", formatDate(assessment.endDate))}
        ${row("End Time", formatTime(assessment.endTime))}
        ${row("Duration", `${assessment.durationMinutes || 0} Minutes`)}
        ${row("Total Marks", String(assessment.totalMarks || 0))}
      </table>
    </div>

    ${
      assessment.instructions
        ? `<div style="border-left:3px solid #E8640C;padding:2px 0 2px 14px;margin:0 0 20px;">
             <p style="color:#6b7280;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;margin:0 0 6px;">Important Instructions</p>
             <div style="color:#374151;font-size:13px;line-height:1.6;">${esc(assessment.instructions)}</div>
           </div>`
        : ""
    }

    <div style="text-align:center;margin:28px 0;">
      <a href="${link}"
         style="background-color:#E8640C;color:#ffffff;padding:13px 34px;text-decoration:none;border-radius:6px;display:inline-block;font-weight:700;font-size:15px;">
         Start Assessment
      </a>
    </div>

    <p style="color:#9ca3af;font-size:12px;line-height:1.6;margin:0 0 6px;">
      This link is personal to you — please do not share it. It only works between the
      start and end times shown above.
    </p>
    <p style="color:#9ca3af;font-size:11px;word-break:break-all;margin:0;">
      If the button does not work, copy this link into your browser:<br />${link}
    </p>
  </div>`;
}

/**
 * Send one invitation.
 *
 * Resolves to { success, error? } — never throws, never rejects, so a caller
 * mapping over 200 bulk-uploaded participants cannot lose the batch to one bad
 * address.
 */
async function sendInvitationEmail({ participant, assessment, token }) {
  try {
    const result = await emailUtil.sendEmail({
      receiverEmails: participant.email,
      subject: `Assessment Invitation: ${assessment.assessmentName}`,
      body: buildInvitationHtml({ participant, assessment, token }),
    });
    return result || { success: false, error: "No response from mailer" };
  } catch (error) {
    // sendEmail already swallows its own errors; this guards against a
    // programming fault in the template builder above.
    console.error("sendInvitationEmail error:", error);
    return { success: false, error: error.message || "Failed to send invitation" };
  }
}

module.exports = {
  sendInvitationEmail,
  buildInvitationHtml,
  invitationLink,
  formatDate,
  formatTime,
};
