// Lesson text extraction — the one-time step behind the interactive glossary.
//
// Given a PDF buffer, store every word and its position, one document per
// page (Lesson-Text-Map). Two paths:
//   • pdf-text : read the PDF's own text layer via pdfjs — exact and fast.
//                Works for every digital PDF and for every office file,
//                because the slide pipeline converts those to PDF first.
//   • ocr      : pages with no text layer (scanned books) are rendered to an
//                image and read with tesseract — best effort, never exact.
//
// Extraction is idempotent: a file that already has pages stored is skipped
// unless force is passed, so upload hooks can fire-and-forget safely.

const LessonTextMap = require("../models/Courses/LessonTextMapModel");

// A page whose text layer yields fewer words than this is treated as a scan.
const OCR_FALLBACK_MIN_WORDS = 5;
const OCR_RENDER_SCALE = 2;

let pdfjsPromise = null;
const getPdfjs = () => {
  // v5 is ESM-only — dynamic import from CJS, cached.
  if (!pdfjsPromise) pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsPromise;
};

// Split a pdfjs text item ("run" of text, possibly several words) into words,
// apportioning the run's width by character share. Approximate, but hit-boxes
// only need to be finger-accurate, not typographically exact.
//
// Coordinates go through the VIEWPORT transform (Util.transform), never a
// hand-rolled flip: pages carry CropBox origin offsets that a naive
// `pageHeight - y` silently ignores, shifting every box by the crop margin.
const splitRunIntoWords = (run, viewport, Util) => {
  const text = run.str || "";
  if (!text.trim()) return [];
  // Device space: origin top-left, y grows downward — exactly what the
  // overlay needs at scale 1.
  const tx = Util.transform(viewport.transform, run.transform);
  const fontH = Math.hypot(tx[2], tx[3]) || 10;
  const runX = tx[4];
  const baselineY = tx[5]; // device-space baseline
  const runW = run.width || 0;
  const totalChars = text.length || 1;

  const words = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const startFrac = m.index / totalChars;
    const widthFrac = m[0].length / totalChars;
    words.push({
      t: m[0],
      x: runX + startFrac * runW,
      // The glyph box spans roughly the ascent above the baseline, with a
      // little slack below for descenders.
      y: baselineY - fontH,
      w: widthFrac * runW,
      h: fontH * 1.2,
    });
  }
  return words;
};

// OCR one page: render via pdfjs onto a node-canvas, hand the PNG to
// tesseract, normalise the boxes back to scale-1 PDF units.
const ocrPage = async (page, viewport) => {
  const { createCanvas } = require("canvas");
  const { createWorker } = require("tesseract.js");

  const vp2 = page.getViewport({ scale: OCR_RENDER_SCALE });
  const canvas = createCanvas(vp2.width, vp2.height);
  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport: vp2 }).promise;
  const png = canvas.toBuffer("image/png");

  const worker = await createWorker("eng");
  try {
    const { data } = await worker.recognize(png);
    // v5 exposes data.words directly; v6 nests them under blocks.
    const rawWords =
      data.words ||
      (data.blocks || []).flatMap((b) =>
        (b.paragraphs || []).flatMap((p) =>
          (p.lines || []).flatMap((l) => l.words || [])
        )
      );
    return rawWords
      .filter((w) => w.text && w.text.trim() && (w.confidence ?? 100) > 40)
      .map((w) => ({
        t: w.text.trim(),
        x: w.bbox.x0 / OCR_RENDER_SCALE,
        y: w.bbox.y0 / OCR_RENDER_SCALE,
        w: (w.bbox.x1 - w.bbox.x0) / OCR_RENDER_SCALE,
        h: (w.bbox.y1 - w.bbox.y0) / OCR_RENDER_SCALE,
      }));
  } finally {
    await worker.terminate();
  }
};

// Main entry. Returns { pages, textPages, ocrPages, skipped }.
const extractLessonTextFromPdf = async (buffer, fileUrl, { force = false } = {}) => {
  if (!force) {
    const existing = await LessonTextMap.countDocuments({ fileUrl });
    if (existing > 0) return { pages: existing, textPages: 0, ocrPages: 0, skipped: true };
  }

  const pdfjs = await getPdfjs();
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
  }).promise;

  let textPages = 0;
  let ocrPages = 0;

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();

    let words = [];
    for (const run of content.items) {
      words = words.concat(splitRunIntoWords(run, viewport, pdfjs.Util));
    }

    let source = "pdf-text";
    if (words.length < OCR_FALLBACK_MIN_WORDS) {
      try {
        words = await ocrPage(page, viewport);
        source = "ocr";
        ocrPages++;
      } catch (e) {
        // OCR is best-effort — a failed page stays empty rather than failing
        // the whole file.
        console.warn(`lessonTextExtract: OCR failed on page ${pageNum}: ${e.message}`);
      }
    } else {
      textPages++;
    }

    await LessonTextMap.updateOne(
      { fileUrl, page: pageNum },
      {
        $set: {
          pageWidth: viewport.width,
          pageHeight: viewport.height,
          source,
          words,
          extractedAt: new Date(),
        },
      },
      { upsert: true }
    );
    page.cleanup();
  }

  await doc.destroy();
  return { pages: doc.numPages, textPages, ocrPages, skipped: false };
};

module.exports = { extractLessonTextFromPdf };
