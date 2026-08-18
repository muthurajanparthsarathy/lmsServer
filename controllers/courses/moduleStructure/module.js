const Module1 = require('../../../models/Courses/moduleStructure/moduleModal');

// Create a new Module
exports.createModule = async (req, res) => {
  try {
    const {  courses, title, description, duration, level,index,testConfiguration } = req.body;

    // Basic validation
    if (  !courses || !title) {
      return res.status(400).json({ message: [{ key: 'error', value: 'Required fields are missing' }] });
    }

    const newModule = new Module1({
      institution:req.user.institution,
      courses,
      index,
      title,
      description,
      duration,
      level,
      testConfiguration: testConfiguration || { coreProgram: [], frontend: [], database: [] },
      createdBy:req.user.email,
    });

    const savedModule = await newModule.save();

    return res.status(201).json({
      message: [{ key: 'success', value: 'Module created successfully' }],
      module: savedModule,
    });
  } catch (error) {
    console.error("Error creating module:", error);
    return res.status(500).json({ message: [{ key: 'error', value: 'Internal server error' }] });
  }
};

// Get all Modules
exports.getAllModules = async (req, res) => {
  try {
    const modules = await Module1.find({institution: req.user.institution,});

    return res.status(200).json({
      message: [{ key: 'success', value: 'Modules retrieved successfully' }],
      modules,
    });
  } catch (error) {
    console.error("Error retrieving modules:", error);
    return res.status(500).json({ message: [{ key: 'error', value: 'Internal server error' }] });
  }
};

// Get a Module by ID
exports.getModuleById = async (req, res) => {
  try {
    const module = await Module1.findById(req.params.id);

    if (!module) {
      return res.status(404).json({ message: [{ key: 'error', value: 'Module not found' }] });
    }

    return res.status(200).json({
      message: [{ key: 'success', value: 'Module retrieved successfully' }],
      module,
    });
  } catch (error) {
    console.error("Error retrieving module by ID:", error);
    return res.status(500).json({ message: [{ key: 'error', value: 'Internal server error' }] });
  }
};

// Update a Module
exports.updateModule = async (req, res) => {
  try {
    const updatedModule = await Module1.findByIdAndUpdate(
      req.params.id,
      {
        ...req.body,
        updatedBy: req.user.email,
        updatedAt: Date.now(),
      },
      { new: true }
    );

    if (!updatedModule) {
      return res.status(404).json({ message: [{ key: 'error', value: 'Module not found' }] });
    }

    return res.status(200).json({
      message: [{ key: 'success', value: 'Module updated successfully' }],
      updatedModule,
    });
  } catch (error) {
    console.error("Error updating module:", error);
    return res.status(500).json({ message: [{ key: 'error', value: 'Internal server error' }] });
  }
};

// Delete a Module
exports.deleteModule = async (req, res) => {
  try {
    const deletedModule = await Module1.findByIdAndDelete(req.params.id);

    if (!deletedModule) {
      return res.status(404).json({ message: [{ key: 'error', value: 'Module not found' }] });
    }

    return res.status(200).json({
      message: [{ key: 'success', value: 'Module deleted successfully' }],
    });
  } catch (error) {
    console.error("Error deleting module:", error);
    return res.status(500).json({ message: [{ key: 'error', value: 'Internal server error' }] });
  }
};
