const mongoose = require("mongoose");

// One hierarchy level in a mapping's configuration. Levels are stored as data,
// not fixed schema fields, so new levels can be added without a schema change.
const hierarchyLevelSchema = new mongoose.Schema(
  {
    level: { type: String, required: true }, // e.g. "Degree", "Department", "Course", "Batch", "Semester", "Section"
    enabled: { type: Boolean, default: false },
    // Locked levels the user cannot uncheck (e.g. Degree Program → Degree + Department)
    mandatory: { type: Boolean, default: false },
  },
  { _id: false }
);

// Master-data values configured for one enabled hierarchy level
// (e.g. level "Degree" → ["B.Sc", "B.E", "MBA"]).
// `group` scopes the values to a parent-level value, e.g.
// { level: "Department", group: "BE", values: ["CSE"] } = departments of BE.
const masterDataSchema = new mongoose.Schema(
  {
    level: { type: String, required: true },
    group: { type: String },
    values: [{ type: String }],
  },
  { _id: false }
);

// One batch of the mapping's course. Every flow ends in Course → Batch(es);
// PRT Department mode additionally ties each batch to a degree + departments
// (e.g. Batch 1 → B.E → [CSE], Batch 2 → B.E → [EEE]).
const batchConfigSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    degree: { type: String, default: "" },
    departments: [{ type: String }],
    // Stages a batch runs through — "Phase 1", "Phase 2", … Opt-in per batch and
    // free-text, since a programme may call them Foundation / Advanced.
    phases: [{ type: String }],
  },
  { _id: false }
);

// One course the mapping covers. Under Degree Program courses are entered per
// semester inside the hierarchy, so `path` records exactly where: the semester's
// full path, e.g. "B.E ▸ CSE ▸ A ▸ 3". Flows that attach a course to the mapping
// as a whole leave `path` unset.
//
// This is what Course Setup reads to know which courses exist and where they
// run; without it the hierarchy the user built in the wizard is unrecoverable.
const mappedCourseSchema = new mongoose.Schema(
  {
    category: { type: String, default: "" },
    courseName: { type: String, default: "" },
    path: { type: String, default: "" },
    // Whether this course splits into batches, and their names once it does.
    batchesEnabled: { type: Boolean, default: false },
    batches: [{ type: String }],
  },
  { _id: false }
);

// Step 3 (Resources) of the Map Service wizard — the resource configuration
// courses created under this mapping start from. Deliberately the SAME shape as
// a course's own `resourcesType` (models/Courses/courseStructureModal.js), so
// applying the default to a new course is a straight copy rather than a
// translation that could drift. Narrower than what the institution's Resource
// Management allows, never wider. Absent → a new course starts with nothing
// checked, same as before this existed.
const mappingFileResourceSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },
    maxSize: { type: Number, default: 0 },
    aiChat: { type: Boolean, default: false },
    aiSummary: { type: Boolean, default: false },
    notes: { type: Boolean, default: false },
    allowedFormats: [{ type: String }],
  },
  { _id: false }
);

const mappingResourceConfigSchema = new mongoose.Schema(
  {
    video: mappingFileResourceSchema,
    ppt: mappingFileResourceSchema,
    pdf: mappingFileResourceSchema,
    image: mappingFileResourceSchema,
    zip: mappingFileResourceSchema,
    url: { enabled: { type: Boolean, default: false } },
    aiChat: { enabled: { type: Boolean, default: false } },
    aiSummary: { enabled: { type: Boolean, default: false } },
    notes: { enabled: { type: Boolean, default: false } },
    ai: { enabled: { type: Boolean, default: false } },
    autoQuestionGenerate: { enabled: { type: Boolean, default: false } },
  },
  { _id: false }
);

const resourceDefaultsSchema = new mongoose.Schema(
  {
    iDo: mappingResourceConfigSchema,
    weDo: mappingResourceConfigSchema,
    youDo: mappingResourceConfigSchema,
  },
  { _id: false }
);

// Client ↔ Service mapping — the standalone Service Mapping module's collection.
// This replaces the `services` array previously edited inside Client Management.
// The embedded client.services array is kept in sync as a legacy read model for
// existing consumers (e.g. Add Course Structure) — see
// serviceMappingController.syncClientServices.
const serviceMappingSchema = new mongoose.Schema(
  {
    institution: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LMS-Institution",
      required: false,
    },
    client: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LMS-ClientManagement",
      required: true,
    },
    // CSR / COE only: the existing Client Management records where the sponsored
    // training is delivered. References to other clients (never duplicated orgs) —
    // the corporate stays the primary `client`, these are the partner institutions.
    // One or more allowed; empty for every non-partner mapping.
    partnerInstitutions: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "LMS-ClientManagement",
      },
    ],
    // Snapshot names pulled from the course-structure-dynamic service data
    service: {
      type: String,
      required: true,
    },
    year: {
      type: String,
    },
    // Selected service model names (e.g. Skilling, DIV, Degree Program)
    serviceModels: [
      {
        type: String,
      },
    ],
    hierarchy: [hierarchyLevelSchema],
    masterData: [masterDataSchema],
    // ── Course captured by the mapping ──────────────────────────────────────
    // Every mapping ends in one course for students; the course record in
    // Course Management is auto-created from these fields when the mapping is
    // saved (there is no separate "New course" flow anymore).
    // Step 3 of the wizard — see resourceDefaultsSchema above.
    resourceDefaults: { type: resourceDefaultsSchema, default: () => ({}) },
    courseName: {
      type: String,
      default: "",
    },
    // Course category display name (drives standard course-name suggestions)
    category: {
      type: String,
      default: "",
    },
    // Every course the mapping covers. `courseName`/`category` above mirror the
    // first entry so older readers keep working; this carries the full list and
    // is the only place a Degree Program's per-semester courses survive.
    courses: [mappedCourseSchema],
    // Placement Training only: 'general' (course + batches, like B2B) or
    // 'department' (each batch tied to a degree + departments). Empty for
    // every other service model.
    prtMode: {
      type: String,
      enum: ["", "general", "department"],
      default: "",
    },
    // Batches of this course (names; PRT department mode adds degree + depts)
    batchConfigs: [batchConfigSchema],
    // Link to the auto-created Course Structure record
    courseId: {
      type: String,
      default: "",
    },
    courseCode: {
      type: String,
      default: "",
    },
    // Human-readable service id like "b2i-deg-be-1" — <business model>-<service
    // model>-<degree>-<n>. Generated once the mapping is complete (see
    // serviceMappingController.ensureServiceCode) and stable thereafter; never sent
    // by the client.
    serviceCode: {
      type: String,
      default: "",
    },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
    },
    createdBy: {
      type: String,
    },
    updatedBy: {
      type: String,
    },
  },
  { timestamps: true }
);

serviceMappingSchema.index({ institution: 1, client: 1 });
// The paginated list's DEFAULT order (and the tie-break under every sort).
// Covers the whole sort spec, so an unsorted page is an index scan rather than
// a blocking in-memory sort.
//
// The five sortable COLUMNS cannot be indexed: Client sorts on the joined
// client's name, and Model on the first element of an array, so both are
// computed inside the aggregation. That is inherent to sorting on a value the
// document does not store — fixing it would mean denormalising the client name
// onto the mapping.
serviceMappingSchema.index({ institution: 1, createdAt: -1, _id: -1 });

module.exports = mongoose.model("LMS-ServiceMapping", serviceMappingSchema);
