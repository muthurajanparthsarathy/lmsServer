const LiveQuestion = require('../../../models/Courses/moduleStructure/LiveQuestionModal');
const StudentResponse = require('../../../models/Courses/moduleStructure/StudentResponseSchema');
const User = require('../../../models/UserModel');
const socketIO = require('../../../utils/socket');

// ─── Helper: get student display name ────────────────────────────────────────
async function getStudentInfo(studentId) {
  try {
    const user = await User.findById(studentId).select('firstName lastName email').lean();
    if (!user) return { name: 'Unknown', email: '' };
    const name = `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email || 'Unknown';
    return { name, email: user.email || '' };
  } catch {
    return { name: 'Unknown', email: '' };
  }
}

// ─── Create a new live question ───────────────────────────────────────────────
exports.createLiveQuestion = async (req, res) => {
  try {
    const liveQuestion = new LiveQuestion({
      ...req.body,
      createdBy: req.user._id,
      updatedBy: req.user._id,
    });
    await liveQuestion.save();
    res.status(201).json({ success: true, data: liveQuestion, message: 'Live question created successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── Get all live questions with filters ──────────────────────────────────────
exports.getLiveQuestions = async (req, res) => {
  try {
    const { institution, courses, status, page = 1, limit = 10 } = req.query;
    const query = {};
    if (institution) query.institution = institution;
    if (courses) query.courses = courses;
    if (status) query.status = status;

    const options = {
      page: parseInt(page),
      limit: parseInt(limit),
      sort: { createdAt: -1 },
      populate: ['institution', 'courses', 'createdBy'],
    };

    const liveQuestions = await LiveQuestion.paginate(query, options);
    res.status(200).json({ success: true, data: liveQuestions });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── Get live question by link (student access) ───────────────────────────────
exports.getLiveQuestionByLink = async (req, res) => {
  try {
    const { link } = req.params;
    const liveQuestion = await LiveQuestion.findOne({ link, status: 'active' }).populate('institution courses');

    if (!liveQuestion) {
      return res.status(404).json({ success: false, message: 'Live question not found or expired' });
    }
    if (liveQuestion.endDate && new Date() > liveQuestion.endDate) {
      return res.status(403).json({ success: false, message: 'This test has expired' });
    }

    // Strip correct answers for student view
    const studentView = liveQuestion.toObject();
    studentView.questions = studentView.questions.map(q => {
      if (q.questionType === 'mcq') delete q.mcqQuestionCorrectAnswers;
      else if (q.questionType === 'programming') { delete q.testCases; delete q.solutions; }
      return q;
    });

    res.status(200).json({ success: true, data: studentView });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── Start a live question attempt ────────────────────────────────────────────
exports.startAttempt = async (req, res) => {
  try {
    const { link } = req.params;
    const studentId = req.user._id;

    const liveQuestion = await LiveQuestion.findOne({ link, status: 'active' });
    if (!liveQuestion) {
      return res.status(404).json({ success: false, message: 'Live question not found' });
    }

    const existingAttempt = await StudentResponse.findOne({
      student: studentId,
      liveQuestion: liveQuestion._id,
      status: { $in: ['in-progress', 'completed'] },
    });

    if (existingAttempt && !liveQuestion.allowRetake) {
      return res.status(403).json({ success: false, message: 'You have already attempted this test' });
    }
    if (existingAttempt && existingAttempt.status === 'in-progress') {
      return res.status(200).json({ success: true, data: existingAttempt, message: 'Continuing previous attempt' });
    }

    const attempt = new StudentResponse({
      student: studentId,
      liveQuestion: liveQuestion._id,
      startedAt: new Date(),
      status: 'in-progress',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    await attempt.save();

    // Get student info from LMS-User for socket emit
    const studentInfo = await getStudentInfo(studentId);
    const totalQuestions = liveQuestion.questions.length;

    const io = socketIO.getIO();
    // Room name must match what the frontend joins: "liveq-{id}"
    io.to(`liveq-${liveQuestion._id}`).emit('student-started', {
      studentId: studentId.toString(),
      studentName: studentInfo.name,
      studentEmail: studentInfo.email,
      attemptId: attempt._id.toString(),
      liveQuestionId: liveQuestion._id.toString(),
      startedAt: attempt.startedAt,
      totalQuestions,
      answeredCount: 0,
    });

    res.status(200).json({ success: true, data: attempt });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── Submit answer for a single question ─────────────────────────────────────
exports.submitAnswer = async (req, res) => {
  try {
    const { attemptId } = req.params;
    const { questionId, answer, questionType, timeSpent } = req.body;
    const studentId = req.user._id;

    const attempt = await StudentResponse.findOne({
      _id: attemptId,
      student: studentId,
      status: 'in-progress',
    });

    if (!attempt) {
      return res.status(404).json({ success: false, message: 'Attempt not found or already completed' });
    }

    const liveQuestion = await LiveQuestion.findById(attempt.liveQuestion);
    if (!liveQuestion) {
      return res.status(404).json({ success: false, message: 'Live question not found' });
    }

    const question = liveQuestion.questions.id(questionId);
    if (!question) {
      return res.status(404).json({ success: false, message: 'Question not found' });
    }

    let isCorrect = false;
    let scoreObtained = 0;

    if (questionType === 'mcq') {
      isCorrect = checkMCQAnswer(question, answer);
      scoreObtained = isCorrect ? (question.mcqQuestionScore || 1) : 0;
    }

    const answerData = {
      questionId,
      questionType,
      answer,
      isCorrect,
      scoreObtained,
      timeSpent,
      submittedAt: new Date(),
    };

    const existingIdx = attempt.answers.findIndex(a => a.questionId.toString() === questionId);
    if (existingIdx > -1) {
      attempt.answers[existingIdx] = answerData;
    } else {
      attempt.answers.push(answerData);
    }

    attempt.totalScore = attempt.answers.reduce((sum, a) => sum + (a.scoreObtained || 0), 0);
    attempt.maxScore = liveQuestion.questions.reduce((sum, q) => {
      return sum + (q.questionType === 'mcq' ? (q.mcqQuestionScore || 1) : (q.score || 0));
    }, 0);
    attempt.percentageScore = attempt.maxScore > 0 ? (attempt.totalScore / attempt.maxScore) * 100 : 0;
    await attempt.save();

    const studentInfo = await getStudentInfo(studentId);
    const answeredCount = attempt.answers.length;
    const totalQuestions = liveQuestion.questions.length;

    const io = socketIO.getIO();
    io.to(`liveq-${liveQuestion._id}`).emit('answer-submitted', {
      studentId: studentId.toString(),
      studentName: studentInfo.name,
      studentEmail: studentInfo.email,
      attemptId: attempt._id.toString(),
      liveQuestionId: liveQuestion._id.toString(),
      questionId,
      isCorrect,
      scoreObtained,
      totalScore: attempt.totalScore,
      answeredCount,
      totalQuestions,
      // Q&A detail for live teacher dashboard
      studentAnswer: Array.isArray(answer) ? answer : [answer],
      correctAnswers: question.mcqQuestionCorrectAnswers || [],
      questionTitle: question.mcqQuestionTitle || '',
      options: (question.mcqQuestionOptions || []).map(o => ({ text: o.text, isCorrect: o.isCorrect })),
    });

    res.status(200).json({
      success: true,
      data: { isCorrect, scoreObtained, totalScore: attempt.totalScore, percentageScore: attempt.percentageScore },
      message: 'Answer submitted successfully',
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── Submit entire test ───────────────────────────────────────────────────────
exports.submitTest = async (req, res) => {
  try {
    const { attemptId } = req.params;
    const studentId = req.user._id;

    const attempt = await StudentResponse.findOne({
      _id: attemptId,
      student: studentId,
      status: 'in-progress',
    });

    if (!attempt) {
      return res.status(404).json({ success: false, message: 'Attempt not found or already completed' });
    }

    const liveQuestion = await LiveQuestion.findById(attempt.liveQuestion);

    attempt.status = 'completed';
    attempt.submittedAt = new Date();
    attempt.totalScore = attempt.answers.reduce((sum, a) => sum + (a.scoreObtained || 0), 0);
    attempt.maxScore = liveQuestion
      ? liveQuestion.questions.reduce((sum, q) => sum + (q.questionType === 'mcq' ? (q.mcqQuestionScore || 1) : (q.score || 0)), 0)
      : attempt.maxScore;
    attempt.percentageScore = attempt.maxScore > 0 ? (attempt.totalScore / attempt.maxScore) * 100 : 0;
    await attempt.save();

    if (liveQuestion) {
      await LiveQuestion.findByIdAndUpdate(liveQuestion._id, {
        $addToSet: { studentResponses: studentId },
      });
    }

    const studentInfo = await getStudentInfo(studentId);
    const totalQuestions = liveQuestion ? liveQuestion.questions.length : 0;
    const answeredCount = attempt.answers.length;

    const io = socketIO.getIO();
    io.to(`liveq-${attempt.liveQuestion}`).emit('test-completed', {
      studentId: studentId.toString(),
      studentName: studentInfo.name,
      studentEmail: studentInfo.email,
      attemptId: attempt._id.toString(),
      liveQuestionId: attempt.liveQuestion.toString(),
      totalScore: attempt.totalScore,
      maxScore: attempt.maxScore,
      percentageScore: attempt.percentageScore,
      submittedAt: attempt.submittedAt,
      answeredCount,
      totalQuestions,
    });

    res.status(200).json({ success: true, data: attempt, message: 'Test submitted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── Get all responses for a live question (staff view) ───────────────────────
exports.getResponses = async (req, res) => {
  try {
    const { liveQuestionId } = req.params;

    // Use 'LMS-User' which is your actual mongoose model name
    const responses = await StudentResponse.find({ liveQuestion: liveQuestionId })
      .populate({ path: 'student', model: 'LMS-User', select: 'firstName lastName email' })
      .sort('-updatedAt')
      .lean();

    const liveQuestion = await LiveQuestion.findById(liveQuestionId).lean();
    const totalQuestions = liveQuestion ? liveQuestion.questions.length : 0;

    // Normalize student info and add answeredCount
    const normalizedResponses = responses.map(r => {
      const firstName = r.student?.firstName || '';
      const lastName = r.student?.lastName || '';
      const studentName = `${firstName} ${lastName}`.trim() || r.student?.email || 'Unknown';
      return {
        ...r,
        student: {
          _id: r.student?._id,
          firstName,
          lastName,
          email: r.student?.email || '',
          name: studentName,
        },
        answeredCount: r.answers?.length || 0,
        totalQuestions,
      };
    });

    // Compute statistics
    const completed = normalizedResponses.filter(r => r.status === 'completed');
    const stats = {
      totalStudents: normalizedResponses.length,
      completedStudents: completed.length,
      inProgressStudents: normalizedResponses.filter(r => r.status === 'in-progress').length,
      averageScore:
        completed.length > 0
          ? completed.reduce((sum, r) => sum + (r.percentageScore || 0), 0) / completed.length
          : 0,
      highestScore: completed.length > 0 ? Math.max(...completed.map(r => r.percentageScore || 0)) : 0,
      lowestScore: completed.length > 0 ? Math.min(...completed.map(r => r.percentageScore || 0)) : 0,
      questionWiseAnalysis: {},
    };

    if (liveQuestion) {
      liveQuestion.questions.forEach((q, index) => {
        const qId = q._id.toString();
        const qResponses = normalizedResponses
          .flatMap(r => r.answers)
          .filter(a => a.questionId?.toString() === qId);

        stats.questionWiseAnalysis[qId] = {
          questionIndex: index + 1,
          title: q.questionType === 'mcq' ? q.mcqQuestionTitle : q.title,
          type: q.questionType,
          totalAttempts: qResponses.length,
          correctAnswers: qResponses.filter(a => a.isCorrect).length,
          averageTimeSpent:
            qResponses.length > 0
              ? qResponses.reduce((sum, a) => sum + (a.timeSpent || 0), 0) / qResponses.length
              : 0,
        };
      });
    }

    res.status(200).json({ success: true, data: { responses: normalizedResponses, statistics: stats } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── Get real-time analytics ──────────────────────────────────────────────────
exports.getRealtimeAnalytics = async (req, res) => {
  try {
    const { liveQuestionId } = req.params;

    const [activeStudents, completedStudents, recentSubmissions] = await Promise.all([
      StudentResponse.countDocuments({ liveQuestion: liveQuestionId, status: 'in-progress' }),
      StudentResponse.countDocuments({ liveQuestion: liveQuestionId, status: 'completed' }),
      StudentResponse.find({ liveQuestion: liveQuestionId, status: 'completed' })
        .sort('-submittedAt')
        .limit(10)
        .populate({ path: 'student', model: 'LMS-User', select: 'firstName lastName email' })
        .lean(),
    ]);

    res.status(200).json({
      success: true,
      data: {
        activeStudents,
        completedStudents,
        totalStudents: activeStudents + completedStudents,
        recentSubmissions,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── Helper: check MCQ answer ─────────────────────────────────────────────────
function checkMCQAnswer(question, studentAnswer) {
  if (!question.mcqQuestionCorrectAnswers || question.mcqQuestionCorrectAnswers.length === 0) return false;

  if (question.mcqQuestionType === 'multiple_choice' || question.mcqQuestionType === 'dropdown') {
    return question.mcqQuestionCorrectAnswers.includes(studentAnswer);
  }

  if (question.mcqQuestionType === 'checkboxes') {
    const studentAnswers = Array.isArray(studentAnswer) ? studentAnswer : [studentAnswer];
    const correctAnswers = question.mcqQuestionCorrectAnswers;
    return (
      studentAnswers.length === correctAnswers.length &&
      studentAnswers.every(a => correctAnswers.includes(a))
    );
  }

  if (question.mcqQuestionType === 'short_answer' || question.mcqQuestionType === 'essay') {
    return question.mcqQuestionCorrectAnswers.some(
      c => c.toLowerCase().trim() === String(studentAnswer).toLowerCase().trim()
    );
  }

  return false;
}