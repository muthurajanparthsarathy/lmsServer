const QuestionDraft = require("../models/QuestionDraftModel");

// Sanitize incoming file array — strip empties, force string types, drop noise.
function sanitizeFiles(rawFiles) {
  if (!Array.isArray(rawFiles)) return [];
  return rawFiles
    .map((f) => {
      const path = String(f?.path || f?.name || "").replace(/^\/+/, "");
      if (!path) return null;
      const name = path.split("/").pop() || "";
      return {
        name,
        path: "/" + path,
        content: String(f?.content ?? ""),
      };
    })
    .filter(Boolean);
}

// Sanitize incoming folder array — keep only a clean {name, path} per folder.
function sanitizeFolders(rawFolders) {
  if (!Array.isArray(rawFolders)) return [];
  const seen = new Set();
  return rawFolders
    .map((f) => {
      const path = String(f?.path || "").replace(/^\/+/, "").replace(/\/+$/, "");
      if (!path || seen.has(path)) return null;
      seen.add(path);
      const name = path.split("/").pop() || "";
      return { name, path: "/" + path };
    })
    .filter(Boolean);
}

// POST /draft/save
// Body: { exerciseId, questionId, language?, files: [{ path, content }], folders?: [{ path }] }
// Auth: userAuth — userId comes from req.user, never the body.
exports.saveDraft = async (req, res) => {
  try {
    const userId = req.user?._id;
    const { exerciseId, questionId, language, files, folders } = req.body || {};

    if (!userId) {
      return res.status(401).json({ success: false, message: "Not authenticated" });
    }
    if (!exerciseId || !questionId) {
      return res.status(400).json({
        success: false,
        message: "exerciseId and questionId are required",
      });
    }

    const safeFiles = sanitizeFiles(files);
    const safeFolders = sanitizeFolders(folders);

    const doc = await QuestionDraft.findOneAndUpdate(
      { userId, exerciseId: String(exerciseId), questionId: String(questionId) },
      {
        $set: {
          language: language || "python",
          files: safeFiles,
          folders: safeFolders,
          updatedAt: Date.now(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.status(200).json({ success: true, draft: doc });
  } catch (err) {
    console.error("[questionDraft.save]", err);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

// GET /draft/load?exerciseId=...&questionId=...
// Auth: userAuth — only returns the caller's own draft.
exports.loadDraft = async (req, res) => {
  try {
    const userId = req.user?._id;
    const { exerciseId, questionId } = req.query || {};

    if (!userId) {
      return res.status(401).json({ success: false, message: "Not authenticated" });
    }
    if (!exerciseId || !questionId) {
      return res.status(400).json({
        success: false,
        message: "exerciseId and questionId are required",
      });
    }

    const doc = await QuestionDraft.findOne({
      userId,
      exerciseId: String(exerciseId),
      questionId: String(questionId),
    });

    if (!doc) {
      return res.status(200).json({ success: true, draft: { files: [], folders: [] } });
    }
    return res.status(200).json({ success: true, draft: doc });
  } catch (err) {
    console.error("[questionDraft.load]", err);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

// DELETE /draft/clear?exerciseId=...&questionId=...
// Optional housekeeping endpoint — wipes a draft (e.g. after final submit).
exports.clearDraft = async (req, res) => {
  try {
    const userId = req.user?._id;
    const { exerciseId, questionId } = req.query || {};

    if (!userId) {
      return res.status(401).json({ success: false, message: "Not authenticated" });
    }
    if (!exerciseId || !questionId) {
      return res.status(400).json({
        success: false,
        message: "exerciseId and questionId are required",
      });
    }

    await QuestionDraft.deleteOne({
      userId,
      exerciseId: String(exerciseId),
      questionId: String(questionId),
    });
    return res.status(200).json({ success: true, cleared: true });
  } catch (err) {
    console.error("[questionDraft.clear]", err);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};
