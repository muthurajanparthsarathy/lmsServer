// Interactive Glossary — per-course terms + the lesson-terms matcher that
// turns stored page words (Lesson-Text-Map) into clickable hotspots.
//
// Matching happens at REQUEST time against the stored words, so adding or
// editing a glossary term needs no reprocessing of any lesson. The expensive
// step (text extraction / OCR) ran once at lesson preparation.

const mongoose = require("mongoose");
const Glossary = require("../../models/Courses/GlossaryModel");
const LessonTextMap = require("../../models/Courses/LessonTextMapModel");
const CourseStructure = require("../../models/Courses/courseStructureModal");
const { extractLessonTextFromPdf } = require("../../utils/lessonTextExtract");

const okId = (id) => mongoose.Types.ObjectId.isValid(id);
const err = (res, code, value) =>
  res.status(code).json({ message: [{ key: "error", value }] });

// Words come out of PDFs/OCR with punctuation stuck to them ("pointer," /
// "(array)"). Matching strips the edges and lowercases; the ORIGINAL box is
// what becomes clickable.
const normalizeWord = (t) =>
  String(t || "")
    .toLowerCase()
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");

// ── CRUD ────────────────────────────────────────────────────────────────────
exports.createTerm = async (req, res) => {
  try {
    const { courseId, term, definition } = req.body;
    if (!okId(courseId) || !String(term || "").trim() || !String(definition || "").trim()) {
      return err(res, 400, "courseId, term and definition are required");
    }
    const course = await CourseStructure.findById(courseId).select("_id").lean();
    if (!course) return err(res, 404, "Course not found");

    const doc = await Glossary.create({
      institution: req.user.institution,
      courseId,
      term: String(term).trim(),
      termKey: String(term).trim().toLowerCase(),
      definition: String(definition).trim(),
      createdBy: req.user.email,
    });
    return res.status(201).json({
      message: [{ key: "success", value: "Glossary term added" }],
      data: doc,
    });
  } catch (e) {
    if (e.code === 11000) return err(res, 400, "This term already exists for the course");
    console.error("createTerm error:", e);
    return err(res, 500, "Internal server error");
  }
};

exports.listByCourse = async (req, res) => {
  try {
    const { courseId } = req.params;
    if (!okId(courseId)) return err(res, 400, "Invalid courseId");
    const terms = await Glossary.find({ courseId }).sort({ termKey: 1 }).lean();
    return res.status(200).json({
      message: [{ key: "success", value: "Glossary terms" }],
      data: terms,
    });
  } catch (e) {
    console.error("listByCourse error:", e);
    return err(res, 500, "Internal server error");
  }
};

exports.updateTerm = async (req, res) => {
  try {
    const { termId } = req.params;
    const { term, definition } = req.body;
    if (!okId(termId)) return err(res, 400, "Invalid term id");
    const doc = await Glossary.findById(termId);
    if (!doc) return err(res, 404, "Term not found");
    if (term && String(term).trim()) {
      doc.term = String(term).trim();
      doc.termKey = doc.term.toLowerCase();
    }
    if (definition && String(definition).trim()) doc.definition = String(definition).trim();
    doc.updatedBy = req.user.email;
    await doc.save();
    return res.status(200).json({
      message: [{ key: "success", value: "Glossary term updated" }],
      data: doc,
    });
  } catch (e) {
    if (e.code === 11000) return err(res, 400, "This term already exists for the course");
    console.error("updateTerm error:", e);
    return err(res, 500, "Internal server error");
  }
};

exports.deleteTerm = async (req, res) => {
  try {
    const { termId } = req.params;
    if (!okId(termId)) return err(res, 400, "Invalid term id");
    const doc = await Glossary.findByIdAndDelete(termId);
    if (!doc) return err(res, 404, "Term not found");
    return res.status(200).json({ message: [{ key: "success", value: "Glossary term deleted" }] });
  } catch (e) {
    console.error("deleteTerm error:", e);
    return err(res, 500, "Internal server error");
  }
};

