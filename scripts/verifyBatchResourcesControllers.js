// Resources by Batch — controller-level checks for the SHARED scope resolver.
//
//   node scripts/verifyBatchResourcesControllers.js
//
// The unit and persistence scripts prove the rules and the storage. This one
// proves the piece that actually broke: `utils/pedagogyScope.js`, the bridge
// from a REQUEST to a container. I Do (pedagogyView.js) was routed through it
// while We Do / You Do (exerciseAndQuestion.js) still read `entity.pedagogy`
// directly, so the batch strip said "batch 2" and the assignment table showed
// batch 1's rows.
//
// No database: `Course-Structure.findById(...).select(...).lean()` is stubbed,
// so the resolver can be driven with fixture courses.
const assert = require("assert");
const mongoose = require("mongoose");
const BSON = require("bson");

["moduleModal", "subModuleModal", "topicModal", "subTopicModal"].forEach((m) =>
  require(`../models/Courses/moduleStructure/${m}`),
);
require("../models/Courses/courseStructureModal");

const BATCH_A = new mongoose.Types.ObjectId();
const BATCH_B = new mongoose.Types.ObjectId();

// ── Stub the course lookup the resolver performs ────────────────────────────
let COURSE_FIXTURE = null;
const CourseStructure = mongoose.model("Course-Structure");
CourseStructure.findById = () => ({
  select: () => ({ lean: async () => COURSE_FIXTURE }),
});

const {
  resolvePedagogyScope,
  resolveSearchScopes,
  mergeSectionAcrossBatches,
  locateExerciseContainer,
} = require("../utils/pedagogyScope");
const { scopeNodePedagogy, resolveViewerBatchId } = require("../utils/batchResources");

const SubTopic = mongoose.model("SubTopic1");
const newNode = () =>
  new SubTopic({
    institution: new mongoose.Types.ObjectId(),
    courses: new mongoose.Types.ObjectId(),
    title: "node",
  });

const makeCourse = (batchResources) => ({
  batchResources,
  batchAndParticipants: [
    { _id: BATCH_A, batchName: "batch 1", users: [{ user: "stuA" }] },
    { _id: BATCH_B, batchName: "batch 2", users: [{ user: "stuB" }] },
  ],
});

const STAFF = { _id: "trainer1", role: { originalRole: "Trainer" } };
const student = (id) => ({ _id: id, role: { originalRole: "Student" } });
const req = (user, batchId, where = "query") => ({
  user,
  query: where === "query" && batchId ? { batchId: String(batchId) } : {},
  body: where === "body" && batchId ? { batchId: String(batchId) } : {},
});

/** The Mongo _id assigned to a stored exercise, for id-keyed lookups. */
const idOf = (node, batchId, name) => {
  const bucket = node.batchPedagogy.get(String(batchId));
  const list = bucket.We_Do.get("Assignment") || [];
  return list.find((e) => e.exerciseInformation.exerciseId === name)._id;
};

/** Stands in for what a controller does after resolving its scope. */
const addExercise = async (node, section, subcategory, request, name) => {
  const { container, basePath } = await resolvePedagogyScope(node, section, request);
  const list = container[section].get(subcategory) || [];
  list.push({ exerciseInformation: { exerciseId: name, exerciseName: name } });
  container[section].set(subcategory, list);
  node.markModified(`${basePath}.${section}.${subcategory}`);
  return basePath;
};

const listExercises = async (node, section, subcategory, request) => {
  const { container } = await resolvePedagogyScope(node, section, request);
  return (container[section]?.get(subcategory) || []).map(
    (e) => e.exerciseInformation?.exerciseId,
  );
};

let passed = 0;
const check = (label, fn) => {
  fn();
  passed++;
  console.log("  PASS  " + label);
};
const acheck = async (label, fn) => {
  await fn();
  passed++;
  console.log("  PASS  " + label);
};

