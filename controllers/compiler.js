const Compiler = require("../models/CompilerModel");

// Save or update code for a user-course-language with versioning
exports.saveCompiler = async (req, res) => {
  try {
    const { userId, courseId, language, code } = req.body;

    if (!userId || !courseId || !language || !code) {
      return res.status(400).json({
        message: [{ key: "error", value: "Required fields are missing" }],
      });
    }

    let compilerDoc = await Compiler.findOne({ userId });

    if (!compilerDoc) {
      // First submission for this user
      compilerDoc = new Compiler({
        userId,
        courses: [
          {
            courseId,
            submissions: [{ language, code, version: 1 }],
          },
        ],
      });
    } else {
      // Find course inside user's compiler doc
      let course = compilerDoc.courses.find(
        (c) => c.courseId.toString() === courseId
      );

      if (!course) {
        // First submission for this course
        compilerDoc.courses.push({
          courseId,
          submissions: [{ language, code, version: 1 }],
        });
      } else {
        // Find existing submission for this language
        let submission = course.submissions.find(
          (s) => s.language === language
        );

        if (submission) {
          // Update existing one → increment version
          submission.version += 1;
          submission.code = code;
          submission.createdAt = Date.now();
        } else {
          // First submission for this language
          course.submissions.push({
            language,
            code,
            version: 1,
          });
        }
      }

      compilerDoc.updatedAt = Date.now();
    }

    await compilerDoc.save();

    return res.status(201).json({
      success: true,
      compiler: compilerDoc,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      message: [{ key: "error", value: "Internal Server Error" }],
    });
  }
};


exports.getUserIdCompiler = async (req, res) => {
  try {
    const { userId, courseId } = req.params;

    const compilerDoc = await Compiler.findOne({ userId });

    if (!compilerDoc) {
      return res.status(404).json({
        message: [{ key: "error", value: "No compiler data found for user" }],
      });
    }

    const course = compilerDoc.courses.find(c => c.courseId.toString() === courseId);

    if (!course) {
      return res.status(404).json({
        message: [{ key: "error", value: "No submissions found for this course" }],
      });
    }

    return res.status(200).json({
      success: true,
      courseId,
      submissions: course.submissions
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      message: [{ key: "error", value: "Internal Server Error" }],
    });
  }
};
