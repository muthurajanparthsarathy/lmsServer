const mongoose = require("mongoose");

// A student's request to retake an assessment (You_Do exercise).
// Stored as its own collection so the coordinator's "Request List" is a simple,
// filterable query and status transitions (Pending -> Approved/Rejected) are easy.
const retestRequestSchema = new mongoose.Schema(
  {
    courseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Course-Structure",
      required: true,
      index: true,
    },
    // Stored as String — matches the Mongo _id of the exercise as passed by the client.
    exerciseId: { type: String, required: true, index: true },
    exerciseName: { type: String, default: "" },
    subcategory: { type: String, default: "" },
    nodeId: { type: String, default: "" },
    nodeType: { type: String, default: "" },

    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LMS-User",
      required: true,
      index: true,
    },
    studentName: { type: String, default: "" },
    studentEmail: { type: String, default: "" },

    message: { type: String, required: true, trim: true },

    status: {
      type: String,
      enum: ["Pending", "Approved", "Rejected"],
      default: "Pending",
      index: true,
    },

    // Per-student retest window set by the coordinator when approving/unlocking.
    // Only this student, only within this window, sees the Start button again.
    retestStart: { type: Date, default: null },
    retestEnd: { type: Date, default: null },

    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "LMS-User", default: null },
  },
  { timestamps: true }
);

retestRequestSchema.index({ courseId: 1, exerciseId: 1, status: 1 });

module.exports =
  mongoose.models.RetestRequest || mongoose.model("RetestRequest", retestRequestSchema);
