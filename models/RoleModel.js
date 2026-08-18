const mongoose = require("mongoose");


const roleSchema = new mongoose.Schema({
  institution: { type: mongoose.Schema.Types.ObjectId, ref: "LMS-Institution", required: true },
  originalRole: { type: String },
  renameRole: { type: String },
  roleValue: { type: String },
 

  createdAt: {
    type: String,
    default: () => {
      const date = new Date();
      const options = { 
        weekday: 'short', 
        year: 'numeric', 
        month: 'short', 
        day: '2-digit', 
        hour: '2-digit', 
        minute: '2-digit', 
        second: '2-digit', 
        hour12: true, 
        timeZone: 'Asia/Kolkata' 
      };
      return date.toLocaleString('en-US', options).replace(',', '');
    }
  },
  createdBy: {
    type: String,
    default: 'self',
    required: [true, "createdBy is required"]
},
});

module.exports = mongoose.model("Role", roleSchema);