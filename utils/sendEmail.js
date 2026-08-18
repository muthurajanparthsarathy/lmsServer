// const sgMail = require("@sendgrid/mail");
// require("dotenv").config();
// sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// const sendEmail = async (receiverEmail, emailSubject, emailBody) => {
//   try {
//     const msg = {
//       to: receiverEmail,
//       from: process.env.FORM_EMAIL,
//       subject: emailSubject,
//       html: emailBody,
//     };

//     await sgMail.send(msg);
//     console.log("Email sent successfully");
//     return true;
//   } catch (error) {
//     console.error("Error sending email:", error);

//     if (error.response) {
//       console.error(error.response.body);
//     }

//     return false;
//   }
// };

// module.exports = { sendEmail };
// utils/sendEmail.js
const nodemailer = require("nodemailer");
const validator = require("validator");
require("dotenv").config();

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.NODEMAILER_FORM_EMAIL,
    pass: process.env.NODEMAILER_FORM_EMAIL_PASSWORD,
  },
});

const sendEmail = async (...args) => {
  try {
    let receiverEmails, emailSubject, emailBody, ccEmails;
    
    // Handle both object and parameter formats
    if (args.length === 1 && typeof args[0] === 'object') {
      // Object format
      const emailData = args[0];
      receiverEmails = emailData.receiverEmails;
      emailSubject = emailData.subject || emailData.emailSubject;
      emailBody = emailData.body || emailData.emailBody;
      ccEmails = emailData.ccEmails || [];
    } else {
      // Parameter format
      [receiverEmails, emailSubject, emailBody, ccEmails = []] = args;
    }

    // Validate receiverEmails
    if (!receiverEmails) {
      console.error("Error: No recipients defined");
      return {
        success: false,
        error: "No recipients defined"
      };
    }

    const mailOptions = {
      from: process.env.NODEMAILER_FORM_EMAIL,
      to: receiverEmails,
      cc: ccEmails,
      subject: emailSubject,
      html: emailBody,
    };

    await transporter.sendMail(mailOptions);
    console.log("Email sent successfully to:", receiverEmails);

    return {
      success: true,
      message: "Email sent successfully"
    };
  } catch (error) {
    console.error("Error sending email:", error);
    return {
      success: false,
      error: error.message || "Failed to send email"
    };
  }
};

// Email validation function
const isValidEmail = (email) => {
  return validator.isEmail(email);
};

module.exports = { 
  sendEmail, 
  isValidEmail
};

// const nodemailer = require("nodemailer");
// const NotificationCount = require("../models/NotificationCountModal");
// require("dotenv").config();
// const Institution = require("../models/InstitutionModal");

// class EmailService {
//   constructor() {
//     this.transporter = nodemailer.createTransport({
//       service: "gmail",
//       auth: {
//         user: process.env.NODEMAILER_FORM_EMAIL,
//         pass: process.env.NODEMAILER_FORM_EMAIL_PASSWORD,
//       },
//     });

//     console.log('EmailService initialized with:', process.env.NODEMAILER_FORM_EMAIL);

//  this.verifyTransporter().then(isVerified => {
//       console.log('Email transporter verified:', isVerified);
//     }).catch(err => {
//       console.error('Email transporter verification failed:', err);
//     });
//   }
//   async verifyTransporter() {
//     try {
//       const isVerified = await this.transporter.verify();
//       console.log('Transporter verified successfully');
//       return isVerified;
//     } catch (error) {
//       console.error("❌ Email transporter configuration error:", error.message);
//       return false;
//     }
//   }

//   isValidEmail(email) {
//     if (!email || typeof email !== 'string') return false;
//     const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
//     return emailRegex.test(email.trim());
//   }

//   prepareMailOptions(fromEmail, toEmail, ccEmails, subject, body, attachment) {
//     return {
//       from: fromEmail,
//       to: toEmail,
//       cc: ccEmails,
//       subject: subject,
//       html: body,
//       attachments: attachment
//         ? [
//             {
//               filename: attachment.filename,
//               path: attachment.path,
//             },
//           ]
//         : [],
//     };
//   }

// async updateNotificationCount(institutionId, successCount, failureCount, users, date, sendType) {
//   try {      
//     const update = {};
    
//     const mappedUsers = users.map((user) => ({
//       userId: {
//         email: user?.email || "",
//         firstName: user.firstName || "",
//         lastName: user.lastName || "",
//         phone: user.phone || "",
//         role: user.roleName || user.role || "",
//       },
//       sendDate: date,
//       sendType: sendType || "BULK_USER_CREATION",
//     }));

//     if (successCount > 0) {
//       update.$inc = { "successfulNotifications.mailNotificationCount": successCount };
//       update.$set = { "successfulNotifications.sendDate": date };
//       update.$push = {
//         "successfulNotifications.mailUsers": {
//           $each: mappedUsers
//         },
//       };
//     }

//     if (failureCount > 0) {
//       update.$inc = {
//         ...update.$inc,
//         "failedNotifications.mailNotificationCount": failureCount,
//       };
//       update.$set = {
//         ...update.$set,
//         "failedNotifications.sendDate": date,
//       };
//       update.$push = {
//         ...update.$push,
//         "failedNotifications.mailUsers": {
//           $each: mappedUsers
//         },
//       };
//     }