// ── EXTRACT — one-time preparation for a stored lesson file ────────────────
// POST { fileUrl, force? } — downloads the PDF from its stored URL and builds
// the per-page word map. Used by the backfill and as a manual trigger; new
// uploads run this automatically from the upload hook.
exports.extractLesson = async (req, res) => {
  try {
    const { fileUrl, force } = req.body || {};
    if (!fileUrl || !/^https?:\/\//.test(fileUrl)) return err(res, 400, "fileUrl is required");
    // Only files this deployment actually stores — not arbitrary URLs.
    const allowedBase = process.env.SUPABASE_URL || "";
    if (allowedBase && !fileUrl.startsWith(allowedBase)) {
      return err(res, 400, "fileUrl must be a stored lesson file");
    }

    const resp = await fetch(fileUrl);
    if (!resp.ok) return err(res, 400, `Could not download file (${resp.status})`);
    const buffer = Buffer.from(await resp.arrayBuffer());

    const result = await extractLessonTextFromPdf(buffer, fileUrl, { force: force === true });
    return res.status(200).json({
      message: [{ key: "success", value: result.skipped ? "Already extracted" : "Extraction complete" }],
      data: result,
    });
  } catch (e) {
    console.error("extractLesson error:", e);
    return err(res, 500, "Internal server error");
  }
};

// ── DEFINE — one word, glossary first, offline WordNet fallback ────────────
// GET ?courseId=&word= — the dictionary layer calls this on hover. The
// course glossary always wins (trainer's definition over generic English);
// WordNet (free, offline) answers everything else. Results are memoized —
// the same word is looked up once per server run.
let wordnetReady = null;
const getWordnet = () => {
  const wordnet = require("wordnet");
  if (!wordnetReady) wordnetReady = wordnet.init().then(() => wordnet);
  return wordnetReady;
};
const defineCache = new Map();

// Light morphology: WordNet indexes lemmas, pages carry inflections.
const stemsOf = (w) => {
  const out = [w];
  if (w.endsWith("ies") && w.length > 4) out.push(w.slice(0, -3) + "y");
  if (w.endsWith("es") && w.length > 3) out.push(w.slice(0, -2));
  if (w.endsWith("s") && w.length > 2) out.push(w.slice(0, -1));
  if (w.endsWith("ing") && w.length > 5) out.push(w.slice(0, -3), w.slice(0, -3) + "e");
  if (w.endsWith("ed") && w.length > 4) out.push(w.slice(0, -2), w.slice(0, -1));
  return [...new Set(out)];
};

exports.defineWord = async (req, res) => {
  try {
    const { courseId } = req.query;
    const word = normalizeWord(req.query.word);
    if (!word) return err(res, 400, "word is required");

    // 1. Course glossary (including inflections: "compilers" → "compiler")
    if (okId(courseId)) {
      const g = await Glossary.findOne({ courseId, termKey: { $in: stemsOf(word) } }).lean();
      if (g) {
        return res.status(200).json({
          message: [{ key: "success", value: "Definition" }],
          data: { found: true, source: "glossary", term: g.term, definition: g.definition },
        });
      }
    }

    // 2. WordNet
    const cacheKey = word;
    if (!defineCache.has(cacheKey)) {
      let result = { found: false };
      try {
        const wn = await getWordnet();
        for (const candidate of stemsOf(word)) {
          try {
            const senses = await wn.lookup(candidate);
            if (senses && senses.length) {
              // First two senses cover the common meanings without flooding
              // the popup; glosses carry example quotes after a semicolon.
              const definition = senses
                .slice(0, 2)
                .map((s, i) => (senses.length > 1 ? `${i + 1}. ` : "") + String(s.glossary || "").split(/; "/)[0])
                .join("\n");
              result = { found: true, source: "dictionary", term: candidate, definition };
              break;
            }
          } catch {
            // unknown word for this candidate — try the next stem
          }
        }
      } catch (e) {
        console.warn("wordnet unavailable:", e.message);
      }
      defineCache.set(cacheKey, result);
    }
    const hit = defineCache.get(cacheKey);
    return res.status(200).json({
      message: [{ key: "success", value: hit.found ? "Definition" : "No definition" }],
      data: hit,
    });
  } catch (e) {
    console.error("defineWord error:", e);
    return err(res, 500, "Internal server error");
  }
};

// ── LESSON WORDS — every word's box, for the dictionary hover layer ────────
// GET ?fileUrl=&fromPage=&toPage= — raw boxes only, no definitions (those
// are fetched per word on hover). Chunks stay small: 10 pages ≈ a few KB.
exports.lessonWords = async (req, res) => {
  try {
    const { fileUrl } = req.query;
    const fromPage = Math.max(1, parseInt(req.query.fromPage, 10) || 1);
    const toPage = Math.min(fromPage + 9, parseInt(req.query.toPage, 10) || fromPage + 9);
    if (!fileUrl) return err(res, 400, "fileUrl is required");

    const maps = await LessonTextMap.find({ fileUrl, page: { $gte: fromPage, $lte: toPage } })
      .select("page pageWidth pageHeight words")
      .lean();
    const pages = maps.map((m) => ({
      page: m.page,
      pageWidth: m.pageWidth,
      pageHeight: m.pageHeight,
      words: (m.words || []).filter(
        (w) => w.x >= 0 && w.y >= 0 && normalizeWord(w.t).length > 2
      ),
    }));
    return res.status(200).json({
      message: [{ key: "success", value: "Lesson words" }],
      data: { pages },
    });
  } catch (e) {
    console.error("lessonWords error:", e);
    return err(res, 500, "Internal server error");
  }
};

// ── LESSON TERMS — the hotspots the viewer overlays ────────────────────────
// GET ?courseId=&fileUrl=&fromPage=&toPage=
// Returns per page: the page's natural size plus every glossary occurrence
// with its box. Multi-word terms ("primary key") are found by joining up to
// three consecutive words on the same text line.
const MAX_TERM_WORDS = 3;

exports.lessonTerms = async (req, res) => {
  try {
    const { courseId, fileUrl } = req.query;
    const fromPage = Math.max(1, parseInt(req.query.fromPage, 10) || 1);
    const toPage = parseInt(req.query.toPage, 10) || fromPage + 19;
    if (!okId(courseId) || !fileUrl) return err(res, 400, "courseId and fileUrl are required");

    const terms = await Glossary.find({ courseId }).lean();
    if (terms.length === 0) {
      return res.status(200).json({
        message: [{ key: "success", value: "No glossary for this course" }],
        data: { pages: [], totalTerms: 0 },
      });
    }
    // termKey may be multi-word — index by word count for the sliding join.
    const byPhrase = new Map(terms.map((t) => [t.termKey, t]));

    const maps = await LessonTextMap.find({
      fileUrl,
      page: { $gte: fromPage, $lte: toPage },
    }).lean();

    const pages = [];
    for (const m of maps) {
      const words = m.words || [];
      const items = [];
      for (let i = 0; i < words.length; i++) {
        const first = normalizeWord(words[i].t);
        if (!first) continue;
        // Try longest phrase first so "primary key" wins over "primary".
        for (let len = MAX_TERM_WORDS; len >= 1; len--) {
          if (i + len > words.length) continue;
          const slice = words.slice(i, i + len);
          // Words of one phrase must sit on the same text line.
          const lineOk = slice.every(
            (w) => Math.abs(w.y - slice[0].y) < Math.max(slice[0].h, 8) * 0.7
          );
          if (!lineOk) continue;
          const phrase = slice.map((w) => normalizeWord(w.t)).filter(Boolean).join(" ");
          const hit = byPhrase.get(phrase);
          if (hit) {
            const x = Math.min(...slice.map((w) => w.x));
            const y = Math.min(...slice.map((w) => w.y));
            const x2 = Math.max(...slice.map((w) => w.x + w.w));
            const y2 = Math.max(...slice.map((w) => w.y + w.h));
            // Rotated/odd transforms can yield off-page boxes — an invisible
            // hotspot is worse than none, so drop anything out of bounds.
            const inBounds =
              x >= 0 && y >= 0 &&
              (!m.pageWidth || x2 <= m.pageWidth * 1.02) &&
              (!m.pageHeight || y2 <= m.pageHeight * 1.02);
            if (inBounds) {
              items.push({
                term: hit.term,
                definition: hit.definition,
                x, y, w: x2 - x, h: y2 - y,
              });
            }
            i += len - 1; // don't re-match inside the consumed phrase
            break;
          }
        }
      }
      if (items.length) {
        pages.push({
          page: m.page,
          pageWidth: m.pageWidth,
          pageHeight: m.pageHeight,
          source: m.source,
          items,
        });
      }
    }

    return res.status(200).json({
      message: [{ key: "success", value: "Lesson glossary terms" }],
      data: { pages, totalTerms: terms.length },
    });
  } catch (e) {
    console.error("lessonTerms error:", e);
    return err(res, 500, "Internal server error");
  }
};