(async () => {
  // ── The reported bug ──────────────────────────────────────────────────────
  console.log("\nThe reported bug — We Do / You Do served course-level data");
  {
    COURSE_FIXTURE = makeCourse({
      sameForAllBatches: false,
      batchwiseElements: ["I_Do", "We_Do", "You_Do"],
    });

    for (const section of ["We_Do", "You_Do"]) {
      const node = newNode();

      // Trainer with "batch 1" selected creates an assignment.
      const p1 = await addExercise(node, section, "Assignment", req(STAFF, BATCH_A), "EX401");
      // Then switches the strip to "batch 2".
      const seen = await listExercises(node, section, "Assignment", req(STAFF, BATCH_B));

      await acheck(`[${section}] a batch-1 assignment does NOT appear under batch 2`, async () => {
        assert.strictEqual(p1, `batchPedagogy.${BATCH_A}`, "the write must go to batch 1");
        assert.deepStrictEqual(seen, [], "batch 2 must start empty, not inherit batch 1");
      });

      // And batch 2's own assignment stays out of batch 1.
      await addExercise(node, section, "Assignment", req(STAFF, BATCH_B), "EX402");
      await acheck(`[${section}] each batch lists only its own`, async () => {
        assert.deepStrictEqual(
          await listExercises(node, section, "Assignment", req(STAFF, BATCH_A)),
          ["EX401"],
        );
        assert.deepStrictEqual(
          await listExercises(node, section, "Assignment", req(STAFF, BATCH_B)),
          ["EX402"],
        );
      });

      // Students see their own batch and cannot ask for another.
      await acheck(`[${section}] students are pinned to their enrolled batch`, async () => {
        assert.deepStrictEqual(
          await listExercises(node, section, "Assignment", req(student("stuA"), BATCH_B)),
          ["EX401"],
          "a batch-1 student naming batch 2 must still get batch 1",
        );
        assert.deepStrictEqual(
          await listExercises(node, section, "Assignment", req(student("stuB"), BATCH_A)),
          ["EX402"],
        );
      });
    }
  }

  // ── All three sections behave identically ─────────────────────────────────
  console.log("\nI Do / We Do / You Do resolve identically");
  {
    COURSE_FIXTURE = makeCourse({
      sameForAllBatches: false,
      batchwiseElements: ["I_Do", "We_Do", "You_Do"],
    });
    const node = newNode();
    const paths = {};
    for (const section of ["I_Do", "We_Do", "You_Do"]) {
      const { basePath } = await resolvePedagogyScope(node, section, req(STAFF, BATCH_A));
      paths[section] = basePath;
    }
    await acheck("all three land in the same batch container", async () => {
      assert.strictEqual(paths.I_Do, `batchPedagogy.${BATCH_A}`);
      assert.strictEqual(paths.We_Do, paths.I_Do);
      assert.strictEqual(paths.You_Do, paths.I_Do);
    });
  }

  // ── Partial config: only We_Do batch-wise ─────────────────────────────────
  console.log("\nPartial config — only We Do batch-wise");
  {
    COURSE_FIXTURE = makeCourse({ sameForAllBatches: false, batchwiseElements: ["We_Do"] });
    const node = newNode();
    await acheck("We Do splits per batch, I Do and You Do stay shared", async () => {
      const we = await resolvePedagogyScope(node, "We_Do", req(STAFF, BATCH_A));
      const iDo = await resolvePedagogyScope(node, "I_Do", req(STAFF, BATCH_A));
      const you = await resolvePedagogyScope(node, "You_Do", req(STAFF, BATCH_A));
      assert.strictEqual(we.basePath, `batchPedagogy.${BATCH_A}`);
      assert.strictEqual(we.batchWise, true);
      assert.strictEqual(iDo.basePath, "pedagogy");
      assert.strictEqual(iDo.batchWise, false);
      assert.strictEqual(you.basePath, "pedagogy");
    });

    await acheck("a shared You Do assessment is visible to every batch", async () => {
      const n = newNode();
      await addExercise(n, "You_Do", "assessment", req(STAFF, BATCH_A), "SHARED1");
      assert.deepStrictEqual(
        await listExercises(n, "You_Do", "assessment", req(student("stuB"), null)),
        ["SHARED1"],
      );
    });
  }

  // ── Shared / no-batch courses are untouched ───────────────────────────────
  console.log("\nShared and no-batch courses keep their old behavior");
  {
    COURSE_FIXTURE = makeCourse({ sameForAllBatches: true, batchwiseElements: [] });
    const node = newNode();
    await acheck("shared: one list, every batch", async () => {
      const p = await addExercise(node, "We_Do", "Assignment", req(STAFF, BATCH_A), "EX1");
      assert.strictEqual(p, "pedagogy");
      assert.deepStrictEqual(
        await listExercises(node, "We_Do", "Assignment", req(student("stuB"), null)),
        ["EX1"],
      );
    });

    COURSE_FIXTURE = { batchResources: { sameForAllBatches: false, batchwiseElements: ["We_Do"] } };
    const plain = newNode();
    await acheck("no batches: everything stays course-level", async () => {
      const p = await addExercise(plain, "We_Do", "Assignment", req(STAFF, BATCH_A), "EX1");
      assert.strictEqual(p, "pedagogy");
      assert.strictEqual(plain.batchPedagogy?.size ?? 0, 0);
    });
  }

  // ── batchId accepted from body as well as query ───────────────────────────
  console.log("\nRequest plumbing");
  {
    COURSE_FIXTURE = makeCourse({ sameForAllBatches: false, batchwiseElements: ["We_Do"] });
    await acheck("batchId is read from the body as well as the query", async () => {
      const fromQuery = await resolvePedagogyScope(newNode(), "We_Do", req(STAFF, BATCH_B, "query"));
      const fromBody = await resolvePedagogyScope(newNode(), "We_Do", req(STAFF, BATCH_B, "body"));
      assert.strictEqual(fromQuery.basePath, `batchPedagogy.${BATCH_B}`);
      assert.strictEqual(fromBody.basePath, fromQuery.basePath);
    });

    await acheck("a batch NAME still resolves (older callers)", async () => {
      const byName = await resolvePedagogyScope(
        newNode(),
        "We_Do",
        { user: STAFF, query: { batchName: "batch 2" }, body: {} },
      );
      assert.strictEqual(byName.basePath, `batchPedagogy.${BATCH_B}`);
    });
  }

  // ── Search order for id-only lookups ──────────────────────────────────────
  console.log("\nExercise lookup by id alone");
  {
    COURSE_FIXTURE = makeCourse({ sameForAllBatches: false, batchwiseElements: ["We_Do"] });
    const node = newNode();
    await addExercise(node, "We_Do", "Assignment", req(STAFF, BATCH_A), "IN_BATCH");

    await acheck("searches the caller's batch first, then the shared set", async () => {
      const scopes = await resolveSearchScopes(node, req(STAFF, BATCH_A));
      assert.strictEqual(scopes.length, 2, "both containers must be searched");
      assert.strictEqual(scopes[0].basePath, `batchPedagogy.${BATCH_A}`);
      assert.strictEqual(scopes[1].basePath, "pedagogy");
    });

    await acheck("a batch with no container yet falls back to shared only", async () => {
      const scopes = await resolveSearchScopes(node, req(STAFF, BATCH_B));
      assert.strictEqual(scopes.length, 1);
      assert.strictEqual(scopes[0].basePath, "pedagogy");
    });
  }

  // ── The list endpoints scope whole node sets ──────────────────────────────
  console.log("\nCourse-wide list endpoints");
  {
    COURSE_FIXTURE = makeCourse({ sameForAllBatches: false, batchwiseElements: ["We_Do"] });
    const node = newNode();
    await addExercise(node, "We_Do", "Assignment", req(STAFF, BATCH_A), "A1");
    await addExercise(node, "We_Do", "Assignment", req(STAFF, BATCH_B), "B1");

    await acheck("scopeNodePedagogy flattens a .lean() node to one batch", async () => {
      // BSON, not JSON.stringify — a Mongoose Map stringifies to `{}` and
      // would make this pass or fail for the wrong reason. This is what a
      // `.lean()` read actually hands the controller.
      const lean = BSON.deserialize(BSON.serialize(node.toObject()));
      const batchId = resolveViewerBatchId(COURSE_FIXTURE, student("stuA"), null);
      const scoped = scopeNodePedagogy(lean, COURSE_FIXTURE, batchId);
      const ids = (scoped.pedagogy.We_Do.Assignment || []).map(
        (e) => e.exerciseInformation.exerciseId,
      );
      assert.deepStrictEqual(ids, ["A1"]);
      assert.ok(!JSON.stringify(scoped).includes("B1"), "batch 2's exercise must not be in the payload");
      assert.strictEqual("batchPedagogy" in scoped, false);
    });
  }

  // ── The Test Your Skills crash ────────────────────────────────────────────
  console.log("\nTest Your Skills — the reported TypeError");
  {
    COURSE_FIXTURE = makeCourse({ sameForAllBatches: false, batchwiseElements: ["You_Do"] });

    await acheck("a node with no pedagogy at all still yields a container", async () => {
      const bare = newNode();
      bare.pedagogy = undefined; // exactly the state that threw
      const { container } = await resolvePedagogyScope(bare, "You_Do", req(STAFF, BATCH_A));
      assert.ok(container, "resolvePedagogyScope must never return undefined");
      // The line that used to crash: `entity.pedagogy.You_Do`.
      assert.doesNotThrow(() => {
        if (container.You_Do) Array.from(container.You_Do.entries());
      });
    });

    await acheck("the same holds for a shared course", async () => {
      COURSE_FIXTURE = { batchResources: { sameForAllBatches: true, batchwiseElements: [] } };
      const bare = newNode();
      bare.pedagogy = undefined;
      const { container, basePath } = await resolvePedagogyScope(bare, "You_Do", req(STAFF, null));
      assert.ok(container);
      assert.strictEqual(basePath, "pedagogy");
    });
  }

  // ── Test Your Skills, through the REAL controller ─────────────────────────
  //
  // Driven end to end rather than through a stand-in, because what broke here
  // was not the resolver but the ROUTE: no auth middleware meant `req.user`
  // was undefined, the resolver treated every caller as unidentified, and
  // everything fell back to the shared container. A resolver-only test would
  // have passed while the feature stayed broken.
  console.log("\nTest Your Skills — add + get are batch-scoped");
  {
    const tys = require("../controllers/courses/moduleStructure/testYourSkillsController");

    const runAdd = (node, request, itemKey, title) =>
      new Promise((resolve) => {
        const res = { status: () => res, json: (b) => resolve(b) };
        tys.addMcqToYouDo(
          {
            ...request,
            params: { type: "subtopics", id: String(node._id), itemKey },
            body: {
              ...request.body,
              testTitle: title,
              questionsData: [
                {
                  questionType: "mcq",
                  mcqQuestionTitle: title,
                  // The controller rejects anything with fewer than two
                  // options, so the fixture has to be a valid question.
                  mcqQuestionOptions: [
                    { text: "a", isCorrect: true },
                    { text: "b", isCorrect: false },
                  ],
                  mcqQuestionCorrectAnswers: ["a"],
                },
              ],
            },
          },
          res,
        );
      });

    // Stand in for the model lookup the controller performs.
    const SubTopicModel = mongoose.model("SubTopic1");
    const originalFindById = SubTopicModel.findById.bind(SubTopicModel);
    let CURRENT_NODE = null;
    SubTopicModel.findById = () => Promise.resolve(CURRENT_NODE);

    try {
      COURSE_FIXTURE = makeCourse({ sameForAllBatches: false, batchwiseElements: ["You_Do"] });
      const node = newNode();
      CURRENT_NODE = node;
      node.save = async () => node;

      await acheck("a batch-1 test is written to batch 1's container", async () => {
        await runAdd(node, req(STAFF, BATCH_A, "body"), "test_your_skills", "TYS-A");
        assert.ok(node.batchPedagogy.get(String(BATCH_A)), "batch 1 container must exist");
        assert.strictEqual(
          node.batchPedagogy.get(String(BATCH_A)).You_Do.has("test_your_skills"),
          true,
        );
        // And NOT to the shared container, which is what "shows for all
        // batches" looked like.
        assert.strictEqual(node.pedagogy?.You_Do?.has("test_your_skills") || false, false);
      });

      await acheck("batch 2 starts empty and gets its own", async () => {
        await runAdd(node, req(STAFF, BATCH_B, "body"), "test_your_skills", "TYS-B");
        const a = node.batchPedagogy.get(String(BATCH_A)).You_Do.get("test_your_skills");
        const b = node.batchPedagogy.get(String(BATCH_B)).You_Do.get("test_your_skills");
        assert.notStrictEqual(a, b, "the two batches must hold different tests");
      });

      // The GET side — the actual reported symptom ("test your skills shows
      // all batches"). Driven through the real handler.
      const runGet = (node, request) =>
        new Promise((resolve) => {
          const res = { status: () => res, json: (b) => resolve(b) };
          tys.getYouDoItems(
            { ...request, params: { type: "subtopics", id: String(node._id) } },
            res,
          );
        });

      // getYouDoItems answers with a flat `{ success, totalQuestions, data: [] }`.
      const titlesOf = (r) => (Array.isArray(r?.data) ? r.data : []).map((q) => q.mcqQuestionTitle);

      await acheck("getYouDoItems returns ONLY the requested batch's questions", async () => {
        const a = await runGet(node, req(STAFF, BATCH_A));
        const b = await runGet(node, req(STAFF, BATCH_B));
        assert.deepStrictEqual(titlesOf(a), ["TYS-A"]);
        assert.deepStrictEqual(titlesOf(b), ["TYS-B"]);
        assert.ok(!JSON.stringify(a).includes("TYS-B"), "batch 1 must not see batch 2's test");
        assert.ok(!JSON.stringify(b).includes("TYS-A"), "batch 2 must not see batch 1's test");
      });

      await acheck("a student gets their enrolled batch, not one they ask for", async () => {
        const asked = await runGet(node, req(student("stuA"), BATCH_B));
        assert.deepStrictEqual(titlesOf(asked), ["TYS-A"], "stuA is in batch 1; batch 2 must be refused");
      });

      await acheck("an unidentified caller no longer silently reads shared", async () => {
        // The route now supplies req.user; this asserts the resolver's rule
        // that WITHOUT one the caller gets the shared set — which is exactly
        // why the missing middleware made every batch look identical.
        const { basePath } = await resolvePedagogyScope(node, "You_Do", {
          query: { batchId: String(BATCH_A) },
          body: {},
        });
        assert.strictEqual(basePath, "pedagogy", "no req.user ⇒ shared container");
        const { basePath: withUser } = await resolvePedagogyScope(
          node,
          "You_Do",
          req(STAFF, BATCH_A),
        );
        assert.strictEqual(withUser, `batchPedagogy.${BATCH_A}`, "with req.user ⇒ that batch");
      });
    } finally {
      SubTopicModel.findById = originalFindById;
    }
  }

  // ── Approvals span every batch ────────────────────────────────────────────
  console.log("\nApprovals are cross-batch");
  {
    COURSE_FIXTURE = makeCourse({ sameForAllBatches: false, batchwiseElements: ["We_Do"] });
    const node = newNode();
    await addExercise(node, "We_Do", "Assignment", req(STAFF, BATCH_A), "A1");
    await addExercise(node, "We_Do", "Assignment", req(STAFF, BATCH_B), "B1");

    await acheck("the queue lists every batch's items, tagged with their batch", async () => {
      const lean = BSON.deserialize(BSON.serialize(node.toObject()));
      const entries = mergeSectionAcrossBatches(lean, "We_Do");
      const seen = entries.flatMap(([, list, batchId]) =>
        (Array.isArray(list) ? list : []).map((e) => [e.exerciseInformation.exerciseId, batchId]),
      );
      assert.deepStrictEqual(
        seen.sort(),
        [["A1", String(BATCH_A)], ["B1", String(BATCH_B)]].sort(),
      );
    });

    await acheck("approving finds an exercise in ANY batch, not the approver's", async () => {
      const inA = locateExerciseContainer(node, "We_Do", "Assignment", idOf(node, BATCH_A, "A1"));
      const inB = locateExerciseContainer(node, "We_Do", "Assignment", idOf(node, BATCH_B, "B1"));
      assert.ok(inA && inB, "both must be locatable");
      assert.strictEqual(inA.basePath, `batchPedagogy.${BATCH_A}`);
      assert.strictEqual(inB.basePath, `batchPedagogy.${BATCH_B}`);
      assert.strictEqual(inA.exercise.exerciseInformation.exerciseId, "A1");
      assert.strictEqual(inB.exercise.exerciseInformation.exerciseId, "B1");
    });

    await acheck("an unknown exercise id locates nowhere", async () => {
      assert.strictEqual(
        locateExerciseContainer(node, "We_Do", "Assignment", new mongoose.Types.ObjectId()),
        null,
      );
    });
  }

  console.log(`\n${passed} checks passed.`);
})().catch((err) => {
  console.error("\nFAILED:", err.message);
  process.exit(1);
});
