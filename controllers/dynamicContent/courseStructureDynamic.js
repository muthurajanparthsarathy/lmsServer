const CourseStructureDynamic = require("../../models/dynamicContent/courseStructureDynamicModal");
const mongoose = require("mongoose");

const courseStructureDynamicController = {
  // Automatic course structure creation/retrieval based on user's institution
  getOrCreateCourseStructure: async (req, res) => {
    try {
      // Get institution ID from authenticated user
      const institutionId = req.user.institution // Assuming user object has institution field
      
      if (!institutionId) {
        return res.status(400).json({
          success: false,
          message: "User institution not found"
        });
      }

      // Check if course structure already exists for this institution
      let courseStructure = await CourseStructureDynamic.findOne({ institution: institutionId });
      
      if (courseStructure) {
        // Return existing course structure
        return res.status(200).json({
          success: true,
          message: "Course structure retrieved successfully",
          data: courseStructure
        });
      }

      // Create new course structure if it doesn't exist
      courseStructure = new CourseStructureDynamic({
        institution: institutionId,
        createdBy:  req.user.email,
        client: [],
        category: [],
        service: [],
        serviceModal: []
      });

      const savedStructure = await courseStructure.save();

      res.status(201).json({
        success: true,
        message: "Course structure created successfully",
        data: savedStructure
      });

    } catch (error) {
      console.error("Error getting/creating course structure:", error);
      res.status(500).json({
        success: false,
        message: "Error processing course structure",
        error: error.message
      });
    }
  },

  // Helper function to ensure course structure exists (used internally)
  ensureCourseStructureExists: async (institutionId, userEmail = "system") => {
    try {
      let courseStructure = await CourseStructureDynamic.findOne({ institution: institutionId });
      
      if (!courseStructure) {
        courseStructure = new CourseStructureDynamic({
          institution: institutionId,
          createdBy: userEmail,
          client: [],
          category: [],
          service: [],
          serviceModal: []
        });
        await courseStructure.save();
      }
      
      return courseStructure;
    } catch (error) {
      throw new Error(`Error ensuring course structure exists: ${error.message}`);
    }
  },

  // CATEGORY METHODS
  addCategory: async (req, res) => {
    try {
      const institutionId = req.user.institution
      
      if (!institutionId) {
        return res.status(400).json({
          success: false,
          message: "User institution not found"
        });
      }

      const { 
        categoryName, 
        categoryDescription, 
        courseNames,
      } = req.body;

      // Validate required fields
      if (!categoryName) {
        return res.status(400).json({
          success: false,
          message: "Category name is required"
        });
      }

      // Ensure course structure exists
      const courseStructure = await courseStructureDynamicController.ensureCourseStructureExists(
        institutionId, 
        req.user.email
      );

      // Check for duplicate category name
      const existingCategory = courseStructure.category.find(c => c.categoryName === categoryName);
      if (existingCategory) {
        return res.status(400).json({
          success: false,
          message: "Category with this name already exists",
          data: existingCategory
        });
      }

      // Check for duplicate category code if provided

      // Create new category
      const newCategory = {
        categoryName,
        categoryDescription: categoryDescription || "",
        courseNames,
        createdBy: req.user.email,
        createdAt: new Date()
      };

      // Add category
      courseStructure.category.push(newCategory);
      await courseStructure.save();

      // Get the newly added category with its generated ID
      const addedCategory = courseStructure.category[courseStructure.category.length - 1];

      res.status(201).json({
        success: true,
        message: "Category added successfully",
        data: addedCategory
      });

    } catch (error) {
      console.error("Error adding category:", error);
      res.status(500).json({
        success: false,
        message: "Error adding category",
        error: error.message
      });
    }
  },

  // Get all categories for user's institution
  getAllCategories: async (req, res) => {
    try {
      const institutionId = req.user.institution
      
      if (!institutionId) {
        return res.status(400).json({
          success: false,
          message: "User institution not found"
        });
      }

      // Ensure course structure exists
      const courseStructure = await courseStructureDynamicController.ensureCourseStructureExists(
        institutionId, 
        req?.user?.email
      );

      res.status(200).json({
        success: true,
        count: courseStructure.category.length,
        data: courseStructure.category
      });

    } catch (error) {
      console.error("Error fetching categories:", error);
      res.status(500).json({
        success: false,
        message: "Error fetching categories",
        error: error.message
      });
    }
  },

  // Get category by ID
  getCategoryById: async (req, res) => {
    try {
      const institutionId = req.user.institution
      const { categoryId } = req.params;

      if (!institutionId) {
        return res.status(400).json({
          success: false,
          message: "User institution not found"
        });
      }

      if (!mongoose.Types.ObjectId.isValid(categoryId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid category ID format"
        });
      }

      const courseStructure = await CourseStructureDynamic.findOne(
        { 
          institution: institutionId,
          "category._id": categoryId 
        },
        { "category.$": 1 }
      );

      if (!courseStructure || !courseStructure.category || courseStructure.category.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Category not found"
        });
      }

      res.status(200).json({
        success: true,
        data: courseStructure.category[0]
      });

    } catch (error) {
      console.error("Error fetching category:", error);
      res.status(500).json({
        success: false,
        message: "Error fetching category",
        error: error.message
      });
    }
  },

  // Update category in user's institution course structure
  updateCategory: async (req, res) => {
    try {
      const institutionId = req.user.institution
      const { categoryId } = req.params;
      const updateData = req.body;

      if (!institutionId) {
        return res.status(400).json({
          success: false,
          message: "User institution not found"
        });
      }

      if (!mongoose.Types.ObjectId.isValid(categoryId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid category ID format"
        });
      }

      const courseStructure = await CourseStructureDynamic.findOne({ institution: institutionId });
      if (!courseStructure) {
        return res.status(404).json({
          success: false,
          message: "Course structure not found for this institution"
        });
      }

      const category = courseStructure.category.id(categoryId);
      if (!category) {
        return res.status(404).json({
          success: false,
          message: "Category not found in this institution's course structure"
        });
      }

      // Check for duplicate category name if name is being updated
      if (updateData.categoryName && updateData.categoryName !== category.categoryName) {
        const nameExists = courseStructure.category.some(
          c => c.categoryName === updateData.categoryName && !c._id.equals(categoryId)
        );
        if (nameExists) {
          return res.status(400).json({
            success: false,
            message: "Another category with this name already exists"
          });
        }
      }

      // Update fields
      Object.keys(updateData).forEach(key => {
        if (key !== '_id' && key !== 'createdAt' && category.schema.path(key)) {
          category[key] = updateData[key];
        }
      });

      category.updatedAt = new Date();
      category.updatedBy = req.user.email

      await courseStructure.save();

      res.status(200).json({
        success: true,
        message: "Category updated successfully",
        data: category
      });

    } catch (error) {
      console.error("Error updating category:", error);
      res.status(500).json({
        success: false,
        message: "Error updating category",
        error: error.message
      });
    }
  },

  // Delete category from user's institution course structure
  deleteCategory: async (req, res) => {
    try {
      const institutionId = req.user.institution
      const { categoryId } = req.params;

      if (!institutionId) {
        return res.status(400).json({
          success: false,
          message: "User institution not found"
        });
      }

      if (!mongoose.Types.ObjectId.isValid(categoryId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid category ID format"
        });
      }

      const courseStructure = await CourseStructureDynamic.findOne({ institution: institutionId });
      if (!courseStructure) {
        return res.status(404).json({
          success: false,
          message: "Course structure not found for this institution"
        });
      }

      const category = courseStructure.category.id(categoryId);
      if (!category) {
        return res.status(404).json({
          success: false,
          message: "Category not found in this institution's course structure"
        });
      }

      courseStructure.category.pull(categoryId);
      await courseStructure.save();

      res.status(200).json({
        success: true,
        message: "Category deleted successfully"
      });

    } catch (error) {
      console.error("Error deleting category:", error);
      res.status(500).json({
        success: false,
        message: "Error deleting category",
        error: error.message
      });
    }
  },

 // SERVICE METHODS
  // Add service to institution's course structure
  addService: async (req, res) => {
    try {
      const institutionId = req.user.institution
     
      if (!institutionId) {
        return res.status(400).json({
          success: false,
          message: "User institution not found"
        });
      }
 
      const {
        name,
        title,
        description
      } = req.body;
 
      // Validate required fields
      if (!name || !title || !description) {
        return res.status(400).json({
          success: false,
          message: "Service name, title, and description are required"
        });
      }
 
      // Ensure course structure exists
      const courseStructure = await courseStructureDynamicController.ensureCourseStructureExists(
        institutionId,
        req.user.email
      );
 
      // Check for duplicate service name
      const existingService = courseStructure.service.find(s => s.name === name);
      if (existingService) {
        return res.status(400).json({
          success: false,
          message: "Service with this name already exists",
          data: existingService
        });
      }
 
      // Create new service
      const newService = {
        name,
        title,
        description,
        createdBy: req.user.email,
        createdAt: new Date()
      };
 
      // Add service
      courseStructure.service.push(newService);
      await courseStructure.save();
 
      // Get the newly added service with its generated ID
      const addedService = courseStructure.service[courseStructure.service.length - 1];
 
      res.status(201).json({
        success: true,
        message: "Service added successfully",
        data: addedService
      });
 
    } catch (error) {
      console.error("Error adding service:", error);
      res.status(500).json({
        success: false,
        message: "Error adding service",
        error: error.message
      });
    }
  },
 
  // Get all services for user's institution
  getAllServices: async (req, res) => {
    try {
      const institutionId = req.user.institution
     
      if (!institutionId) {
        return res.status(400).json({
          success: false,
          message: "User institution not found"
        });
      }
 
      // Ensure course structure exists
      const courseStructure = await courseStructureDynamicController.ensureCourseStructureExists(
        institutionId,
        req?.user?.email
      );
 
      res.status(200).json({
        success: true,
        count: courseStructure.service.length,
        data: courseStructure.service
      });
 
    } catch (error) {
      console.error("Error fetching services:", error);
      res.status(500).json({
        success: false,
        message: "Error fetching services",
        error: error.message
      });
    }
  },
 
  // Get service by ID
  getServiceById: async (req, res) => {
    try {
      const institutionId = req.user.institution
      const { serviceId } = req.params;
 
      if (!institutionId) {
        return res.status(400).json({
          success: false,
          message: "User institution not found"
        });
      }
 
      if (!mongoose.Types.ObjectId.isValid(serviceId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid service ID format"
        });
      }
 
      const courseStructure = await CourseStructureDynamic.findOne(
        {
          institution: institutionId,
          "service._id": serviceId
        },
        { "service.$": 1 }
      );
 
      if (!courseStructure || !courseStructure.service || courseStructure.service.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Service not found"
        });
      }
 
      res.status(200).json({
        success: true,
        data: courseStructure.service[0]
      });
 
    } catch (error) {
      console.error("Error fetching service:", error);
      res.status(500).json({
        success: false,
        message: "Error fetching service",
        error: error.message
      });
    }
  },
 
  // Update service in user's institution course structure
  updateService: async (req, res) => {
    try {
      const institutionId = req.user.institution
      const { serviceId } = req.params;
      const updateData = req.body;
 
      if (!institutionId) {
        return res.status(400).json({
          success: false,
          message: "User institution not found"
        });
      }
 
      if (!mongoose.Types.ObjectId.isValid(serviceId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid service ID format"
        });
      }
 
      const courseStructure = await CourseStructureDynamic.findOne({ institution: institutionId });
      if (!courseStructure) {
        return res.status(404).json({
          success: false,
          message: "Course structure not found for this institution"
        });
      }
 
      const service = courseStructure.service.id(serviceId);
      if (!service) {
        return res.status(404).json({
          success: false,
          message: "Service not found in this institution's course structure"
        });
      }
 
      // Check for duplicate service name if name is being updated
      if (updateData.name && updateData.name !== service.name) {
        const nameExists = courseStructure.service.some(
          s => s.name === updateData.name && !s._id.equals(serviceId)
        );
        if (nameExists) {
          return res.status(400).json({
            success: false,
            message: "Another service with this name already exists"
          });
        }
      }
 
      // Update fields
      Object.keys(updateData).forEach(key => {
        if (key !== '_id' && key !== 'createdAt' && service.schema.path(key)) {
          service[key] = updateData[key];
        }
      });
 
      service.updatedAt = new Date();
      service.updatedBy = req.user.email
 
      await courseStructure.save();
 
      res.status(200).json({
        success: true,
        message: "Service updated successfully",
        data: service
      });
 
    } catch (error) {
      console.error("Error updating service:", error);
      res.status(500).json({
        success: false,
        message: "Error updating service",
        error: error.message
      });
    }
  },
 
  // Delete service from user's institution course structure
  deleteService: async (req, res) => {
    try {
      const institutionId = req.user.institution
      const { serviceId } = req.params;
 
      if (!institutionId) {
        return res.status(400).json({
          success: false,
          message: "User institution not found"
        });
      }
 
      if (!mongoose.Types.ObjectId.isValid(serviceId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid service ID format"
        });
      }
 
      const courseStructure = await CourseStructureDynamic.findOne({ institution: institutionId });
      if (!courseStructure) {
        return res.status(404).json({
          success: false,
          message: "Course structure not found for this institution"
        });
      }
 
      const service = courseStructure.service.id(serviceId);
      if (!service) {
        return res.status(404).json({
          success: false,
          message: "Service not found in this institution's course structure"
        });
      }
 
      courseStructure.service.pull(serviceId);
      await courseStructure.save();
 
      res.status(200).json({
        success: true,
        message: "Service deleted successfully"
      });
 
    } catch (error) {
      console.error("Error deleting service:", error);
      res.status(500).json({
        success: false,
        message: "Error deleting service",
        error: error.message
      });
    }
  },
 
  // SERVICE MODAL METHODS
  // Add service modal to institution's course structure
  addServiceModal: async (req, res) => {
    try {
      const institutionId = req?.user?.institution;
      if (!institutionId) {
        return res.status(400).json({
          success: false,
          message: "User institution not found"
        });
      }
      const { serviceId, title, description } = req.body;

      // Validate required fields
      if (!serviceId || !title || !description) {
        return res.status(400).json({
          success: false,
          message: "Service ID, title, and description are required"
        });
      }
 
      // Validate service ObjectId format
      if (!mongoose.Types.ObjectId.isValid(serviceId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid service ID format"
        });
      }
 
      // Find the course structure for the institution
      const courseStructure = await CourseStructureDynamic.findOne({ institution: institutionId });
      if (!courseStructure) {
        return res.status(404).json({
          success: false,
          message: "Course structure not found for this institution"
        });
      }
 
      // Find the service to add the modal to
      const service = courseStructure.service.id(serviceId);
      if (!service) {
        return res.status(404).json({
          success: false,
          message: "Service not found in this institution"
        });
      }
 
      // Create new service modal
      const newServiceModal = {
        title,
        description,
        createdBy: req?.user?.email,
        createdAt: new Date(),
        updatedAt: new Date(),
        updatedBy: req?.user?.email
      };
 
      // Add service modal to the service
      service.serviceModal.push(newServiceModal);
      await courseStructure.save();
 
      // Get the newly added service modal
      const addedServiceModal = service.serviceModal[service.serviceModal.length - 1];
 
      res.status(201).json({
        success: true,
        message: "Service modal added successfully",
        data: addedServiceModal
      });
 
    } catch (error) {
      console.error("Error adding service modal:", error);
      res.status(500).json({
        success: false,
        message: "Error adding service modal",
        error: error.message
      });
    }
  },
  // Get all service modals for user's institution
  getAllServiceModals: async (req, res) => {
    try {
      const institutionId = req.user.institution
     
      if (!institutionId) {
        return res.status(400).json({
          success: false,
          message: "User institution not found"
        });
      }
 
      // Ensure course structure exists
      const courseStructure = await courseStructureDynamicController.ensureCourseStructureExists(
        institutionId,
        req?.user?.email
      );
 
      res.status(200).json({
        success: true,
        count: courseStructure.serviceModal.length,
        data: courseStructure.serviceModal
      });
 
    } catch (error) {
      console.error("Error fetching service modals:", error);
      res.status(500).json({
        success: false,
        message: "Error fetching service modals",
        error: error.message
      });
    }
  },
 
  // Get service modal by ID
  getServiceModalById: async (req, res) => {
    try {
      const institutionId = req.user.institution
      const { serviceModalId } = req.params;
 
      if (!institutionId) {
        return res.status(400).json({
          success: false,
          message: "User institution not found"
        });
      }
 
      if (!mongoose.Types.ObjectId.isValid(serviceModalId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid service modal ID format"
        });
      }
 
      const courseStructure = await CourseStructureDynamic.findOne(
        {
          institution: institutionId,
          "serviceModal._id": serviceModalId
        },
        { "serviceModal.$": 1 }
      );
 
      if (!courseStructure || !courseStructure.serviceModal || courseStructure.serviceModal.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Service modal not found"
        });
      }
 
      res.status(200).json({
        success: true,
        data: courseStructure.serviceModal[0]
      });
 
    } catch (error) {
      console.error("Error fetching service modal:", error);
      res.status(500).json({
        success: false,
        message: "Error fetching service modal",
        error: error.message
      });
    }
  },
 
 updateServiceModal: async (req, res) => {
    try {
      const institutionId = req?.user?.institution;
      if (!institutionId) {
        return res.status(400).json({
          success: false,
          message: "User institution not found"
        });
      }
      const { serviceId, modalId } = req.params;
      const { title, description } = req.body;

      // Validate IDs
      if (!mongoose.Types.ObjectId.isValid(serviceId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid service ID format"
        });
      }
 
      if (!mongoose.Types.ObjectId.isValid(modalId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid modal ID format"
        });
      }
 
      const courseStructure = await CourseStructureDynamic.findOne({ institution: institutionId });
      if (!courseStructure) {
        return res.status(404).json({
          success: false,
          message: "Course structure not found"
        });
      }
 
      const service = courseStructure.service.id(serviceId);
      if (!service) {
        return res.status(404).json({
          success: false,
          message: "Service not found"
        });
      }
 
      const modal = service.serviceModal.id(modalId);
      if (!modal) {
        return res.status(404).json({
          success: false,
          message: "Service modal not found"
        });
      }
 
      // Update fields
      if (title) modal.title = title;
      if (description) modal.description = description;
      modal.updatedAt = new Date();
      modal.updatedBy = req?.user?.email;
 
      await courseStructure.save();
 
      res.status(200).json({
        success: true,
        message: "Service modal updated successfully",
        data: modal
      });
 
    } catch (error) {
      console.error("Error updating service modal:", error);
      res.status(500).json({
        success: false,
        message: "Error updating service modal",
        error: error.message
      });
    }
  },
 
