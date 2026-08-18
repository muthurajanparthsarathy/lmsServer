const mongoose = require("mongoose");
const Feedback = require("../models/FeedbackModal");

// ==================== CREATE FEEDBACK ====================
exports.createFeedback = async (req, res) => {
    try {
        const {
            courseId,
            feedbackTitle,
            feedbackDescription,
            questions,
            ratingScale,
            isPublished,
            startDate,
            endDate,
            isAnonymousAllowed,
            maxAttempts,
            batchId,
            batchName,
            trainerId,
            trainerName,
            trainerEmail
        } = req.body;

        const createdBy = req?.user?.email || req?.user?.id || 'system';

        // Validate required fields
        if (!courseId) {
            return res.status(400).json({
                message: [{ key: "error", value: "Course ID is required" }]
            });
        }

        if (!feedbackTitle) {
            return res.status(400).json({
                message: [{ key: "error", value: "Feedback title is required" }]
            });
        }

        // Every new feedback form belongs to a batch of the course.
        if (!batchName || !String(batchName).trim()) {
            return res.status(400).json({
                message: [{ key: "error", value: "Batch is required — select the batch this feedback is for" }]
            });
        }

        // Questions are optional at creation — they are added afterwards on
        // the Manage Questions page. When provided they must be an array.
        const questionList = Array.isArray(questions) ? questions : [];

        // Create new feedback with auto-computed status
        const newFeedback = new Feedback({
            courseId,
            feedbackTitle,
            feedbackDescription: feedbackDescription || '',
            ratingScale: ratingScale || undefined,
            questions: questionList.map((q, index) => ({
                questionText: q.questionText,
                questionType: q.questionType,
                isRequired: q.isRequired !== undefined ? q.isRequired : true,
                order: q.order || index + 1,
                ratingConfig: q.ratingConfig || { minRating: 1, maxRating: 5 },
                ratingStyle: q.ratingStyle || 'number',
                placeholder: q.placeholder || (q.questionType === 'text' ? 'Enter your answer here...' : 'Select a rating'),
                maxLength: q.maxLength || 500,
                category: q.category || ''
            })),
            // Don't set isPublished/isActive manually - they'll be auto-set
            startDate: startDate || new Date(),
            endDate: endDate || null,
            isAnonymousAllowed: isAnonymousAllowed !== undefined ? isAnonymousAllowed : true,
            maxAttempts: maxAttempts || 1,
            batchId: mongoose.Types.ObjectId.isValid(batchId) ? batchId : null,
            batchName: String(batchName).trim(),
            trainerId: trainerId || null,
            trainerName: trainerName || '',
            trainerEmail: trainerEmail || '',
            createdBy,
            updatedBy: createdBy
        });

        // Automatically set status based on dates before saving
        newFeedback.applyAutoStatus();

        await newFeedback.save();

        return res.status(201).json({
            message: [{ key: "success", value: "Feedback created successfully" }],
            data: newFeedback
        });
    } catch (error) {
        console.error("Error creating feedback:", error);
        return res.status(500).json({ 
            message: [{ key: "error", value: error.message || "Internal server error" }] 
        });
    }
};

