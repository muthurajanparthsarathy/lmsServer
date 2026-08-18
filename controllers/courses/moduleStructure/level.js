const LevelView = require("../../../models/Courses/moduleStructure/levelModel");
const mongoose = require("mongoose");

// Create a new LevelView
exports.createlevelView = async (req, res) => {
  try {
    const { courses, levels } = req.body;

    if (!courses || !levels || !Array.isArray(levels)) {
      return res.status(400).json({
        message: [
          {
            key: "error",
            value: "Required fields are missing (institution, courses, levels)",
          },
        ],
      });
    }

    const newPedagogy = new LevelView({
      institution: req.user.institution,
      courses,
      levels,
      createdBy: req.user.email,
    });

    const savedLevels = await newPedagogy.save();

    return res.status(201).json({
      message: [{ key: "success", value: "LevelView created successfully" }],
      levelsView: savedLevels,
    });
  } catch (err) {
    console.error("Error creating LevelView:", err);
    return res
      .status(500)
      .json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};

exports.getAlllevelsViews = async (req, res) => {
  try {
    const levels = await LevelView.find();

    return res.status(200).json({
      message: [{ key: "success", value: "Level view retrieved successfully" }],
      levelsViews: levels,
    });
  } catch (err) {
    console.error("Error retrieving levelsView:", err);
    return res
      .status(500)
      .json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};

exports.getLevelViewById = async (req, res) => {
  try {
    const level = await LevelView.findById(req.params.id);

    if (!level) {
      return res
        .status(404)
        .json({ message: [{ key: "error", value: "levelView not found" }] });
    }

    return res.status(200).json({
      message: [{ key: "success", value: "levelView retrieved successfully" }],
      levelViewByid: level,
    });
  } catch (err) {
    console.error("Error retrieving levelView by ID:", err);
    return res
      .status(500)
      .json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};

exports.updateLevelView = async (req, res) => {
  try {
    const { documentId } = req.params; // Changed from levelId to documentId
    const updateData = req.body;

    // Validate document ID
    if (!mongoose.isValidObjectId(documentId)) {
      return res.status(400).json({
        message: [{ key: "error", value: "Invalid document ID" }],
      });
    }

    // Find the LevelView document by its main _id
    const levelView = await LevelView.findById(documentId);

    if (!levelView) {
      return res.status(404).json({
        message: [{ key: "error", value: "Document not found" }],
      });
    }

    // Check if there are levels to update
    if (!levelView.levels || levelView.levels.length === 0) {
      return res.status(404).json({
        message: [{ key: "error", value: "No levels found in document" }],
      });
    }

    // Helper function to safely update level data
    const updateLevelData = (existingLevel, newData) => {
      const updatedLevel = { ...existingLevel.toObject() };

      // Only update fields that are provided in newData
      Object.keys(newData).forEach((key) => {
        if (
          newData[key] !== undefined &&
          key !== "_id" &&
          key !== "createdAt"
        ) {
          updatedLevel[key] = newData[key];
        }
      });

      updatedLevel.updatedAt = new Date();
      return updatedLevel;
    };

    // Helper function to process new levels array
    const processLevelsArray = (levelsArray) => {
      return levelsArray.map((level) => {
        // If level has an _id, it's an existing level - preserve its data
        if (level._id) {
          return {
            ...level,
            updatedAt: new Date(),
          };
        } else {
          // If no _id, it's a new level - generate one
          return {
            ...level,
            _id: new mongoose.Types.ObjectId(),
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        }
      });
    };

    // Option 1: Replace entire levels array (when levels array is provided)
    if (updateData.levels && Array.isArray(updateData.levels)) {
      levelView.levels = processLevelsArray(updateData.levels);
    }
    // Option 2: Update all levels in the document
    else if (updateData.updateAll) {
      levelView.levels = levelView.levels.map((level) =>
        updateLevelData(level, updateData.levelData)
      );
    }
    // Option 3: Update specific level by index
    else if (updateData.levelIndex !== undefined) {
      const levelIndex = updateData.levelIndex;

      if (levelIndex < 0 || levelIndex >= levelView.levels.length) {
        return res.status(400).json({
          message: [{ key: "error", value: "Invalid level index" }],
        });
      }

      levelView.levels[levelIndex] = updateLevelData(
        levelView.levels[levelIndex],
        updateData.levelData
      );
    }
    // Option 4: Update specific level by level ID
    else if (updateData.levelId) {
      const levelIndex = levelView.levels.findIndex(
        (l) => l._id.toString() === updateData.levelId
      );

      if (levelIndex === -1) {
        return res.status(404).json({
          message: [{ key: "error", value: "Level not found in document" }],
        });
      }

      levelView.levels[levelIndex] = updateLevelData(
        levelView.levels[levelIndex],
        updateData.levelData
      );
    }
    // Option 5: Add new level to the document
    else if (updateData.addLevel) {
      // Validate required fields for new level
      if (!updateData.levelData.level) {
        return res.status(400).json({
          message: [
            { key: "error", value: "Level field is required for new level" },
          ],
        });
      }

      const newLevel = {
        ...updateData.levelData,
        _id: new mongoose.Types.ObjectId(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      levelView.levels.push(newLevel);
    }
    // Option 6: Update the first level (default behavior)
    else {
      levelView.levels[0] = updateLevelData(levelView.levels[0], updateData);
    }

    // Update document metadata
    levelView.updatedBy = req.user.email;
    levelView.updatedAt = new Date();
    levelView.markModified("levels");

    const saved = await levelView.save();

    return res.status(200).json({
      message: [{ key: "success", value: "Document updated successfully" }],
      document: saved,
    });
  } catch (err) {
    console.error("Error updating document:", err);
    return res.status(500).json({
      message: [{ key: "error", value: "Internal server error" }],
    });
  }
};  

// Alternative simpler version if you just want to update the first level

exports.deleteLevelView = async (req, res) => {
  try {
    const levelId = req.params.id;

    if (!mongoose.Types.ObjectId.isValid(levelId)) {
      return res.status(400).json({
        message: [{ key: "error", value: "Invalid level ID" }],
      });
    }

    // First find the document containing the level
    const levelViewDoc = await LevelView.findOne({ "levels._id": levelId });

    if (!levelViewDoc) {
      return res.status(404).json({
        message: [{ key: "error", value: "Level not found" }],
      });
    }

    // Check if this is the last level in the array
    const isLastLevel = levelViewDoc.levels.length === 1;

    if (isLastLevel) {
      // If it's the last level, delete the entire document
      await LevelView.findByIdAndDelete(levelViewDoc._id);
      return res.status(200).json({
        message: [{ 
          key: "success", 
          value: "Level deleted successfully and document removed as it was the last level" 
        }],
        deletedDocument: true
      });
    } else {
      // Otherwise, just remove the level from the array
      const updatedDoc = await LevelView.findOneAndUpdate(
        { "levels._id": levelId },
        { 
          $pull: { levels: { _id: levelId } }, 
          $set: { updatedAt: new Date() } 
        },
        { new: true }
      );

      return res.status(200).json({
        message: [{ key: "success", value: "Level deleted successfully" }],
        updatedLevels: updatedDoc,
      });
    }
  } catch (err) {
    console.error("Error deleting level:", err);
    return res.status(500).json({
      message: [{ key: "error", value: "Internal server error" }],
    });
  }
};
