const StudentWorkspace = require("../models/StudentWorkspaceModel");

// Upsert the most recent files for (userId, courseId). Called by Vercel after
// every successful agent write so the workspace survives Railway redeploys.
exports.saveWorkspace = async (req, res) => {
  try {
    const { userId, courseId, language, files } = req.body;

    if (!userId || !Array.isArray(files)) {
      return res.status(400).json({
        message: [{ key: "error", value: "userId and files[] required" }],
      });
    }

    const safeFiles = files
      .map((f) => ({
        name:    String(f.name || f.path || "").split("/").pop() || "",
        path:    String(f.path || f.name || ""),
        content: String(f.content || ""),
      }))
      .filter((f) => f.name && f.path);

    const doc = await StudentWorkspace.findOneAndUpdate(
      { userId, courseId: courseId || "default" },
      {
        $set: {
          language: language || "python",
          files: safeFiles,
          updatedAt: Date.now(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.status(200).json({ success: true, workspace: doc });
  } catch (err) {
    console.error("[studentWorkspace.save]", err);
    return res.status(500).json({
      message: [{ key: "error", value: "Internal Server Error" }],
    });
  }
};

// Fetch the saved workspace for a (userId, courseId). Vercel calls this when
// the agent reports an empty folder (cold start) so the student sees their
// last work.
exports.getWorkspace = async (req, res) => {
  try {
    const { userId, courseId } = req.params;

    if (!userId) {
      return res.status(400).json({
        message: [{ key: "error", value: "userId required" }],
      });
    }

    const doc = await StudentWorkspace.findOne({
      userId,
      courseId: courseId || "default",
    });

    if (!doc) {
      return res.status(200).json({ success: true, workspace: { files: [] } });
    }

    return res.status(200).json({ success: true, workspace: doc });
  } catch (err) {
    console.error("[studentWorkspace.get]", err);
    return res.status(500).json({
      message: [{ key: "error", value: "Internal Server Error" }],
    });
  }
};