// ==================== UPDATE FEEDBACK ====================
exports.updateFeedback = async (req, res) => {
    try {
        const { id } = req.params;
        const {
            feedbackTitle,
            feedbackDescription,
            questions,
            ratingScale,
            isPublished,  // Can still manually set if needed
            isActive,     // Can still manually set if needed
            startDate,
            endDate,
            isAnonymousAllowed,
            maxAttempts,
            batchId,
            batchName,
            trainerId,
            trainerName,
            trainerEmail
        } = req.body;

        const updatedBy = req?.user?.email || req?.user?.id || 'system';

        // Validate ObjectId
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ 
                message: [{ key: "error", value: "Invalid feedback ID format" }] 
            });
        }

        const feedback = await Feedback.findById(id);
        if (!feedback) {
            return res.status(404).json({ 
                message: [{ key: "error", value: "Feedback not found" }] 
            });
        }

        // Update fields
        feedback.feedbackTitle = feedbackTitle || feedback.feedbackTitle;
        feedback.feedbackDescription = feedbackDescription !== undefined ? feedbackDescription : feedback.feedbackDescription;
        
        // Only update dates if provided
        if (startDate) feedback.startDate = startDate;
        if (endDate !== undefined) feedback.endDate = endDate;
        
        feedback.isAnonymousAllowed = isAnonymousAllowed !== undefined ? isAnonymousAllowed : feedback.isAnonymousAllowed;
        feedback.maxAttempts = maxAttempts || feedback.maxAttempts;
        feedback.updatedBy = updatedBy;

        // Batch fields — a form always keeps a batch once set; an empty
        // batchName in the payload is ignored rather than clearing it.
        if (batchId !== undefined) {
            feedback.batchId = mongoose.Types.ObjectId.isValid(batchId) ? batchId : null;
        }
        if (batchName !== undefined && String(batchName).trim()) {
            feedback.batchName = String(batchName).trim();
        }

        // Trainer fields — accept null to explicitly clear, otherwise keep
        // the previous value when the client omits the field.
        if (trainerId !== undefined) feedback.trainerId = trainerId || null;
        if (trainerName !== undefined) feedback.trainerName = trainerName || '';
        if (trainerEmail !== undefined) feedback.trainerEmail = trainerEmail || '';

        // Handle manual status overrides (if provided)
        if (isPublished !== undefined) {
            feedback.isPublished = isPublished;
        }
        if (isActive !== undefined) {
            feedback.isActive = isActive;
        }

        // Auto-apply status based on dates (this will override manual if dates dictate)
        // This ensures date-based rules always apply
        const statusChanged = feedback.applyAutoStatus();

        // Form-level rating scale — only overwritten when explicitly sent.
        if (ratingScale !== undefined && ratingScale !== null) {
            feedback.ratingScale = ratingScale;
        }

        // Update questions if provided — replaces the whole array, mirroring
        // the createFeedback mapper so client-supplied fields (including
        // category) actually persist on edit. An empty array is valid: the
        // Manage Questions page uses it to remove the last question.
        if (Array.isArray(questions)) {
            feedback.questions = questions.map((q, index) => ({
                questionText: q.questionText,
                questionType: q.questionType,
                isRequired: q.isRequired !== undefined ? q.isRequired : true,
                order: q.order || index + 1,
                ratingConfig: q.ratingConfig || { minRating: 1, maxRating: 5 },
                ratingStyle: q.ratingStyle || 'number',
                placeholder: q.placeholder || (q.questionType === 'text' ? 'Enter your answer here...' : 'Select a rating'),
                maxLength: q.maxLength || 500,
                category: q.category || ''
            }));
        }

        await feedback.save();

        return res.status(200).json({
            message: [{ key: "success", value: "Feedback updated successfully" }],
            updated_feedback: feedback,
            statusAutoUpdated: statusChanged
        });
    } catch (error) {
        console.error("Error updating feedback:", error);
        return res.status(500).json({ 
            message: [{ key: "error", value: "Internal server error" }] 
        });
    }
};

// ==================== GET ALL FEEDBACK ====================
exports.getAllFeedback = async (req, res) => {
    try {
        const { courseId } = req.query;
        let filter = {};

        if (courseId) {
            filter.courseId = courseId;
        }

        // ?summary=1 → drop the three heavy fields. The student course list
        // calls this once PER COURSE purely to answer "does this course have a
        // published, active feedback form?" — a boolean — and was pulling the
        // full documents to do it, `studentResponses` included (71,668 bytes
        // for one course here). Additive: without the flag the response is
        // unchanged for the feedback module, which needs questions and
        // responses.
        const summary = req.query.summary === '1' || req.query.summary === 'true';

        const query = Feedback.find(filter).sort({ createdAt: -1 });
        if (summary) query.select('-studentResponses -questions -statistics');
        const feedbacks = await query;
        // NB: this used to `console.log` the whole result — every student's
        // feedback answers, serialised to stdout on every single request.
        return res.status(200).json({
            message: [{ key: "success", value: "Feedback retrieved successfully" }],
            getAllFeedback: feedbacks
        });
    } catch (error) {
        console.error("Error getting all feedback:", error);
        return res.status(500).json({ 
            message: [{ key: "error", value: "Internal server error" }] 
        });
    }
};

