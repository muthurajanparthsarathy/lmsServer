const mongoose = require("mongoose");


const optionSchema = new mongoose.Schema({
  text: { type: String, required: true },
  isCorrect: { type: Boolean, default: false },
  imageUrl: { type: String, default: null },
  imageAlignment: { type: String, enum: ['left', 'center', 'right']},
  imageSizePercent: { type: Number }
});
const testCaseSchema = new mongoose.Schema(
  {
    input: { type: String },
    expectedOutput: { type: String },
    isSample: { type: Boolean, default: true },
    isHidden: { type: Boolean, default: true },
    points: { type: Number, default: 1 },
    explanation: String,
  },
  { _id: true }
);

const solutionSchema = new mongoose.Schema(
  {
    startedCode: { type: String },
    functionName: { type: String },
    language: { type: String, default: "javascript" },
  },
  { _id: true }
);

// Hint Schema
const hintSchema = new mongoose.Schema(
  {
    hintText: { type: String },
    pointsDeduction: { type: Number, default: 0 },
    isPublic: { type: Boolean, default: true },
    sequence: { type: Number, default: 0 },
  },
  { _id: true }
);


const questionsSchema = new mongoose.Schema({
  questionType: { type: String, enum: ['mcq', 'programming'], required: true },
  
  // MCQ Specific Fields
  mcqQuestionTitle: { type: String },
  mcqQuestionDescription: { type: String, default: '' },
  mcqQuestionType: { 
    type: String, 
    enum: ['multiple_choice', 'dropdown', 'short_answer', 'essay', 'checkboxes'],
  },
  mcqQuestionDifficulty: { 
    type: String, 
    enum: ['easy', 'medium', 'hard'],
    default: 'medium' 
  },
  mcqQuestionScore: { type: Number },
  mcqQuestionTimeLimit: { type: Number },
  mcqQuestionOptionsPerRow: { type: Number },
  mcqQuestionRequired: { type: Boolean, default: false },
  mcqQuestionOptions: [optionSchema],
  mcqQuestionCorrectAnswers: [{ type: String }],

  // Programming Specific Fields
  title: { type: String, trim: true },
  description: { type: String },
  difficulty: { type: String, enum: ['easy', 'medium', 'hard'] },
  sampleInput: { type: String },
  sampleOutput: { type: String },
  score: { type: Number, min: 0, max: 100 },
  constraints: [{ type: String }],
  hints: [hintSchema],
  testCases: [testCaseSchema],
  solutions: solutionSchema,
  timeLimit: { type: Number, min: 0, max: 10000 },
});

const liveQuestionSchema = new mongoose.Schema({
  institution: { type: mongoose.Schema.Types.ObjectId, ref: "LMS-Institution", required: true },
  courses: { type: mongoose.Schema.Types.ObjectId, ref: "Course-Structure", required: true },
  structureType: { type:mongoose.Schema.Types.Mixed },
  tabType: { type: String },
  subCategory:  {type: String },
  duration: { type: Number}, // in minutes
  link: { type: String, unique: true, required: true }, // Unique link for the test
  
  questions: [questionsSchema],
  
  // Settings
  allowRetake: { type: Boolean, default: false },
  maxAttempts: { type: Number, default: 1 },
  shuffleQuestions: { type: Boolean, default: false },
  showResultImmediately: { type: Boolean, default: true },
  
  // Status and tracking
  status: { type: String, enum: ['active', 'inactive', 'expired'], default: 'active' },
  startDate: { type: Date, default: Date.now },
  endDate: { type: Date },
  
  createdAt: { type: Date, default: Date.now },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  updatedAt: { type: Date, default: Date.now },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
});

// Generate unique link before saving
liveQuestionSchema.pre('save', async function(next) {
  if (!this.link) {
    const generateLink = () => {
      return Math.random().toString(36).substring(2, 15) + 
             Math.random().toString(36).substring(2, 15);
    };
    
    let link = generateLink();
    let existing = await this.constructor.findOne({ link });
    
    while (existing) {
      link = generateLink();
      existing = await this.constructor.findOne({ link });
    }
    
    this.link = link;
  }
  next();
});

module.exports = mongoose.model("LiveQuestion", liveQuestionSchema);