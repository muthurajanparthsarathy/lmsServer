// Resources by Batch — scenario checks for utils/batchResources.js.
//
//   node scripts/verifyBatchResources.js
//
// No database: the module is pure, so the three specified scenarios can be
// asserted directly against course- and node-shaped fixtures. Run it after
// touching the container layout or the scoping rules — the "Batch A student
// sees ONLY Batch A" and "batchPedagogy is stripped from responses" cases are
// the ones that quietly break.
const assert = require("assert");
const B = require("../utils/batchResources.js");

const STUDENT_ROLE = { originalRole: "Student", renameRole: "Learner" };
const STAFF_ROLE = { originalRole: "Trainer", renameRole: "Faculty" };

const BATCH_A = "aaaaaaaaaaaaaaaaaaaaaaa1";
const BATCH_B = "aaaaaaaaaaaaaaaaaaaaaaa2";
const BATCH_C = "aaaaaaaaaaaaaaaaaaaaaaa3";

const studentA = { _id: "sA", role: STUDENT_ROLE };
const studentB = { _id: "sB", role: STUDENT_ROLE };
const staff = { _id: "st", role: STAFF_ROLE };

const withBatches = (cfg) => ({
  batchResources: cfg,
  batchAndParticipants: [
    { _id: BATCH_A, batchName: "Batch A", users: [{ user: "sA" }] },
    { _id: BATCH_B, batchName: "Batch B", users: [{ user: "sB" }] },
    { _id: BATCH_C, batchName: "Batch C", users: [] },
  ],
});

/** A node document as it comes back from mongo, shared content only. */
const sharedNode = () => ({
  pedagogy: {
    I_Do: { video: "shared-video" },
    We_Do: { practical: "shared-practical" },
    You_Do: { assessment: "shared-assessment" },
  },
});

/** A node with a complete set filed under each batch id. */
const batchedNode = () => ({
  pedagogy: { I_Do: {}, We_Do: {}, You_Do: {} },
  batchPedagogy: {
    [BATCH_A]: { I_Do: { video: "A-vid" }, We_Do: { practical: "A-prac" }, You_Do: { assessment: "A-assess" } },
    [BATCH_B]: { I_Do: { video: "B-vid" }, We_Do: { practical: "B-prac" }, You_Do: { assessment: "B-assess" } },
    [BATCH_C]: { I_Do: { video: "C-vid" }, We_Do: { practical: "C-prac" }, You_Do: { assessment: "C-assess" } },
  },
});

let passed = 0;
const check = (label, fn) => { fn(); passed++; console.log("  PASS  " + label); };

// ── Test Case 3 — Course WITHOUT batches ────────────────────────────────────
console.log("\nTest Case 3 — course without batches");
{
  const course = { batchResources: { sameForAllBatches: true, batchwiseElements: [] } };

  check("section is hidden (mode=no-batches)", () => {
    const ctx = B.buildResourceBatchContext(course, staff, undefined);
    assert.strictEqual(ctx.mode, "no-batches");
    assert.strictEqual(ctx.usesBatches, false);
    assert.strictEqual(ctx.canSelectBatch, false);
    assert.match(ctx.message, /does not use batches/);
  });

  check("uploads land in the course-level container", () => {
    const node = sharedNode();
    const t = B.resolvePedagogyTarget(node, course, "I_Do", BATCH_A);
    assert.strictEqual(t.basePath, "pedagogy");
    assert.strictEqual(t.container, node.pedagogy);
    assert.strictEqual(node.batchPedagogy, undefined, "no batch container should be created");
  });

  check("students read course-level resources", () => {
    const out = B.scopeNodePedagogy(sharedNode(), course, "");
    assert.deepStrictEqual(out.pedagogy.I_Do, { video: "shared-video" });
    assert.deepStrictEqual(out.pedagogy.We_Do, { practical: "shared-practical" });
    assert.deepStrictEqual(out.pedagogy.You_Do, { assessment: "shared-assessment" });
  });

  check("a stale batch-wise config cannot turn it batch-wise", () => {
    const drifted = { batchResources: { sameForAllBatches: false, batchwiseElements: ["I_Do"] } };
    assert.strictEqual(B.isBatchWiseSection(drifted, "I_Do"), false);
    assert.strictEqual(B.buildResourceBatchContext(drifted, staff).mode, "no-batches");
  });
}

// ── Test Case 1 — Batches, resources shared ────────────────────────────────
console.log("\nTest Case 1 — batches, resources shared across all batches");
{
  const course = withBatches({ sameForAllBatches: true, batchwiseElements: [] });

  check("mode=shared, no batch picker", () => {
    const ctx = B.buildResourceBatchContext(course, staff);
    assert.strictEqual(ctx.mode, "shared");
    assert.strictEqual(ctx.canSelectBatch, false);
    assert.deepStrictEqual(ctx.batches.map((b) => b.name), ["Batch A", "Batch B", "Batch C"]);
  });

  check("staff uploads once — the batch is ignored", () => {
    for (const s of ["I_Do", "We_Do", "You_Do"]) {
      const node = sharedNode();
      assert.strictEqual(B.resolvePedagogyTarget(node, course, s, BATCH_A).basePath, "pedagogy");
      assert.strictEqual(B.resolvePedagogyTarget(node, course, s, BATCH_B).basePath, "pedagogy");
    }
  });

  check("every batch's students see the same set", () => {
    const a = B.scopeNodePedagogy(sharedNode(), course, B.resolveViewerBatchId(course, studentA));
    const b = B.scopeNodePedagogy(sharedNode(), course, B.resolveViewerBatchId(course, studentB));
    assert.deepStrictEqual(a, b);
    assert.deepStrictEqual(a.pedagogy.I_Do, { video: "shared-video" });
  });
}

