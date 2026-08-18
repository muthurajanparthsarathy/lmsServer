// utils/batchResources.js
//
// Resources by Batch — the single place that decides WHERE a course's I Do /
// We Do / You Do material lives, and WHICH slice of it a given caller may see.
//
// ── The three scenarios ──────────────────────────────────────────────────────
//   1. Course WITHOUT batches            → course-level resources only.
//   2. Course WITH batches, shared       → one set, every batch sees it.
//   3. Course WITH batches, batch-wise   → one set per batch, per element.
//
// ── How it is stored ─────────────────────────────────────────────────────────
// The batch is its own level of the hierarchy, holding a complete I_Do /
// We_Do / You_Do set inside it:
//
//   node
//     ├── pedagogy                ← course-level / shared  (scenarios 1 & 2)
//     │     ├── I_Do   ├── We_Do   └── You_Do
//     └── batchPedagogy
//           ├── <batchId>         ← Batch A                (scenario 3)
//           │     ├── I_Do   ├── We_Do   └── You_Do
//           └── <batchId>         ← Batch B
//                 ├── I_Do   ├── We_Do   └── You_Do
//
// Batches are keyed by `_id` (from `Course-Structure.batchAndParticipants`),
// never by name — renaming a batch must not orphan its material.
//
// Two consequences worth stating, because everything else follows from them:
//
//   • `pedagogy` is untouched by this feature. Every course that exists today
//     keeps its material exactly where it was and keeps behaving as
//     course-level/shared, with nothing migrated. Only an element explicitly
//     ticked batch-wise in Course Setup ever reads or writes `batchPedagogy`.
//
//   • Callers never assemble paths themselves. Writes pick a container through
//     `resolvePedagogyTarget`; reads flatten one batch's container back onto
//     the plain `pedagogy` shape through `scopeNodePedagogy`, which also DROPS
//     `batchPedagogy` from the response — that is what keeps Batch B's
//     material out of a Batch A student's payload entirely, rather than merely
//     unrendered.

const SECTIONS = ["I_Do", "We_Do", "You_Do"];

/** Normalizes a Map / Mongoose Map / plain object to entries. */
const toEntries = (map) => {
  if (!map) return [];
  if (map instanceof Map) return Array.from(map.entries());
  if (typeof map.toObject === "function") return Object.entries(map.toObject());
  return Object.entries(map);
};

/** Reads one key out of a Map or plain object. */
const mapGet = (map, key) => {
  if (!map) return undefined;
  if (typeof map.get === "function") return map.get(key);
  return map[key];
};

/**
 * Every batch on this course, as `{ id, name }`.
 *
 * Mirrors `getCourseBatches` in courseStructure.js: `batchAndParticipants` is
 * the truth once it exists, but a course mapped with batches whose Batches
 * page was never opened has only the picked NAMES and no containers yet.
 * Those are surfaced with a null id — they can be displayed and enrolled
 * into, but nothing can be filed under them until the container exists, which
 * `getCourseBatches` creates on first visit.
 */
const listCourseBatches = (course) => {
  if (!course) return [];

  const out = [];
  const seen = new Set();

  for (const b of course.batchAndParticipants || []) {
    const name = String(b?.batchName || "").trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ id: b?._id ? String(b._id) : null, name });
  }

  for (const raw of [course.batch, ...(course.skillingBatches || []), ...(course.batches || [])]) {
    const name = String(raw || "").trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ id: null, name });
  }

  return out;
};

const listCourseBatchNames = (course) => listCourseBatches(course).map((b) => b.name);

/** Scenario 1 hinges on this: does the course run in batches at all? */
const courseUsesBatches = (course) => listCourseBatches(course).length > 0;

/**
 * Is THIS element batch-wise for THIS course?
 *
 * All three conditions must hold. In particular a course with no batches can
 * never be batch-wise no matter what the stored config says — which is what
 * makes a course that had its batches removed fall back to course-level
 * cleanly instead of pointing at containers that no longer exist.
 */
const isBatchWiseSection = (course, section) => {
  if (!course || !SECTIONS.includes(section)) return false;
  if (!courseUsesBatches(course)) return false;
  const cfg = course.batchResources || {};
  if (cfg.sameForAllBatches !== false) return false;
  return (cfg.batchwiseElements || []).map(String).includes(section);
};

/**
 * Resolve a batch id from whatever the caller had to hand — an id, or a name.
 * Returns "" when it matches nothing on this course.
 */
