 
 
 
 
const Topic = require('../../../models/Courses/moduleStructure/topicModal');
 
// Create Topic
exports.createTopic = async (req, res) => {
  try {
    const {
      courses,
      subModuleId,
      moduleId,
      index,
      title,
      description,
      duration,
      createdBy,
      level,
      testConfiguration
    } = req.body;
 
    // Validation
    if (  !courses || !moduleId || !title) {
      return res.status(400).json({
        message: [{ key: 'error', value: 'Required fields are missing (institution, courses, moduleId, title)' }]
      });
    }
 
    const newTopic = new Topic({
      institution:req.user.institution,
      courses,
      moduleId,
      subModuleId,
      index,
      title,
      description,
      duration,
      level,
      testConfiguration: testConfiguration || { coreProgram: [], frontend: [], database: [] },
      createdBy: createdBy || req.user.email
    });
 
    const savedTopic = await newTopic.save();
 
    return res.status(201).json({
      message: [{ key: 'success', value: 'Topic created successfully' }],
      topic: savedTopic
    });
  } catch (err) {
    console.error("Error creating topic:", err);
    return res.status(500).json({ message: [{ key: 'error', value: 'Internal server error' }] });
  }
};
 
// Get All Topics
exports.getAllTopics = async (req, res) => {
  try {
    const topics = await Topic.find({ institution: req.user.institution })
 
    return res.status(200).json({
      message: [{ key: 'success', value: 'Topics retrieved successfully' }],
      topics
    });
  } catch (err) {
    console.error("Error fetching topics:", err);
    return res.status(500).json({ message: [{ key: 'error', value: 'Internal server error' }] });
  }
};
 
// Get Topic by ID
exports.getTopicById = async (req, res) => {
  try {
    const topic = await Topic.findById(req.params.id)
 
    if (!topic) {
      return res.status(404).json({ message: [{ key: 'error', value: 'Topic not found' }] });
    }
 
    return res.status(200).json({
      message: [{ key: 'success', value: 'Topic retrieved successfully' }],
      topic
    });
  } catch (err) {
    console.error("Error fetching topic by ID:", err);
    return res.status(500).json({ message: [{ key: 'error', value: 'Internal server error' }] });
  }
};
 
// Update Topic
exports.updateTopic = async (req, res) => {
  try {
    const updatedTopic = await Topic.findByIdAndUpdate(
      req.params.id,
      {
        ...req.body,
        updatedBy: req.user.email,
        updatedAt: Date.now()
      },
      { new: true }
    );
 
    if (!updatedTopic) {
      return res.status(404).json({ message: [{ key: 'error', value: 'Topic not found' }] });
    }
 
    return res.status(200).json({
      message: [{ key: 'success', value: 'Topic updated successfully' }],
      updatedTopic
    });
  } catch (err) {
    console.error("Error updating topic:", err);
    return res.status(500).json({ message: [{ key: 'error', value: 'Internal server error' }] });
  }
};
 
// Delete Topic
exports.deleteTopic = async (req, res) => {
  try {
    const deletedTopic = await Topic.findByIdAndDelete(req.params.id);
 
    if (!deletedTopic) {
      return res.status(404).json({ message: [{ key: 'error', value: 'Topic not found' }] });
    }
 
    return res.status(200).json({
      message: [{ key: 'success', value: 'Topic deleted successfully' }]
    });
  } catch (err) {
    console.error("Error deleting topic:", err);
    return res.status(500).json({ message: [{ key: 'error', value: 'Internal server error' }] });
  }
};
 
 