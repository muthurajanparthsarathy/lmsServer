// utils/pedagogyScope.js
//
// Resources by Batch — the bridge between a REQUEST and the pedagogy container
// it should read or write.
//
// `utils/batchResources.js` holds the pure rules (which container, which batch,
// what a viewer may see). This file is the thin database-aware layer on top:
// given a loaded node document and the request, it looks up the node's course
// and hands back the container to use. It lives on its own so that every
// controller touching `pedagogy.<tab>.<subcategory>` — the file/resource one
// (pedagogyView.js) AND the exercise one (exerciseAndQuestion.js), which owns
// We Do assignments and You Do assessments — shares ONE implementation.
//
// That sharing is the point. When only pedagogyView.js knew about batches, I Do
// scoped correctly and We Do / You Do silently kept serving the course-level
// set, so a trainer with "batch 2" selected was shown batch 1's assignments.

const mongoose = require("mongoose");
const {
  resolvePedagogyTarget,
  resolveViewerBatchId,
  isBatchWiseSection,
} = require("./batchResources");

// Only the fields batch scoping reads. Kept tight because this runs on every
// exercise read, and the course document is otherwise large.
const COURSE_BATCH_FIELDS =
  "batchResources batchAndParticipants batch skillingBatches batches";

/**
 * The course a pedagogy node belongs to.
 *
 * Every node level (module / submodule / topic / subtopic) carries `courses`,
 * so one lookup covers all four. Returns null when the node has no course ref
 * (legacy rows) — callers then fall through to the shared, course-level
 * container, i.e. the behavior that predates this feature.
 */
const loadCourseForNode = async (entity) => {
  const courseId = entity?.courses;
  if (!courseId) return null;
  try {
    return await mongoose
      .model("Course-Structure")
      .findById(courseId)
      .select(COURSE_BATCH_FIELDS)
      .lean();
  } catch (err) {
    console.error("loadCourseForNode failed:", err.message);
    return null;
  }
};

/** The batch id a request resolves to, given the node's course. */
const readRequestedBatch = (req) =>
  req?.body?.batchId ??
  req?.query?.batchId ??
  req?.body?.batchName ??
  req?.query?.batchName;

/**
 * Where a handler should read/write for one pedagogy section.
 *
 * Returns:
 *   container → the object holding I_Do/We_Do/You_Do. `entity.pedagogy` for a
 *               shared element, `entity.batchPedagogy.<batchId>` for a
 *               batch-wise one (created on first write).
 *   basePath  → the mongoose path to that container, for `markModified` —
 *               these are Maps of Mixed, so changes are not auto-tracked.
 *   batchId   → "" when the resolved scope is the shared container.
 *   batchWise → whether THIS section is batch-wise on this course, so a caller
 *               can decide whether a missing batch is worth reporting.
 *
 * The batch is resolved from the caller, never taken on trust:
 *
 *   • staff → the `batchId` they sent (the batch strip on the Resources page),
 *     falling back to the course's first batch;
 *   • student → their ENROLLED batch, whatever they sent. That is what stops a
 *     Batch A student reaching Batch B's assignments by naming it.
 *
 * With no batch resolvable it returns the shared container, which is the
 * correct no-op for courses without batches and for callers written before
 * this feature existed.
 */
const resolvePedagogyScope = async (entity, section, req) => {
  const course = await loadCourseForNode(entity);
  const batchId = resolveViewerBatchId(course, req?.user, readRequestedBatch(req));
  return {
    ...resolvePedagogyTarget(entity, course, section, batchId),
    batchWise: isBatchWiseSection(course, section),
    course,
  };
};

/**
 * Same, for handlers that search across ALL sections without being told which
 * one they are in (exercise lookup by id, approval flows arriving with only an
 * exercise id, …).
 *
 * Returns the containers to search IN PRIORITY ORDER: this batch's first, then
 * the shared one. Searching both is deliberate — an exercise id may belong to
 * either, and a course whose config was flipped after content was created can
 * legitimately have exercises in both places. The batch container comes first
 * so a batch's own copy wins over a shared one with the same id.
 */
