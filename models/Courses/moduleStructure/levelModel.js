const mongoose = require("mongoose");

const levelSchema = new mongoose.Schema(
  {
    module: [{ type: mongoose.Schema.Types.ObjectId, ref: "Module1" }],
    subModule: [{ type: mongoose.Schema.Types.ObjectId, ref: "SubModule1" }],
    topic: [{ type: mongoose.Schema.Types.ObjectId, ref: "Topic1" }],
    subTopic: [{ type: mongoose.Schema.Types.ObjectId, ref: "SubTopic1" }],
      index: Number,
    level: {
      type: String,
      required: true,
    },
  },
  { timestamps: true }
);

const levelViewSchema = new mongoose.Schema({
  institution: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "LMS-Institution",
    required: true,
  },
  courses: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Course-Structure",
    required: true,
  },
  levels: [levelSchema],
  createdAt: { type: Date, default: Date.now },
  createdBy: String,
  updatedAt: { type: Date, default: Date.now },
  updatedBy: String,
});

module.exports = mongoose.model("level-view", levelViewSchema);
