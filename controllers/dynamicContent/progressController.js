const User = require('../../models/UserModel');
const ActivityLog = require('../../models/ActivityLog');
const mongoose = require('mongoose');

/**
 * PATCH /api/progress/:userId/courses/:courseId/visit-node
 * Adds a nodeId to visitedNodes array, updates lastVisitedNode and lastVisitedAt
 */
// progressController.js — recordNodeVisit
exports.recordNodeVisit = async (req, res) => {
  try {
    const { userId, courseId } = req.params;
    const { nodeId } = req.body;

    if (!nodeId) {
      return res.status(400).json({ success: false, message: "nodeId is required" });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    let courseIndex = user.courses.findIndex(
      c => c.courseId && c.courseId.toString() === courseId
    );

    // ✅ Auto-create course entry if not present
    if (courseIndex === -1) {
      user.courses.push({
        courseId: courseId,
        lastAccessed: new Date(),
        progress: {
          visitedNodes: [],
          openedResources: [],
          completedExercises: [],
          lastVisitedNode: "",
          lastVisitedAt: null
        }
      });
      courseIndex = user.courses.length - 1;
    }

    // Initialize progress if missing
    if (!user.courses[courseIndex].progress) {
      user.courses[courseIndex].progress = {
        visitedNodes: [],
        openedResources: [],
        completedExercises: [],
        lastVisitedNode: "",
        lastVisitedAt: null
      };
    }

    if (!user.courses[courseIndex].progress.visitedNodes.includes(nodeId)) {
      user.courses[courseIndex].progress.visitedNodes.push(nodeId);
    }

    user.courses[courseIndex].progress.lastVisitedNode = nodeId;
    user.courses[courseIndex].progress.lastVisitedAt = new Date();
    user.courses[courseIndex].lastAccessed = new Date();

    user.markModified(`courses.${courseIndex}.progress`);
    await user.save();

    // Node-visit activity logging removed — module/topic/subtopic visits are no longer
    // stored as 'node_visit' activity entries.

    res.status(200).json({
      success: true,
      message: "Node visit recorded successfully",
      data: {
        progress: user.courses[courseIndex].progress,
        visitedNodesCount: user.courses[courseIndex].progress.visitedNodes.length
      }
    });

  } catch (error) {
    console.error("Error recording node visit:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * PATCH /api/progress/:userId/courses/:courseId/open-resource
 * Adds a resourceId to openedResources array
 */
exports.recordResourceOpen = async (req, res) => {
  try {
    const { userId, courseId } = req.params;
    const { resourceId } = req.body;

    // Validate required fields
    if (!resourceId) {
      return res.status(400).json({
        success: false,
        message: "resourceId is required"
      });
    }

    // Find user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    // Find the course in user's courses array
    const courseIndex = user.courses.findIndex(
      c => c.courseId && c.courseId.toString() === courseId
    );

    if (courseIndex === -1) {
      return res.status(404).json({
        success: false,
        message: "Course not found in user's enrollment"
      });
    }

    // Initialize progress object if it doesn't exist
    if (!user.courses[courseIndex].progress) {
      user.courses[courseIndex].progress = {
        visitedNodes: [],
        openedResources: [],
        completedExercises: [],
        lastVisitedNode: "",
        lastVisitedAt: null
      };
    }

    // Use $addToSet equivalent to avoid duplicates
    if (!user.courses[courseIndex].progress.openedResources.includes(resourceId)) {
      user.courses[courseIndex].progress.openedResources.push(resourceId);
    }

    // Mark the modified path
    user.markModified(`courses.${courseIndex}.progress`);

    await user.save();

    // Activity log — create and capture its id so the client can stamp a close
    // time / view duration on this exact record when the viewer is closed.
    let logId = null;
    try {
      const logDoc = await ActivityLog.create({
        userId: user._id,
        userName: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
        userEmail: user.email || '',
        courseId: courseId || null,
        action: 'resource_open',
        details: {
          resourceId,
          resourceName: req.body.resourceName || resourceId,
          resourceType: req.body.resourceType || '',
          method: req.body.method || null, // 'I_Do' | 'We_Do' | 'You_Do' | null
          nodeName: req.body.nodeName || null,
          nodeType: req.body.nodeType || null,
        },
      });
      logId = logDoc._id;
    } catch (e) { /* best effort — don't block progress */ }

    // Return updated progress object
    res.status(200).json({
      success: true,
      message: "Resource open recorded successfully",
      data: {
        progress: user.courses[courseIndex].progress,
        openedResourcesCount: user.courses[courseIndex].progress.openedResources.length,
        logId,
      }
    });

  } catch (error) {
    console.error("Error recording resource open:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Internal server error"
    });
  }
};

/**
 * PATCH /progress/:userId/courses/:courseId/close-resource
 * Stamps the view duration (seconds) + close time onto a previously-created
 * resource_open activity log. Called when the student closes the resource viewer.
 */
exports.recordResourceClose = async (req, res) => {
  try {
    const { userId } = req.params;
    const { logId, duration, closedAt } = req.body;

    if (!logId) {
      return res.status(400).json({ success: false, message: 'logId is required' });
    }

    const dur = Number(duration);
    await ActivityLog.updateOne(
      { _id: logId, userId, action: 'resource_open' },
      {
        $set: {
          'details.duration': isNaN(dur) ? null : dur,
          'details.closedAt': closedAt ? new Date(closedAt) : new Date(),
        },
      }
    );

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error recording resource close:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/progress/:userId/courses/:courseId
 * Fetch progress data for a specific course
 */
// In progressController.js — getProgress
exports.getProgress = async (req, res) => {
  try {
    const { userId, courseId } = req.params;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const course = (user.courses || []).find(
      c => c.courseId && c.courseId.toString() === courseId
    );

    // ✅ Return empty progress instead of 404 — course may exist but not yet tracked
    res.status(200).json({
      success: true,
      data: {
        progress: course?.progress || {
          visitedNodes: [],
          openedResources: [],
          completedExercises: [],
          lastVisitedNode: "",
          lastVisitedAt: null
        }
      }
    });
  } catch (error) {
    console.error("Error fetching progress:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * PATCH /progress/:userId/courses/:courseId/select-method
 * Logs when a student selects an I Do / We Do / You Do tab
 */
exports.recordMethodSelect = async (req, res) => {
  try {
    const { userId, courseId } = req.params;
    const { method, nodeId, nodeName } = req.body;

    if (!method) {
      return res.status(400).json({ success: false, message: 'method is required' });
    }

    const user = await User.findById(userId).select('firstName lastName email').lean();
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    ActivityLog.create({
      userId: user._id,
      userName: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
      userEmail: user.email || '',
      courseId: courseId || null,
      action: 'method_select',
      details: { method, nodeId: nodeId || null, nodeName: nodeName || null },
    }).catch(() => {});

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error recording method select:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * PATCH /progress/:userId/courses/:courseId/select-activity
 * Logs when a student selects a subcategory (Presentation, Practice, etc.)
 */
exports.recordActivitySelect = async (req, res) => {
  try {
    const { userId, courseId } = req.params;
    const { method, activity, nodeId, nodeName } = req.body;

    if (!method || !activity) {
      return res.status(400).json({ success: false, message: 'method and activity are required' });
    }

    const user = await User.findById(userId).select('firstName lastName email').lean();
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    ActivityLog.create({
      userId: user._id,
      userName: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
      userEmail: user.email || '',
      courseId: courseId || null,
      action: 'activity_select',
      details: { method, activity, nodeId: nodeId || null, nodeName: nodeName || null },
    }).catch(() => {});

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error recording activity select:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};