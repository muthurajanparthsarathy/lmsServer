const mongoose = require('mongoose');
const PedagogyStructureDynamic = require('../../models/dynamicContent/pedagogyStructureModal');

exports.createPedagogyStructure = async (req, res) => {
  try {
    // Validate institution ID
    if (!req.user?.institution || !mongoose.Types.ObjectId.isValid(req.user.institution)) {
      return res.status(400).json({
        success: false,
        message: "Invalid or missing institution ID in user data"
      });
    }

    const { I_Do = [], We_Do = [], You_Do = [] } = req.body;
    const institutionId = req.user.institution;

    // Check if pedagogy structure already exists
    const existingStructure = await PedagogyStructureDynamic.findOne({ 
      institution: institutionId 
    });

    if (existingStructure) {
      // Update existing structure
      const updateData = {};
      
      if (I_Do.length > 0) {
        updateData.$addToSet = { 
          ...updateData.$addToSet,
          I_Do: { $each: I_Do }
        };
      }
      
      if (We_Do.length > 0) {
        updateData.$addToSet = { 
          ...updateData.$addToSet,
          We_Do: { $each: We_Do }
        };
      }
      
      if (You_Do.length > 0) {
        updateData.$addToSet = { 
          ...updateData.$addToSet,
          You_Do: { $each: You_Do }
        };
      }
      
      updateData.updatedBy = req.user._id;
      
      const updatedStructure = await PedagogyStructureDynamic.findOneAndUpdate(
        { institution: institutionId },
        updateData,
        { new: true, runValidators: true }
      );

      return res.status(200).json({
        success: true,
        message: "Pedagogy structure updated successfully",
        data: updatedStructure,
      });
    }

    // Create new structure
    const newPedagogyStructure = new PedagogyStructureDynamic({
      institution: institutionId,
      I_Do,
      We_Do,
      You_Do,
      createdBy: req?.user?.email || "roobankr5@gmail.com",
    });

    const savedStructure = await newPedagogyStructure.save();
    
    res.status(201).json({
      success: true,
      message: "Pedagogy structure created successfully",
      data: savedStructure,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: "Error creating/updating pedagogy structure",
      error: error.message,
    });
  }
};

exports.getAllPedagogyStructures = async (req, res) => {
  try {
    // Validate institution ID from user
    if (!req.user?.institution || !mongoose.Types.ObjectId.isValid(req.user.institution)) {
      return res.status(400).json({
        success: false,
        message: "Invalid or missing institution ID in user data"
      });
    }

    const institutionId = req.user.institution;

    // Find all pedagogy structures for the institution (read-only → lean)
    const structures = await PedagogyStructureDynamic.find({ institution: institutionId })
      .sort({ createdAt: -1 }) // Sort by newest first
      .lean()


    res.status(200).json({
      success: true,
      message: "Pedagogy structures retrieved successfully",
      data: structures,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error retrieving pedagogy structures",
      error: error.message,
    });
  }
};


exports.getPedagogyStructureById = async (req, res) => {
  try {
    // Validate IDs
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid pedagogy structure ID"
      });
    }

    if (!req.user?.institution || !mongoose.Types.ObjectId.isValid(req.user.institution)) {
      return res.status(400).json({
        success: false,
        message: "Invalid or missing institution ID in user data"
      });
    }

    const structureId = req.params.id;
    const institutionId = req.user.institution;

    // Find the structure that belongs to the user's institution
    const structure = await PedagogyStructureDynamic.findOne({
      _id: structureId,
      institution: institutionId
    })


    if (!structure) {
      return res.status(404).json({
        success: false,
        message: "Pedagogy structure not found or not accessible for this institution"
      });
    }

    res.status(200).json({
      success: true,
      message: "Pedagogy structure retrieved successfully",
      data: structure,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error retrieving pedagogy structure",
      error: error.message,
    });
  }
};

exports.updateArrayElement = async (req, res) => {
  try {
    const { id } = req.params;
    const { section, index, newValue } = req.body; // <-- use index instead of elementId
    const institutionId = req.user.institution;

    // Validate IDs
    if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(institutionId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid ID format",
      });
    }

    // Validate section
    if (!['I_Do', 'We_Do', 'You_Do'].includes(section)) {
      return res.status(400).json({
        success: false,
        message: "Invalid section. Must be I_Do, We_Do, or You_Do",
      });
    }

    // Find the structure
    const structure = await PedagogyStructureDynamic.findOne({
      _id: id,
      institution: institutionId
    });

    if (!structure) {
      return res.status(404).json({
        success: false,
        message: "Pedagogy structure not found or not accessible",
      });
    }

    // Validate index
    if (index < 0 || index >= structure[section].length) {
      return res.status(400).json({
        success: false,
        message: "Invalid index for the given section",
      });
    }

    // Update by index
    structure[section][index] = newValue;
    structure.updatedBy = req.user._id;

    await structure.save();

    res.status(200).json({
      success: true,
      message: "Element updated successfully",
      data: structure,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error updating element",
      error: error.message,
    });
  }
};


exports.deleteArrayElement = async (req, res) => {
  try {
    const { id } = req.params;
    const { section, index } = req.body;
    const institutionId = req.user.institution;
 
    // Validate IDs
    if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(institutionId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid ID format",
      });
    }
 
    // Validate section
    if (!['I_Do', 'We_Do', 'You_Do'].includes(section)) {
      return res.status(400).json({
        success: false,
        message: "Invalid section. Must be I_Do, We_Do, or You_Do",
      });
    }
 
    // Find the structure
    const structure = await PedagogyStructureDynamic.findOne({
      _id: id,
      institution: institutionId
    });
 
    if (!structure) {
      return res.status(404).json({
        success: false,
        message: "Pedagogy structure not found or not accessible",
      });
    }
 
    // Validate index
    if (index < 0 || index >= structure[section].length) {
      return res.status(400).json({
        success: false,
        message: "Invalid index for the given section",
      });
    }
 
    // Delete by index using splice
    structure[section].splice(index, 1);
    structure.updatedBy = req.user._id;
 
    await structure.save();
 
    res.status(200).json({
      success: true,
      message: "Element deleted successfully",
      data: structure,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error deleting element",
      error: error.message,
    });
  }
};
 
 
