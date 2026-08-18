// Resources by Batch — persistence check against the real Mongoose models.
//
//   node scripts/verifyBatchResourcesPersistence.js
//
// No database connection: documents are built in memory and pushed through
// BSON serialize/deserialize, which is exactly what `.lean()` reads hand back.
// That round-trip is the point — `JSON.stringify` on a Mongoose Map renders
// `{}` and will happily convince you the data was never written.
//
// Covers the three specified scenarios end to end: upload → store → read back
// as the student, at every node level (module / submodule / topic / subtopic).
const assert = require("assert");
const mongoose = require("mongoose");
const BSON = require("bson");

["moduleModal", "subModuleModal", "topicModal", "subTopicModal"].forEach((m) =>
  require(`../models/Courses/moduleStructure/${m}`),
);
const B = require("../utils/batchResources");

const NODE_MODELS = {
  module: mongoose.model("Module1"),
  submodule: mongoose.model("SubModule1"),
  topic: mongoose.model("Topic1"),
  subtopic: mongoose.model("SubTopic1"),
};

const BATCH_A = new mongoose.Types.ObjectId();
const BATCH_B = new mongoose.Types.ObjectId();

const makeCourse = (batchResources) => ({
  batchResources,
  batchAndParticipants: [
    { _id: BATCH_A, batchName: "python I", users: [{ user: "stuA" }] },
    { _id: BATCH_B, batchName: "python II", users: [{ user: "stuB" }] },
  ],
});

const student = (id) => ({ _id: id, role: { originalRole: "Student" } });
const STAFF = { _id: "staff1", role: { originalRole: "Trainer" } };

const newNode = (type) =>
  new NODE_MODELS[type]({
    institution: new mongoose.Types.ObjectId(),
    courses: new mongoose.Types.ObjectId(),
    title: "node",
    ...(type === "topic" || type === "subtopic" ? { moduleId: new mongoose.Types.ObjectId() } : {}),
  });

// The three sections do NOT store the same shape, and the fixtures have to
// respect that or Mongoose casting quietly discards them:
//   I_Do   → a pedagogy element  { description, files, folders, pages }
//   We_Do  → an ARRAY of exercises
//   You_Do → Mixed
const sectionPayload = (section, marker) => {
  if (section === "We_Do") return [{ exerciseInformation: { exerciseId: marker, exerciseName: marker } }];
  if (section === "You_Do") return { marker };
  return { description: "", files: [{ fileName: marker }], folders: [], pages: [] };
};

/** Reads the marker back out of whichever shape the section uses. */
const readMarker = (section, value) => {
  if (section === "We_Do") return value?.[0]?.exerciseInformation?.exerciseId;
  if (section === "You_Do") return value?.marker;
  return value?.files?.[0]?.fileName;
};

/** Simulates one staff upload through the same helper the controller uses. */
const upload = (doc, course, section, subcategory, batchId, marker) => {
  const { container, basePath } = B.resolvePedagogyTarget(doc, course, section, batchId);
  container[section].set(subcategory, sectionPayload(section, marker));
  doc.markModified(`${basePath}.${section}.${subcategory}`);
  return basePath;
};

/** What a `.lean()` read would hand the controller. */
const asStored = (doc) => BSON.deserialize(BSON.serialize(doc.toObject()));

let passed = 0;
const check = (label, fn) => { fn(); passed++; console.log("  PASS  " + label); };