//     await NotificationCount.findOneAndUpdate(
//       { institution: institutionId },
//       update,
//       { 
//         upsert: true, 
//         new: true, 
//         setDefaultsOnInsert: true,
//         runValidators: true 
//       }
//     );
    
//   } catch (error) {
//     console.error("❌ Error updating notification count:", error.message);
//     console.error("Error details:", error);
//   }
// }

//   initializeEmailDetails(institution) {
//     if (!institution.emailDetails) {
//       institution.emailDetails = {
//         recharged: 0,
//         remaining: 0,
//         used: {
//           bulkUpload: 0,
//           individual: 0
//         }
//       };
//     }

//     if (!institution.emailDetails.used) {
//       institution.emailDetails.used = {
//         bulkUpload: 0,
//         individual: 0
//       };
//     }

//     if (typeof institution.emailDetails.used.bulkUpload !== 'number') {
//       institution.emailDetails.used.bulkUpload = 0;
//     }

//     if (typeof institution.emailDetails.used.individual !== 'number') {
//       institution.emailDetails.used.individual = 0;
//     }

//     if (typeof institution.emailDetails.recharged !== 'number') {
//       institution.emailDetails.recharged = 0;
//     }

//     if (typeof institution.emailDetails.remaining !== 'number') {
//       institution.emailDetails.remaining = Math.max(
//         0,
//         institution.emailDetails.recharged - 
//         (institution.emailDetails.used.bulkUpload + institution.emailDetails.used.individual)
//       );
//     }

//     if (!institution.alerts) {
//       institution.alerts = {};
//     }

//     if (typeof institution.alerts.emailLowBalance !== 'boolean') {
//       institution.alerts.emailLowBalance = institution.emailDetails.remaining < 50;
//     }

//     return institution;
//   }

//   async sendEmail({
//     fromEmail,
//     receiverEmails,
//     ccEmails = [],
//     subject,
//     body,
//     institutionId,
//     users = [],
//     sendType = "GENERAL_NOTIFICATION",
//     attachment
//   }) {
//     const sendDate = new Date();

//     // Validate fromEmail
//     if (!fromEmail || !this.isValidEmail(fromEmail)) {
//       console.error("❌ Invalid fromEmail:", fromEmail);
//       return {
//         success: false,
//         successfulEmails: [],
//         failedEmails: [],
//         error: "Invalid sender email address"
//       };
//     }

//     // Normalize receiver emails to array
//     const recipients = Array.isArray(receiverEmails) ? receiverEmails : [receiverEmails];
//     const successfulEmails = [];
//     const failedEmails = [];

//     try {
//       // Validate email addresses
//       const validRecipients = recipients.filter((email) => {
//         if (this.isValidEmail(email)) return true;
//         failedEmails.push(email);
//         console.warn(`❌ Invalid email format: ${email}`);
//         return false;
//       });

//       if (validRecipients.length === 0) {
//         console.error("❌ No valid email recipients found");
//         return {
//           success: false,
//           successfulEmails: [],
//           failedEmails: failedEmails,
//           error: "No valid email recipients found"
//         };
//       }

//       // Send emails
//       const emailResults = await Promise.allSettled(
//         validRecipients.map((email) => {
//           const mailOptions = this.prepareMailOptions(
//             fromEmail,
//             email,
//             ccEmails,
//             subject,
//             body,
//             attachment
//           );
//           return this.transporter.sendMail(mailOptions);
//         })
//       );

//       // Process results
//       emailResults.forEach((result, index) => {
//         const email = validRecipients[index];
//         if (result.status === "fulfilled") {
//           successfulEmails.push(email);
//           console.log(`✅ Email sent successfully to: ${email}`);
//         } else {
//           failedEmails.push(email);
//           console.error(`❌ Failed to send email to: ${email}`, result.reason);
//         }
//       });

//       if (institutionId) {
//         try {
//           const successfulUsers = users.filter((u) => u && successfulEmails.includes(u.email));
//           const failedUsers = users.filter((u) => u && failedEmails.includes(u.email));

//           await this.updateNotificationCount(
//             institutionId,
//             successfulEmails.length,
//             failedEmails.length,
//             [...successfulUsers, ...failedUsers],
//             sendDate,
//             sendType
//           );

//           // Update institution email usage
//           if (successfulEmails.length > 0) {
//             const institution = await Institution.findById(institutionId);
//             if (institution) {
//               this.initializeEmailDetails(institution);
//               institution.emailDetails.used.individual += successfulEmails.length;
//               const totalUsed = institution.emailDetails.used.bulkUpload + institution.emailDetails.used.individual;
//               institution.emailDetails.remaining = Math.max(0, institution.emailDetails.recharged - totalUsed);
//               institution.alerts.emailLowBalance = institution.emailDetails.remaining < 50;
//               await institution.save();
//             }
//           }
//         } catch (dbError) {
//           console.error("❌ Error updating database records:", dbError.message);
//           // Don't fail the email process
//         }
//       }
      
//       return { 
//         success: failedEmails.length === 0, 
//         successfulEmails, 
//         failedEmails,
//         totalSent: successfulEmails.length,
//         totalFailed: failedEmails.length
//       };
//     } catch (error) {
//       console.error("❌ Error during email sending process:", error);
//       return {
//         success: false,
//         successfulEmails: [],
//         failedEmails: recipients,
//         error: error.message,
//       };
//     }
//   }
// }

// module.exports = EmailService;