// ── Test Case 2 — Batch-specific resources ─────────────────────────────────
console.log("\nTest Case 2 — batch-specific resources");
{
  const course = withBatches({
    sameForAllBatches: false,
    batchwiseElements: ["I_Do", "We_Do", "You_Do"],
  });

  check("mode=batch-wise, staff get the picker", () => {
    const ctx = B.buildResourceBatchContext(course, staff);
    assert.strictEqual(ctx.mode, "batch-wise");
    assert.strictEqual(ctx.canSelectBatch, true);
    assert.strictEqual(ctx.activeBatchId, BATCH_A); // first, on a cold load
    assert.strictEqual(ctx.activeBatchName, "Batch A");
  });

  check("students never get a picker", () => {
    const ctx = B.buildResourceBatchContext(course, studentA);
    assert.strictEqual(ctx.canSelectBatch, false);
    assert.strictEqual(ctx.isStudent, true);
    assert.strictEqual(ctx.activeBatchId, BATCH_A);
  });

  check("the batch is its own level: batchPedagogy.<batchId>.I_Do", () => {
    const node = { pedagogy: { I_Do: new Map(), We_Do: new Map(), You_Do: new Map() } };
    const tA = B.resolvePedagogyTarget(node, course, "I_Do", BATCH_A);
    const tB = B.resolvePedagogyTarget(node, course, "I_Do", BATCH_B);
    assert.strictEqual(tA.basePath, `batchPedagogy.${BATCH_A}`);
    assert.strictEqual(tB.basePath, `batchPedagogy.${BATCH_B}`);
    assert.notStrictEqual(tA.container, tB.container);
    // Each batch container carries a complete I_Do / We_Do / You_Do set.
    assert.deepStrictEqual(Object.keys(tA.container).sort(), ["I_Do", "We_Do", "You_Do"]);
    // And the shared container is left alone.
    assert.strictEqual(node.pedagogy.I_Do.size, 0);
  });

  check("all three sections of one batch share one container", () => {
    const node = { pedagogy: { I_Do: new Map(), We_Do: new Map(), You_Do: new Map() } };
    const i = B.resolvePedagogyTarget(node, course, "I_Do", BATCH_A);
    const w = B.resolvePedagogyTarget(node, course, "We_Do", BATCH_A);
    const y = B.resolvePedagogyTarget(node, course, "You_Do", BATCH_A);
    assert.strictEqual(i.container, w.container);
    assert.strictEqual(w.container, y.container);
  });

  check("Batch A student sees ONLY Batch A", () => {
    const out = B.scopeNodePedagogy(batchedNode(), course, B.resolveViewerBatchId(course, studentA));
    assert.deepStrictEqual(out.pedagogy.I_Do, { video: "A-vid" });
    assert.deepStrictEqual(out.pedagogy.We_Do, { practical: "A-prac" });
    assert.deepStrictEqual(out.pedagogy.You_Do, { assessment: "A-assess" });
    const wire = JSON.stringify(out);
    assert.ok(!wire.includes("B-vid"), "Batch B material must not be in the payload");
    assert.ok(!wire.includes("C-vid"), "Batch C material must not be in the payload");
  });

  check("batchPedagogy is stripped from every response", () => {
    const out = B.scopeNodePedagogy(batchedNode(), course, BATCH_A);
    assert.strictEqual("batchPedagogy" in out, false);
  });

  check("Batch B student sees ONLY Batch B", () => {
    const out = B.scopeNodePedagogy(batchedNode(), course, B.resolveViewerBatchId(course, studentB));
    assert.deepStrictEqual(out.pedagogy.I_Do, { video: "B-vid" });
    assert.ok(!JSON.stringify(out).includes("A-vid"));
  });

  check("a student asking for another batch is ignored", () => {
    const id = B.resolveViewerBatchId(course, studentA, BATCH_B);
    assert.strictEqual(id, BATCH_A);
    assert.deepStrictEqual(B.scopeNodePedagogy(batchedNode(), course, id).pedagogy.I_Do, { video: "A-vid" });
  });

  check("staff switching the strip switches the slice", () => {
    const id = B.resolveViewerBatchId(course, staff, BATCH_C);
    assert.deepStrictEqual(B.scopeNodePedagogy(batchedNode(), course, id).pedagogy.I_Do, { video: "C-vid" });
  });

  check("staff may also name a batch instead of its id", () => {
    assert.strictEqual(B.resolveViewerBatchId(course, staff, "Batch C"), BATCH_C);
    assert.strictEqual(B.resolveViewerBatchId(course, staff, "batch c"), BATCH_C);
  });

  check("anonymous callers get the shared set only", () => {
    const out = B.scopeNodePedagogy(batchedNode(), course, B.resolveViewerBatchId(course, null, BATCH_A));
    assert.deepStrictEqual(out.pedagogy.I_Do, {});
  });

  check("renaming a batch does not orphan its material", () => {
    const renamed = JSON.parse(JSON.stringify(course));
    renamed.batchAndParticipants[0].batchName = "Batch A (evening)";
    const out = B.scopeNodePedagogy(batchedNode(), renamed, B.resolveViewerBatchId(renamed, studentA));
    assert.deepStrictEqual(out.pedagogy.I_Do, { video: "A-vid" });
  });
}