// ==================== GET FEEDBACK BY OBJECT ID ====================
exports.getFeedbackById = async (req, res) => {
    try {
        const { id } = req.params;

        // Validate ObjectId
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ 
                message: [{ key: "error", value: "Invalid feedback ID format" }] 
            });
        }

        const feedback = await Feedback.findById(id);
        if (!feedback) {
            return res.status(404).json({ 
                message: [{ key: "error", value: "Feedback not found" }] 
            });
        }

        return res.status(200).json({
            message: [{ key: "success", value: "Feedback retrieved successfully" }],
            feedbackById: feedback
        });
    } catch (error) {
        console.error("Error getting feedback by ID:", error);
        return res.status(500).json({ 
            message: [{ key: "error", value: "Internal server error" }] 
        });
    }
};

// ==================== GET FEEDBACK BY COURSE ====================
exports.getFeedbackByCourse = async (req, res) => {
    try {
        const { courseId } = req.params;

        const feedbacks = await Feedback.find({ 
            courseId, 
            isActive: true 
        }).sort({ createdAt: -1 });

        return res.status(200).json({
            message: [{ key: "success", value: "Course feedback retrieved successfully" }],
            courseFeedback: feedbacks
        });
    } catch (error) {
        console.error("Error getting course feedback:", error);
        return res.status(500).json({ 
            message: [{ key: "error", value: "Internal server error" }] 
        });
    }
};



// ==================== DELETE FEEDBACK BY OBJECT ID ====================
exports.deleteFeedback = async (req, res) => {
    try {
        const { id } = req.params;

        // Validate ObjectId
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ 
                message: [{ key: "error", value: "Invalid feedback ID format" }] 
            });
        }

        const feedback = await Feedback.findById(id);
        if (!feedback) {
            return res.status(404).json({ 
                message: [{ key: "error", value: "Feedback not found" }] 
            });
        }

        await Feedback.findByIdAndDelete(id);

        return res.status(200).json({ 
            message: [{ key: "success", value: "Feedback deleted successfully" }] 
        });
    } catch (error) {
        console.error("Error deleting feedback:", error);
        return res.status(500).json({ 
            message: [{ key: "error", value: "Internal server error" }] 
        });
    }
};

// ==================== TOGGLE FEEDBACK STATUS BY OBJECT ID ====================
exports.toggleFeedbackStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { isActive, isPublished } = req.body;

        // Validate ObjectId
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ 
                message: [{ key: "error", value: "Invalid feedback ID format" }] 
            });
        }

        const feedback = await Feedback.findById(id);
        if (!feedback) {
            return res.status(404).json({ 
                message: [{ key: "error", value: "Feedback not found" }] 
            });
        }

        if (isActive !== undefined) {
            feedback.isActive = isActive;
        }
        if (isPublished !== undefined) {
            feedback.isPublished = isPublished;
        }

        feedback.updatedBy = req?.user?.email || req?.user?.id || 'system';
        await feedback.save();

        return res.status(200).json({
            message: [{ key: "success", value: "Feedback status updated successfully" }],
            updated_feedback: feedback
        });
    } catch (error) {
        console.error("Error toggling feedback status:", error);
        return res.status(500).json({ 
            message: [{ key: "error", value: "Internal server error" }] 
        });
    }
};

