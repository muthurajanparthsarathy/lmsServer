const mongoose = require("mongoose");

// Contact person sub-document for a standalone client
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
  designation: {
    type: String,
  },
  isPrimary: {
    type: Boolean,
    default: false,
  },
});

// A service the client uses, with the service modals selected under it.
// Values are snapshots (names) pulled from the course-structure-dynamic
// service / serviceModal data via dynamic dropdowns on the client.
// A department with its own sections and one or more semesters
// (e.g. ME → [A, B] · Sem 1–4 ; CIVIL → [A, B] · Sem 1–2)
const departmentSectionSchema = new mongoose.Schema({
  department: { type: String },
  sections: [{ type: String }],
  semesters: [{ type: String }],
});

// One batch block: a single batch + degree, with multiple departments,
// each carrying its own sections and semester.
const degreeProgramSchema = new mongoose.Schema({
  batch: { type: String },
  degree: { type: String },
  departments: [departmentSectionSchema],
});

const clientServiceSchema = new mongoose.Schema({
  service: {
    type: String,
    required: true,
  },
  // e.g. degree-program clients train a fresh batch every year
  year: {
    type: String,
  },
  serviceModals: [
    {
      type: String,
    },
  ],
  // Company clients: one or more batches (batch-only)
  batches: [{ type: String }],
  // College clients: batch blocks (batch + degree + departments)
  degreePrograms: [degreeProgramSchema],
});

// Standalone Client Management schema — its own top-level collection.
// This is intentionally independent of the embedded `client` inside
// Course-Structure-Dynamic; the two represent different concepts.
const clientManagementSchema = new mongoose.Schema(
  {
    institution: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LMS-Institution",
      required: false,
    },
    clientCompany: {
      type: String,
      required: true,
      trim: true,
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
    // A client can be a college and/or a company
    type: {
      type: [String],
      enum: ["college", "company"],
      default: [],
    },
    // Business model this client is engaged under. Defined here on the client;
    // Service Mapping derives each mapping's service from it (the wizard no
    // longer has its own business-model select). Empty for legacy records.
    // "CSR" stays in the enum only so records saved when CSR was offered as a
    // business model keep validating — new writes only accept B2B/B2I/B2C
    // (enforced in the controller); CSR is a service model under B2B now.
    businessModel: {
      type: String,
      enum: ["B2B", "B2I", "B2C", "CSR", ""],
      default: "",
    },
    // Services (and their service modals) this client is engaged for
    services: [clientServiceSchema],
    contactPersons: [contactPersonSchema],
    createdBy: {
      type: String,
    },
    updatedBy: {
      type: String,
    },
  },
  { timestamps: true }
);

// The BM list query filters by institution and sorts by createdAt desc; this
// composite covers both.
clientManagementSchema.index({ institution: 1, createdAt: -1 });
// ── Indexes for the paginated client list ───────────────────────────────────
// The three sortable columns, each ending in the controller's createdAt/_id
// tie-break: an index only serves a sort when it covers the WHOLE sort spec,
// so omitting the tie-break columns leaves every sorted page doing a blocking
// in-memory sort. Collation strength 1 matches the page's
// `localeCompare(undefined, { sensitivity: 'base' })` — a collated sort can
// only use an index built with the SAME collation.
const CLIENT_LIST_COLLATION = { locale: "en", strength: 1, numericOrdering: true };
clientManagementSchema.index(
  { institution: 1, clientCompany: 1, createdAt: -1, _id: -1 },
  { collation: CLIENT_LIST_COLLATION }
);
clientManagementSchema.index(
  { institution: 1, businessModel: 1, createdAt: -1, _id: -1 },
  { collation: CLIENT_LIST_COLLATION }
);
clientManagementSchema.index(
  { institution: 1, status: 1, createdAt: -1, _id: -1 },
  { collation: CLIENT_LIST_COLLATION }
);

module.exports = mongoose.model("LMS-ClientManagement", clientManagementSchema);
