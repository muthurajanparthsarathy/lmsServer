const express = require("express");
const {
  createGroup,
  getGroupsByCourse,
  getGroupDetails,
  addUsersToGroup,
  removeUsersFromGroup,
  deleteGroup,
  setGroupLeader,
  getAllGroupsCoursesData,
  removeGroupLeader,
} = require("../../controllers/courses/groupParticipants");
const { userAuth } = require("../../middlewares/userAuth");
const router = express.Router();

// All routes require authentication

// Create a new group
router.post("/create", userAuth, createGroup);

// Get all groups for a course
router.get(
  "/course/:courseId/institution/:institution",
  userAuth,
  getGroupsByCourse
);

// Get group details
router.get("/:groupId/institution/:institution", userAuth, getGroupDetails);

// Add users to group
router.post("/:groupId/add-users", userAuth, addUsersToGroup);

// Remove users from group
router.post("/:groupId/remove-users", userAuth, removeUsersFromGroup);

// Delete group
router.delete("/:groupId", userAuth, deleteGroup);

// Set group leader
router.put("/:groupId/set-leader", userAuth, setGroupLeader);

router.get(
  "/getAll/groups/courses-data/:courseId",
  userAuth,
  getAllGroupsCoursesData
);

router.put(
  "/remove-group-leader/:groupId/:institution",
  userAuth,
  removeGroupLeader
);
module.exports = router;
