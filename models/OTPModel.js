const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const otpSchema = new mongoose.Schema({
    userId: {
      type:  mongoose.Schema.ObjectId,
      required: [true, "Your password is required"],
    },
    otp: {
      type: String,
      required: [true, "OTP is missing"],
    },
    subject: {
        type: String,
        required: [true, "OTP subject is missing"],
    },
    expirationTime: {
        type: Date,
        required: [true, "OTP expirationTime is missing"],
    },
    createdAt: {
      type: Date,
      default: Date.now,
      expires: 60 * 5, // The document will be automatically deleted after 5 minutes of its creation time
    },
  });
  
  otpSchema.pre("save", async function () {
    this.otp = await bcrypt.hash(this.otp, 12);
  });
  
  module.exports = mongoose.model("LMS-OTP", otpSchema);