deleteServiceModal: async (req, res) => {
    try {
      const institutionId = req.user.institution
      const { serviceId, modalId } = req.params;
 
      if (!institutionId) {
        return res.status(400).json({
          success: false,
          message: "User institution not found"
        });
      }
 
      // Fix: Remove the extra closing parenthesis
      if (!mongoose.Types.ObjectId.isValid(serviceId) || !mongoose.Types.ObjectId.isValid(modalId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid ID format"
        });
      }
 
      const courseStructure = await CourseStructureDynamic.findOne({ institution: institutionId });
      if (!courseStructure) {
        return res.status(404).json({
          success: false,
          message: "Course structure not found for this institution"
        });
      }
 
      // Find the service that contains the modal
      const service = courseStructure.service.id(serviceId);
      if (!service) {
        return res.status(404).json({
          success: false,
          message: "Service not found in this institution's course structure"
        });
      }
 
      // Find and remove the modal from the service
      const modal = service.serviceModal.id(modalId);
      if (!modal) {
        return res.status(404).json({
          success: false,
          message: "Service modal not found in the specified service"
        });
      }
 
      service.serviceModal.pull(modalId);
      await courseStructure.save();
 
      res.status(200).json({
        success: true,
        message: "Service modal deleted successfully"
      });
 
    } catch (error) {
      console.error("Error deleting service modal:", error);
      res.status(500).json({
        success: false,
        message: "Error deleting service modal",
        error: error.message
      });
    }
  },
 
 