const resolveSearchScopes = async (entity, req) => {
  const course = await loadCourseForNode(entity);
  const batchId = resolveViewerBatchId(course, req?.user, readRequestedBatch(req));

  const scopes = [];
  if (batchId && entity?.batchPedagogy) {
    const bucket =
      typeof entity.batchPedagogy.get === "function"
        ? entity.batchPedagogy.get(String(batchId))
        : entity.batchPedagogy[String(batchId)];
    if (bucket) scopes.push({ container: bucket, basePath: `batchPedagogy.${batchId}`, batchId });
  }
  if (entity?.pedagogy) scopes.push({ container: entity.pedagogy, basePath: "pedagogy", batchId: "" });
  return scopes;
};

/**
 * A merged view of one section across the shared container AND every batch,
 * for lookups keyed by an item's own `_id`.
 *
 * Several helpers resolve an exercise from an id alone, with no request and no
 * batch in hand — "what is this submission's exercise called?", "has its
 * deadline passed?". An `_id` is unambiguous, so which batch owns it does not
 * change the answer; what matters is that the lookup can SEE batch-wise
 * content at all, which a plain `doc.pedagogy[section]` cannot.
 *
 * Read-only by design. Anything that WRITES must go through
 * `resolvePedagogyScope` so it lands in one specific batch.
 *
 * Keys collide across batches (every batch has an "Assignment"), so entries
 * are returned as a flat LIST rather than an object — merging into an object
 * would silently drop all but the last batch's.
 *
 * Each entry is `[subcategory, value, batchId]`, where `batchId` is "" for the
 * shared container. Callers that only need the first two can destructure two;
 * callers that will later WRITE to what they found (the approval queues, which
 * hand the item back to an approve/reject endpoint) must carry `batchId` so
 * that write can be scoped to the right container.
 */
const mergeSectionAcrossBatches = (doc, section) => {
  const out = [];
  const push = (map, batchId) => {
    if (!map) return;
    const entries =
      map instanceof Map
        ? Array.from(map.entries())
        : typeof map.toObject === "function"
          ? Object.entries(map.toObject())
          : Object.entries(map);
    for (const [k, v] of entries) out.push([k, v, batchId]);
  };

  push(doc?.pedagogy?.[section], "");

  const bp = doc?.batchPedagogy;
  if (bp) {
    const ids =
      typeof bp.keys === "function" ? Array.from(bp.keys()) : Object.keys(bp);
    for (const id of ids) {
      const bucket = typeof bp.get === "function" ? bp.get(id) : bp[id];
      push(bucket?.[section], String(id));
    }
  }

  return out;
};

/**
 * Find the LIVE container holding a specific exercise, by id.
 *
 * For actions on one identified exercise — approve, reject, resubmit, act on a
 * question inside it — the batch is a property OF THE EXERCISE, not of the
 * person acting. An approver works a queue spanning every batch, so scoping to
 * whatever batch their Resources page happens to have selected would send them
 * to the wrong container and report the exercise as missing.
 *
 * Unlike `mergeSectionAcrossBatches` (read-only, `.lean()` docs), this returns
 * the live Mongoose containers so the caller can mutate and save, plus the
 * `basePath` for `markModified`.
 *
 * Returns null when the exercise is in none of them.
 */
const locateExerciseContainer = (entity, section, subcategory, exerciseId) => {
  const target = String(exerciseId);

  const candidates = [];
  if (entity?.pedagogy) candidates.push({ container: entity.pedagogy, basePath: "pedagogy", batchId: "" });

  const bp = entity?.batchPedagogy;
  if (bp) {
    const ids = typeof bp.keys === "function" ? Array.from(bp.keys()) : Object.keys(bp);
    for (const id of ids) {
      const bucket = typeof bp.get === "function" ? bp.get(id) : bp[id];
      if (bucket) {
        candidates.push({ container: bucket, basePath: `batchPedagogy.${id}`, batchId: String(id) });
      }
    }
  }

  for (const c of candidates) {
    const map = c.container?.[section];
    if (!map) continue;
    const list = typeof map.get === "function" ? map.get(subcategory) : map[subcategory];
    if (!Array.isArray(list)) continue;
    const index = list.findIndex((e) => e && String(e._id) === target);
    if (index !== -1) return { ...c, exercises: list, index, exercise: list[index] };
  }

  return null;
};

module.exports = {
  COURSE_BATCH_FIELDS,
  loadCourseForNode,
  readRequestedBatch,
  resolvePedagogyScope,
  resolveSearchScopes,
  mergeSectionAcrossBatches,
  locateExerciseContainer,
};
