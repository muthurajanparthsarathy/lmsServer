 
 
const SubTopic = require('../../../models/Courses/moduleStructure/subTopicModal');
 
// Create a new SubTopic
exports.createSubTopic = async (req, res) => {
  try {
    const {
      institution,
      courses,
      topicId,
      index,
      title,
      description,
      duration,
      level,
      testConfiguration
    } = req.body;
 
    // Validation
    if (  !courses || !topicId || !title) {
      return res.status(400).json({
        message: [{ key: 'error', value: 'Required fields are missing (institution, courses, topicId, title)' }]
      });
    }
 
    const newSubTopic = new SubTopic({
      institution:req.user.institution,
      courses,
      topicId,
      index,
      title,
      description,
      duration,
      level,
      testConfiguration: testConfiguration || { coreProgram: [], frontend: [], database: [] },
      createdBy: req.user.email
    });
 
    const savedSubTopic = await newSubTopic.save();
 
    return res.status(201).json({
      message: [{ key: 'success', value: 'SubTopic created successfully' }],
      subTopic: savedSubTopic
    });
  } catch (err) {
    console.error("Error creating SubTopic:", err);
    return res.status(500).json({ message: [{ key: 'error', value: 'Internal server error' }] });
  }
};
 
// Get all SubTopics
exports.getAllSubTopics = async (req, res) => {
  try {
    const subTopics = await SubTopic.find({ institution: req.user.institution })
 
    return res.status(200).json({
      message: [{ key: 'success', value: 'SubTopics retrieved successfully' }],
      subTopics
    });
  } catch (err) {
    console.error("Error fetching SubTopics:", err);
    return res.status(500).json({ message: [{ key: 'error', value: 'Internal server error' }] });
  }
};
 
// Get SubTopic by ID
exports.getSubTopicById = async (req, res) => {
  try {
    const subTopic = await SubTopic.findById(req.params.id)
   
 
    if (!subTopic) {
      return res.status(404).json({ message: [{ key: 'error', value: 'SubTopic not found' }] });
    }
 
    return res.status(200).json({
      message: [{ key: 'success', value: 'SubTopic retrieved successfully' }],
      subTopic
    });
  } catch (err) {
    console.error("Error retrieving SubTopic by ID:", err);
    return res.status(500).json({ message: [{ key: 'error', value: 'Internal server error' }] });
  }
};
 
// Update SubTopic
exports.updateSubTopic = async (req, res) => {
  try {
    const updatedSubTopic = await SubTopic.findByIdAndUpdate(
      req.params.id,
      {
        ...req.body,
        updatedBy: req.user.email,
        updatedAt: Date.now()
      },
      { new: true }
    );
 
    if (!updatedSubTopic) {
      return res.status(404).json({ message: [{ key: 'error', value: 'SubTopic not found' }] });
    }
 
    return res.status(200).json({
      message: [{ key: 'success', value: 'SubTopic updated successfully' }],
      updatedSubTopic
    });
  } catch (err) {
    console.error("Error updating SubTopic:", err);
    return res.status(500).json({ message: [{ key: 'error', value: 'Internal server error' }] });
  }
};
 
// Delete SubTopic
exports.deleteSubTopic = async (req, res) => {
  try {
    const deletedSubTopic = await SubTopic.findByIdAndDelete(req.params.id);
 
    if (!deletedSubTopic) {
      return res.status(404).json({ message: [{ key: 'error', value: 'SubTopic not found' }] });
    }
 
    return res.status(200).json({
      message: [{ key: 'success', value: 'SubTopic deleted successfully' }]
    });
  } catch (err) {
    console.error("Error deleting SubTopic:", err);
    return res.status(500).json({ message: [{ key: 'error', value: 'Internal server error' }] });
  }
};
 
 