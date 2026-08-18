const mongoose = require("mongoose");

// Sub-schema for schedule items
const ScheduleItemSchema = new mongoose.Schema(
  {
    date: {
      type: Date,
    },
    module: {
      id: {
        type: mongoose.Schema.Types.ObjectId,
      },
      title: {
        type: String,
      },
    },
    submodule: {
      id: {
        type: mongoose.Schema.Types.ObjectId,
      },
      title: {
        type: String,
      },
    },
    topic: {
      id: {
        type: mongoose.Schema.Types.ObjectId,
      },
      title: {
        type: String,
      },
    },
    subtopic: {
      id: {
        type: mongoose.Schema.Types.ObjectId,
      },
      title: {
        type: String,
      },
    },
    hours: {
      type: Number,

      min: 0,
    },
    moduleColor: {
      type: String,
    },
    type: {
      type: String,

      default: "learning",
    },
    status: {
      type: String,

      default: "scheduled",
    },
  },
  { _id: true }
);

// Main Calendar Schedule Schema
const CalendarScheduleSchema = new mongoose.Schema({
  // Course Information
  courseId: {
    type: mongoose.Schema.Types.ObjectId,

    ref: "Course-Structure",
  },
  courseName: {
    type: String,
  },

  // Schedule Information
  title: {
    type: String,
  },
  description: {
    type: String,
  },

  // Configuration Data
  configuration: {
    courseHierarchy: {
      type: String,
      enum: ["Module", "Sub Module", "Topic", "Sub Topic"],
    },
    startDate: {
      type: Date,
    },
    dailyHours: {
      type: Number,

      default: 8,
    },
lunchBreak: {
  start: {
    type: String, // e.g., "13:00"
    required: true,
  },
  end: {
    type: String, 
    required: true,
  },
},
shortBreaks: [
    {
      start: {
        type: String, // format: "HH:mm"
        required: true,
      },
      end: {
        type: String, // format: "HH:mm"
        required: true,
      },
    },
  ],
      weekends: [
      {
        type: Number,
        min: 0,
        max: 6,
      },
    ],
    holidays: [
      {
        type: Date,
      },
    ],
    workingHoursPerDay: {
      type: Number,
    },
  },

  // Summary Data
  summary: {
    totalDuration: {
      type: Number,
    },
    workingHoursPerDay: {
      type: Number,
    },
    estimatedDays: {
      type: Number,
    },
    actualDays: {
      type: Number,
    },
    moduleCount: {
      type: Number,
    },
    startDate: {
      type: Date,
    },
    endDate: {
      type: Date,
    },
  },

  // Schedule Items Array
  scheduleItems: [ScheduleItemSchema],

  // Status and Metadata
  status: {
    type: String,
    default: "draft",
  },
  calendarAddType: {
    type: String,
    enum: ["Manual", "Automatic"],
  },
  createdBy: {
    type: String,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

// Calculate working hours before saving
CalendarScheduleSchema.pre("save", function (next) {
  if (this.configuration) {
    this.configuration.workingHoursPerDay =
      this.configuration.dailyHours -
      this.configuration.lunchBreak -
      this.configuration.shortBreaks;
  }
  this.updatedAt = new Date();
  next();
});

// Index for efficient querying
CalendarScheduleSchema.index({ courseId: 1 });
CalendarScheduleSchema.index({ createdBy: 1 });
CalendarScheduleSchema.index({ "scheduleItems.date": 1 });

module.exports = mongoose.model("CalendarSchedule", CalendarScheduleSchema);