const resolveBatchId = (course, batchIdOrName) => {
  const wanted = String(batchIdOrName || "").trim();
  if (!wanted) return "";
  const batches = listCourseBatches(course);
  const byId = batches.find((b) => b.id && b.id === wanted);
  if (byId) return byId.id;
  const byName = batches.find((b) => b.name.toLowerCase() === wanted.toLowerCase());
  return byName?.id || "";
};

const getBatchName = (course, batchId) =>
  listCourseBatches(course).find((b) => b.id === String(batchId || ""))?.name || "";

/**
 * The batch a user is enrolled in on this course, as an id. "" for staff and
 * for anyone not enrolled. First match wins — a user enrolled twice is a data
 * problem, not something to resolve here.
 */
const getUserBatchId = (course, userId) => {
  if (!course || !userId) return "";
  const target = String(userId);
  for (const batch of course.batchAndParticipants || []) {
    const inBatch = (batch.users || []).some((u) => {
      const uid = u?.user?._id || u?.user;
      return uid && String(uid) === target;
    });
    if (inBatch) return batch?._id ? String(batch._id) : "";
  }
  return "";
};

// The Role model stores `originalRole` (the platform role) and `renameRole`
// (the institution's own label for it), and different call sites have
// historically written `roleName`/`roleValue` too. Check them all — a missed
// spelling here would hand a student the staff view of every batch.
const isStudentUser = (user) => {
  const role = user?.role;
  if (!role || typeof role !== "object") return false;
  const label = [role.originalRole, role.renameRole, role.roleName, role.roleValue]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return label.includes("student");
};

/**
 * Which batch a request is scoped to, as an id.
 *
 * A student's batch comes from their enrolment and NOTHING else — a
 * client-supplied batch is ignored for them, so "Batch A student asks for
 * Batch B" cannot succeed at any layer. Staff may pick any batch on the
 * course; naming none lands them on the first, so the Resources page opens on
 * something real rather than an empty screen. An unidentified caller gets no
 * batch at all: the `/getAll/courses-data` reads are open, and defaulting them
 * to "the first batch" would hand one batch's material to anyone holding a
 * course id.
 */
const resolveViewerBatchId = (course, user, requestedBatch) => {
  if (!courseUsesBatches(course)) return "";
  if (!user) return "";
  if (isStudentUser(user)) return getUserBatchId(course, user._id || user.id);

  const asked = resolveBatchId(course, requestedBatch);
  if (asked) return asked;

  const enrolled = getUserBatchId(course, user._id || user.id);
  if (enrolled) return enrolled;

  return listCourseBatches(course).find((b) => b.id)?.id || "";
};

/**
 * Where a write should land for one (section, batch) pair.
 *
 * Returns the container holding I_Do/We_Do/You_Do plus the mongoose path that
 * addresses it, because every caller needs both — the container to mutate and
 * the path to `markModified`, since Maps of Mixed do not track changes.
 *
 * A shared element always resolves to `pedagogy`, so "staff uploads once"
 * needs no special case at the call site. A batch-wise element resolves to
 * `batchPedagogy.<batchId>`, CREATING that container on first write. With no
 * batch resolvable it falls back to `pedagogy` rather than inventing a bucket
 * no reader would ever look in.
 */
const resolvePedagogyTarget = (entity, course, section, batchId) => {
  // A node that has never had a resource uploaded has no `pedagogy` subdoc at
  // all (the schema sets no default), so create it here rather than leaving
  // every caller to remember. This is the only function that hands out a
  // container, which makes it the only place that has to get this right.
  if (!entity.pedagogy) {
    entity.pedagogy = { I_Do: new Map(), We_Do: new Map(), You_Do: new Map() };
  }
  const shared = { container: entity.pedagogy, basePath: "pedagogy", batchId: "" };

  if (!isBatchWiseSection(course, section)) return shared;

  // Re-validate against the course rather than trusting the id. Callers reach
  // here through `resolveViewerBatchId`, which already checks — but this is
  // the function that CREATES a container, and an unchecked id would mint one
  // no reader could ever find. Cheap insurance against the next caller.
  const id = resolveBatchId(course, batchId);
  if (!id) return shared;

  if (!entity.batchPedagogy) entity.batchPedagogy = new Map();

  let bucket = mapGet(entity.batchPedagogy, id);
  if (!bucket) {
    bucket = { I_Do: new Map(), We_Do: new Map(), You_Do: new Map() };
    if (typeof entity.batchPedagogy.set === "function") entity.batchPedagogy.set(id, bucket);
    else entity.batchPedagogy[id] = bucket;
    bucket = mapGet(entity.batchPedagogy, id);
  }

  return { container: bucket, basePath: `batchPedagogy.${id}`, batchId: id };
};

