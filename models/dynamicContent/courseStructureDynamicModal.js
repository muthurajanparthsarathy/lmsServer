const mongoose = require("mongoose");
 
const contactPersonSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  email: {
    type: String,
    required: true,
  },
  phoneNumber: {
    type: String,
    required: true,
  },
  isPrimary: {
    type: Boolean,
    default: false,
  },
});

// Department + sections sub-document (nested inside a degree batch entry)
// department and sections are optional
const departmentSectionSchema = new mongoose.Schema({
  department: {
    type: String,
  },
  sections: [
    {
      type: String,
    },
  ],
});

// Per-semester month range (start / end month), auto-generated from the degree's semester count
const semesterDetailSchema = new mongoose.Schema({
  semesterNumber: {
    type: Number,
  },
  startMonth: {
    type: String,
  },
  endMonth: {
    type: String,
  },
});

// Degree batch sub-document schema (used when client type includes "degree program")
// Each entry: batch + degree + semester, with multiple departments, each having multiple sections
const degreeBatchSchema = new mongoose.Schema({
  batch: {
    type: String,
    required: true,
  },
  degree: {
    type: String,
    required: true,
  },
  semester: {
    type: String,
    required: true,
  },
  departments: [departmentSectionSchema],
  // Semester schedule (start/end month per semester)
  semesterDetails: [semesterDetailSchema],
});

// Define the client schema (embedded)
const clientSchema = new mongoose.Schema({
  contactPersons: [contactPersonSchema],
  clientCompany: {
    type: String,
    required: true,
  },
  description: {
    type: String,
  },
  clientAddress: {
    type: String,
  },
    clientLogo: {
    type: String,
  },
    status: {
    type: String,
    enum: ["active", "inactive"],
    default: "active",
  },
  type: {
    type: [String],
    enum: ["skilling", "degree program"],
    default: [],
  },
  // Used when type includes "skilling" — a client can run multiple batches
  skillingBatches: [
    {
      type: String,
    },
  ],
  // Used when type includes "degree program" — multiple degree/department/semester/section/batch combos
  degreeBatches: [degreeBatchSchema],
  createdAt: {
    type: Date,
    default: Date.now,
  },
  createdBy: {
    type: String,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
  updatedBy: {
    type: String,
  },
});
  
const categorySchema = new mongoose.Schema({
  categoryName: {
    type: String,
    required: false,
  },
  categoryDescription: {
    type: String,
  },
  courseNames: [{
    type: String,
    trim: true
  }], // Array of course names
  createdAt: {
    type: Date,
    default: Date.now,
  },
  createdBy: {
    type: String,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
  updatedBy: {
    type: String,
  },
}); 
// Define the service modal schema (embedded)
const serviceModalSchema = new mongoose.Schema({
  title: {
    type: String,
    required: false
  },
  description: {
    type: String,
    required: false
  },
  createdBy: {
    type: String
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedBy: {
    type: String
  },
  updatedAt: {
    type: Date,
    default: Date.now
  },
});
 
// Define the service schema (embedded) - Updated to include serviceModal array
const serviceSchema = new mongoose.Schema({
  name: {
    type: String,
    required: false
  },
  title: {
    type: String,
    required: false
  },
  description: {
    type: String,
    required: false
  },
  serviceModal: [serviceModalSchema], // Added serviceModal as an array
  createdBy: {
    type: String
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedBy: {
    type: String
  },
  updatedAt: {
    type: Date,
    default: Date.now
  },
});
 
const courseStructureDynamicSchema = new mongoose.Schema({
  institution: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "LMS-Institution",
    required: false,
  },
 
  // Embedded arrays of different schemas
  // DEPRECATED — the Dynamic Field Settings "Client Modal" tab and its
  // /clients/* CRUD routes were removed. Clients now live in the standalone
  // Client Management module (LMS-ClientManagement). The field is kept only so
  // existing documents are not silently orphaned; nothing reads or writes it.
  client: [clientSchema],
  category: [categorySchema],
  service: [serviceSchema],
  // Removed serviceModal from here since it's now embedded in service schema
 
  // Additional fields for course structure
  createdAt: {
    type: Date,
    default: Date.now,
  },
  createdBy: {
    type: String,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
  updatedBy: {
    type: String,
  },
});
 
// Pre-save middleware to update the updatedAt field
courseStructureDynamicSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Every read/write in courseStructureDynamic.js queries by institution
// (findOne({institution})) — this had no index at all, making every one of
// those 15 handlers a full collection scan.
courseStructureDynamicSchema.index({ institution: 1 });
 
// Methods for managing embedded documents
courseStructureDynamicSchema.methods.addCategory = function(categoryData) {
  this.category.push(categoryData);
  return this.save();
};
 
courseStructureDynamicSchema.methods.addService = function(serviceData) {
  this.service.push(serviceData);
  return this.save();
};
 
// Updated method to add service modal to a specific service
courseStructureDynamicSchema.methods.addServiceModal = function(serviceId, serviceModalData) {
  const service = this.service.id(serviceId);
  if (service) {
    service.serviceModal.push(serviceModalData);
    return this.save();
  }
  throw new Error('Service not found');
};
 
module.exports = mongoose.model("Course-Structure-Dynamic", courseStructureDynamicSchema);
 