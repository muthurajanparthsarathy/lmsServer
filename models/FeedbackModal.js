const mongoose = require("mongoose");

// Student Response Schema - Each student's response to a feedback
const studentResponseSchema = new mongoose.Schema({
    studentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "LMS-User",
        required: [true, "studentId is required"]
    },
    studentName: {
        type: String,
        required: [true, "studentName is required"]
    },
    studentEmail: {
        type: String,
        required: [true, "studentEmail is required"]
    },
    answers: [{
        questionText: {
            type: String,
            required: [true, "questionText is required"]
        },
        questionType: {
            type: String,
            enum: ['text', 'rating'],
            default: 'text'
        },
        answer: {
            type: mongoose.Schema.Types.Mixed,
            required: [true, "answer is required"]
        },
        // Per-question reason (optional)
        reason: {
            type: String,
            default: ''
        }
    }],
    // Overall reason for the entire feedback (optional)
    overallReason: {
        type: String,
        default: ''
    },
    overallRating: {
        type: Number,
        min: 1,
        max: 10
    },
    isAnonymous: {
        type: Boolean,
        default: false
    },
    submittedAt: {
        type: Date,
        default: Date.now
    },
    ipAddress: String,
    userAgent: String
});

// Feedback Questions Schema
const feedbackQuestionSchema = new mongoose.Schema({
    questionText: {
        type: String,
        required: [true, "questionText is required"],
        unique: false
    },
    questionType: {
        type: String,
        enum: ['text', 'rating'],
        default: 'text',
        required: [true, "questionType is required"]
    },
    isRequired: {
        type: Boolean,
        default: true
    },
    order: {
        type: Number,
        required: [true, "order is required"]
    },
    // For rating questions
    ratingConfig: {
        minRating: {
            type: Number,
            default: 1
        },
        maxRating: {
            type: Number,
            default: 5
        },
        ratingLabels: {
            type: [String],
            default: ['Poor', 'Fair', 'Good', 'Very Good', 'Excellent']
        }
    },
    // Visual style for rating questions — what the student sees. Default is
    // 'number' to preserve current behaviour for existing documents.
    ratingStyle: {
        type: String,
        enum: ['number', 'star', 'emoji'],
        default: 'number'
    },
    // For text questions
    placeholder: {
        type: String,
        default: 'Enter your answer here...'
    },
    maxLength: {
        type: Number,
        default: 500
    },
    // Optional grouping label — questions sharing the same category render
    // under one section in the student modal.
    category: {
        type: String,
        default: ''
    }
});

