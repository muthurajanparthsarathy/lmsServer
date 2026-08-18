 
 
const SubModule = require('../../../models/Courses/moduleStructure/subModuleModal');
 
// Create SubModule
exports.createSubModule = async (req, res) => {
  try {
    const {
      courses,
      moduleId,
      index,
      title,
      description,
      duration,
      level,
      createdBy,
      testConfiguration
    } = req.body;
 
    // Validation
    if (  !courses || !moduleId || !title) {
      return res.status(400).json({
        message: [{ key: 'error', value: 'Required fields are missing (institution, courses, moduleId, title)' }]
      });
    }
 
    const newSubModule = new SubModule({
      institution:req.user.institution,
      courses,
      moduleId,
      index,
      title,
      description,
      duration,
      level,
      testConfiguration: testConfiguration || { coreProgram: [], frontend: [], database: [] },
      createdBy:req.user.email
    });
 
    const savedSubModule = await newSubModule.save();
 
    return res.status(201).json({
      message: [{ key: 'success', value: 'SubModule created successfully' }],
      subModule: savedSubModule
    });
  } catch (error) {
    console.error("Error creating SubModule:", error);
    return res.status(500).json({ message: [{ key: 'error', value: 'Internal server error' }] });
  }
};
 
// Get All SubModules
exports.getAllSubModules = async (req, res) => {
  try {
    const subModules = await SubModule.find({institution: req.user.institution,})
     
 
    return res.status(200).json({
      message: [{ key: 'success', value: 'SubModules retrieved successfully' }],
      subModules
    });
  } catch (error) {
    console.error("Error fetching SubModules:", error);
    return res.status(500).json({ message: [{ key: 'error', value: 'Internal server error' }] });
  }
};
 
// Get SubModule by ID
exports.getSubModuleById = async (req, res) => {
  try {
    const subModule = await SubModule.findById(req.params.id)
   
 
    if (!subModule) {
      return res.status(404).json({ message: [{ key: 'error', value: 'SubModule not found' }] });
    }
 
    return res.status(200).json({
      message: [{ key: 'success', value: 'SubModule retrieved successfully' }],
      subModule
    });
  } catch (error) {
    console.error("Error fetching SubModule by ID:", error);
    return res.status(500).json({ message: [{ key: 'error', value: 'Internal server error' }] });
  }
};
 
// Update SubModule
exports.updateSubModule = async (req, res) => {
  try {
    const updatedSubModule = await SubModule.findByIdAndUpdate(
      req.params.id,
      {
        ...req.body,
        updatedBy: req.user.email,
        updatedAt: Date.now()
      },
      { new: true }
    );
 
    if (!updatedSubModule) {
      return res.status(404).json({ message: [{ key: 'error', value: 'SubModule not found' }] });
    }
 
    return res.status(200).json({
      message: [{ key: 'success', value: 'SubModule updated successfully' }],
      updatedSubModule
    });
  } catch (error) {
    console.error("Error updating SubModule:", error);
    return res.status(500).json({ message: [{ key: 'error', value: 'Internal server error' }] });
  }
};
 
// Delete SubModule
exports.deleteSubModule = async (req, res) => {
  try {
    const deletedSubModule = await SubModule.findByIdAndDelete(req.params.id);
 
    if (!deletedSubModule) {
      return res.status(404).json({ message: [{ key: 'error', value: 'SubModule not found' }] });
    }
 
    return res.status(200).json({
      message: [{ key: 'success', value: 'SubModule deleted successfully' }]
    });
  } catch (error) {
    console.error("Error deleting SubModule:", error);
    return res.status(500).json({ message: [{ key: 'error', value: 'Internal server error' }] });
  }
};
 
 