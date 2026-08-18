const mongoose = require("mongoose");

const studentResponseSchema = new mongoose.Schema({
  student: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  liveQuestion: { type: mongoose.Schema.Types.ObjectId, ref: "LiveQuestion", required: true },
  answers: [{
    questionId: { type: mongoose.Schema.Types.ObjectId, required: true },
    questionType: { type: String, enum: ['mcq', 'programming'] },
    answer: mongoose.Schema.Types.Mixed, // Can be string, array, or object
    isCorrect: { type: Boolean, default: false },
    scoreObtained: { type: Number, default: 0 },
    timeSpent: { type: Number }, // in seconds
    submittedAt: { type: Date, default: Date.now }
  }],
  totalScore: { type: Number, default: 0 },
  maxScore: { type: Number, default: 0 },
  percentageScore: { type: Number, default: 0 },
  startedAt: { type: Date },
  submittedAt: { type: Date },
  status: { 
    type: String, 
    enum: ['in-progress', 'completed', 'timeout'], 
    default: 'in-progress' 
  },
  ipAddress: { type: String },
  userAgent: { type: String }
}, { timestamps: true });

module.exports = mongoose.model("StudentResponse", studentResponseSchema);