// ── Mixed: only some elements batch-wise (the screenshot's config) ──────────
console.log("\nMixed — I_Do + We_Do batch-wise, You_Do shared");
{
  const course = withBatches({ sameForAllBatches: false, batchwiseElements: ["I_Do", "We_Do"] });

  check("You_Do writes stay in the shared container", () => {
    const node = { pedagogy: { I_Do: new Map(), We_Do: new Map(), You_Do: new Map() } };
    assert.strictEqual(B.resolvePedagogyTarget(node, course, "You_Do", BATCH_A).basePath, "pedagogy");
    assert.strictEqual(B.resolvePedagogyTarget(node, course, "I_Do", BATCH_A).basePath, `batchPedagogy.${BATCH_A}`);
  });

  check("student sees own I_Do/We_Do plus the shared You_Do", () => {
    const node = {
      pedagogy: { I_Do: {}, We_Do: {}, You_Do: { assessment: "shared-assess" } },
      batchPedagogy: {
        [BATCH_A]: { I_Do: { video: "A-vid" }, We_Do: { practical: "A-prac" }, You_Do: {} },
        [BATCH_B]: { I_Do: { video: "B-vid" }, We_Do: { practical: "B-prac" }, You_Do: {} },
      },
    };
    const out = B.scopeNodePedagogy(node, course, B.resolveViewerBatchId(course, studentA));
    assert.deepStrictEqual(out.pedagogy.I_Do, { video: "A-vid" });
    assert.deepStrictEqual(out.pedagogy.We_Do, { practical: "A-prac" });
    assert.deepStrictEqual(out.pedagogy.You_Do, { assessment: "shared-assess" });
  });
}

// ── Migration safety ────────────────────────────────────────────────────────
console.log("\nMigration safety");
{
  const course = withBatches({ sameForAllBatches: false, batchwiseElements: ["I_Do"] });

  check("pre-existing shared uploads stay visible after switching to batch-wise", () => {
    const out = B.scopeNodePedagogy(sharedNode(), course, BATCH_A);
    assert.deepStrictEqual(out.pedagogy.I_Do, { video: "shared-video" });
  });

  check("a batch's own upload takes over from the legacy shared one", () => {
    const node = {
      pedagogy: { I_Do: { video: "legacy" }, We_Do: {}, You_Do: {} },
      batchPedagogy: { [BATCH_A]: { I_Do: { video: "A-new" }, We_Do: {}, You_Do: {} } },
    };
    assert.deepStrictEqual(
      B.scopeNodePedagogy(JSON.parse(JSON.stringify(node)), course, BATCH_A).pedagogy.I_Do,
      { video: "A-new" },
    );
    assert.deepStrictEqual(
      B.scopeNodePedagogy(JSON.parse(JSON.stringify(node)), course, BATCH_B).pedagogy.I_Do,
      { video: "legacy" },
    );
  });

  check("unknown batch falls back to shared, not an orphan container", () => {
    const node = { pedagogy: { I_Do: new Map(), We_Do: new Map(), You_Do: new Map() } };
    assert.strictEqual(B.resolvePedagogyTarget(node, course, "I_Do", "nope").basePath, "pedagogy");
    assert.strictEqual(node.batchPedagogy, undefined);
  });

  check("a batch with no container yet cannot be filed under", () => {
    // Course mapped with batch names but whose Batches page was never opened —
    // getCourseBatches creates the containers on first visit.
    const pending = {
      batchResources: { sameForAllBatches: false, batchwiseElements: ["I_Do"] },
      batches: ["b1", "b2"],
    };
    assert.strictEqual(B.courseUsesBatches(pending), true);
    assert.strictEqual(B.buildResourceBatchContext(pending, staff).canSelectBatch, false);
    const node = { pedagogy: { I_Do: new Map(), We_Do: new Map(), You_Do: new Map() } };
    assert.strictEqual(B.resolvePedagogyTarget(node, pending, "I_Do", "b1").basePath, "pedagogy");
  });

  check("non-section keys on pedagogy survive scoping", () => {
    const node = { pedagogy: { I_Do: {}, We_Do: {}, You_Do: {}, legacyNotes: "keep me" } };
    assert.strictEqual(B.scopeNodePedagogy(node, course, BATCH_A).pedagogy.legacyNotes, "keep me");
  });
}

console.log(`\n${passed} checks passed.`);
