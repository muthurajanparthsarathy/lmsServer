const mongoose = require('mongoose');

const EmailBulkUploadCountSchema = new mongoose.Schema({
  totalEmail: [{
    email: { type: String },
    firstName: { type: String },
    lastName: { type: String },
    phone: { type: String },
    role: { type: String },
  }],
  notSendmail: [{
    email: { type: String },
    firstName: { type: String },
    lastName: { type: String },
    phone: { type: String },
    role: { type: String },
  }],
  sendmail: [{
    email: { type: String },
    firstName: { type: String },
    lastName: { type: String },
    phone: { type: String },
    role: { type: String },
  }],
  fileName: { type: String },
  sendDate: { type: Date, default: Date.now },
  sendType: { 
    type: String, 
    required: true, 
  default:"BULK_UPLOADS_USERS"
  },
  sendBy: { type: String, default: 'self', required: [true, "sendBy is required"] },
}, { _id: true });



const BulkSendMailSchema = new mongoose.Schema({
  institution: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'LMS-Institution',
    required: true,
    unique: true
  },
  emailBulkUploadCounts: [EmailBulkUploadCountSchema],
  overAllCount: {
    overAllEmailSuccessCount: { type: Number, default: 0 },
    overAllEmailFailedCount: { type: Number, default: 0 },
  }
}, { timestamps: true });

const BulkSendMail = mongoose.model("Bulk_Messaging_Data", BulkSendMailSchema);
module.exports = BulkSendMail;