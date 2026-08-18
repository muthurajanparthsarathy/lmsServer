const Degree = require("../../models/dynamicContent/DegreeAndDepartmentModel");

// ─── Degree CRUD Operations ───────────────────────────────────────────────────

// Create Degree with multiple departments
exports.createDegree = async (req, res) => {
  try {
    const {
      degreeName,
      degreeCode,
      degreeType,
      numberOfSemesters,
      description,
      duration,
      status,
      departments
    } = req.body;

    const institutionId = req.user.institution._id;
    const createdBy = req.user.email;

    // Check if degree with same code exists
    const existingDegree = await Degree.findOne({ 
      degreeCode, 
      institution: institutionId 
    });

    if (existingDegree) {
      return res.status(400).json({ 
        message: [{ key: "error", value: "Degree with this code already exists" }] 
      });
    }

    // Prepare departments with createdBy
    const departmentsWithMeta = departments ? departments.map(dept => ({
      ...dept,
      createdBy: createdBy,
      updatedBy: createdBy
    })) : [];

    // Create degree with departments
    const newDegree = new Degree({
      degreeName,
      degreeCode,
      degreeType,
      numberOfSemesters,
      description,
      duration,
      status: status || 'active',
      institution: institutionId,
      departments: departmentsWithMeta,
      createdBy: createdBy,
      updatedBy: createdBy
    });

    await newDegree.save();

    return res.status(201).json({ 
      message: [{ key: "Success", value: "Degree created successfully" }],
      degree: newDegree
    });

  } catch (error) {
    console.error('Error creating degree:', error);
    return res.status(500).json({ 
      message: [{ key: "error", value: "Internal server error" }] 
    });
  }
};

// Get all degrees with departments
exports.getAllDegrees = async (req, res) => {
  try {
    const institutionId = req.user.institution._id;
    
    const degrees = await Degree.find({
      institution: institutionId
    })
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      message: [{ key: 'success', value: 'Degrees retrieved successfully' }],
      degrees: degrees,
      getAllDegrees: degrees
    });

  } catch (error) {
    console.error('Error fetching degrees:', error);
    return res.status(500).json({ 
      message: [{ key: 'error', value: 'Internal server error' }] 
    });
  }
};

// Get degree by ID
exports.getDegreeById = async (req, res) => {
  const { id } = req.params;
  try {
    const institutionId = req.user.institution._id;
    
    const degree = await Degree.findOne({ 
      _id: id, 
      institution: institutionId 
    });

    if (!degree) {
      return res.status(404).json({ 
        message: [{ key: 'error', value: 'Degree not found' }] 
      });
    }

    return res.status(200).json({
      message: [{ key: 'success', value: 'Degree retrieved successfully' }],
      degreeById: degree
    });

  } catch (error) {
    console.error("Error retrieving degree:", error);
    return res.status(500).json({ 
      message: [{ key: 'error', value: 'Internal server error' }] 
    });
  }
};

