// Student resource visibility — regression checks for the "teacher added
// resources but the student list is empty" bug (2026-09-01).
//
//   node scripts/verifyStudentResourceVisibility.js
//
// Companion to verifyBatchResources.js and written against the same pure
// utils. Covers the seven scenarios from the fix:
//   1. Teacher uploads for Batch I → a Batch I student's scoped view has them.
//   2. A student from another batch does NOT see Batch I's resources.
//   3. Shared resources stay visible to every eligible student.
//   4. "lecture" and the legacy "letcure" spelling resolve to one canonical
//      bucket (the client-side normalizeKey contract).
//   5. Cache identity: different viewers must map to different course-detail
//      cache keys, and the courseId-only form must remain a prefix of both
//      (the invalidation contract) — asserted as the key-shape contract the
//      client factory implements.
//   6. fileSettings.showToStudents === false stays enforceable: the flag
//      survives batch scoping so the student page's filter can hide the file.
//   7. The scoped view is empty ONLY when the student's batch truly has
//      nothing and the shared container is empty too.
const assert = require("assert");
const B = require("../utils/batchResources.js");

const STUDENT_ROLE = { originalRole: "Student", renameRole: "Learner" };

const BATCH_1 = "bbbbbbbbbbbbbbbbbbbbbbb1";
const BATCH_2 = "bbbbbbbbbbbbbbbbbbbbbbb2";

const student1 = { _id: "stu1", role: STUDENT_ROLE };
const student2 = { _id: "stu2", role: STUDENT_ROLE };

// Course where I_Do is batch-wise (the GRAD 2026 shape that surfaced the bug).
const batchWiseIDoCourse = () => ({
  batchResources: { sameForAllBatches: false, batchwiseElements: ["I_Do"] },
  batchAndParticipants: [
    { _id: BATCH_1, batchName: "Batch I", users: [{ user: "stu1" }] },
    { _id: BATCH_2, batchName: "Batch II", users: [{ user: "stu2" }] },
  ],
});

// Node shaped like the real topic: shared I_Do empty, all content in Batch I's
// bucket under the legacy-typo subcategory key, including a hidden file and a
// grouped page.
const topicNode = () => ({
  pedagogy: { I_Do: {}, We_Do: { assignment: { files: [], folders: [], pages: [] } }, You_Do: {} },
  batchPedagogy: {
    [BATCH_1]: {
      I_Do: {
        letcure: {
          description: "",
          files: [
            { _id: "f1", fileName: "a.pdf", fileSettings: { showToStudents: true } },
            { _id: "f2", fileName: "hidden.pdf", fileSettings: { showToStudents: false } },
            { _id: "f3", fileName: "grouped.ppt", groupId: "g1", groupName: "basic concept" },
          ],
          folders: [{ _id: "d1", name: "basic program", files: [], subfolders: [], pages: [] }],
          pages: [
            { _id: "p1", title: "root page", combinedCode: "<html/>" },
            { _id: "p2", title: "grouped page", combinedCode: "<html/>", groupId: "g1", groupName: "basic concept" },
          ],
        },
      },
      We_Do: {},
      You_Do: {},
    },
  },
});

// The client-side canonicalization contract (coursesdetailedview
// components/types/utils.ts normalizeKey). Mirrored here because the client
// helper is TypeScript; keep the two in lockstep.
const KEY_ALIASES = { letcure: "lecture" };
const normalizeKey = (s) => {
  const k = s.trim().toLowerCase().replace(/\s+/g, "_");
  return KEY_ALIASES[k] ?? k;
};

// The client cache-key contract (lib/queryKeys.ts courses.detail).
const courseDetailKey = (courseId, viewerId) =>
  viewerId === undefined
    ? ["courses", "detail", courseId]
    : ["courses", "detail", courseId, { viewerId }];

let passed = 0;
const check = (label, fn) => { fn(); passed++; console.log("  PASS  " + label); };

console.log("\nScenario 1 — Batch I student sees Batch I uploads");
{
  const course = batchWiseIDoCourse();
  const batchId = B.resolveViewerBatchId(course, student1, undefined);
  check("student resolves to their enrolled batch", () =>
    assert.strictEqual(batchId, BATCH_1));

  const out = B.scopeNodePedagogy(topicNode(), course, batchId);
  const lect = out.pedagogy.I_Do.letcure;
  check("root files, folders, pages and groups all present", () => {
    assert.strictEqual(lect.files.length, 3);
    assert.strictEqual(lect.folders.length, 1);
    assert.strictEqual(lect.pages.length, 2);
    const groupIds = new Set(
      [...lect.files, ...lect.pages].filter((x) => x.groupId).map((x) => x.groupId)
    );
    assert.deepStrictEqual([...groupIds], ["g1"]);
  });
  check("batchPedagogy is stripped from the response", () =>
    assert.strictEqual(out.batchPedagogy, undefined));
}