getAllCourseStructureWithPopulated: async (req, res) => {
  try {
    const institutionId = req.user.institution
    if (!institutionId) {
      return res.status(400).json({
        success: false,
        message: "User institution not found"
      });
    }

    // Get course structure with populated service references
    let courseStructure = await CourseStructureDynamic.findOne({ institution: institutionId });
    
    if (!courseStructure) {
      // Create if doesn't exist
      courseStructure = await courseStructureDynamicController.ensureCourseStructureExists(
        institutionId, 
        req?.user?.email
      );
    }

    // Ensure all arrays exist with fallback to empty arrays
    const clients = courseStructure.client || [];
    const categories = courseStructure.category || [];
    const services = courseStructure.service || [];
    const serviceModals = courseStructure.serviceModal || [];

    // Manually populate service references in serviceModal
    const populatedServiceModals = serviceModals.map(modal => {
      // Check if modal.services exists and is a valid ObjectId
      let referencedService = null;
      if (modal.services && services.length > 0) {
        referencedService = services.find(service => 
          service._id.toString() === modal.services.toString()
        );
      }
      
      return {
        ...modal.toObject(),
        serviceDetails: referencedService || null
      };
    });

    res.status(200).json({
      success: true,
      message: "Complete course structure retrieved successfully with populated references",
      data: {
        _id: courseStructure._id,
        institution: courseStructure.institution,
        createdAt: courseStructure.createdAt,
        createdBy: courseStructure.createdBy,
        updatedAt: courseStructure.updatedAt,
        updatedBy: courseStructure.updatedBy,
        
        clients: clients,
        categories: categories,
        services: services,
        serviceModals: populatedServiceModals // With populated service details
      },
      counts: {
        clients: clients.length,
        categories: categories.length,
        services: services.length,
        serviceModals: serviceModals.length,
        total: clients.length + categories.length + services.length + serviceModals.length
      }
    });

  } catch (error) {
    console.error("Error fetching complete course structure:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching complete course structure",
      error: error.message
    });
  }
}
};


module.exports = courseStructureDynamicController;