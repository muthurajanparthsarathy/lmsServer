// Updated Token Schema
const mongoose = require("mongoose");

const tokenSchema = new mongoose.Schema({
  token: { 
    type: String, 
    required: true, 
    unique: true 
  },
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 172800, // 2 days in seconds (2 * 24 * 60 * 60)
  },
});

// Index for automatic expiration
tokenSchema.index({ createdAt: 1 }, { expireAfterSeconds: 172800 });


module.exports = mongoose.model("LMS-token", tokenSchema);