const mongoose = require("mongoose");

// Institution status/plan/limits live here instead of on LMS-Institution
// itself — keeps the existing tenant schema untouched (zero-regression
// requirement, see docs/ARCHITECTURE.md section 4). One document per
// institution; usage counters (users/courses) are computed at read time
// in controllers/superadmin/institutionController.js, not stored here.
const subscriptionSchema = new mongoose.Schema(
  {
    institution: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LMS-Institution",
      required: true,
      unique: true,
    },
    status: {
      type: String,
      enum: ["active", "suspended"],
      default: "active",
    },
    plan: {
      type: String,
      default: "standard",
    },
    storageQuotaMB: {
      type: Number,
      default: 5000,
    },
    maxUsers: {
      type: Number,
      default: 0, // 0 = unlimited
    },
    // Subscription price/amount for this plan.
    amount: {
      type: Number,
      default: 0,
    },
    startDate: {
      type: Date,
      default: Date.now,
    },
    expiryDate: {
      type: Date,
    },
    updatedBy: {
      type: String,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("client-Subscription", subscriptionSchema);
