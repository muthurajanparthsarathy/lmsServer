const CalendarSchedule = require("../../models/Courses/CalendarScheduleModel");
const CourseStructure = require("../../models/Courses/courseStructureModal");
const Module1 = require("../../models/Courses/moduleStructure/moduleModal");
const SubModule1 = require("../../models/Courses/moduleStructure/subModuleModal");
const Topic1 = require("../../models/Courses/moduleStructure/topicModal");
const SubTopic1 = require("../../models/Courses/moduleStructure/subTopicModal");
const PedagogyView = require("../../models/Courses/moduleStructure/pedagogyViewModal");
const mongoose = require("mongoose");

// Create and Generate Schedule
exports.createSchedule = async (req, res) => {
  try {
    const {
      courseId,
      title,
      description,
      courseHierarchy,
      startDate,
      dailyHours,
      lunchBreak,
      shortBreaks,
      weekends,
      holidays,
      createdBy,
      calendarAddType,
    } = req.body;

    // Validate course exists
    const course = await CourseStructure.findById(courseId);
    if (!course) {
      return res.status(404).json({
        success: false,
        message: "Course not found",
      });
    }

    // Get course structure data
    const courseData = await getCourseStructureData(courseId);

    // Convert the course hierarchy to a string representation
function calculateTotalShortBreakTime(shortBreaks) {
  let totalMinutes = 0;

  for (const breakTime of shortBreaks) {
    const [startHour, startMinute] = breakTime.start.split(":").map(Number);
    const [endHour, endMinute] = breakTime.end.split(":").map(Number);

    const start = new Date(0, 0, 0, startHour, startMinute);
    const end = new Date(0, 0, 0, endHour, endMinute);

    const diffMs = end - start;
    totalMinutes += diffMs / 60000;
  }

  return totalMinutes / 60; // convert to hours
}
function calculateLunchBreakHours(lunchBreak) {
  const [startHour, startMinute] = lunchBreak.start.split(":").map(Number);
  const [endHour, endMinute] = lunchBreak.end.split(":").map(Number);

  const start = new Date(0, 0, 0, startHour, startMinute);
  const end = new Date(0, 0, 0, endHour, endMinute);

  const diffMs = end - start;
  return diffMs / 3600000; // convert milliseconds to hours
}

    // Create configuration object with stringified courseHierarchy
const lunchBreakHours = calculateLunchBreakHours(lunchBreak);
const totalShortBreakHours = calculateTotalShortBreakTime(shortBreaks);

const configuration = {
  courseHierarchy,
  startDate: new Date(startDate),
  dailyHours,
  lunchBreak,
  shortBreaks,
  weekends,
  holidays: holidays?.filter(Boolean).map((h) => new Date(h)) || [],
  workingHoursPerDay: dailyHours - lunchBreakHours - totalShortBreakHours,
};

    // Generate schedule items
    const scheduleItems = generateScheduleItems(configuration, courseData);

    // Calculate summary
    const summary = calculateSummary(scheduleItems, configuration);

    // Create complete schedule document
    const schedule = new CalendarSchedule({
      courseId,
      courseName: course.courseName,
      title: title || `${course.courseName} - Schedule`,
      description,
      configuration,
      summary,
      scheduleItems,
      createdBy,
      calendarAddType,
    });

    await schedule.save();

    res.status(201).json({
      success: true,
      message: "Schedule created successfully",
      data: schedule,
    });
  } catch (error) {
    console.error("Error creating schedule:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};

// Helper to regenerate schedule items
exports.updateSchedule = async (req, res) => {
  try {
    const { scheduleId } = req.params;
    const {
      courseId, // 🔥 This was missing before
      title,
      description,
      courseHierarchy,
      startDate,
      dailyHours,
      lunchBreak,
      shortBreaks,
      weekends,
      holidays,
      createdBy,
      calendarAddType,
    } = req.body;

    // Validate schedule ID
    if (!mongoose.Types.ObjectId.isValid(scheduleId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid schedule ID" });
    }

    // Find the schedule by ID
    const existingSchedule = await CalendarSchedule.findById(scheduleId);
    if (!existingSchedule) {
      return res
        .status(404)
        .json({ success: false, message: "Schedule not found" });
    }

    // Optional: Double-check that courseId matches
    if (existingSchedule.courseId.toString() !== courseId) {
      return res
        .status(400)
        .json({ success: false, message: "Mismatched courseId" });
    }

    // Get course structure data
    const courseData = await getCourseStructureData(courseId);
function calculateTotalShortBreakTime(shortBreaks) {
  let totalMinutes = 0;

  for (const breakTime of shortBreaks) {
    const [startHour, startMinute] = breakTime.start.split(":").map(Number);
    const [endHour, endMinute] = breakTime.end.split(":").map(Number);

    const start = new Date(0, 0, 0, startHour, startMinute);
    const end = new Date(0, 0, 0, endHour, endMinute);

    const diffMs = end - start;
    totalMinutes += diffMs / 60000;
  }

  return totalMinutes / 60; // convert to hours
}

    // Create configuration object with stringified courseHierarchy
function calculateLunchBreakHours(lunchBreak) {
  const [startHour, startMinute] = lunchBreak.start.split(":").map(Number);
  const [endHour, endMinute] = lunchBreak.end.split(":").map(Number);

  const start = new Date(0, 0, 0, startHour, startMinute);
  const end = new Date(0, 0, 0, endHour, endMinute);

  const diffMs = end - start;
  return diffMs / 3600000; // convert milliseconds to hours
}

    // Create configuration object with stringified courseHierarchy
const lunchBreakHours = calculateLunchBreakHours(lunchBreak);
const totalShortBreakHours = calculateTotalShortBreakTime(shortBreaks);

const configuration = {
  courseHierarchy,
  startDate: new Date(startDate),
  dailyHours,
  lunchBreak,
  shortBreaks,
  weekends,
  holidays: holidays?.filter(Boolean).map((h) => new Date(h)) || [],
  workingHoursPerDay: dailyHours - lunchBreakHours - totalShortBreakHours,
};
    // Recalculate schedule items and summary
    const scheduleItems = generateScheduleItems(configuration, courseData);
    const summary = calculateSummary(scheduleItems, configuration);

    // Update fields
    existingSchedule.title = title || existingSchedule.title;
    existingSchedule.description = description;
    existingSchedule.configuration = configuration;
    existingSchedule.summary = summary;
    existingSchedule.scheduleItems = scheduleItems;
    existingSchedule.calendarAddType = calendarAddType;

    existingSchedule.createdBy = createdBy;

    await existingSchedule.save();

    res.status(200).json({
      success: true,
      message: "Schedule updated successfully",
      data: existingSchedule,
    });
  } catch (error) {
    console.error("Error updating schedule:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};

exports.getAllCoursesDataWithDetailedSchedule = async (req, res) => {
  try {
    const { courseId } = req.params;

    // 1. Get the course details
    const course = await CourseStructure.findById(courseId).lean();

    if (!course) {
      return res.status(404).json({
        success: false,
        message: "Course not found",
      });
    }

    // 2. Get all modules for this course
    const modules = await Module1.find({
      courses: courseId,
    }).lean();

    // 3. Get all submodules for these modules
    const subModules = await SubModule1.find({
      moduleId: { $in: modules.map((m) => m._id) },
    }).lean();

    // 4. Get all topics (both module-level and submodule-level)
    const topics = await Topic1.find({
      $or: [
        { moduleId: { $in: modules.map((m) => m._id) } },
        { subModuleId: { $in: subModules.map((sm) => sm._id) } },
      ],
    }).lean();

    // 5. Get all subtopics
    const subTopics = await SubTopic1.find({
      topicId: { $in: topics.map((t) => t._id) },
    }).lean();

    // 6. Get schedule/pedagogy data for this course
    const scheduleData = await PedagogyView.find({
      courseId: courseId,
    }).lean();

    // 7. Get calendar schedule data for this course
    const calendarScheduleData = await CalendarSchedule.find({
      courseId: courseId,
    }).lean();

    // Create a schedule lookup map for easier access
    const scheduleMap = {};
    scheduleData.forEach((schedule) => {
      const key =
        schedule.moduleId ||
        schedule.subModuleId ||
        schedule.topicId ||
        schedule.subTopicId;
      if (key) {
        if (!scheduleMap[key.toString()]) {
          scheduleMap[key.toString()] = [];
        }
        scheduleMap[key.toString()].push(schedule);
      }
    });

    // Create a calendar schedule lookup map for easier access
    const calendarScheduleMap = {};
    calendarScheduleData.forEach((calendarSchedule) => {
      const key =
        calendarSchedule.moduleId ||
        calendarSchedule.subModuleId ||
        calendarSchedule.topicId ||
        calendarSchedule.subTopicId;
      if (key) {
        if (!calendarScheduleMap[key.toString()]) {
          calendarScheduleMap[key.toString()] = [];
        }
        calendarScheduleMap[key.toString()].push(calendarSchedule);
      }
    });

    // Build the hierarchical structure with integrated schedule data
    const structuredCourse = {
      ...course,
      schedule: scheduleData,
      calendarSchedule: calendarScheduleData,
      modules: modules.map((module) => {
        // Find submodules for this module
        const moduleSubModules = subModules.filter(
          (sm) => sm.moduleId?.toString() === module._id.toString()
        );

        // Process submodules with their topics and subtopics
        const processedSubModules = moduleSubModules.map((subModule) => {
          // Find topics for this submodule
          const subModuleTopics = topics.filter(
            (t) => t.subModuleId?.toString() === subModule._id.toString()
          );

          // Process topics with their subtopics
          const processedTopics = subModuleTopics.map((topic) => ({
            ...topic,
            subTopics: subTopics
              .filter((st) => st.topicId?.toString() === topic._id.toString())
              .map((subTopic) => ({
                ...subTopic,
              })),
          }));

          return {
            ...subModule,
            topics: processedTopics,
          };
        });

        // Find topics directly under module (without submodule)
        const moduleDirectTopics = topics.filter(
          (t) =>
            t.moduleId?.toString() === module._id.toString() && !t.subModuleId
        );

        // Process direct topics with their subtopics
        const processedDirectTopics = moduleDirectTopics.map((topic) => ({
          ...topic,
          subTopics: subTopics
            .filter((st) => st.topicId?.toString() === topic._id.toString())
            .map((subTopic) => ({
              ...subTopic,
            })),
        }));

        return {
          ...module,
          subModules: processedSubModules,
          topics: processedDirectTopics,
        };
      }),
    };

    res.status(200).json({
      success: true,
      data: structuredCourse,
      message:
        "Course data with detailed schedule and calendar retrieved successfully",
    });
  } catch (error) {
    console.error(
      "Error fetching course structure with detailed schedule and calendar:",
      error
    );
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};

exports.getAllCalendarSchedules = async (req, res) => {
  try {
    const schedules = await CalendarSchedule.find()
      .populate("courseId") // optionally populate related course
      .sort({ createdAt: -1 }); // latest first, optional

    res.status(200).json({
      success: true,
      message: "All calendar schedules fetched successfully",
      data: schedules,
    });
  } catch (error) {
    console.error("Error fetching calendar schedules:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching calendar schedules",
    });
  }
};
// Get Schedule by ID
exports.getSchedule = async (req, res) => {
  try {
    const { courseId } = req.params; // or req.query if it's passed as a query param
    const { startDate, endDate, viewMode } = req.query;

    const schedule = await CalendarSchedule.findOne({ courseId }).populate(
      "courseId"
    );

    if (!schedule) {
      return res.status(404).json({
        success: false,
        message: "Schedule not found for the given courseId",
      });
    }

    // Filter schedule items by date range if provided
    let filteredItems = schedule.scheduleItems;

    if (startDate || endDate) {
      filteredItems = schedule.scheduleItems.filter((item) => {
        const itemDate = new Date(item.date);
        if (startDate && itemDate < new Date(startDate)) return false;
        if (endDate && itemDate > new Date(endDate)) return false;
        return true;
      });
    }

    // Format response based on view mode
    const responseData = {
      schedule: {
        ...schedule.toObject(),
        scheduleItems: filteredItems,
      },
    };

    if (viewMode === "calendar") {
      responseData.calendarData = formatForCalendarView(filteredItems);
    } else if (viewMode === "table") {
      responseData.tableData = formatForTableView(filteredItems);
    }

    res.status(200).json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    console.error("Error fetching schedule:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};

// Get All Schedules for a Course
exports.getCourseSchedules = async (req, res) => {
  try {
    const { courseId } = req.params;

    const schedules = await CalendarSchedule.find({ courseId })
      .select("-scheduleItems") // Exclude schedule items for list view
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      data: schedules,
    });
  } catch (error) {
    console.error("Error fetching course schedules:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};

// Update Schedule

// Update Schedule Item Status
exports.updateScheduleItemStatus = async (req, res) => {
  try {
    const { scheduleId, itemId } = req.params;
    const { status } = req.body;

    const schedule = await CalendarSchedule.findById(scheduleId);

    if (!schedule) {
      return res.status(404).json({
        success: false,
        message: "Schedule not found",
      });
    }

    const item = schedule.scheduleItems.id(itemId);

    if (!item) {
      return res.status(404).json({
        success: false,
        message: "Schedule item not found",
      });
    }

    item.status = status;
    await schedule.save();

    res.status(200).json({
      success: true,
      message: "Schedule item status updated successfully",
      data: item,
    });
  } catch (error) {
    console.error("Error updating schedule item status:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};

// Delete Schedule
exports.deleteSchedule = async (req, res) => {
  try {
    const { scheduleId } = req.params;
    const schedule = await CalendarSchedule.findByIdAndDelete(scheduleId);

    if (!schedule) {
      return res.status(404).json({
        success: false,
        message: "Schedule not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "Schedule deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting schedule:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};

// Get Schedule Statistics
exports.getScheduleStats = async (req, res) => {
  try {
    const { scheduleId } = req.params;

    const schedule = await CalendarSchedule.findById(scheduleId);

    if (!schedule) {
      return res.status(404).json({
        success: false,
        message: "Schedule not found",
      });
    }

    // Calculate statistics
    const stats = {
      totalItems: schedule.scheduleItems.length,
      completedItems: schedule.scheduleItems.filter(
        (item) => item.status === "completed"
      ).length,
      inProgressItems: schedule.scheduleItems.filter(
        (item) => item.status === "in-progress"
      ).length,
      scheduledItems: schedule.scheduleItems.filter(
        (item) => item.status === "scheduled"
      ).length,
      cancelledItems: schedule.scheduleItems.filter(
        (item) => item.status === "cancelled"
      ).length,
      totalHours: schedule.summary.totalDuration,
      completedHours: schedule.scheduleItems
        .filter((item) => item.status === "completed")
        .reduce((sum, item) => sum + item.hours, 0),
      progressPercentage: 0,
    };

    stats.progressPercentage =
      stats.totalHours > 0
        ? (stats.completedHours / stats.totalHours) * 100
        : 0;

    res.status(200).json({
      success: true,
      data: {
        schedule: {
          _id: schedule._id,
          title: schedule.title,
          courseName: schedule.courseName,
          status: schedule.status,
          summary: schedule.summary,
        },
        statistics: stats,
      },
    });
  } catch (error) {
    console.error("Error fetching schedule statistics:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};

// Helper Functions
async function getCourseStructureData(courseId) {
  const course = await CourseStructure.findById(courseId).lean();
  const modules = await Module1.find({ courses: courseId }).lean();
  const subModules = await SubModule1.find({
    moduleId: { $in: modules.map((m) => m._id) },
  }).lean();
  const topics = await Topic1.find({
    $or: [
      { moduleId: { $in: modules.map((m) => m._id) } },
      { subModuleId: { $in: subModules.map((sm) => sm._id) } },
    ],
  }).lean();
  const subTopics = await SubTopic1.find({
    topicId: { $in: topics.map((t) => t._id) },
  }).lean();

  return {
    ...course,
    modules: modules.map((module) => ({
      ...module,
      subModules: subModules
        .filter((sm) => sm.moduleId?.toString() === module._id.toString())
        .map((subModule) => ({
          ...subModule,
          topics: topics
            .filter(
              (t) => t.subModuleId?.toString() === subModule._id.toString()
            )
            .map((topic) => ({
              ...topic,
              subTopics: subTopics.filter(
                (st) => st.topicId?.toString() === topic._id.toString()
              ),
            })),
        })),
      topics: topics
        .filter(
          (t) =>
            t.moduleId?.toString() === module._id.toString() && !t.subModuleId
        )
        .map((topic) => ({
          ...topic,
          subTopics: subTopics.filter(
            (st) => st.topicId?.toString() === topic._id.toString()
          ),
        })),
    })),
  };
}

function generateScheduleItems(config, courseData) {
  const items = [];
  const currentDate = new Date(config.startDate);
  const moduleColors = [
    "bg-blue-500",
    "bg-green-500",
    "bg-purple-500",
    "bg-red-500",
    "bg-yellow-500",
    "bg-indigo-500",
    "bg-pink-500",
    "bg-teal-500",
  ];

  courseData.modules.forEach((module, moduleIndex) => {
    const moduleColor = moduleColors[moduleIndex % moduleColors.length];

    // Process direct topics
    module.topics.forEach((topic) => {
      topic.subTopics.forEach((subtopic) => {
        let remainingHours = subtopic.duration;

        while (remainingHours > 0) {
          while (!isWorkingDay(currentDate, config.weekends, config.holidays)) {
            currentDate.setDate(currentDate.getDate() + 1);
          }

          const hoursForDay = Math.min(
            remainingHours,
            config.workingHoursPerDay
          );

          items.push({
            date: new Date(currentDate),
            module: {
              id: module._id,
              title: module.title,
            },
            submodule: {
              id: null,
              title: "Direct Topic",
            },
            topic: {
              id: topic._id,
              title: topic.title,
            },
            subtopic: {
              id: subtopic._id,
              title: subtopic.title,
            },
            hours: hoursForDay,
            moduleColor,
            type: "learning",
            status: "scheduled",
          });

          remainingHours -= hoursForDay;
          if (remainingHours > 0) {
            currentDate.setDate(currentDate.getDate() + 1);
          }
        }
      });
    });

    // Process submodules
    module.subModules.forEach((subModule) => {
      subModule.topics.forEach((topic) => {
        topic.subTopics.forEach((subtopic) => {
          let remainingHours = subtopic.duration;

          while (remainingHours > 0) {
            while (
              !isWorkingDay(currentDate, config.weekends, config.holidays)
            ) {
              currentDate.setDate(currentDate.getDate() + 1);
            }

            const hoursForDay = Math.min(
              remainingHours,
              config.workingHoursPerDay
            );

            items.push({
              date: new Date(currentDate),
              module: {
                id: module._id,
                title: module.title,
              },
              submodule: {
                id: subModule._id,
                title: subModule.title,
              },
              topic: {
                id: topic._id,
                title: topic.title,
              },
              subtopic: {
                id: subtopic._id,
                title: subtopic.title,
              },
              hours: hoursForDay,
              moduleColor,
              type: "learning",
              status: "scheduled",
            });

            remainingHours -= hoursForDay;
            if (remainingHours > 0) {
              currentDate.setDate(currentDate.getDate() + 1);
            }
          }
        });
      });
    });
  });

  return items;
}

function isWorkingDay(date, weekends, holidays) {
  const dayOfWeek = date.getDay();
  const dateString = date.toISOString().split("T")[0];
  const holidayStrings = holidays.map(
    (h) => new Date(h).toISOString().split("T")[0]
  );

  return !weekends.includes(dayOfWeek) && !holidayStrings.includes(dateString);
}

function calculateSummary(items, config) {
  const totalDuration = items.reduce((sum, item) => sum + item.hours, 0);
  const startDate = items.length > 0 ? items[0].date : config.startDate;
  const endDate =
    items.length > 0 ? items[items.length - 1].date : config.startDate;
  const actualDays = items.length;
  const estimatedDays = Math.ceil(totalDuration / config.workingHoursPerDay);

  // Count unique modules
  const uniqueModules = new Set(items.map((item) => item.module.id.toString()));

  return {
    totalDuration,
    workingHoursPerDay: config.workingHoursPerDay,
    estimatedDays,
    actualDays,
    moduleCount: uniqueModules.size,
    startDate,
    endDate,
  };
}

function formatForCalendarView(items) {
  const calendarData = {};

  items.forEach((item) => {
    const dateKey = item.date.toISOString().split("T")[0];
    if (!calendarData[dateKey]) {
      calendarData[dateKey] = [];
    }
    calendarData[dateKey].push(item);
  });

  return calendarData;
}

function formatForTableView(items) {
  return items.map((item, index) => {
    const prevItem = items[index - 1];
    return {
      ...item.toObject(),
      showModule: index === 0 || prevItem.module.title !== item.module.title,
      showSubmodule:
        index === 0 || prevItem.submodule.title !== item.submodule.title,
      showTopic: index === 0 || prevItem.topic.title !== item.topic.title,
    };
  });
}

exports.getAllCoursesDataWithSchedule = async (req, res) => {
  try {
    const { courseId } = req.params;

    // 1. Get the course details
    const course = await CourseStructure.findById(courseId).lean();

    if (!course) {
      return res.status(404).json({
        success: false,
        message: "Course not found",
      });
    }

    // 2. Get all modules for this course
    const modules = await Module1.find({
      courses: courseId,
    }).lean();

    // 3. Get all submodules for these modules
    const subModules = await SubModule1.find({
      moduleId: { $in: modules.map((m) => m._id) },
    }).lean();

    // 4. Get all topics (both module-level and submodule-level)
    const topics = await Topic1.find({
      $or: [
        { moduleId: { $in: modules.map((m) => m._id) } },
        { subModuleId: { $in: subModules.map((sm) => sm._id) } },
      ],
    }).lean();

    // 5. Get all subtopics
    const subTopics = await SubTopic1.find({
      topicId: { $in: topics.map((t) => t._id) },
    }).lean();

    // 6. Get schedule/pedagogy data for this course
    const scheduleData = await PedagogyView.find({
      courseId: courseId,
    }).lean();

    // 7. Get calendar schedule data for this course
    const calendarScheduleData = await CalendarSchedule.find({
      courseId: courseId,
    }).lean();

    // Build the hierarchical structure
    const structuredCourse = {
      ...course,
      modules: modules.map((module) => {
        // Find submodules for this module
        const moduleSubModules = subModules.filter(
          (sm) => sm.moduleId?.toString() === module._id.toString()
        );

        // Process submodules with their topics and subtopics
        const processedSubModules = moduleSubModules.map((subModule) => {
          // Find topics for this submodule
          const subModuleTopics = topics.filter(
            (t) => t.subModuleId?.toString() === subModule._id.toString()
          );

          // Process topics with their subtopics
          const processedTopics = subModuleTopics.map((topic) => ({
            ...topic,
            subTopics: subTopics.filter(
              (st) => st.topicId?.toString() === topic._id.toString()
            ),
          }));

          return {
            ...subModule,
            topics: processedTopics,
          };
        });

        // Find topics directly under module (without submodule)
        const moduleDirectTopics = topics.filter(
          (t) =>
            t.moduleId?.toString() === module._id.toString() && !t.subModuleId
        );

        // Process direct topics with their subtopics
        const processedDirectTopics = moduleDirectTopics.map((topic) => ({
          ...topic,
          subTopics: subTopics.filter(
            (st) => st.topicId?.toString() === topic._id.toString()
          ),
        }));

        return {
          ...module,
          subModules: processedSubModules,
          topics: processedDirectTopics,
        };
      }),
      schedule: scheduleData,
      calendarSchedule: calendarScheduleData,
    };

    res.status(200).json({
      success: true,
      data: structuredCourse,
      message: "Course data with schedule and calendar retrieved successfully",
    });
  } catch (error) {
    console.error("Error fetching course structure with schedule:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};

// Alternative version with more detailed schedule integration
exports.getAllCoursesDataWithDetailedSchedule = async (req, res) => {
  try {
    const { courseId } = req.params;

    // 1. Get the course details
    const course = await CourseStructure.findById(courseId).lean();

    if (!course) {
      return res.status(404).json({
        success: false,
        message: "Course not found",
      });
    }

    // 2. Get all modules for this course
    const modules = await Module1.find({
      courses: courseId,
    }).lean();

    // 3. Get all submodules for these modules
    const subModules = await SubModule1.find({
      moduleId: { $in: modules.map((m) => m._id) },
    }).lean();

    // 4. Get all topics (both module-level and submodule-level)
    const topics = await Topic1.find({
      $or: [
        { moduleId: { $in: modules.map((m) => m._id) } },
        { subModuleId: { $in: subModules.map((sm) => sm._id) } },
      ],
    }).lean();

    // 5. Get all subtopics
    const subTopics = await SubTopic1.find({
      topicId: { $in: topics.map((t) => t._id) },
    }).lean();

    // 6. Get schedule/pedagogy data for this course
    const scheduleData = await PedagogyView.find({
      courseId: courseId,
    }).lean();

    // 7. Get calendar schedule data for this course
    const calendarScheduleData = await CalendarSchedule.find({
      courseId: courseId,
    }).lean();

    // Create a schedule lookup map for easier access
    const scheduleMap = {};
    scheduleData.forEach((schedule) => {
      const key =
        schedule.moduleId ||
        schedule.subModuleId ||
        schedule.topicId ||
        schedule.subTopicId;
      if (key) {
        if (!scheduleMap[key.toString()]) {
          scheduleMap[key.toString()] = [];
        }
        scheduleMap[key.toString()].push(schedule);
      }
    });

    // Create a calendar schedule lookup map for easier access
    const calendarScheduleMap = {};
    calendarScheduleData.forEach((calendarSchedule) => {
      const key =
        calendarSchedule.moduleId ||
        calendarSchedule.subModuleId ||
        calendarSchedule.topicId ||
        calendarSchedule.subTopicId;
      if (key) {
        if (!calendarScheduleMap[key.toString()]) {
          calendarScheduleMap[key.toString()] = [];
        }
        calendarScheduleMap[key.toString()].push(calendarSchedule);
      }
    });

    // Build the hierarchical structure with integrated schedule data
    const structuredCourse = {
      ...course,
      schedule: scheduleData,
      calendarSchedule: calendarScheduleData,
      modules: modules.map((module) => {
        // Find submodules for this module
        const moduleSubModules = subModules.filter(
          (sm) => sm.moduleId?.toString() === module._id.toString()
        );

        // Process submodules with their topics and subtopics
        const processedSubModules = moduleSubModules.map((subModule) => {
          // Find topics for this submodule
          const subModuleTopics = topics.filter(
            (t) => t.subModuleId?.toString() === subModule._id.toString()
          );

          // Process topics with their subtopics
          const processedTopics = subModuleTopics.map((topic) => ({
            ...topic,
            subTopics: subTopics
              .filter((st) => st.topicId?.toString() === topic._id.toString())
              .map((subTopic) => ({
                ...subTopic,
              })),
          }));

          return {
            ...subModule,
            topics: processedTopics,
          };
        });

        // Find topics directly under module (without submodule)
        const moduleDirectTopics = topics.filter(
          (t) =>
            t.moduleId?.toString() === module._id.toString() && !t.subModuleId
        );

        // Process direct topics with their subtopics
        const processedDirectTopics = moduleDirectTopics.map((topic) => ({
          ...topic,
          subTopics: subTopics
            .filter((st) => st.topicId?.toString() === topic._id.toString())
            .map((subTopic) => ({
              ...subTopic,
            })),
        }));

        return {
          ...module,
          subModules: processedSubModules,
          topics: processedDirectTopics,
        };
      }),
    };

    res.status(200).json({
      success: true,
      data: structuredCourse,
      message:
        "Course data with detailed schedule and calendar retrieved successfully",
    });
  } catch (error) {
    console.error(
      "Error fetching course structure with detailed schedule and calendar:",
      error
    );
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};