// Update degree
exports.updateDegree = async (req, res) => {
  const { id } = req.params;
  const {
    degreeName,
    degreeCode,
    degreeType,
    numberOfSemesters,
    description,
    duration,
    status,
    departments
  } = req.body;

  try {
    const institutionId = req.user.institution._id;
    const updatedBy = req.user.email;

    // Find degree
    const degree = await Degree.findOne({ 
      _id: id, 
      institution: institutionId 
    });

    if (!degree) {
      return res.status(404).json({ 
        message: [{ key: 'error', value: 'Degree not found' }] 
      });
    }

    // Update degree fields
    if (degreeName) degree.degreeName = degreeName;
    if (degreeCode) degree.degreeCode = degreeCode;
    if (degreeType) degree.degreeType = degreeType;
    if (numberOfSemesters !== undefined) degree.numberOfSemesters = numberOfSemesters;
    if (description !== undefined) degree.description = description;
    if (duration !== undefined) degree.duration = duration;
    if (status) degree.status = status;
    
    // Update departments if provided
    if (departments && Array.isArray(departments)) {
      // Add updatedBy to each department
      const date = new Date();
      const options = { 
        weekday: 'short', 
        year: 'numeric', 
        month: 'short', 
        day: '2-digit', 
        hour: '2-digit', 
        minute: '2-digit', 
        second: '2-digit', 
        hour12: true, 
        timeZone: 'Asia/Kolkata' 
      };
      const formattedDate = date.toLocaleString('en-US', options).replace(',', '');
      
      degree.departments = departments.map(dept => ({
        ...dept,
        updatedBy: updatedBy,
        updatedAt: formattedDate
      }));
    }

    degree.updatedBy = updatedBy;
    await degree.save();

    return res.status(200).json({
      message: [{ key: 'success', value: 'Degree updated successfully' }],
      updatedDegree: degree
    });

  } catch (error) {
    console.error("Error updating degree:", error);
    return res.status(500).json({ 
      message: [{ key: 'error', value: 'Internal server error' }] 
    });
  }
};

// Delete degree
exports.deleteDegree = async (req, res) => {
  const { id } = req.params;

  try {
    const institutionId = req.user.institution._id;
    
    const deletedDegree = await Degree.findOneAndDelete({ 
      _id: id, 
      institution: institutionId 
    });

    if (!deletedDegree) {
      return res.status(404).json({ 
        message: [{ key: 'error', value: 'Degree not found' }] 
      });
    }

    return res.status(200).json({
      message: [{ key: 'success', value: 'Degree deleted successfully' }]
    });

  } catch (error) {
    console.error("Error deleting degree:", error);
    return res.status(500).json({ 
      message: [{ key: 'error', value: 'Internal server error' }] 
    });
  }
};

// ─── Department CRUD Operations ──────────────────────────────────────────────

// Add department to existing degree
exports.addDepartment = async (req, res) => {
  const { id } = req.params;
  const { 
    departmentName, 
    departmentCode, 
    description, 
    headOfDepartment, 
    status 
  } = req.body;

  try {
    const institutionId = req.user.institution._id;
    const createdBy = req.user.email;

    const degree = await Degree.findOne({ 
      _id: id, 
      institution: institutionId 
    });

    if (!degree) {
      return res.status(404).json({ 
        message: [{ key: 'error', value: 'Degree not found' }] 
      });
    }

    // Check if department with same code exists in this degree
    const existingDept = degree.departments.find(
      dept => dept.departmentCode === departmentCode
    );

    if (existingDept) {
      return res.status(400).json({ 
        message: [{ key: 'error', value: 'Department with this code already exists in this degree' }] 
      });
    }

    // Add new department
    const newDepartment = {
      departmentName,
      departmentCode,
      description,
      headOfDepartment,
      status: status || 'active',
      createdBy: createdBy,
      updatedBy: createdBy
    };

    degree.departments.push(newDepartment);
    degree.updatedBy = createdBy;
    await degree.save();

    return res.status(201).json({
      message: [{ key: 'success', value: 'Department added successfully' }],
      degree: degree
    });

  } catch (error) {
    console.error("Error adding department:", error);
    return res.status(500).json({ 
      message: [{ key: 'error', value: 'Internal server error' }] 
    });
  }
};

// Get all departments of a degree
exports.getAllDepartments = async (req, res) => {
  const { id } = req.params;

  try {
    const institutionId = req.user.institution._id;
    
    const degree = await Degree.findOne({ 
      _id: id, 
      institution: institutionId 
    });

    if (!degree) {
      return res.status(404).json({ 
        message: [{ key: 'error', value: 'Degree not found' }] 
      });
    }

    return res.status(200).json({
      message: [{ key: 'success', value: 'Departments retrieved successfully' }],
      departments: degree.departments,
      getAllDepartments: degree.departments
    });

  } catch (error) {
    console.error("Error retrieving departments:", error);
    return res.status(500).json({ 
      message: [{ key: 'error', value: 'Internal server error' }] 
    });
  }
};