// ==================== STUDENT SUBMIT FEEDBACK BY OBJECT ID ====================
exports.submitStudentResponse = async (req, res) => {
    try {
        const { id } = req.params;
        const { answers, isAnonymous, overallReason } = req.body; // ← Added overallReason here
        
        const studentId = req?.user?.id || req?.user?._id;
        const studentName = req?.user?.firstName;
        const studentEmail = req?.user?.email || 'anonymous@example.com';

        // Validate required fields
        if (!id) {
            return res.status(400).json({ 
                message: [{ key: "error", value: "Feedback ID is required" }] 
            });
        }

        if (!answers || !Array.isArray(answers) || answers.length === 0) {
            return res.status(400).json({ 
                message: [{ key: "error", value: "At least one answer is required" }] 
            });
        }

        if (!studentId) {
            return res.status(401).json({ 
                message: [{ key: "error", value: "User not authenticated" }] 
            });
        }

        // Validate ObjectId
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ 
                message: [{ key: "error", value: "Invalid feedback ID format" }] 
            });
        }

        // Find feedback by Object ID
        const feedback = await Feedback.findById(id);
        if (!feedback) {
            return res.status(404).json({ 
                message: [{ key: "error", value: "Feedback not found" }] 
            });
        }

        // Check if feedback is active and published
        if (!feedback.isActive) {
            return res.status(400).json({ 
                message: [{ key: "error", value: "This feedback is not active" }] 
            });
        }

        if (!feedback.isPublished) {
            return res.status(400).json({ 
                message: [{ key: "error", value: "This feedback is not published yet" }] 
            });
        }

        // Check if feedback is within date range
        const now = new Date();
        if (feedback.startDate && now < feedback.startDate) {
            return res.status(400).json({ 
                message: [{ key: "error", value: "Feedback has not started yet" }] 
            });
        }
        if (feedback.endDate && now > feedback.endDate) {
            return res.status(400).json({ 
                message: [{ key: "error", value: "Feedback has ended" }] 
            });
        }

        // Check if student has already responded
        if (feedback.hasStudentResponded(studentId)) {
            return res.status(400).json({ 
                message: [{ key: "error", value: "You have already submitted feedback for this" }] 
            });
        }

        // Add student response - Pass overallReason to the method
        const studentResponse = feedback.addStudentResponse(
            studentId,
            studentName,
            studentEmail,
            answers,
            isAnonymous || false,
            overallReason || '' // ← Pass overallReason here
        );

        await feedback.save();

        return res.status(201).json({
            message: [{ key: "success", value: "Feedback submitted successfully" }],
            data: studentResponse
        });
    } catch (error) {
        console.error("Error submitting student response:", error);
        return res.status(500).json({ 
            message: [{ key: "error", value: error.message || "Internal server error" }] 
        });
    }
};

// ==================== GET STUDENT RESPONSES BY OBJECT ID ====================
exports.getStudentResponses = async (req, res) => {
    try {
        const { id } = req.params;
        const studentId = req?.user?.id || req?.user?._id;

        if (!id) {
            return res.status(400).json({ 
                message: [{ key: "error", value: "Feedback ID is required" }] 
            });
        }

        // Validate ObjectId
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ 
                message: [{ key: "error", value: "Invalid feedback ID format" }] 
            });
        }

        const feedback = await Feedback.findById(id);
        if (!feedback) {
            return res.status(404).json({ 
                message: [{ key: "error", value: "Feedback not found" }] 
            });
        }

        // Find student response
        const studentResponse = feedback.studentResponses.find(
            response => response.studentId.toString() === studentId.toString()
        );

        return res.status(200).json({
            message: [{ key: "success", value: "Student responses retrieved successfully" }],
            data: studentResponse || null,
            hasSubmitted: !!studentResponse
        });
    } catch (error) {
        console.error("Error getting student responses:", error);
        return res.status(500).json({ 
            message: [{ key: "error", value: "Internal server error" }] 
        });
    }
};

// ==================== GET ALL STUDENT RESPONSES FOR A FEEDBACK BY OBJECT ID ====================
exports.getAllStudentResponses = async (req, res) => {
    try {
        const { id } = req.params;

        if (!id) {
            return res.status(400).json({ 
                message: [{ key: "error", value: "Feedback ID is required" }] 
            });
        }

        // Validate ObjectId
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ 
                message: [{ key: "error", value: "Invalid feedback ID format" }] 
            });
        }

        const feedback = await Feedback.findById(id);
        if (!feedback) {
            return res.status(404).json({ 
                message: [{ key: "error", value: "Feedback not found" }] 
            });
        }

        return res.status(200).json({
            message: [{ key: "success", value: "All student responses retrieved successfully" }],
            totalResponses: feedback.studentResponses.length,
            studentResponses: feedback.studentResponses,
            statistics: feedback.statistics
        });
    } catch (error) {
        console.error("Error getting all student responses:", error);
        return res.status(500).json({ 
            message: [{ key: "error", value: "Internal server error" }] 
        });
    }
};