// Main Feedback Schema
const feedbackSchema = new mongoose.Schema({
    feedback_id: {
        type: String,
        unique: true,
        default: function() {
            return `FEED-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
        }
    },
    courseId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Course-Structure",
        required: true,
    },
    feedbackTitle: {
        type: String,
        required: [true, "feedbackTitle is required"]
    },
    feedbackDescription: {
        type: String,
        default: ''
    },
  
    questions: [feedbackQuestionSchema],
    // Form-level rating scale defined at creation. Every rating question on
    // this form inherits this scale (copied into each question's ratingConfig
    // when the question is added on the Manage Questions page).
    ratingScale: {
        minRating: {
            type: Number,
            default: 1
        },
        maxRating: {
            type: Number,
            default: 5
        },
        ratingLabels: {
            type: [String],
            default: ['Poor', 'Fair', 'Good', 'Very Good', 'Excellent']
        },
        // Form-level rating type — how the scale is presented (number / star /
        // emoji). Rating questions added later default to this style.
        ratingStyle: {
            type: String,
            enum: ['number', 'star', 'emoji'],
            default: 'number'
        },
        // 'single': every rating question uses ratingStyle. 'custom': each
        // question picks its style from allowedRatingStyles.
        ratingMode: {
            type: String,
            enum: ['single', 'custom'],
            default: 'single'
        },
        allowedRatingStyles: {
            type: [{ type: String, enum: ['number', 'star', 'emoji'] }],
            default: ['number']
        }
    },
    studentResponses: [studentResponseSchema],
    statistics: {
        totalStudents: {
            type: Number,
            default: 0
        },
        averageRating: {
            type: Number,
            default: 0
        },
        responseRate: {
            type: Number,
            default: 0
        },
        questionStats: [{
            questionText: {
                type: String,
                required: true
            },
            questionType: {
                type: String,
                enum: ['text', 'rating'],
                default: 'text'
            },
            totalResponses: {
                type: Number,
                default: 0
            },
            responses: [mongoose.Schema.Types.Mixed],
            // For rating questions
            averageRating: {
                type: Number,
                default: null
            },
            ratingDistribution: {
                type: Map,
                of: Number,
                default: new Map()
            },
            // For text questions
            wordCount: {
                type: Number,
                default: 0
            },
            averageWordCount: {
                type: Number,
                default: 0
            }
        }]
    },
    isActive: {
        type: Boolean,
        default: true
    },
    isPublished: {
        type: Boolean,
        default: false
    },
    startDate: {
        type: Date,
        default: Date.now
    },
    endDate: {
        type: Date
    },
    isAnonymousAllowed: {
        type: Boolean,
        default: true
    },
    maxAttempts: {
        type: Number,
        default: 1
    },
    // The batch this feedback belongs to. Every course splits into batches
    // (batchAndParticipants on the course) and a feedback form is created FOR
    // one batch — the list page groups forms under their batch. Older
    // documents predate this field, so it stays optional at the schema level;
    // the create endpoint enforces it for new forms.
    batchId: {
        type: mongoose.Schema.Types.ObjectId,
        default: null
    },
    batchName: {
        type: String,
        default: ''
    },
    // Optional: the specific trainer this feedback is about. A course can have
    // multiple trainers — when set, this feedback is collected about THAT
    // trainer's teaching, not the course in aggregate.
    trainerId: {
        type: mongoose.Schema.Types.ObjectId,
        default: null
    },
    trainerName: {
        type: String,
        default: ''
    },
    trainerEmail: {
        type: String,
        default: ''
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    createdBy: {
        type: String,
        required: [true, "createdBy is required"]
    },
    updatedAt: {
        type: Date,
        default: Date.now
    },
    updatedBy: {
        type: String,
        default: 'self'
    }
});

// Indexes
feedbackSchema.index({ courseId: 1, isActive: 1 });
feedbackSchema.index({ courseId: 1, isPublished: 1 });
feedbackSchema.index({ 'studentResponses.studentId': 1, courseId: 1 });

// Pre-save middleware to update statistics
feedbackSchema.pre('save', function(next) {
    this.updatedAt = Date.now();
    
    if (this.studentResponses && this.studentResponses.length > 0) {
        this.statistics.totalStudents = this.studentResponses.length;
        
        // Calculate overall average rating
        const ratings = this.studentResponses
            .map(r => r.overallRating)
            .filter(r => r !== undefined && r !== null);
        
        if (ratings.length > 0) {
            this.statistics.averageRating = Number(
                (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1)
            );
        }
        
        // Calculate question statistics
        const questionStatsMap = new Map();
        
        this.studentResponses.forEach(response => {
            response.answers.forEach(answer => {
                if (!questionStatsMap.has(answer.questionText)) {
                    const question = this.questions.find(q => q.questionText === answer.questionText);
                    questionStatsMap.set(answer.questionText, {
                        questionText: answer.questionText,
                        questionType: answer.questionType || question?.questionType || 'text',
                        totalResponses: 0,
                        responses: [],
                        averageRating: null,
                        ratingDistribution: new Map(),
                        wordCount: 0,
                        averageWordCount: 0
                    });
                }
                
                const stats = questionStatsMap.get(answer.questionText);
                stats.totalResponses++;
                stats.responses.push(answer.answer);
                
                // Handle rating questions
                if (answer.questionType === 'rating' || stats.questionType === 'rating') {
                    const rating = parseFloat(answer.answer);
                    if (!isNaN(rating)) {
                        const count = stats.ratingDistribution.get(rating.toString()) || 0;
                        stats.ratingDistribution.set(rating.toString(), count + 1);
                        
                        const sum = stats.responses.reduce((acc, val) => acc + parseFloat(val), 0);
                        stats.averageRating = Number((sum / stats.responses.length).toFixed(1));
                    }
                }
                
                // Handle text questions
                if (answer.questionType === 'text' || stats.questionType === 'text') {
                    if (typeof answer.answer === 'string') {
                        const words = answer.answer.trim().split(/\s+/).length;
                        stats.wordCount += words;
                        stats.averageWordCount = Math.round(stats.wordCount / stats.totalResponses);
                    }
                }
            });
        });
        
        const questionStatsArray = Array.from(questionStatsMap.values()).map(stats => {
            const statsObj = {
                questionText: stats.questionText,
                questionType: stats.questionType,
                totalResponses: stats.totalResponses,
                responses: stats.responses,
                averageRating: stats.averageRating,
                ratingDistribution: Object.fromEntries(stats.ratingDistribution),
                wordCount: stats.wordCount,
                averageWordCount: stats.averageWordCount
            };
            return statsObj;
        });
        
        this.statistics.questionStats = questionStatsArray;
    }
    
    next();
});

// Method to check if student has already responded
feedbackSchema.methods.hasStudentResponded = function(studentId) {
    return this.studentResponses.some(
        response => response.studentId.toString() === studentId.toString()
    );
};

// Method to add student response with validation
feedbackSchema.methods.addStudentResponse = function(studentId, studentName, studentEmail, answers, isAnonymous = false, overallReason = '') {
    if (this.hasStudentResponded(studentId)) {
        throw new Error('Student has already submitted feedback for this course');
    }
    
    // Validate required questions
    const requiredQuestions = this.questions.filter(q => q.isRequired);
    const answeredQuestionTexts = new Set(answers.map(a => a.questionText));
    
    for (const question of requiredQuestions) {
        if (!answeredQuestionTexts.has(question.questionText)) {
            throw new Error(`Required question "${question.questionText}" is missing`);
        }
    }
    
    // Validate answers based on question type
    for (const answer of answers) {
        const question = this.questions.find(q => q.questionText === answer.questionText);
        if (question) {
            switch (question.questionType) {
                case 'rating':
                    const rating = parseFloat(answer.answer);
                    const minRating = question.ratingConfig?.minRating || 1;
                    const maxRating = question.ratingConfig?.maxRating || 5;
                    if (isNaN(rating) || rating < minRating || rating > maxRating) {
                        throw new Error(`Rating for "${answer.questionText}" must be between ${minRating} and ${maxRating}`);
                    }
                    break;
                case 'text':
                    if (typeof answer.answer !== 'string' || answer.answer.trim().length === 0) {
                        throw new Error(`Text answer for "${answer.questionText}" cannot be empty`);
                    }
                    if (question.maxLength && answer.answer.length > question.maxLength) {
                        throw new Error(`Text answer for "${answer.questionText}" exceeds maximum length of ${question.maxLength} characters`);
                    }
                    break;
            }
        }
    }
    
    // Calculate overall rating from rating questions
    let overallRating = null;
    const ratingAnswers = answers.filter(a => {
        const question = this.questions.find(q => q.questionText === a.questionText);
        return question && question.questionType === 'rating' && !isNaN(parseFloat(a.answer));
    });
    
    if (ratingAnswers.length > 0) {
        const sum = ratingAnswers.reduce((acc, curr) => acc + parseFloat(curr.answer), 0);
        overallRating = Number((sum / ratingAnswers.length).toFixed(1));
    }
    
    const studentResponse = {
        studentId,
        studentName: isAnonymous ? 'Anonymous' : studentName,
        studentEmail: isAnonymous ? 'anonymous@example.com' : studentEmail,
        answers: answers.map(a => {
            const question = this.questions.find(q => q.questionText === a.questionText);
            return {
                ...a,
                questionType: question?.questionType || 'text'
            };
        }),
        overallReason: overallReason || '',
        overallRating,
        isAnonymous,
        submittedAt: new Date()
    };
    
    this.studentResponses.push(studentResponse);
    return studentResponse;
};

// Method to get summary
feedbackSchema.methods.getSummary = function() {
    return {
        feedbackTitle: this.feedbackTitle,
        totalStudents: this.studentResponses.length,
        totalQuestions: this.questions.length,
        averageRating: this.statistics.averageRating,
        responseRate: this.statistics.responseRate,
        questionSummary: this.questions.map(q => {
            const stats = this.statistics.questionStats.find(s => s.questionText === q.questionText);
            const summary = {
                questionText: q.questionText,
                questionType: q.questionType,
                totalResponses: stats ? stats.totalResponses : 0,
                sampleResponses: stats ? stats.responses.slice(0, 5) : []
            };
            
            if (q.questionType === 'rating' && stats) {
                summary.averageRating = stats.averageRating;
                summary.ratingDistribution = stats.ratingDistribution;
            } else if (q.questionType === 'text' && stats) {
                summary.averageWordCount = stats.averageWordCount;
                summary.totalWordCount = stats.wordCount;
            }
            
            return summary;
        })
    };
};
// Method to compute what isActive/isPublished SHOULD be right now, based on dates
feedbackSchema.methods.computeAutoStatus = function() {
    const now = new Date();
    const hasStarted = this.startDate && now >= this.startDate;
    const hasEnded = this.endDate && now > this.endDate;

    let isActive = this.isActive;
    let isPublished = this.isPublished;

    if (hasEnded) {
        isActive = false;
        isPublished = false;
    } else if (hasStarted) {
        isActive = true;
        isPublished = true;
    } else {
        // before startDate - not started yet
        isPublished = false;
    }

    return { isActive, isPublished };
};

// Method to apply the auto status to this document (does NOT save - caller decides)
feedbackSchema.methods.applyAutoStatus = function() {
    const { isActive, isPublished } = this.computeAutoStatus();
    let changed = false;

    if (this.isActive !== isActive) {
        this.isActive = isActive;
        changed = true;
    }
    if (this.isPublished !== isPublished) {
        this.isPublished = isPublished;
        changed = true;
    }

    return changed;
};

// Static method to sync ALL feedbacks' status based on current date/time
// Used by the cron job to sweep the whole collection
feedbackSchema.statics.syncAllStatuses = async function() {
    const now = new Date();

    // 1) Activate/publish feedbacks whose startDate has arrived and haven't ended
    const activated = await this.updateMany(
        {
            startDate: { $lte: now },
            $or: [{ endDate: null }, { endDate: { $exists: false } }, { endDate: { $gt: now } }],
            $or: [{ isActive: false }, { isPublished: false }]
        },
        { $set: { isActive: true, isPublished: true, updatedAt: now, updatedBy: 'auto-scheduler' } }
    );

    // 2) Deactivate/unpublish feedbacks whose endDate has passed
    const endedResult = await this.updateMany(
        {
            endDate: { $ne: null, $lte: now },
            $or: [{ isActive: true }, { isPublished: true }]
        },
        { $set: { isActive: false, isPublished: false, updatedAt: now, updatedBy: 'auto-scheduler' } }
    );

    return {
        activatedCount: activated.modifiedCount || 0,
        endedCount: endedResult.modifiedCount || 0
    };
};
module.exports = mongoose.model("Feedback", feedbackSchema);