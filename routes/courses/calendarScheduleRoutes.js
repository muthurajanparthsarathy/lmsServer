const express = require("express")
const { createSchedule, getSchedule, updateSchedule, deleteSchedule, getCourseSchedules, updateScheduleItemStatus, getScheduleStats, getAllCoursesDataWithSchedule, getAllCoursesDataWithDetailedSchedule, getAllCalendarSchedules } = require("../../controllers/courses/calendarSchedule")
const { userAuth } = require("../../middlewares/userAuth")
const router = express.Router()

// Schedule CRUD operations
router.post("/calendar/schedule", createSchedule)
router.get("/getAll/schedule/:courseId",  getSchedule)
router.put("/update/schedule/:scheduleId",  updateSchedule)
router.delete("/delete-1/calandar-schedule/:scheduleId",userAuth,  deleteSchedule)

// Course schedules
router.get("/course/:courseId/schedule",  getCourseSchedules)

// Schedule item operations
router.patch("/schedule/:scheduleId/item/:itemId/status",  updateScheduleItemStatus)

// Schedule statistics
router.get("/schedule/:scheduleId/stats",  getScheduleStats)



router.get("/getAll-1/schedule/:courseId",  getAllCoursesDataWithSchedule)
router.get("/getAll-2/schedule/:courseId",  getAllCoursesDataWithDetailedSchedule)

router.get("/getAll/calendar-schedule",  getAllCalendarSchedules)

module.exports = router