// ==================== GET FEEDBACK STATISTICS BY OBJECT ID ====================
exports.getFeedbackStatistics = async (req, res) => {
    try {
        const { id } = req.params;

        if (!id) {
            return res.status(400).json({ 
                message: [{ key: "error", value: "Feedback ID is required" }] 
            });
        }

        // Validate ObjectId
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ 
                message: [{ key: "error", value: "Invalid feedback ID format" }] 
            });
        }

        const feedback = await Feedback.findById(id);
        if (!feedback) {
            return res.status(404).json({ 
                message: [{ key: "error", value: "Feedback not found" }] 
            });
        }

        // Get detailed statistics
        const statistics = {
            _id: feedback._id,
            feedback_id: feedback.feedback_id,
            feedbackTitle: feedback.feedbackTitle,
            totalStudents: feedback.statistics.totalStudents,
            averageRating: feedback.statistics.averageRating,
            responseRate: feedback.statistics.responseRate,
            questionStats: feedback.statistics.questionStats,
            summary: feedback.getSummary()
        };

        return res.status(200).json({
            message: [{ key: "success", value: "Feedback statistics retrieved successfully" }],
            statistics
        });
    } catch (error) {
        console.error("Error getting feedback statistics:", error);
        return res.status(500).json({ 
            message: [{ key: "error", value: "Internal server error" }] 
        });
    }
};

// ==================== GET QUESTION RESPONSES BY OBJECT ID ====================
exports.getQuestionResponses = async (req, res) => {
    try {
        const { id } = req.params;
        const { questionText } = req.query;

        if (!id || !questionText) {
            return res.status(400).json({ 
                message: [{ key: "error", value: "Feedback ID and Question Text are required" }] 
            });
        }

        // Validate ObjectId
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ 
                message: [{ key: "error", value: "Invalid feedback ID format" }] 
            });
        }

        const feedback = await Feedback.findById(id);
        if (!feedback) {
            return res.status(404).json({ 
                message: [{ key: "error", value: "Feedback not found" }] 
            });
        }

        const responses = feedback.getQuestionResponses(questionText);

        return res.status(200).json({
            message: [{ key: "success", value: "Question responses retrieved successfully" }],
            questionText,
            totalResponses: responses.length,
            responses
        });
    } catch (error) {
        console.error("Error getting question responses:", error);
        return res.status(500).json({ 
            message: [{ key: "error", value: "Internal server error" }] 
        });
    }
};

// ==================== GET COURSE FEEDBACK STATISTICS ====================
exports.getCourseFeedbackStatistics = async (req, res) => {
    try {
        const { courseId } = req.params;

        if (!courseId) {
            return res.status(400).json({ 
                message: [{ key: "error", value: "Course ID is required" }] 
            });
        }

        const statistics = await Feedback.getStatistics(courseId);

        return res.status(200).json({
            message: [{ key: "success", value: "Course feedback statistics retrieved successfully" }],
            statistics
        });
    } catch (error) {
        console.error("Error getting course feedback statistics:", error);
        return res.status(500).json({ 
            message: [{ key: "error", value: "Internal server error" }] 
        });
    }
};

// ==================== GET ALL STUDENT RESPONSES BY COURSE ====================
exports.getAllStudentResponsesByCourse = async (req, res) => {
    try {
        const { courseId } = req.params;

        if (!courseId) {
            return res.status(400).json({ 
                message: [{ key: "error", value: "Course ID is required" }] 
            });
        }

        const feedbacks = await Feedback.find({ 
            courseId, 
            isActive: true 
        });

        let allResponses = [];
        let totalResponses = 0;

        feedbacks.forEach(feedback => {
            allResponses = allResponses.concat(feedback.studentResponses);
            totalResponses += feedback.studentResponses.length;
        });

        return res.status(200).json({
            message: [{ key: "success", value: "All student responses by course retrieved successfully" }],
            courseId,
            totalFeedbacks: feedbacks.length,
            totalResponses,
            studentResponses: allResponses
        });
    } catch (error) {
        console.error("Error getting all student responses by course:", error);
        return res.status(500).json({ 
            message: [{ key: "error", value: "Internal server error" }] 
        });
    }
};

exports.syncAllFeedbackStatus = async (req, res) => {
    try {
        const result = await Feedback.syncAllStatuses();
        
        return res.status(200).json({
            message: [{ key: "success", value: "Feedback statuses synced successfully" }],
            data: result,
            syncedAt: new Date()
        });
    } catch (error) {
        console.error("Error syncing feedback status:", error);
        return res.status(500).json({ 
            message: [{ key: "error", value: "Internal server error" }] 
        });
    }
};