const Group = require("../../models/Courses/GroupParticipantsModal");
const Course = require("../../models/Courses/courseStructureModal");
const User = require("../../models/UserModel");
const { sendEmail } = require("../../utils/sendEmail");
// Create a new group
exports.createGroup = async (req, res) => {
  try {
    const { courseId, groupName, groupDescription, institution } = req.body;
    const userId = req.user?._id;

    // Validate required fields
    if (!courseId || !groupName || !institution) {
      return res.status(400).json({
        success: false,
        message: "Course ID, group name, and institution are required",
      });
    }

    // Check if course exists
    const course = await Course.findById(courseId);
    if (!course) {
      return res.status(404).json({
        success: false,
        message: "Course not found",
      });
    }

    // Check if group name already exists for this course
    const existingGroup = await Group.findOne({
      course: courseId,
      groupName,
      institution,
    });

    if (existingGroup) {
      return res.status(400).json({
        success: false,
        message: "Group name already exists for this course",
      });
    }

    // Create new group
    const newGroup = new Group({
      course: courseId,
      groupName,
      groupDescription: groupDescription || "",
      institution,
      members: [],
      createdBy: userId,
      updatedBy: userId,
    });

    await newGroup.save();

    // Add group to course
    course.groups.push(newGroup._id);
    await course.save();

    res.status(201).json({
      success: true,
      message: "Group created successfully",
      data: newGroup,
    });
  } catch (error) {
    console.error("Error creating group:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

// Get all groups for a course
exports.getGroupsByCourse = async (req, res) => {
  try {
    const { courseId, institution } = req.params;

    if (!courseId || !institution) {
      return res.status(400).json({
        success: false,
        message: "Course ID and institution are required",
      });
    }

    const groups = await Group.find({ course: courseId, institution })
      .populate({
        path: 'members',
        select: 'firstName lastName email phone role status profile department degree year semester batch',
        populate: {
          path: 'role',
          select: 'name renameRole'  // Populate the role to get name/renameRole
        }
      })
      .populate({
        path: 'groupLeader',
        select: 'firstName lastName email phone role status profile department degree year semester batch',
        populate: {
          path: 'role',
          select: 'name renameRole'  // Populate role for groupLeader too
        }
      })
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      message: "Groups retrieved successfully",
      data: groups,
    });
  } catch (error) {
    console.error("Error fetching groups:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

exports.getAllGroupsCoursesData = async (req, res) => {
  try {
    const { courseId } = req.params;
    const institution = req.headers.institution;

    if (!institution) {
      return res.status(400).json({
        success: false,
        message: "Institution ID is required"
      });
    }

    // Find course with populated batch participants
    const course = await Course.findOne({
      _id: courseId,
      institution: institution
    })
    .populate({
      path: "batchAndParticipants.users.user",
      select: "firstName lastName email phone role status profile department degree year semester batch gender createdAt",
      populate: {
        path: "role",
        select: "renameRole name",
        model: "Role"
      }
    })
    .lean();

    if (!course) {
      return res.status(404).json({
        success: false,
        message: "Course not found"
      });
    }

    // Format the response
    const formattedCourse = {
      _id: course._id,
      institution: course.institution,
      courseName: course.courseName,
      courseCode: course.courseCode,
      courseDescription: course.courseDescription,
      category: course.category,
      serviceType: course.serviceType,
      serviceModal: course.serviceModal,
      participants: (course?.batchAndParticipants || []).flatMap(batch =>
        (batch.users || []).map(enrollment => {
          const user = enrollment.user || {};
          const role = user.role || {};

          return {
            _id: enrollment._id,
            batchId: batch._id,
            batchName: batch.batchName,
            user: {
              _id: user._id,
              id: user._id,
              firstName: user.firstName || '',
              lastName: user.lastName || '',
              email: user.email || '',
              phone: user.phone || '',
              role: role.renameRole || role.name || 'Unknown Role',
              roleId: role._id,
              status: user.status || 'active',
              profile: user.profile || '',
              department: user.department || '',
              degree: user.degree || '',
              year: user.year || '',
              semester: user.semester || '',
              batch: user.batch || '',
              gender: user.gender || '',
              createdAt: user.createdAt || ''
            },
            status: enrollment.status || 'active',
            joinedAt: enrollment.joinedAt,
            updatedAt: enrollment.updatedAt
          };
        })
      ),
      createdAt: course.createdAt,
      updatedAt: course.updatedAt
    };

    res.status(200).json({
      success: true,
      message: "Course data retrieved successfully",
      data: formattedCourse
    });

  } catch (error) {
    console.error("Error fetching course data:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
};
// Add users to group
exports.addUsersToGroup = async (req, res) => {
  try {
    const { groupId } = req.params;
    const { participantIds, institution } = req.body;

    if (!groupId || !participantIds || !Array.isArray(participantIds) || participantIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Group ID and user IDs array are required",
      });
    }

    const group = await Group.findOne({ _id: groupId, institution });

    if (!group) {
      return res.status(404).json({
        success: false,
        message: "Group not found",
      });
    }

    // Check if users are already in the group
    const existingUserIds = new Set(group.members.map(id => id.toString()));
    const newUserIds = participantIds.filter(id => !existingUserIds.has(id));

    if (newUserIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "All users are already in the group",
      });
    }

    // Get user details for new users
    const newUsers = await User.find({
      _id: { $in: newUserIds }
    }).select('firstName lastName email _id');

    if (newUsers.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No valid users found to add",
      });
    }

    // Add new users to group
    group.members.push(...newUserIds);
    group.updatedAt = new Date();
    group.updatedBy = req.user?._id;

    await group.save();

    // Send notifications to added users
    const notificationResults = [];
    const notificationPromises = newUsers.map(async (user) => {
      try {
        const notification = {
          title: 'Added to Group',
          message: `You have been added to the group "${group.groupName}"`,
          type: 'success',
          relatedEntity: 'enrollment',
          relatedEntityId: groupId,
          addedBy: req.user?._id,
          metadata: new Map([
            ['Group Name', group.groupName],
            ['Group Code', group.groupCode || 'N/A'],
            ['Added Date', new Date().toISOString()],
            ['Added By', req.user?.email],
          ]),
        };

        // Get full user document to ensure methods are available
        const userDoc = await User.findById(user._id);
        
        if (userDoc && typeof userDoc.addNotification === 'function') {
          await userDoc.addNotification(notification);
          notificationResults.push({
            userId: user._id,
            success: true,
            email: user.email
          });
        } else {
          // Fallback: Update notifications directly
          await User.findByIdAndUpdate(
            user._id,
            {
              $push: {
                notifications: {
                  $each: [{
                    title: notification.title,
                    message: notification.message,
                    type: notification.type,
                    relatedEntity: notification.relatedEntity,
                    relatedEntityId: notification.relatedEntityId,
                    read: false,
                    createdAt: new Date()
                  }],
                  $position: 0
                }
              },
              $inc: { unreadNotificationCount: 1 }
            }
          );
          notificationResults.push({
            userId: user._id,
            success: true,
            email: user.email,
            method: 'fallback'
          });
        }
      } catch (error) {
        console.error(`Failed to send notification to user ${user._id}:`, error);
        notificationResults.push({
          userId: user._id,
          success: false,
          email: user.email,
          error: error.message
        });
      }
    });

    await Promise.all(notificationPromises);

    // Send emails to added users
    const emailResults = [];
    const emailPromises = newUsers.map(async (user) => {
      try {
        const emailSubject = `Added to Group: ${group.groupName}`;
        const emailBody = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #2c3e50;">Group Membership Update</h2>
            <p>Dear ${user.firstName} ${user.lastName || ''},</p>
            <p>You have been successfully added to the following group:</p>
            <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #27ae60;">
              <h3 style="margin-top: 0; color: #27ae60;">${group.groupName}</h3>
              ${group.groupCode ? `<p><strong>Group Code:</strong> ${group.groupCode}</p>` : ''}
              ${group.description ? `<p><strong>Description:</strong> ${group.description}</p>` : ''}
              <p><strong>Added Date:</strong> ${new Date().toLocaleDateString()}</p>
              <p><strong>Added By:</strong> ${req.user?._id ? 'System Administrator' : 'System'}</p>
            </div>
            <p>You can now access this group and its resources through your LMS account.</p>
            <p>If you have any questions, please contact your group administrator or system administrator.</p>
            <br>
            <p>Best regards,<br>LMS Team</p>
          </div>
        `;

        const emailSent = await sendEmail(
          [user.email],
          emailSubject,
          emailBody,
          []
        );

        emailResults.push({
          userId: user._id,
          email: user.email,
          success: emailSent ? true : false
        });

      } catch (error) {
        console.error(`Failed to send email to ${user.email}:`, error);
        emailResults.push({
          userId: user._id,
          email: user.email,
          success: false,
          error: error.message
        });
      }
    });

    // Send emails in background (don't wait for completion)
    Promise.all(emailPromises)
      .then(results => {
        const successfulEmails = results.filter(r => r && r.success).length;
        const failedEmails = results.filter(r => !r || !r.success).length;
      })
      .catch(error => {
        console.error('Error in group email sending process:', error);
      });

    // Populate the updated members for response
    await group.populate({
      path: 'members',
      select: 'firstName lastName email phone role status profile department degree year semester batch',
    });

    // Calculate statistics
    const successfulNotifications = notificationResults.filter(r => r.success).length;
    const failedNotifications = notificationResults.filter(r => !r.success).length;
    
    const successfulEmails = emailResults.filter(r => r.success).length;
    const failedEmails = emailResults.filter(r => !r.success).length;

    res.status(200).json({
      success: true,
      message: "Users added to group successfully",
      data: {
        group,
        addedCount: newUserIds.length,
        addedUsers: newUsers.map(user => ({
          id: user._id,
          name: `${user.firstName} ${user.lastName || ''}`.trim(),
          email: user.email
        })),
        notifications: {
          total: notificationResults.length,
          successful: successfulNotifications,
          failed: failedNotifications,
          details: notificationResults
        },
        emails: {
          total: emailResults.length,
          successful: successfulEmails,
          failed: failedEmails,
          details: emailResults
        }
      },
    });
  } catch (error) {
    console.error("Error adding users to group:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

// Remove users from group
exports.removeUsersFromGroup = async (req, res) => {
  try {
    const { groupId } = req.params;
    const { participantIds, institution } = req.body;

    if (!groupId || !participantIds || !Array.isArray(participantIds) || participantIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Group ID and user IDs array are required",
      });
    }

    const group = await Group.findOne({ _id: groupId, institution });

    if (!group) {
      return res.status(404).json({
        success: false,
        message: "Group not found",
      });
    }

    // Get user details before removal for notifications
    const usersToRemove = await User.find({
      _id: { $in: participantIds }
    }).select('firstName lastName email _id');

    const userMap = new Map();
    usersToRemove.forEach(user => {
      userMap.set(user._id.toString(), user);
    });

    // Remove users from group
    const initialCount = group.members.length;
    const removedUserIds = [];
    
    group.members = group.members.filter(memberId => {
      const memberIdStr = memberId.toString();
      if (participantIds.includes(memberIdStr)) {
        removedUserIds.push(memberIdStr);
        return false; // Remove this member
      }
      return true; // Keep this member
    });
    
    const removedCount = initialCount - group.members.length;

    if (removedCount === 0) {
      return res.status(400).json({
        success: false,
        message: "None of the specified users were in the group",
      });
    }

    // If group leader is removed, clear group leader
    if (group.groupLeader && participantIds.includes(group.groupLeader.toString())) {
      group.groupLeader = null;
    }

    group.updatedAt = new Date();
    group.updatedBy = req.user?._id;

    await group.save();

    // Send notifications to removed users
    const notificationResults = [];
    const notificationPromises = usersToRemove.map(async (user) => {
      try {
        // Only send notification if the user was actually removed
        if (removedUserIds.includes(user._id.toString())) {
          const notification = {
            title: 'Removed from Group',
            message: `You have been removed from the group "${group.groupName}"`,
            type: 'warning',
            relatedEntity: 'enrollment',
            relatedEntityId: groupId,
            removedBy: req.user?._id,
            metadata: new Map([
              ['Group Name', group.groupName],
              ['Group Code', group.groupCode || 'N/A'],
              ['Removal Date', new Date().toISOString()],
              ['Removed By', req.user?.email || 'system'],
            ]),
          };

          // Get full user document to ensure methods are available
          const userDoc = await User.findById(user._id);
          
          if (userDoc && typeof userDoc.addNotification === 'function') {
            await userDoc.addNotification(notification);
            notificationResults.push({
              userId: user._id,
              success: true,
              email: user.email
            });
          } else {
            // Fallback: Update notifications directly
            await User.findByIdAndUpdate(
              user._id,
              {
                $push: {
                  notifications: {
                    $each: [{
                      title: notification.title,
                      message: notification.message,
                      type: notification.type,
                      relatedEntity: notification.relatedEntity,
                      relatedEntityId: notification.relatedEntityId,
                      read: false,
                      createdAt: new Date()
                    }],
                    $position: 0
                  }
                },
                $inc: { unreadNotificationCount: 1 }
              }
            );
            notificationResults.push({
              userId: user._id,
              success: true,
              email: user.email,
              method: 'fallback'
            });
          }
        } else {
          // User was not in the group, so no notification needed
          notificationResults.push({
            userId: user._id,
            success: false,
            email: user.email,
            message: 'User was not in the group'
          });
        }
      } catch (error) {
        console.error(`Failed to send notification to user ${user._id}:`, error);
        notificationResults.push({
          userId: user._id,
          success: false,
          email: user.email,
          error: error.message
        });
      }
    });

    await Promise.all(notificationPromises);

    // Send emails to removed users
    const emailResults = [];
    const emailPromises = usersToRemove.map(async (user) => {
      try {
        // Only send email if the user was actually removed
        if (removedUserIds.includes(user._id.toString())) {
          const emailSubject = `Removed from Group: ${group.groupName}`;
          const emailBody = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
              <h2 style="color: #2c3e50;">Group Membership Update</h2>
              <p>Dear ${user.firstName} ${user.lastName || ''},</p>
              <p>You have been removed from the following group:</p>
              <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #e74c3c;">
                <h3 style="margin-top: 0; color: #e74c3c;">${group.groupName}</h3>
                ${group.groupCode ? `<p><strong>Group Code:</strong> ${group.groupCode}</p>` : ''}
                <p><strong>Removal Date:</strong> ${new Date().toLocaleDateString()}</p>
                <p><strong>Removed By:</strong> ${req.user?._id ? 'System Administrator' : 'System'}</p>
              </div>
              <p>You will no longer have access to this group and its resources through your LMS account.</p>
              <p>If you believe this is an error or have any questions, please contact your group administrator or system administrator.</p>
              <br>
              <p>Best regards,<br>LMS Team</p>
            </div>
          `;

          const emailSent = await sendEmail(
            [user.email],
            emailSubject,
            emailBody,
            []
          );

          emailResults.push({
            userId: user._id,
            email: user.email,
            success: emailSent ? true : false
          });

        } else {
          // User was not in the group, so no email needed
          emailResults.push({
            userId: user._id,
            email: user.email,
            success: false,
            message: 'User was not in the group'
          });
        }
      } catch (error) {
        console.error(`Failed to send removal email to ${user.email}:`, error);
        emailResults.push({
          userId: user._id,
          email: user.email,
          success: false,
          error: error.message
        });
      }
    });

    // Send emails in background (don't wait for completion)
    Promise.all(emailPromises)
      .then(results => {
        const successfulEmails = results.filter(r => r && r.success).length;
        const failedEmails = results.filter(r => !r || !r.success).length;
      })
      .catch(error => {
        console.error('Error in group removal email sending process:', error);
      });

    // Populate remaining members for response
    await group.populate({
      path: 'members',
      select: 'firstName lastName email phone role status profile department degree year semester batch',
    });

    // Calculate statistics
    const actualRemovedUsers = usersToRemove.filter(user => 
      removedUserIds.includes(user._id.toString())
    );
    
    const successfulNotifications = notificationResults.filter(r => r.success && !r.message).length;
    const failedNotifications = notificationResults.filter(r => !r.success || r.message).length;
    
    const successfulEmails = emailResults.filter(r => r.success && !r.message).length;
    const failedEmails = emailResults.filter(r => !r.success || r.message).length;

    res.status(200).json({
      success: true,
      message: "Users removed from group successfully",
      data: {
        group,
        removedCount,
        removedUsers: actualRemovedUsers.map(user => ({
          id: user._id,
          name: `${user.firstName} ${user.lastName || ''}`.trim(),
          email: user.email,
          wasGroupLeader: group.groupLeader && group.groupLeader.toString() === user._id.toString()
        })),
        notifications: {
          total: notificationResults.length,
          successful: successfulNotifications,
          failed: failedNotifications,
          details: notificationResults
        },
        emails: {
          total: emailResults.length,
          successful: successfulEmails,
          failed: failedEmails,
          details: emailResults
        },
        groupLeaderRemoved: group.groupLeader === null && 
          usersToRemove.some(user => user._id.toString() === group.groupLeader?.toString())
      },
    });
  } catch (error) {
    console.error("Error removing users from group:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

// Delete group
exports.deleteGroup = async (req, res) => {
  try {
    const { groupId } = req.params;
    const { institution } = req.body;

    if (!groupId || !institution) {
      return res.status(400).json({
        success: false,
        message: "Group ID and institution are required",
      });
    }

    const group = await Group.findOne({ _id: groupId, institution });

    if (!group) {
      return res.status(404).json({
        success: false,
        message: "Group not found",
      });
    }

    // Remove group from course
    await Course.updateOne(
      { _id: group.course },
      { $pull: { groups: groupId } }
    );

    // Delete the group
    await Group.deleteOne({ _id: groupId });

    res.status(200).json({
      success: true,
      message: "Group deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting group:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

// Set group leader
exports.setGroupLeader = async (req, res) => {
  try {
    const { groupId } = req.params;
    const { userId, institution } = req.body;

    if (!groupId || !userId || !institution) {
      return res.status(400).json({
        success: false,
        message: "Group ID, user ID, and institution are required",
      });
    }

    const group = await Group.findOne({ _id: groupId, institution });

    if (!group) {
      return res.status(404).json({
        success: false,
        message: "Group not found",
      });
    }

    // Get user details
    const newLeader = await User.findById(userId).select('firstName lastName email _id');
    
    if (!newLeader) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Check if user is a member of the group
    if (!group.members.some(memberId => memberId.toString() === userId)) {
      return res.status(400).json({
        success: false,
        message: "User is not a member of this group",
      });
    }

    const previousLeaderId = group.groupLeader ? group.groupLeader.toString() : null;
    const isDifferentLeader = previousLeaderId !== userId;

    group.groupLeader = userId;
    group.updatedAt = new Date();
    group.updatedBy = req.user?._id;

    await group.save();

    // Prepare notifications for sending
    const notificationResults = [];
    
    // 1. Send notification to the new leader
    try {
      const newLeaderNotification = {
        title: 'Assigned as Group Leader',
        message: `You have been assigned as the leader of group "${group.groupName}"`,
        type: 'info',
        relatedEntity: 'enrollment',
        relatedEntityId: groupId,
        assignedBy: req.user?._id,
        metadata: new Map([
          ['Group Name', group.groupName],
          ['Group Code', group.groupCode || 'N/A'],
          ['Assignment Date', new Date().toISOString()],
          ['Assigned By', req.user?.email || 'system'],
        ]),
      };

      const newLeaderDoc = await User.findById(userId);
      
      if (newLeaderDoc && typeof newLeaderDoc.addNotification === 'function') {
        await newLeaderDoc.addNotification(newLeaderNotification);
        notificationResults.push({
          userId: userId,
          type: 'new_leader',
          success: true,
          email: newLeader.email
        });
      } else {
        // Fallback
        await User.findByIdAndUpdate(
          userId,
          {
            $push: {
              notifications: {
                $each: [{
                  title: newLeaderNotification.title,
                  message: newLeaderNotification.message,
                  type: newLeaderNotification.type,
                  relatedEntity: newLeaderNotification.relatedEntity,
                  relatedEntityId: newLeaderNotification.relatedEntityId,
                  read: false,
                  createdAt: new Date()
                }],
                $position: 0
              }
            },
            $inc: { unreadNotificationCount: 1 }
          }
        );
        notificationResults.push({
          userId: userId,
          type: 'new_leader',
          success: true,
          email: newLeader.email,
          method: 'fallback'
        });
      }
    } catch (error) {
      console.error(`Failed to send notification to new leader ${userId}:`, error);
      notificationResults.push({
        userId: userId,
        type: 'new_leader',
        success: false,
        email: newLeader.email,
        error: error.message
      });
    }

    // 2. Send notification to the previous leader (if changed)
    if (previousLeaderId && isDifferentLeader) {
      try {
        const previousLeader = await User.findById(previousLeaderId).select('firstName lastName email');
        
        if (previousLeader) {
          const previousLeaderNotification = {
            title: 'Group Leadership Changed',
            message: `You are no longer the leader of group "${group.groupName}"`,
            type: 'warning',
            relatedEntity: 'enrollment',
            relatedEntityId: groupId,
            changedBy: req.user?._id,
            metadata: new Map([
              ['Group Name', group.groupName],
              ['Group Code', group.groupCode || 'N/A'],
              ['Change Date', new Date().toISOString()],
              ['New Leader', `${newLeader.firstName} ${newLeader.lastName || ''}`.trim()],
            ]),
          };

          const previousLeaderDoc = await User.findById(previousLeaderId);
          
          if (previousLeaderDoc && typeof previousLeaderDoc.addNotification === 'function') {
            await previousLeaderDoc.addNotification(previousLeaderNotification);
            notificationResults.push({
              userId: previousLeaderId,
              type: 'previous_leader',
              success: true,
              email: previousLeader.email
            });
          } else {
            // Fallback
            await User.findByIdAndUpdate(
              previousLeaderId,
              {
                $push: {
                  notifications: {
                    $each: [{
                      title: previousLeaderNotification.title,
                      message: previousLeaderNotification.message,
                      type: previousLeaderNotification.type,
                      relatedEntity: previousLeaderNotification.relatedEntity,
                      relatedEntityId: previousLeaderNotification.relatedEntityId,
                      read: false,
                      createdAt: new Date()
                    }],
                    $position: 0
                  }
                },
                $inc: { unreadNotificationCount: 1 }
              }
            );
            notificationResults.push({
              userId: previousLeaderId,
              type: 'previous_leader',
              success: true,
              email: previousLeader.email,
              method: 'fallback'
            });
          }
        }
      } catch (error) {
        console.error(`Failed to send notification to previous leader ${previousLeaderId}:`, error);
        notificationResults.push({
          userId: previousLeaderId,
          type: 'previous_leader',
          success: false,
          error: error.message
        });
      }
    }

    // Send emails
    const emailResults = [];
    
    // 1. Send email to the new leader
    try {
      const newLeaderEmailSubject = `Assigned as Group Leader: ${group.groupName}`;
      const newLeaderEmailBody = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #2c3e50;">Group Leadership Assignment</h2>
          <p>Dear ${newLeader.firstName} ${newLeader.lastName || ''},</p>
          <p>You have been assigned as the leader of the following group:</p>
          <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #3498db;">
            <h3 style="margin-top: 0; color: #3498db;">${group.groupName}</h3>
            ${group.groupCode ? `<p><strong>Group Code:</strong> ${group.groupCode}</p>` : ''}
            ${group.description ? `<p><strong>Description:</strong> ${group.description}</p>` : ''}
            <p><strong>Assignment Date:</strong> ${new Date().toLocaleDateString()}</p>
            <p><strong>Assigned By:</strong> ${req.user?._id ? 'System Administrator' : 'System'}</p>
          </div>
          <p>As group leader, you may have additional responsibilities and access to group management features.</p>
          <p>If you have any questions about your new role, please contact your administrator.</p>
          <br>
          <p>Best regards,<br>LMS Team</p>
        </div>
      `;

      const newLeaderEmailSent = await sendEmail(
        [newLeader.email],
        newLeaderEmailSubject,
        newLeaderEmailBody,
        []
      );

      emailResults.push({
        userId: userId,
        type: 'new_leader',
        success: newLeaderEmailSent ? true : false,
        email: newLeader.email
      });

    } catch (error) {
      console.error(`Failed to send email to new leader ${newLeader.email}:`, error);
      emailResults.push({
        userId: userId,
        type: 'new_leader',
        success: false,
        email: newLeader.email,
        error: error.message
      });
    }

    // 2. Send email to the previous leader (if changed)
    if (previousLeaderId && isDifferentLeader) {
      try {
        const previousLeader = await User.findById(previousLeaderId).select('firstName lastName email');
        
        if (previousLeader) {
          const previousLeaderEmailSubject = `Group Leadership Update: ${group.groupName}`;
          const previousLeaderEmailBody = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
              <h2 style="color: #2c3e50;">Group Leadership Update</h2>
              <p>Dear ${previousLeader.firstName} ${previousLeader.lastName || ''},</p>
              <p>The leadership of the following group has been changed:</p>
              <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #f39c12;">
                <h3 style="margin-top: 0; color: #f39c12;">${group.groupName}</h3>
                ${group.groupCode ? `<p><strong>Group Code:</strong> ${group.groupCode}</p>` : ''}
                <p><strong>Change Date:</strong> ${new Date().toLocaleDateString()}</p>
                <p><strong>New Leader:</strong> ${newLeader.firstName} ${newLeader.lastName || ''}</p>
                <p><strong>Changed By:</strong> ${req.user?._id ? 'System Administrator' : 'System'}</p>
              </div>
              <p>You are no longer the leader of this group. You will retain your membership in the group.</p>
              <p>If you have any questions about this change, please contact your administrator.</p>
              <br>
              <p>Best regards,<br>LMS Team</p>
            </div>
          `;

          const previousLeaderEmailSent = await sendEmail(
            [previousLeader.email],
            previousLeaderEmailSubject,
            previousLeaderEmailBody,
            []
          );

          emailResults.push({
            userId: previousLeaderId,
            type: 'previous_leader',
            success: previousLeaderEmailSent ? true : false,
            email: previousLeader.email
          });

        }
      } catch (error) {
        console.error(`Failed to send email to previous leader:`, error);
        emailResults.push({
          userId: previousLeaderId,
          type: 'previous_leader',
          success: false,
          error: error.message
        });
      }
    }

    // Populate the group leader and members for response
    await group.populate({
      path: 'groupLeader',
      select: 'firstName lastName email phone role status profile department degree year semester batch',
    });

    await group.populate({
      path: 'members',
      select: 'firstName lastName email',
    });

    // Calculate statistics
    const successfulNotifications = notificationResults.filter(r => r.success).length;
    const failedNotifications = notificationResults.filter(r => !r.success).length;
    
    const successfulEmails = emailResults.filter(r => r.success).length;
    const failedEmails = emailResults.filter(r => !r.success).length;

    res.status(200).json({
      success: true,
      message: "Group leader set successfully",
      data: {
        group,
        leadershipChange: {
          newLeader: {
            id: newLeader._id,
            name: `${newLeader.firstName} ${newLeader.lastName || ''}`.trim(),
            email: newLeader.email
          },
          previousLeader: previousLeaderId ? {
            id: previousLeaderId,
            changed: isDifferentLeader
          } : null,
          changed: isDifferentLeader,
          changedAt: new Date(),
          changedBy: req.user?._id
        },
        notifications: {
          total: notificationResults.length,
          successful: successfulNotifications,
          failed: failedNotifications,
          details: notificationResults
        },
        emails: {
          total: emailResults.length,
          successful: successfulEmails,
          failed: failedEmails,
          details: emailResults
        }
      },
    });
  } catch (error) {
    console.error("Error setting group leader:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

// Get group details
exports.getGroupDetails = async (req, res) => {
  try {
    const { groupId, institution } = req.params;

    if (!groupId || !institution) {
      return res.status(400).json({
        success: false,
        message: "Group ID and institution are required",
      });
    }

    const group = await Group.findOne({ _id: groupId, institution })
      .populate({
        path: 'members',
        select: 'firstName lastName email phone role status profile department degree year semester batch',
      })
      .populate({
        path: 'groupLeader',
        select: 'firstName lastName email phone role status profile department degree year semester batch',
      })
      .populate({
        path: 'course',
        select: 'courseName courseCode',
      });

    if (!group) {
      return res.status(404).json({
        success: false,
        message: "Group not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "Group details retrieved successfully",
      data: group,
    });
  } catch (error) {
    console.error("Error fetching group details:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};



exports.removeGroupLeader = async (req, res) => {
  try {
    const { groupId, institution } = req.params;

    if (!groupId || !institution) {
      return res.status(400).json({
        success: false,
        message: "Group ID and institution are required",
      });
    }

    const group = await Group.findOne({ _id: groupId, institution });

    if (!group) {
      return res.status(404).json({
        success: false,
        message: "Group not found",
      });
    }

    // Get the previous leader details before removal
    let previousLeader = null;
    if (group.groupLeader) {
      previousLeader = await User.findById(group.groupLeader).select('firstName lastName email _id');
    }

    // Clear group leader
    const hadLeader = group.groupLeader !== null;
    group.groupLeader = null;
    group.updatedAt = new Date();
    group.updatedBy = req.user?._id;
    await group.save();

    // Send notification to the removed leader
    let notificationResult = null;
    if (hadLeader && previousLeader) {
      try {
        const notification = {
          title: 'Group Leadership Removed',
          message: `You are no longer the leader of group "${group.groupName}"`,
          type: 'warning',
          relatedEntity: 'enrollment',
          relatedEntityId: groupId,
          removedBy: req.user?._id,
          metadata: new Map([
            ['Group Name', group.groupName],
            ['Group Code', group.groupCode || 'N/A'],
            ['Removal Date', new Date().toISOString()],
            ['Removed By', req.user?.email || 'system'],
          ]),
        };

        const leaderDoc = await User.findById(previousLeader._id);
        
        if (leaderDoc && typeof leaderDoc.addNotification === 'function') {
          await leaderDoc.addNotification(notification);
          notificationResult = {
            success: true,
            message: 'Notification sent to previous leader'
          };
        } else {
          // Fallback: Update notifications directly
          await User.findByIdAndUpdate(
            previousLeader._id,
            {
              $push: {
                notifications: {
                  $each: [{
                    title: notification.title,
                    message: notification.message,
                    type: notification.type,
                    relatedEntity: notification.relatedEntity,
                    relatedEntityId: notification.relatedEntityId,
                    read: false,
                    createdAt: new Date()
                  }],
                  $position: 0
                }
              },
              $inc: { unreadNotificationCount: 1 }
            }
          );
          notificationResult = {
            success: true,
            message: 'Notification sent via fallback method'
          };
        }
      } catch (error) {
        console.error(`Failed to send notification to removed leader:`, error);
        notificationResult = {
          success: false,
          message: 'Failed to send notification',
          error: error.message
        };
      }
    } else if (hadLeader) {
      notificationResult = {
        success: false,
        message: 'Previous leader not found in database'
      };
    } else {
      notificationResult = {
        success: false,
        message: 'No group leader was set'
      };
    }

    // Send email to the removed leader
    let emailResult = null;
    if (hadLeader && previousLeader) {
      try {
        const emailSubject = `Group Leadership Removed: ${group.groupName}`;
        const emailBody = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #2c3e50;">Group Leadership Update</h2>
            <p>Dear ${previousLeader.firstName} ${previousLeader.lastName || ''},</p>
            <p>Your leadership role has been removed from the following group:</p>
            <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #e74c3c;">
              <h3 style="margin-top: 0; color: #e74c3c;">${group.groupName}</h3>
              ${group.groupCode ? `<p><strong>Group Code:</strong> ${group.groupCode}</p>` : ''}
              <p><strong>Removal Date:</strong> ${new Date().toLocaleDateString()}</p>
              <p><strong>Removed By:</strong> ${req.user?._id ? 'System Administrator' : 'System'}</p>
            </div>
            <p>You will retain your membership in the group, but you no longer have leader privileges.</p>
            <p>If you have any questions about this change, please contact your administrator.</p>
            <br>
            <p>Best regards,<br>LMS Team</p>
          </div>
        `;

        const emailSent = await sendEmail(
          [previousLeader.email],
          emailSubject,
          emailBody,
          []
        );

        emailResult = {
          success: emailSent ? true : false,
          message: emailSent ? 'Email sent successfully' : 'Email failed to send'
        };

      } catch (error) {
        console.error(`Failed to send email to removed leader:`, error);
        emailResult = {
          success: false,
          message: 'Failed to send email',
          error: error.message
        };
      }
    } else if (hadLeader) {
      emailResult = {
        success: false,
        message: 'Previous leader email not available'
      };
    } else {
      emailResult = {
        success: false,
        message: 'No group leader was set'
      };
    }

    // Populate the updated group for response
    const updatedGroup = await Group.findById(groupId)
      .populate({
        path: 'members',
        select: 'firstName lastName email phone role status profile department degree year semester batch',
        populate: {
          path: 'role',
          select: 'name renameRole'
        }
      })
      .populate({
        path: 'groupLeader',
        select: 'firstName lastName email phone role status profile department degree year semester batch',
        populate: {
          path: 'role',
          select: 'name renameRole'
        }
      });

    res.status(200).json({
      success: true,
      message: hadLeader ? "Group leader removed successfully" : "Group had no leader to remove",
      data: {
        group: updatedGroup,
        removalInfo: {
          hadLeader: hadLeader,
          previousLeader: previousLeader ? {
            id: previousLeader._id,
            name: `${previousLeader.firstName} ${previousLeader.lastName || ''}`.trim(),
            email: previousLeader.email
          } : null,
          removedAt: new Date(),
          removedBy: req.user?._id
        },
        notification: notificationResult,
        email: emailResult
      },
    });
  } catch (error) {
    console.error("Error removing group leader:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};