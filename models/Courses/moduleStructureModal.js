const mongoose = require("mongoose");

// SubTopic Schema
const subTopicSchema = new mongoose.Schema({
  title: { type: String},
  description: String,
  duration: Number,
    level:String,

});

// Topic Schema
const topicSchema = new mongoose.Schema({
  title: { type: String },
  description: String,
  duration: Number,
    level:String,

  subTopics: [subTopicSchema],
});
const subModuleSchema = new mongoose.Schema({
  title: { type: String},
  description: String,
  duration: Number,
    level:String,

  topics: [topicSchema],
});
// Module Schema
const moduleSchema = new mongoose.Schema({
  title: { type: String},
  description: String,
  duration: Number,
  level:String,
  topics: [topicSchema],
  subModules: [subModuleSchema],
});

// Pedagogy Activity Item
const pedagogyActivityItemSchema = new mongoose.Schema(
  {
    type: {
      type: String,
   
    },
    duration: {
      type: Number,
    
    },
  },
);

// Pedagogy Schema
const pedagogySchema = new mongoose.Schema(
  {
    module: [{ type: String }], // store module titles
    subModule: [{ type: String }],
    topic: [{ type: String }], // store topic titles

    subTopic: [{ type: String }],
    iDo: [pedagogyActivityItemSchema],
    weDo: [pedagogyActivityItemSchema],
    youDo: [pedagogyActivityItemSchema],
  },
  { timestamps: true }
);

// Final Module Structure
const moduleStructureSchema = new mongoose.Schema({
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
  modules: [moduleSchema],
  pedagogies: [pedagogySchema],
  createdAt: { type: Date, default: Date.now },
  createdBy: String,
  updatedAt: { type: Date, default: Date.now },
  updatedBy: String,
});

module.exports = mongoose.model("Module-Structure-demo", moduleStructureSchema);