for (const type of Object.keys(NODE_MODELS)) {
  console.log(`\n── ${type} ──────────────────────────────────────────────`);

  // ── Test Case 1 — batches, shared resources ──────────────────────────────
  check(`[${type}] shared: one upload, every batch sees it`, () => {
    const course = makeCourse({ sameForAllBatches: true, batchwiseElements: [] });
    const doc = newNode(type);

    // Staff has "python I" selected, but the element is shared.
    const path = upload(doc, course, "I_Do", "video", String(BATCH_A), "shared.mp4");
    assert.strictEqual(path, "pedagogy", "a shared upload must not create a batch container");

    const stored = asStored(doc);
    assert.strictEqual(readMarker("I_Do", stored.pedagogy.I_Do.video), "shared.mp4");
    assert.ok(!stored.batchPedagogy || Object.keys(stored.batchPedagogy).length === 0);

    for (const id of ["stuA", "stuB"]) {
      const batch = B.resolveViewerBatchId(course, student(id));
      const seen = B.scopeNodePedagogy(asStored(doc), course, batch);
      assert.strictEqual(readMarker("I_Do", seen.pedagogy.I_Do.video), "shared.mp4");
    }
  });

  // ── Test Case 2 — batch-specific resources ───────────────────────────────
  check(`[${type}] batch-wise: each batch gets its own I_Do/We_Do/You_Do`, () => {
    const course = makeCourse({
      sameForAllBatches: false,
      batchwiseElements: ["I_Do", "We_Do", "You_Do"],
    });
    const doc = newNode(type);

    upload(doc, course, "I_Do", "video", String(BATCH_A), "A.mp4");
    upload(doc, course, "We_Do", "practical", String(BATCH_A), "A.zip");
    upload(doc, course, "You_Do", "assessment", String(BATCH_A), "A.pdf");
    upload(doc, course, "I_Do", "video", String(BATCH_B), "B.mp4");
    upload(doc, course, "We_Do", "practical", String(BATCH_B), "B.zip");
    upload(doc, course, "You_Do", "assessment", String(BATCH_B), "B.pdf");

    const stored = asStored(doc);
    // Course → Batch → I_Do/We_Do/You_Do, exactly the specified hierarchy.
    assert.deepStrictEqual(
      Object.keys(stored.batchPedagogy).sort(),
      [String(BATCH_A), String(BATCH_B)].sort(),
    );
    for (const id of [BATCH_A, BATCH_B]) {
      assert.deepStrictEqual(
        Object.keys(stored.batchPedagogy[String(id)]).filter((k) => k !== "_id").sort(),
        ["I_Do", "We_Do", "You_Do"],
      );
    }

    // Student visibility: own batch only, other batches absent from the wire.
    const cases = [
      ["stuA", "A", "B"],
      ["stuB", "B", "A"],
    ];
    for (const [id, mine, theirs] of cases) {
      const batch = B.resolveViewerBatchId(course, student(id));
      const seen = B.scopeNodePedagogy(asStored(doc), course, batch);
      assert.strictEqual(readMarker("I_Do", seen.pedagogy.I_Do.video), `${mine}.mp4`);
      assert.strictEqual(readMarker("We_Do", seen.pedagogy.We_Do.practical), `${mine}.zip`);
      assert.strictEqual(readMarker("You_Do", seen.pedagogy.You_Do.assessment), `${mine}.pdf`);

      const wire = JSON.stringify(seen);
      assert.ok(!wire.includes(`${theirs}.mp4`), `${id} must not receive ${theirs}'s I_Do`);
      assert.ok(!wire.includes(`${theirs}.zip`), `${id} must not receive ${theirs}'s We_Do`);
      assert.ok(!wire.includes(`${theirs}.pdf`), `${id} must not receive ${theirs}'s You_Do`);
      assert.strictEqual("batchPedagogy" in seen, false);
    }

    // Staff switching the strip switches the slice.
    for (const [id, mine] of [[BATCH_A, "A"], [BATCH_B, "B"]]) {
      const batch = B.resolveViewerBatchId(course, STAFF, String(id));
      const seen = B.scopeNodePedagogy(asStored(doc), course, batch);
      assert.strictEqual(readMarker("I_Do", seen.pedagogy.I_Do.video), `${mine}.mp4`);
    }
  });

  // ── Mixed config (the screenshot: I_Do + We_Do batch-wise, You_Do shared) ─
  check(`[${type}] mixed: batch-wise I_Do/We_Do alongside a shared You_Do`, () => {
    const course = makeCourse({
      sameForAllBatches: false,
      batchwiseElements: ["I_Do", "We_Do"],
    });
    const doc = newNode(type);

    upload(doc, course, "I_Do", "video", String(BATCH_A), "A.mp4");
    upload(doc, course, "I_Do", "video", String(BATCH_B), "B.mp4");
    const sharedPath = upload(doc, course, "You_Do", "assessment", String(BATCH_A), "shared.pdf");
    assert.strictEqual(sharedPath, "pedagogy", "You_Do is shared and must stay course-level");

    const seen = B.scopeNodePedagogy(
      asStored(doc),
      course,
      B.resolveViewerBatchId(course, student("stuA")),
    );
    assert.strictEqual(readMarker("I_Do", seen.pedagogy.I_Do.video), "A.mp4");
    assert.strictEqual(readMarker("You_Do", seen.pedagogy.You_Do.assessment), "shared.pdf");
    assert.ok(!JSON.stringify(seen).includes("B.mp4"));
  });

  // ── Test Case 3 — course without batches ─────────────────────────────────
  check(`[${type}] no batches: everything stays course-level`, () => {
    const course = { batchResources: { sameForAllBatches: false, batchwiseElements: ["I_Do"] } };
    const doc = newNode(type);

    const path = upload(doc, course, "I_Do", "video", String(BATCH_A), "course.mp4");
    assert.strictEqual(path, "pedagogy");

    const stored = asStored(doc);
    assert.strictEqual(readMarker("I_Do", stored.pedagogy.I_Do.video), "course.mp4");
    assert.ok(!stored.batchPedagogy || Object.keys(stored.batchPedagogy).length === 0);
    assert.strictEqual(B.buildResourceBatchContext(course, STAFF).mode, "no-batches");
  });

  check(`[${type}] documents with batch content still validate`, () => {
    const course = makeCourse({ sameForAllBatches: false, batchwiseElements: ["I_Do"] });
    const doc = newNode(type);
    upload(doc, course, "I_Do", "video", String(BATCH_A), "A.mp4");
    const err = doc.validateSync();
    assert.strictEqual(err, undefined, err && String(err));
  });
}

console.log(`\n${passed} checks passed across ${Object.keys(NODE_MODELS).length} node levels.`);
