const mongoose = require("mongoose");

const pedagogyActivityItemSchema = new mongoose.Schema(
  {
    type: {
      type: String,
    
      required: true,
    },
    duration: {
      type: Number,
      required: true,
    },
  },
);

const pedagogySchema = new mongoose.Schema(
  {
    module: [{ type: mongoose.Schema.Types.ObjectId, ref: "Module1" }], 
    subModule: [{ type: mongoose.Schema.Types.ObjectId, ref: "SubModule1" }],
    topic: [{ type: mongoose.Schema.Types.ObjectId, ref: "Topic1" }],

    subTopic: [{ type: mongoose.Schema.Types.ObjectId, ref: "SubTopic1" }],
    iDo: [pedagogyActivityItemSchema],
    weDo: [pedagogyActivityItemSchema],
    youDo: [pedagogyActivityItemSchema],
  },
  { timestamps: true }
);

const pedagogyvireSchema = new mongoose.Schema({
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
  pedagogies: [pedagogySchema],
  createdAt: { type: Date, default: Date.now },
  createdBy: String,
  updatedAt: { type: Date, default: Date.now },
  updatedBy: String,
});

module.exports = mongoose.model("pedagogy-view", pedagogyvireSchema);