// Get department by ID from a degree
exports.getDepartmentById = async (req, res) => {
  const { id, departmentId } = req.params;

  try {
    const institutionId = req.user.institution._id;
    
    const degree = await Degree.findOne({ 
      _id: id, 
      institution: institutionId 
    });

    if (!degree) {
      return res.status(404).json({ 
        message: [{ key: 'error', value: 'Degree not found' }] 
      });
    }

    const department = degree.departments.find(
      dept => dept._id.toString() === departmentId
    );

    if (!department) {
      return res.status(404).json({ 
        message: [{ key: 'error', value: 'Department not found' }] 
      });
    }

    return res.status(200).json({
      message: [{ key: 'success', value: 'Department retrieved successfully' }],
      departmentById: department
    });

  } catch (error) {
    console.error("Error retrieving department:", error);
    return res.status(500).json({ 
      message: [{ key: 'error', value: 'Internal server error' }] 
    });
  }
};

// Update department within degree
exports.updateDepartment = async (req, res) => {
  const { id, departmentId } = req.params;
  const { 
    departmentName, 
    departmentCode, 
    description, 
    headOfDepartment, 
    status 
  } = req.body;

  try {
    const institutionId = req.user.institution._id;
    const updatedBy = req.user.email;

    const degree = await Degree.findOne({ 
      _id: id, 
      institution: institutionId 
    });

    if (!degree) {
      return res.status(404).json({ 
        message: [{ key: 'error', value: 'Degree not found' }] 
      });
    }

    // Find and update department
    const departmentIndex = degree.departments.findIndex(
      dept => dept._id.toString() === departmentId
    );

    if (departmentIndex === -1) {
      return res.status(404).json({ 
        message: [{ key: 'error', value: 'Department not found' }] 
      });
    }

    // Update department fields
    const dept = degree.departments[departmentIndex];
    if (departmentName) dept.departmentName = departmentName;
    if (departmentCode) dept.departmentCode = departmentCode;
    if (description !== undefined) dept.description = description;
    if (headOfDepartment) dept.headOfDepartment = headOfDepartment;
    if (status) dept.status = status;
    dept.updatedBy = updatedBy;
    
    const date = new Date();
    const options = { 
      weekday: 'short', 
      year: 'numeric', 
      month: 'short', 
      day: '2-digit', 
      hour: '2-digit', 
      minute: '2-digit', 
      second: '2-digit', 
      hour12: true, 
      timeZone: 'Asia/Kolkata' 
    };
    dept.updatedAt = date.toLocaleString('en-US', options).replace(',', '');

    degree.updatedBy = updatedBy;
    await degree.save();

    return res.status(200).json({
      message: [{ key: 'success', value: 'Department updated successfully' }],
      updatedDepartment: dept
    });

  } catch (error) {
    console.error("Error updating department:", error);
    return res.status(500).json({ 
      message: [{ key: 'error', value: 'Internal server error' }] 
    });
  }
};

// Remove department from degree
exports.removeDepartment = async (req, res) => {
  const { id, departmentId } = req.params;

  try {
    const institutionId = req.user.institution._id;
    const updatedBy = req.user.email;

    const degree = await Degree.findOne({ 
      _id: id, 
      institution: institutionId 
    });

    if (!degree) {
      return res.status(404).json({ 
        message: [{ key: 'error', value: 'Degree not found' }] 
      });
    }

    // Remove department
    degree.departments = degree.departments.filter(
      dept => dept._id.toString() !== departmentId
    );
    
    degree.updatedBy = updatedBy;
    await degree.save();

    return res.status(200).json({
      message: [{ key: 'success', value: 'Department removed successfully' }],
      degree: degree
    });

  } catch (error) {
    console.error("Error removing department:", error);
    return res.status(500).json({ 
      message: [{ key: 'error', value: 'Internal server error' }] 
    });
  }
};