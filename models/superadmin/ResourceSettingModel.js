const mongoose = require("mongoose");

// Resource Management is organised by pedagogy phase (I Do / We Do / You Do).
//
// I Do: per upload type (ppt, pdf, videos, image, zip, url, notes, ai) with an
//   enable flag + max size. ppt/pdf/videos/image additionally carry AI
//   assistant + AI summary + a per-type "Notes" toggle (zip/url/notes/ai leave
//   those false/unused). Notes is also its own standalone type (below) —
//   this per-type flag is separate: it grants attaching notes alongside that
//   specific upload (e.g. a PDF with its own notes), the standalone type is a
//   notes-only resource on its own.
const typeConfigSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },
    maxSizeMB: { type: Number, default: 20 },
    aiAssistant: { type: Boolean, default: false },
    aiSummary: { type: Boolean, default: false },
    notes: { type: Boolean, default: false },
  },
  { _id: false }
);

const iDoTypesSchema = new mongoose.Schema(
  {
    ppt: { type: typeConfigSchema, default: () => ({ enabled: true, maxSizeMB: 20, aiAssistant: true, aiSummary: true }) },
    pdf: { type: typeConfigSchema, default: () => ({ enabled: true, maxSizeMB: 25, aiAssistant: true, aiSummary: true }) },
    videos: { type: typeConfigSchema, default: () => ({ enabled: false, maxSizeMB: 500 }) },
    image: { type: typeConfigSchema, default: () => ({ enabled: false, maxSizeMB: 10 }) },
    zip: { type: typeConfigSchema, default: () => ({ enabled: false, maxSizeMB: 100 }) },
    url: { type: typeConfigSchema, default: () => ({ enabled: false, maxSizeMB: 0 }) },
    notes: { type: typeConfigSchema, default: () => ({ enabled: false, maxSizeMB: 10 }) },
    ai: { type: typeConfigSchema, default: () => ({ enabled: false, maxSizeMB: 0 }) },
  },
  { _id: false }
);

const pedagogyFeatureSchema = new mongoose.Schema(
  {
    aiAssistant: { type: Boolean, default: false },
    autoQuestionGenerate: { type: Boolean, default: false },
  },
  { _id: false }
);

const resourcePedagogySchema = new mongoose.Schema(
  {
    iDo: {
      type: new mongoose.Schema(
        { types: { type: iDoTypesSchema, default: () => ({}) } },
        { _id: false }
      ),
      default: () => ({}),
    },
    weDo: { type: pedagogyFeatureSchema, default: () => ({ aiAssistant: false, autoQuestionGenerate: false }) },
    youDo: { type: pedagogyFeatureSchema, default: () => ({ aiAssistant: false, autoQuestionGenerate: false }) },
  },
  { _id: false }
);

// Per-institution resource/upload governance — one settings document per
// institution. Sizes are in MB. New collection; nothing in the existing LMS
// is changed.
const resourceSettingSchema = new mongoose.Schema(
  {
    // Uniqueness key. Holds the institution id (as a string) so each
    // institution gets exactly one settings doc. "global" is reserved for the
    // legacy platform-default doc. Reuses the existing unique index.
    scope: { type: String, default: "global", unique: true },

    // The institution these settings belong to (null for the legacy global doc).
    institution: { type: mongoose.Schema.Types.ObjectId, ref: "LMS-Institution", default: null },

    // Pedagogy-phase resource config (I Do / We Do / You Do) — the only config
    // the Resource Management screen edits. Defaults applied per subdocument.
    resourcePedagogy: { type: resourcePedagogySchema, default: () => ({}) },

    // Alert threshold shown on the Storage Summary. The storage quota itself is
    // derived from the institution's subscription (see resourceController), not
    // stored here.
    storageAlertThresholdPercent: { type: Number, default: 85 },

    updatedBy: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model("client-ResourceSetting", resourceSettingSchema);
