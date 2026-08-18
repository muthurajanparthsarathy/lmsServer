const Role = require("../models/RoleModel");

exports.createRole = async (req, res) => {
  try {
    const {  originalRole, renameRole, roleValue } = req.body;

    const newRole = new Role({
      originalRole,
      renameRole,
      roleValue,
     institution:req.user.institution._id,
    });

    await newRole.save();

    return res.status(201).json({ message: [{ key: "Success", value: "Role Added Successfully" }] });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};

exports.getAllRole = async (req, res) => {
  try {
    const userInstitutionId = req.user.institution;
    
    if (!userInstitutionId) {
      return res.status(400).json({ 
        message: [{ key: 'error', value: 'User institution not found' }] 
      });
    }

    const roles = await Role.find({ institution: userInstitutionId }).lean();

    return res.status(200).json({
      message: [{ key: 'success', value: 'Role Retrieved successfully' }],
      roles: roles,
      getAllRoles: roles,
    });
  } catch (error) {
    console.error('Error fetching roles:', error);
    return res.status(500).json({ 
      message: [{ key: 'error', value: 'Internal server error' }] 
    });
  }
};
exports.getRoleById = async (req, res) => {
  const { id } = req.params;
  try {
    const institutionId = req.institutionId || req.user.institution;
    
    if (!institutionId) {
      return res.status(400).json({ 
        message: [{ key: 'error', value: 'Institution ID not found' }] 
      });
    }

    const role = await Role.findOne({ 
      _id: id, 
      institution: institutionId 
    }).populate("institution");

    if (!role) {
      return res.status(404).json({ 
        message: [{ key: 'error', value: 'Role not found or access denied' }] 
      });
    }

    return res.status(200).json({
      message: [{ key: 'success', value: 'Role retrieved successfully' }],
      roleById: role
    });
  } catch (error) {
    console.error("Error retrieving Role by ID:", error);
    return res.status(500).json({ 
      message: [{ key: 'error', value: 'Internal server error' }] 
    });
  }
};

exports.updateRole = async (req, res) => {
  const { id } = req.params;
  const { originalRole, renameRole, roleValue } = req.body;

  try {
    const updatedRole = await Role.findByIdAndUpdate(
      id,
      {
        institution:req.user.institution._id,
        originalRole,
        renameRole,
        roleValue
      },
      { new: true, runValidators: true }
    ).populate("institution");

    if (!updatedRole) {
      return res.status(404).json({ message: [{ key: 'error', value: 'Role not found' }] });
    }

    return res.status(200).json({
      message: [{ key: 'success', value: 'Role updated successfully' }],
      updatedRole: updatedRole
    });
  } catch (error) {
    console.error("Error updating Role:", error);
    return res.status(500).json({ message: [{ key: 'error', value: 'Internal server error' }] });
  }
};

exports.deleteRole = async (req, res) => {
  const { id } = req.params;

  try {
    const deletedRole = await Role.findByIdAndDelete(id);

    if (!deletedRole) {
      return res.status(404).json({ message: [{ key: 'error', value: 'Role not found' }] });
    }

    return res.status(200).json({
      message: [{ key: 'success', value: 'Role deleted successfully' }]
    });
  } catch (error) {
    console.error("Error deleting Role:", error);
    return res.status(500).json({ message: [{ key: 'error', value: 'Internal server error' }] });
  }
};