console.log("\nScenario 2 — other-batch student cannot see Batch I resources");
{
  const course = batchWiseIDoCourse();
  const batchId = B.resolveViewerBatchId(course, student2, undefined);
  check("second student resolves to their own batch", () =>
    assert.strictEqual(batchId, BATCH_2));

  const out = B.scopeNodePedagogy(topicNode(), course, batchId);
  check("Batch I content is absent (falls back to empty shared)", () =>
    assert.deepStrictEqual(out.pedagogy.I_Do, {}));
  check("a student asking for Batch I by param is still denied", () => {
    const forced = B.resolveViewerBatchId(course, student2, BATCH_1);
    assert.strictEqual(forced, BATCH_2, "client-sent batchId must be ignored for students");
  });
}

console.log("\nScenario 3 — shared resources visible to all eligible students");
{
  const course = batchWiseIDoCourse();
  const node = topicNode();
  node.pedagogy.We_Do = { assignment: { files: [{ _id: "s1", fileName: "shared.pdf" }], folders: [], pages: [] } };
  for (const [stu, batch] of [[student1, BATCH_1], [student2, BATCH_2]]) {
    const out = B.scopeNodePedagogy(
      JSON.parse(JSON.stringify(node)),
      course,
      B.resolveViewerBatchId(course, stu, undefined)
    );
    check(`We_Do (shared element) reaches student of ${batch === BATCH_1 ? "Batch I" : "Batch II"}`, () =>
      assert.strictEqual(out.pedagogy.We_Do.assignment.files.length, 1));
  }
}

console.log("\nScenario 4 — lecture / legacy letcure resolve to one bucket");
{
  check("letcure canonicalizes to lecture", () =>
    assert.strictEqual(normalizeKey("Letcure"), "lecture"));
  check("lecture stays lecture", () =>
    assert.strictEqual(normalizeKey(" Lecture "), "lecture"));
  check("stored letcure key matches a lecture-configured activity", () => {
    const storedKeys = ["letcure"];
    const selectedActivity = "Lecture";
    const hit = storedKeys.find((k) => normalizeKey(k) === normalizeKey(selectedActivity));
    assert.strictEqual(hit, "letcure", "original stored key must be returned for data access");
  });
  check("unrelated keys are untouched", () =>
    assert.strictEqual(normalizeKey("Problem Solving"), "problem_solving"));
}

console.log("\nScenario 5 — course-detail cache identity separates viewers");
{
  check("different viewers get different cache keys", () =>
    assert.notDeepStrictEqual(
      courseDetailKey("c1", "viewerA"),
      courseDetailKey("c1", "viewerB")
    ));
  check("courseId-only form is a prefix of every viewer's key (invalidation reaches all)", () => {
    const prefix = courseDetailKey("c1");
    for (const viewer of ["viewerA", "viewerB", null]) {
      const full = courseDetailKey("c1", viewer);
      assert.deepStrictEqual(full.slice(0, prefix.length), prefix);
    }
  });
  check("anonymous viewer still gets its own distinct key", () =>
    assert.notDeepStrictEqual(courseDetailKey("c1", null), courseDetailKey("c1")));
}

console.log("\nScenario 6 — showToStudents=false stays enforceable after scoping");
{
  const course = batchWiseIDoCourse();
  const out = B.scopeNodePedagogy(topicNode(), course, BATCH_1);
  const files = out.pedagogy.I_Do.letcure.files;
  check("the hidden flag survives scoping", () => {
    const hidden = files.find((f) => f._id === "f2");
    assert.strictEqual(hidden.fileSettings.showToStudents, false);
  });
  check("the student-page filter predicate hides exactly that file", () => {
    // Same predicate as coursesdetailedview [id]/page.tsx resource mapping.
    const visible = files.filter((f) => !f.fileSettings || f.fileSettings.showToStudents !== false);
    assert.deepStrictEqual(visible.map((f) => f._id), ["f1", "f3"]);
  });
}

console.log("\nScenario 7 — empty state only when truly empty for that viewer");
{
  const course = batchWiseIDoCourse();
  const emptyNode = { pedagogy: { I_Do: {}, We_Do: {}, You_Do: {} }, batchPedagogy: {} };
  const out1 = B.scopeNodePedagogy(JSON.parse(JSON.stringify(emptyNode)), course, BATCH_1);
  check("no content anywhere → empty view (empty state is correct)", () =>
    assert.deepStrictEqual(out1.pedagogy.I_Do, {}));
  const out2 = B.scopeNodePedagogy(topicNode(), course, BATCH_1);
  check("content in the viewer's batch → view is NOT empty", () =>
    assert.ok(Object.keys(out2.pedagogy.I_Do).length > 0));
}

console.log(`\nAll ${passed} checks passed.`);
