const mongoose = require("mongoose");
const ModuleStructure = require("../../models/Courses/moduleStructureModal");

exports.addElementToModuleStructure = async (req, res) => {
  try {
    const { courseId, courses, moduleId, subModuleId, topicId, action, data } = req.body;
    const courseRef = courseId || courses;
 
    // Convert string to ObjectId if it's a valid ObjectId string
    let queryValue = courseRef;
    if (mongoose.Types.ObjectId.isValid(courseRef)) {
      queryValue = new mongoose.Types.ObjectId(courseRef);
    }
 
    // Find existing structure or create new one
    let structure = await ModuleStructure.findOne({ courses: queryValue });
   
    if (!structure) {
      // Create new ModuleStructure document
      structure = new ModuleStructure({
        institution: req.user.institution,
        courses: queryValue,
        modules: [],
        pedagogies: [],
        createdBy: req.user?.id || 'system',
        updatedBy: req.user?.id || 'system'
      });
     
    }
 
    switch (action) {
      case "addModule":
        structure.modules.push(data);
        break;
 
      case "addTopic":
        {
          if (moduleId) {
            // Adding topic to main module
            const module = structure.modules.id(moduleId);
            if (!module) return res.status(404).json({ message: "Module not found" });
            module.topics.push(data);
          } else if (subModuleId) {
            // Adding topic to submodule - search across all modules
            let targetSubModule = null;
            for (const module of structure.modules) {
              const subModule = module.subModules.id(subModuleId);
              if (subModule) {
                targetSubModule = subModule;
                break;
              }
            }
            if (!targetSubModule) return res.status(404).json({ message: "SubModule not found" });
            targetSubModule.topics.push(data);
          } else {
            return res.status(400).json({ message: "Either moduleId or subModuleId is required for addTopic" });
          }
        }
        break;
 
      case "addSubTopic":
        {
          // Find topic by ID across all modules and submodules
          let targetTopic = null;
         
          // Search in main modules
          for (const module of structure.modules) {
            const topic = module.topics.id(topicId);
            if (topic) {
              targetTopic = topic;
              break;
            }
           
            // Search in submodules
            for (const subModule of module.subModules) {
              const subTopic = subModule.topics.id(topicId);
              if (subTopic) {
                targetTopic = subTopic;
                break;
              }
            }
            if (targetTopic) break;
          }
         
          if (!targetTopic) return res.status(404).json({ message: "Topic not found" });
          targetTopic.subTopics.push(data);
        }
        break;
 
      case "addSubModule":
        {
          const module = structure.modules.id(moduleId);
          if (!module) return res.status(404).json({ message: "Module not found" });
          module.subModules.push(data);
        }
        break;
 
      case "addSubModuleTopic":
        {
          // Find submodule across all modules
          let targetSubModule = null;
          for (const module of structure.modules) {
            const subModule = module.subModules.id(subModuleId);
            if (subModule) {
              targetSubModule = subModule;
              break;
            }
          }
          if (!targetSubModule) return res.status(404).json({ message: "SubModule not found" });
          targetSubModule.topics.push(data);
        }
        break;
 
      case "addSubModuleSubTopic":
        {
          // Find submodule across all modules
          let targetSubModule = null;
          for (const module of structure.modules) {
            const subModule = module.subModules.id(subModuleId);
            if (subModule) {
              targetSubModule = subModule;
              break;
            }
          }
          if (!targetSubModule) return res.status(404).json({ message: "SubModule not found" });
         
          const topic = targetSubModule.topics.id(topicId);
          if (!topic) return res.status(404).json({ message: "Topic not found in SubModule" });
          topic.subTopics.push(data);
        }
        break;
 
      case "addPedagogy":
        {
          // Handle both single object and array of objects
          if (Array.isArray(data)) {
            // If data is an array, add each pedagogy
            data.forEach(pedagogy => {
              structure.pedagogies.push(pedagogy);
            });
          } else {
            // If data is a single object, add it directly
            structure.pedagogies.push(data);
          }
        }
        break;
 
      default:
        return res.status(400).json({ message: "Invalid action" });
    }
 
    // Update the updatedAt and updatedBy fields
    structure.updatedAt = new Date();
    structure.updatedBy = req.user?.id || 'system';
 
    await structure.save();
   
    return res.status(200).json({
      message: "Element added successfully",
      structure,
      isNewStructure: structure.isNew
    });
  } catch (error) {
    console.error("Error adding element:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};
 
// Update specific element in Module Structure (action-based, like addElementToModuleStructure)
exports.updateElementInModuleStructure = async (req, res) => {
  try {
    const { courseId, moduleId, subModuleId, topicId, subtopicId, action, data } = req.body;
    
    // Validate required fields
    if (!courseId) {
      return res.status(400).json({ message: "courseId is required" });
    }
    if (!action) {
      return res.status(400).json({ message: "action is required" });
    }
    if (!data) {
      return res.status(400).json({ message: "data is required" });
    }

    // Find the existing structure
    const structure = await ModuleStructure.findOne({ 
      courses: mongoose.Types.ObjectId.isValid(courseId) 
        ? new mongoose.Types.ObjectId(courseId) 
        : courseId
    });

    if (!structure) {
      return res.status(404).json({ message: "Module structure not found for this course" });
    }

    // Helper function to find elements
    const findElement = {
      module: () => structure.modules.id(moduleId),
      subModule: () => {
        const module = findElement.module();
        return module?.subModules.id(subModuleId);
      },
      topic: () => {
        const module = findElement.module();
        const subModule = findElement.subModule();
        
        // Check in module topics
        if (module && topicId) {
          const topic = module.topics.id(topicId);
          if (topic) return topic;
        }
        
        // Check in submodule topics
        if (subModule && topicId) {
          return subModule.topics.id(topicId);
        }
        
        return null;
      },
      subtopic: () => {
        const topic = findElement.topic();
        return topic?.subTopics.id(subtopicId);
      }
    };

    // Update logic based on action
    switch (action) {
      case "updateModule":
        {
          const module = findElement.module();
          if (!module) return res.status(404).json({ message: "Module not found" });
          module.set(data);
        }
        break;

      case "updateSubModule":
        {
          const subModule = findElement.subModule();
          if (!subModule) return res.status(404).json({ message: "SubModule not found" });
          subModule.set(data);
        }
        break;

      case "updateTopic":
        {
          const topic = findElement.topic();
          if (!topic) return res.status(404).json({ message: "Topic not found" });
          topic.set(data);
        }
        break;

      case "updateSubTopic":
        {
          const subtopic = findElement.subtopic();
          if (!subtopic) return res.status(404).json({ message: "SubTopic not found" });
          subtopic.set(data);
        }
        break;

      case "updatePedagogy":
        {
          if (!data._id) {
            return res.status(400).json({ message: "Pedagogy _id is required for update" });
          }
          
          const pedagogy = structure.pedagogies.id(data._id);
          if (!pedagogy) {
            return res.status(404).json({ message: "Pedagogy not found" });
          }
          
          pedagogy.set(data);
        }
        break;

      case "reorderElements":
        {
          // Data should contain { elementType, parentId, newOrder }
          const { elementType, parentId, newOrder } = data;
          
          if (!elementType || !parentId || !newOrder) {
            return res.status(400).json({ message: "elementType, parentId, and newOrder are required" });
          }

          let parentElement;
          let elementsArray;

          switch (elementType) {
            case "module":
              elementsArray = structure.modules;
              break;
            case "subModule":
              const module = findElement.module();
              if (!module) return res.status(404).json({ message: "Parent module not found" });
              elementsArray = module.subModules;
              break;
            case "topic":
              const moduleForTopic = findElement.module();
              const subModuleForTopic = findElement.subModule();
              
              if (moduleForTopic?.topics) {
                elementsArray = moduleForTopic.topics;
              } else if (subModuleForTopic?.topics) {
                elementsArray = subModuleForTopic.topics;
              } else {
                return res.status(404).json({ message: "Parent for topic not found" });
              }
              break;
            case "subTopic":
              const topic = findElement.topic();
              if (!topic) return res.status(404).json({ message: "Parent topic not found" });
              elementsArray = topic.subTopics;
              break;
            default:
              return res.status(400).json({ message: "Invalid elementType" });
          }

          // Validate new order
          if (newOrder.some(id => !elementsArray.id(id))) {
            return res.status(400).json({ message: "Invalid IDs in newOrder array" });
          }

          // Reorder the elements
          const sortedElements = newOrder.map(id => elementsArray.id(id)).filter(Boolean);
          elementsArray.splice(0, elementsArray.length, ...sortedElements);
        }
        break;

      default:
        return res.status(400).json({ message: "Invalid action" });
    }

    // Update metadata
    structure.updatedAt = new Date();
    structure.updatedBy = req.user?.id || 'system';

    // Validate before saving
    try {
      await structure.validate();
    } catch (validationError) {
      return res.status(400).json({ 
        message: "Validation failed",
        error: validationError.message 
      });
    }

    await structure.save();

    return res.status(200).json({
      message: "Element updated successfully",
      structure
    });

  } catch (error) {
    console.error("Error updating element:", error);
    
    if (error.name === 'CastError') {
      return res.status(400).json({ message: "Invalid ID format" });
    }
    
    return res.status(500).json({ 
      message: "Internal server error",
      error: error.message 
    });
  }
};

exports.deleteElementFromModuleStructure = async (req, res) => {
  try {
    const {
      courseId,
      moduleId,
      subModuleId,
      topicId,
      subtopicId,
      action,
      targetId,
      elementType, // for pedagogy
    } = req.body;
 
    // Validation
    if (!courseId) return res.status(400).json({ message: "courseId is required" });
    if (!action) return res.status(400).json({ message: "action is required" });
    if (!targetId) return res.status(400).json({ message: "targetId is required for deletion" });
 
    const structure = await ModuleStructure.findOne({
      courses: mongoose.Types.ObjectId.isValid(courseId)
        ? new mongoose.Types.ObjectId(courseId)
        : courseId,
    });
 
    if (!structure) {
      return res.status(404).json({ message: "Module structure not found for this course" });
    }
 
    // Helper functions
    const findElement = {
      module: () => structure.modules.find(m => m._id.toString() === moduleId),
      subModule: () => {
        const module = findElement.module();
        return module?.subModules.find(sm => sm._id.toString() === subModuleId);
      },
      topic: () => {
        const module = findElement.module();
        const subModule = findElement.subModule();
        if (module && topicId) return module.topics.find(t => t._id.toString() === topicId);
        if (subModule && topicId) return subModule.topics.find(t => t._id.toString() === topicId);
        return null;
      },
      subtopic: () => findElement.topic()?.subTopics.find(st => st._id.toString() === subtopicId),
    };
 
    // Deletion Logic
    switch (action) {
      case "deleteModule":
        {
          const index = structure.modules.findIndex(m => m._id.toString() === targetId);
          if (index === -1) return res.status(404).json({ message: "Module not found" });
          structure.modules.splice(index, 1);
          structure.markModified('modules');
        }
        break;
 
      case "deleteSubModule":
        {
          const module = findElement.module();
          if (!module) return res.status(404).json({ message: "Parent module not found" });
 
          const index = module.subModules.findIndex(sm => sm._id.toString() === targetId);
          if (index === -1) return res.status(404).json({ message: "SubModule not found" });
 
          module.subModules.splice(index, 1);
          structure.markModified('modules');
        }
        break;
 
      case "deleteTopic":
        {
          const module = findElement.module();
          const subModule = findElement.subModule();
 
          let topicIndex = -1;
          if (module?.topics) {
            topicIndex = module.topics.findIndex(t => t._id.toString() === targetId);
            if (topicIndex !== -1) {
              module.topics.splice(topicIndex, 1);
              structure.markModified('modules');
              break;
            }
          }
 
          if (subModule?.topics) {
            topicIndex = subModule.topics.findIndex(t => t._id.toString() === targetId);
            if (topicIndex !== -1) {
              subModule.topics.splice(topicIndex, 1);
              structure.markModified('modules');
              break;
            }
          }
 
          return res.status(404).json({ message: "Topic not found" });
        }
 
      case "deleteSubTopic":
        {
          const topic = findElement.topic();
          if (!topic) return res.status(404).json({ message: "Parent topic not found" });
 
          const index = topic.subTopics.findIndex(st => st._id.toString() === targetId);
          if (index === -1) return res.status(404).json({ message: "SubTopic not found" });
 
          topic.subTopics.splice(index, 1);
          structure.markModified('modules');
        }
        break;
 
      case "deletePedagogy":
        {
          if (!elementType) {
            return res.status(400).json({ message: "elementType is required for pedagogy deletion" });
          }
 
          const validTypes = ["iDo", "weDo", "youDo"];
          if (!validTypes.includes(elementType)) {
            return res.status(400).json({ message: "Invalid elementType. Must be one of: iDo, weDo, youDo" });
          }
 
          const pedagogy = structure.pedagogies.find(p =>
            Array.isArray(p[elementType]) &&
            p[elementType].some(el => el._id?.toString() === targetId)
          );
 
          if (!pedagogy) {
            return res.status(404).json({ message: `No pedagogy found containing the ${elementType} with given targetId` });
          }
 
          pedagogy[elementType] = pedagogy[elementType].filter(el => el._id?.toString() !== targetId);
          pedagogy.updatedAt = new Date();
          structure.markModified('pedagogies');
        }
        break;
 
      default:
        return res.status(400).json({ message: "Invalid action" });
    }
 
    // Update metadata and save
    structure.updatedAt = new Date();
    structure.updatedBy = req.user?.id || 'system';
 
    await structure.save();
 
    return res.status(200).json({
      message: "Element deleted successfully",
      structure,
    });
 
  } catch (error) {
    console.error("Error deleting element:", error);
    if (error.name === "CastError") {
      return res.status(400).json({ message: "Invalid ID format" });
    }
    return res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
};
 
 
 
 

// Get All Module Structures
exports.getAllModuleStructures = async (req, res) => {
  try {
    const moduleStructures = await ModuleStructure.find()
      .populate('courses') // Ensure courses are populated if needed
      .lean();

    return res.status(200).json(moduleStructures); // Return array directly
  } catch (error) {
    console.error("Error fetching all module structures:", error);
    return res.status(500).json([]); // Return empty array on error
  }
};
// Get Module Structure by ID
exports.getModuleStructureById = async (req, res) => {
  try {
    const { id } = req.params;

    const moduleStructure = await ModuleStructure.findById(id)
      .populate("institution")
      .populate("courses");

    if (!moduleStructure) {
      return res.status(404).json({ error: "Module structure not found" });
    }

    return res.status(200).json({
      message: "Module structure fetched successfully",
      data: moduleStructure,
    });
  } catch (error) {
    console.error("Error fetching module structure by ID:", error);
    return res.status(500).json({ error: "Failed to fetch module structure" });
  }
};

// Update Module Structure
exports.updateModuleStructure = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      institution,
      courses,
      modules,
      pedagogies,
      updatedBy,
    } = req.body;

    const sanitizedPedagogies = (pedagogies || []).map(ped => ({
      ...ped,
      iDo: (ped.iDo || []).map(i => ({ ...i, duration: Number(i.duration) })),
      weDo: (ped.weDo || []).map(w => ({ ...w, duration: Number(w.duration) })),
      youDo: (ped.youDo || []).map(y => ({ ...y, duration: Number(y.duration) })),
    }));

    const updated = await ModuleStructure.findByIdAndUpdate(
      id,
      {
        institution,
        courses,
        modules,
        pedagogies: sanitizedPedagogies,
        updatedBy,
        updatedAt: new Date(),
      },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ error: "Module structure not found" });
    }

    return res.status(200).json({
      message: "Module structure updated successfully",
      data: updated,
    });
  } catch (error) {
    console.error("Error updating module structure:", error);
    return res.status(500).json({ error: "Failed to update module structure" });
  }
};

