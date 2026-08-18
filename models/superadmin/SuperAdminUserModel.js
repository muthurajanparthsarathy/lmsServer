const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const validator = require("validator");

// Platform-owner identity — intentionally separate from LMS-User.
// No institution reference: the Super Admin sits above every tenant.
const superAdminUserSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true,
      validate: (value) => validator.isEmail(value),
    },
    phone: {
      type: String,
    },
    password: {
      type: String,
      required: [true, "Password is required"],
    },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
    },
    lastLoginAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

superAdminUserSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  try {
    this.password = await bcrypt.hash(this.password, 12);
    next();
  } catch (error) {
    next(error);
  }
});

module.exports = mongoose.model("SuperAdmin-User", superAdminUserSchema);
