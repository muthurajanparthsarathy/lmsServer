const mongoose = require("mongoose");

// The extracted words of ONE page of ONE lesson file, with positions.
// Stored once at lesson preparation (text layer via pdfjs, OCR fallback via
// tesseract for scanned pages) and reused on every student view — the
// expensive step never runs at view time.
//
// One document PER PAGE, not per file: a 700-page book as a single doc would
// brush Mongo's 16MB cap, and the viewer only ever asks for a page range.
//
// Coordinates are in PDF units at scale 1 (top-left origin), with the page's
// natural width/height alongside — the client positions hotspots as
// percentages, so any rendered size/zoom stays aligned.
const wordSchema = new mongoose.Schema(
  {
    t: { type: String, required: true }, // the word text as extracted
    x: Number,
    y: Number,
    w: Number,
    h: Number,
  },
  { _id: false }
);

const lessonTextMapSchema = new mongoose.Schema(
  {
    // The stored file URL is the same key PptCache uses — one identity per
    // uploaded file across the whole pipeline.
    fileUrl: { type: String, required: true },
    page: { type: Number, required: true },
    pageWidth: Number,
    pageHeight: Number,
    // 'pdf-text' = read from the PDF's text layer (exact);
    // 'ocr' = tesseract on the rendered page image (best effort, scans).
    source: { type: String, enum: ["pdf-text", "ocr"], default: "pdf-text" },
    words: [wordSchema],
    extractedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

lessonTextMapSchema.index({ fileUrl: 1, page: 1 }, { unique: true });

module.exports = mongoose.model("Lesson-Text-Map", lessonTextMapSchema);