// Delete Module Structure
exports.deleteModuleStructure = async (req, res) => {
  try {
    const { id } = req.params;

    // Validate ID format
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        message: [{ key: "error", value: "Invalid module structure ID format" }],
      });
    }

    // Find and delete structure
    const deletedStructure = await ModuleStructure.findOneAndDelete({
      _id: id,
      institution: req.user.institution
    });

    if (!deletedStructure) {
      return res.status(404).json({
        message: [{ key: "error", value: "Module structure not found" }],
      });
    }

    return res.status(200).json({
      message: [{ key: "success", value: "Module structure deleted successfully" }],
      data: {
        deletedId: id,
        deletedTitle: deletedStructure.modules[0]?.title || "Unknown"
      }
    });
  } catch (error) {
    console.error("Error deleting module structure:", error);
    return res.status(500).json({
      message: [{ key: "error", value: "Server error while deleting module structure" }],
    });
  }
};


// Create Module Structure
exports.createModuleStructure = async (req, res) => {
  try {
    const {
      institution,
      courses,
      modules,
      pedagogies,
      createdBy,
      updatedBy,
    } = req.body;

    // Sanitize pedagogy durations from string to number (if needed)
    const sanitizedPedagogies = (pedagogies || []).map(ped => ({
      ...ped,
      iDo: (ped.iDo || []).map(i => ({ ...i, duration: Number(i.duration) })),
      weDo: (ped.weDo || []).map(w => ({ ...w, duration: Number(w.duration) })),
      youDo: (ped.youDo || []).map(y => ({ ...y, duration: Number(y.duration) })),
    }));

    const newStructure = new ModuleStructure({
      institution,
      courses,
      modules,
      pedagogies: sanitizedPedagogies,
      createdBy,
      updatedBy,
    });

    await newStructure.save();
    return res.status(201).json({ message: "Module structure created successfully", data: newStructure });
  } catch (error) {
    console.error("Error creating module structure:", error);
    return res.status(500).json({ error: "Failed to create module structure" });
  }
};