/**
 * Flatten ONE batch's view of a node onto the plain `pedagogy` shape.
 *
 * For a batch-wise element the batch's own set replaces the shared one; for a
 * shared element the shared set is returned as-is. `batchPedagogy` is stripped
 * from the result either way, so no response ever carries another batch's
 * material — "hidden" means absent, not just unrendered.
 *
 * The shared set is used as a fallback for a batch-wise element whose batch
 * has nothing of its own yet, so flipping a course from shared to batch-wise
 * does not look like every resource vanished overnight.
 */
const scopeNodePedagogy = (node, course, batchId) => {
  if (!node || typeof node !== "object") return node;

  const batchBucket = batchId ? mapGet(node.batchPedagogy, String(batchId)) : null;
  const result = {};

  for (const section of SECTIONS) {
    const sharedEntries = Object.fromEntries(toEntries(node.pedagogy?.[section]));
    if (!isBatchWiseSection(course, section) || !batchBucket) {
      result[section] = sharedEntries;
      continue;
    }
    const own = Object.fromEntries(toEntries(batchBucket[section]));
    result[section] = Object.keys(own).length > 0 ? own : sharedEntries;
  }

  // The pedagogy schemas are `strict: false`, so anything else stored on them
  // is real data — dropping it here would be a silent loss.
  for (const [key, value] of toEntries(node.pedagogy)) {
    if (!SECTIONS.includes(key)) result[key] = value;
  }

  node.pedagogy = result;
  delete node.batchPedagogy;
  return node;
};

/** Walk a structured course payload and scope every node in it. */
const scopeCourseTreePedagogy = (node, course, batchId) => {
  if (!node || typeof node !== "object") return node;
  if (node.pedagogy || node.batchPedagogy) scopeNodePedagogy(node, course, batchId);
  for (const childKey of ["modules", "subModules", "topics", "subTopics"]) {
    if (Array.isArray(node[childKey])) {
      node[childKey].forEach((child) => scopeCourseTreePedagogy(child, course, batchId));
    }
  }
  return node;
};

/**
 * Everything the UI needs to render the section correctly, in one object.
 *
 * `mode` is what the client branches on:
 *   "no-batches" → hide the Resources-by-batch section entirely; everything is
 *                  course-level (this is the spec's "course without batches").
 *   "shared"     → batches exist but there is still nothing to pick; staff
 *                  upload once and every batch sees it.
 *   "batch-wise" → show the batch strip for the elements in
 *                  `batchwiseElements`; the rest stay shared.
 */
const buildResourceBatchContext = (course, user, requestedBatch) => {
  const batches = listCourseBatches(course);
  const usesBatches = batches.length > 0;
  const cfg = course?.batchResources || {};
  const sameForAllBatches = cfg.sameForAllBatches !== false;
  const batchwiseElements =
    usesBatches && !sameForAllBatches
      ? (cfg.batchwiseElements || []).map(String).filter((s) => SECTIONS.includes(s))
      : [];

  const student = !!user && isStudentUser(user);
  const activeBatchId = resolveViewerBatchId(course, user, requestedBatch);

  return {
    mode: !usesBatches ? "no-batches" : batchwiseElements.length === 0 ? "shared" : "batch-wise",
    usesBatches,
    sameForAllBatches,
    batchwiseElements,
    batches,
    activeBatchId,
    activeBatchName: getBatchName(course, activeBatchId),
    // A student never picks; staff pick only when something is batch-wise.
    canSelectBatch: !student && batchwiseElements.length > 0 && batches.some((b) => b.id),
    isStudent: student,
    // Surfaced so the client can explain an empty screen instead of showing one.
    enrolledBatchId: student ? getUserBatchId(course, user._id || user.id) : "",
    message: !usesBatches
      ? "This course does not use batches. Resources are managed at the course level."
      : batchwiseElements.length === 0
        ? "Course resources are shared — every batch sees the same material."
        : `Batch-wise resources: ${batchwiseElements.join(", ")}.`,
  };
};

module.exports = {
  SECTIONS,
  listCourseBatches,
  listCourseBatchNames,
  courseUsesBatches,
  isBatchWiseSection,
  resolveBatchId,
  getBatchName,
  getUserBatchId,
  isStudentUser,
  resolveViewerBatchId,
  resolvePedagogyTarget,
  scopeNodePedagogy,
  scopeCourseTreePedagogy,
  buildResourceBatchContext,
};
