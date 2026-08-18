const mongoose = require("mongoose");

const groupSchema = new mongoose.Schema({
  institution: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "LMS-Institution",
    required: true,
  },
  course: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Course-Structure",
    required: true,
  },
  groupName: {
    type: String,
    required: true,
    trim: true,
  },
  groupDescription: {
    type: String,
    trim: true,
    default: "",
  },
  members: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: "LMS-User",
    required: true,
  }],
  groupLeader: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "LMS-User",
  },
  status: {
    type: String,
    enum: ['active', 'inactive', 'archived'],
    default: 'active',
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "LMS-User",
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "LMS-User",
  },
});

// Index for faster queries
groupSchema.index({ course: 1, institution: 1 });
groupSchema.index({ groupName: 1, course: 1 }, { unique: true });

module.exports = mongoose.model("Course-Group", groupSchema);