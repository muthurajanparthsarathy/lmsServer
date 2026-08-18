const mongoose = require("mongoose");

// Department sub-document schema
const departmentSchema = new mongoose.Schema({
  departmentName: { 
    type: String, 
    required: true,
    trim: true 
  },
  departmentCode: { 
    type: String, 
    required: true,
    trim: true 
  },
  description: { 
    type: String,
    trim: true 
  },
 
  status: { 
    type: String, 
    enum: ['active', 'inactive'],
    default: 'active' 
  },
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
    default: 'self'
  },
  updatedAt: {
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
  updatedBy: {
    type: String,
    default: 'self'
  }
});

// Main Degree schema with embedded departments
const degreeSchema = new mongoose.Schema({
  institution: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: "LMS-Institution", 
    required: true 
  },
  degreeName: { 
    type: String, 
    required: true,
    trim: true 
  },
  degreeCode: {
    type: String,
    required: true,
    trim: true
  },
  numberOfSemesters: {
    type: Number,
    required: true,
    min: 1
  },
  // Degree length in years (e.g. B.Sc = 3, B.E = 4). Optional so existing degrees
  // stay valid; when unset, consumers fall back to ceil(numberOfSemesters / 2).
  // The controller already reads `duration` from the request body — this makes it
  // persist instead of being dropped by strict mode.
  duration: {
    type: Number,
    min: 1
  },

  description: {
    type: String,
    trim: true
  },

  status: {
    type: String,
    enum: ['active', 'inactive'],
    default: 'active'
  },
  // Embedded departments array
  departments: [departmentSchema],
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
  updatedAt: {
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
  updatedBy: {
    type: String,
    default: 'self'
  }
});

// Compound index for unique degree per institution
degreeSchema.index({ institution: 1, degreeCode: 1 }, { unique: true });
degreeSchema.index({ institution: 1, degreeName: 1 });

// Pre-save middleware
degreeSchema.pre('save', function(next) {
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
  this.updatedAt = date.toLocaleString('en-US', options).replace(',', '');
  this.updatedBy = this.createdBy || 'self';
  
  // Set createdBy for departments if not set
  if (this.departments && this.departments.length > 0) {
    this.departments.forEach(dept => {
      if (!dept.createdBy) {
        dept.createdBy = this.createdBy;
        dept.updatedBy = this.createdBy;
      }
    });
  }
  next();
});

// Pre-update middleware for findOneAndUpdate
degreeSchema.pre('findOneAndUpdate', function(next) {
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
  this._update.updatedAt = date.toLocaleString('en-US', options).replace(',', '');
  next();
});

module.exports = mongoose.model("Degree", degreeSchema);