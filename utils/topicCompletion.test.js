// topicCompletion.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Framework-free tests for the topic-completion aggregator. Run with:
//
//   node server/utils/topicCompletion.test.js
//
// Follows the existing repo pattern (client/…/quotaModel.test.ts): no Jest /
// Vitest, just `node:assert/strict` + a tiny runner. Each `test(…)` prints
// PASS/FAIL and the process exits 1 if anything fails. Coverage is the seven
// scenarios (A–G) called out in the plan file + a couple of edge cases.

'use strict';

const assert = require('node:assert/strict');
const {
  computeCourseTopicProgress,
  computeIDoStage,
  computeWeDoStage,
  computeYouDoStage,
  findStudentAnswers,
} = require('./topicCompletion');

// ─── Tiny runner ────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \x1b[32m✔\x1b[0m ${name}`);
  } catch (e) {
    failed++;
    const line = (e.message || String(e)).split('\n')[0];
    failures.push(`${name}\n    ${line}`);
    console.log(`  \x1b[31m✘\x1b[0m ${name}\n      ${line}`);
  }
}
function group(label, fn) {
  console.log(`\n\x1b[1m${label}\x1b[0m`);
  fn();
}

// ─── Fixture builders ───────────────────────────────────────────────────────
const oid = (n) => `oid-${n}`; // stand-in ObjectId — the aggregator uses String() comparison.

// A PDF resource under an I Do bucket ("Presentation").
function pdfResource(bucketKey, files) {
  return {
    _id: oid(`pdf-bucket-${bucketKey}`),
    files,
  };
}

// A file with N MCQs on pages 1..N — matches fileSchema shape.
function fileWithMcqs(fileId, mcqIds) {
  return {
    _id: fileId,
    fileName: `${fileId}.pdf`,
    fileType: 'pdf',
    mcqQuestions: mcqIds.map((id, i) => ({
      _id: id,
      isActive: true,
      sequence: i + 1,
      timestamp: 0,
      videoTimestamp: 0,
    })),
  };
}

function videoWithActivities(fileId, activityIds) {
  return {
    _id: fileId,
    fileName: `${fileId}.mp4`,
    fileType: 'video',
    isVideo: true,
    mcqQuestions: activityIds.map((id, i) => ({
      _id: id,
      isActive: true,
      sequence: i + 1,
      // videoTimestamp is the "activity fires at 42 s" gate.
      timestamp: i * 30,
      videoTimestamp: i * 30,
    })),
  };
}

// Exercise-shaped node under a We Do or You Do bucket.
function exercise(id, extra = {}) {
  return {
    _id: id,
    exerciseInformation: { exerciseId: id, exerciseName: `Ex ${id}` },
    availabilityPeriod: {
      startDate: '2026-01-01T00:00:00.000Z',
      endDate: '2027-01-01T00:00:00.000Z',
    },
    approvalWorkflow: null,
    ...extra,
  };
}

// One MCQ-submitted answer entry (as it lands under
// user.courses[i].answers.<stage>[<bucket>][].questions[]).
function mcqSubmitted(questionId, status = 'submitted') {
  return { questionId, status };
}

// One exercise-completed progress entry.
function exerciseCompletedEntry(exerciseId, opts = {}) {
  return {
    exerciseId,
    status: 'completed',
    testSubmissions: opts.testSubmissions || 1,
    questions: opts.questions || [],
  };
}

function courseWithOneTopic(pedagogy) {
  return {
    _id: oid('course-1'),
    modules: [
      {
        _id: oid('mod-1'),
        title: 'Module',
        topics: [
          {
            _id: oid('topic-1'),
            title: 'C Programming Basics',
            pedagogy,
          },
        ],
      },
    ],
  };
}

// ─── Scenario suites ────────────────────────────────────────────────────────

group('Example A — PDF without MCQ auto-satisfies', () => {
  test('PDF exists, no MCQs configured → I Do stage complete + total 0', () => {
    const pedagogy = {
      I_Do: {
        Presentation: pdfResource('Presentation', [
          fileWithMcqs(oid('pdf-1'), []),
        ]),
      },
    };
    const answers = {};
    const stage = computeIDoStage(pedagogy, answers);
    assert.deepEqual(stage, { total: 0, completed: 0, complete: true });
  });

  test('Topic with only unconfigured resources → not_started (not completed)', () => {
    const course = courseWithOneTopic({
      I_Do: { Presentation: pdfResource('Presentation', [fileWithMcqs(oid('pdf-1'), [])]) },
    });
    const map = computeCourseTopicProgress(course, {});
    const topic = map[oid('topic-1')];
    // A totally-empty topic is not_started, not completed — the spec is
    // explicit that "nothing configured on any stage" doesn't earn a tick.
    assert.equal(topic.status, 'not_started');
    assert.equal(topic.iDoComplete, true);
    assert.equal(topic.weDoComplete, true);
    assert.equal(topic.youDoComplete, true);
  });
});

group('Example B — PDF with three MCQs, only two submitted', () => {
  test('two of three submitted → I Do incomplete', () => {
    const mcqs = [oid('mcq-1'), oid('mcq-2'), oid('mcq-3')];
    const pedagogy = {
      I_Do: {
        Presentation: pdfResource('Presentation', [fileWithMcqs(oid('pdf-1'), mcqs)]),
      },
    };
    const answers = {
      I_Do: {
        Presentation: [
          {
            questions: [
              mcqSubmitted(mcqs[0]),
              mcqSubmitted(mcqs[1]),
              // mcq-3 NOT submitted
            ],
          },
        ],
      },
    };
    const stage = computeIDoStage(pedagogy, answers);
    assert.deepEqual(stage, { total: 3, completed: 2, complete: false });
  });

  test('topic rollup → in_progress, no green tick', () => {
    const mcqs = [oid('mcq-1'), oid('mcq-2'), oid('mcq-3')];
    const course = courseWithOneTopic({
      I_Do: { Presentation: pdfResource('Presentation', [fileWithMcqs(oid('pdf-1'), mcqs)]) },
    });
    const answers = {
      I_Do: { Presentation: [{ questions: [mcqSubmitted(mcqs[0]), mcqSubmitted(mcqs[1])] }] },
    };
    const map = computeCourseTopicProgress(course, answers);
    assert.equal(map[oid('topic-1')].status, 'in_progress');
  });
});

group('Example C — all PDF MCQs completed', () => {
  test('every MCQ submitted → I Do stage complete', () => {
    const mcqs = [oid('mcq-1'), oid('mcq-2'), oid('mcq-3')];
    const pedagogy = {
      I_Do: {
        Presentation: pdfResource('Presentation', [fileWithMcqs(oid('pdf-1'), mcqs)]),
      },
    };
    const answers = {
      I_Do: {
        Presentation: [{ questions: mcqs.map((m) => mcqSubmitted(m)) }],
      },
    };
    const stage = computeIDoStage(pedagogy, answers);
    assert.equal(stage.complete, true);
    assert.equal(stage.completed, 3);
  });

  test('MCQs across DIFFERENT pages/timestamps all counted', () => {
    // Two files under the same bucket, each with its own MCQs — all must
    // be submitted for the stage to complete. This is the "MCQs may exist
    // on any page — do not check only the current page" rule.
    const page1Mcqs = [oid('p1-mcq-1'), oid('p1-mcq-2')];
    const page2Mcqs = [oid('p2-mcq-1')];
    const pedagogy = {
      I_Do: {
        Presentation: pdfResource('Presentation', [
          fileWithMcqs(oid('pdf-page-1'), page1Mcqs),
          fileWithMcqs(oid('pdf-page-2'), page2Mcqs),
        ]),
      },
    };
    // Only page 1 answered — page 2 still pending.
    const partial = {
      I_Do: { Presentation: [{ questions: page1Mcqs.map((m) => mcqSubmitted(m)) }] },
    };
    assert.equal(computeIDoStage(pedagogy, partial).complete, false);
    // Answer page 2 too → complete.
    const full = {
      I_Do: {
        Presentation: [
          {
            questions: [...page1Mcqs, ...page2Mcqs].map((m) => mcqSubmitted(m)),
          },
        ],
      },
    };
    assert.equal(computeIDoStage(pedagogy, full).complete, true);
  });

  test('attempted-but-not-submitted MCQ does NOT count', () => {
    const mcqs = [oid('mcq-1'), oid('mcq-2')];
    const pedagogy = {
      I_Do: { Presentation: pdfResource('Presentation', [fileWithMcqs(oid('pdf'), mcqs)]) },
    };
    const answers = {
      I_Do: {
        Presentation: [
          {
            questions: [
              mcqSubmitted(mcqs[0], 'submitted'),
              mcqSubmitted(mcqs[1], 'attempted'), // not a terminal status
            ],
          },
        ],
      },
    };
    assert.equal(computeIDoStage(pedagogy, answers).completed, 1);
    assert.equal(computeIDoStage(pedagogy, answers).complete, false);
  });

  test('isActive:false MCQs are excluded from the required set', () => {
    const active = oid('mcq-active');
    const inactive = oid('mcq-inactive');
    const pedagogy = {
      I_Do: {
        Presentation: pdfResource('Presentation', [
          {
            _id: oid('pdf'),
            mcqQuestions: [
              { _id: active, isActive: true, sequence: 1, timestamp: 0, videoTimestamp: 0 },
              { _id: inactive, isActive: false, sequence: 2, timestamp: 0, videoTimestamp: 0 },
            ],
          },
        ]),
      },
    };
    const answers = { I_Do: { Presentation: [{ questions: [mcqSubmitted(active)] }] } };
    // Total is 1 (inactive excluded), so completing the one active one is a full stage complete.
    assert.equal(computeIDoStage(pedagogy, answers).complete, true);
    assert.equal(computeIDoStage(pedagogy, answers).total, 1);
  });
});

group('Example D — video with two activities, only one submitted', () => {
  test('video partial completion → I Do incomplete', () => {
    const acts = [oid('act-1'), oid('act-2')];
    const pedagogy = {
      I_Do: {
        Presentation: {
          _id: oid('videoBucket'),
          files: [videoWithActivities(oid('vid'), acts)],
        },
      },
    };
    const answers = { I_Do: { Presentation: [{ questions: [mcqSubmitted(acts[0])] }] } };
    assert.equal(computeIDoStage(pedagogy, answers).complete, false);
  });
});

group('Example E — missed We Do assignment', () => {
  test('I Do complete + missed We Do → topic still incomplete', () => {
    const wdEx = exercise(oid('assn-1'), {
      availabilityPeriod: {
        startDate: '2025-01-01T00:00:00.000Z',
        endDate: '2025-01-02T00:00:00.000Z', // already expired, no answer entry
      },
    });
    const course = courseWithOneTopic({
      I_Do: { Presentation: pdfResource('Presentation', [fileWithMcqs(oid('pdf'), [])]) },
      We_Do: { Assignments: [wdEx] },
    });
    // No answer for the assignment — "missed" is naturally not-in-answers.
    const map = computeCourseTopicProgress(course, { I_Do: {}, We_Do: {}, You_Do: {} });
    const topic = map[oid('topic-1')];
    // 0 of 1 required item done → not_started (hollow gray circle in the
    // sidebar, per the spec's four UI states). What matters most is that
    // status !== 'completed' and weDoComplete === false.
    assert.notEqual(topic.status, 'completed');
    assert.equal(topic.status, 'not_started');
    assert.equal(topic.weDoComplete, false);
    assert.equal(topic.iDoComplete, true);
  });
});

group('Example F — all three stages complete', () => {
  test('every configured item satisfied → topic completed', () => {
    const iDoMcqs = [oid('i-mcq-1')];
    const wdEx = exercise(oid('assn-1'));
    const ydEx = exercise(oid('ass-1'));
    const course = courseWithOneTopic({
      I_Do: { Presentation: pdfResource('Presentation', [fileWithMcqs(oid('pdf'), iDoMcqs)]) },
      We_Do: { Assignments: [wdEx] },
      You_Do: { Assessment: [ydEx] },
    });
    const answers = {
      I_Do: { Presentation: [{ questions: [mcqSubmitted(iDoMcqs[0])] }] },
      We_Do: { Assignments: [exerciseCompletedEntry(oid('assn-1'))] },
      You_Do: { Assessment: [exerciseCompletedEntry(oid('ass-1'))] },
    };
    const map = computeCourseTopicProgress(course, answers);
    const topic = map[oid('topic-1')];
    assert.equal(topic.status, 'completed');
    assert.equal(topic.iDoComplete, true);
    assert.equal(topic.weDoComplete, true);
    assert.equal(topic.youDoComplete, true);
    assert.equal(topic.completedRequiredItems, 3);
    assert.equal(topic.totalRequiredItems, 3);
  });
});

group('Example G — admin adds a new required MCQ after previous completion', () => {
  test('newly-configured MCQ makes a previously-complete topic incomplete again', () => {
    const originalMcq = oid('i-mcq-1');
    // Snapshot 1: only mcq-1 required, student submitted it → complete.
    const before = courseWithOneTopic({
      I_Do: { Presentation: pdfResource('Presentation', [fileWithMcqs(oid('pdf'), [originalMcq])]) },
    });
    const answers = { I_Do: { Presentation: [{ questions: [mcqSubmitted(originalMcq)] }] } };
    assert.equal(computeCourseTopicProgress(before, answers)[oid('topic-1')].status, 'completed');

    // Snapshot 2: admin adds a second MCQ. Same student answers → now
    // in_progress, no green tick until they answer the new one too.
    const newMcq = oid('i-mcq-2');
    const after = courseWithOneTopic({
      I_Do: { Presentation: pdfResource('Presentation', [fileWithMcqs(oid('pdf'), [originalMcq, newMcq])]) },
    });
    assert.equal(computeCourseTopicProgress(after, answers)[oid('topic-1')].status, 'in_progress');
  });
});

group('Empty stages never block completion', () => {
  test('only I Do configured + fully done → topic completes even with no We Do / You Do', () => {
    const mcq = oid('m1');
    const course = courseWithOneTopic({
      I_Do: { Presentation: pdfResource('Presentation', [fileWithMcqs(oid('pdf'), [mcq])]) },
      // We_Do + You_Do omitted → empty.
    });
    const answers = { I_Do: { Presentation: [{ questions: [mcqSubmitted(mcq)] }] } };
    const map = computeCourseTopicProgress(course, answers);
    assert.equal(map[oid('topic-1')].status, 'completed');
  });
});

group('Approval gate — unapproved exercises don\'t count', () => {
  test('exercise with un-flipped approvalWorkflow is skipped as not required', () => {
    const invisible = exercise(oid('assn-invisible'), {
      approvalWorkflow: {
        studentVisible: false,
        currentStep: 1,
        steps: [{ roleId: 'r1' }],
      },
    });
    const visible = exercise(oid('assn-visible'));
    const pedagogy = { We_Do: { Assignments: [invisible, visible] } };
    const answers = { We_Do: { Assignments: [exerciseCompletedEntry(oid('assn-visible'))] } };
    const stage = computeWeDoStage(pedagogy, answers);
    assert.equal(stage.total, 1);
    assert.equal(stage.complete, true);
  });
});

group('You Do — test_your_skills MCQ shape', () => {
  test('bucket with questions[] treated as MCQ pool', () => {
    const q1 = oid('tys-1');
    const q2 = oid('tys-2');
    const pedagogy = {
      You_Do: {
        test_your_skills: {
          questions: [
            { _id: q1, isActive: true },
            { _id: q2, isActive: true },
          ],
        },
      },
    };
    const answers = { You_Do: { test_your_skills: [{ questions: [mcqSubmitted(q1)] }] } };
    const stage = computeYouDoStage(pedagogy, answers);
    assert.equal(stage.total, 2);
    assert.equal(stage.completed, 1);
    assert.equal(stage.complete, false);
  });
});

group('Rollup — module aggregates its topics', () => {
  test('module status is the min of its topics', () => {
    // One topic complete, one topic in-progress → module is in_progress
    // and its rollup counts the sum of required items across both.
    const mcqA = oid('mA');
    const mcqB = oid('mB');
    const course = {
      _id: oid('course'),
      modules: [
        {
          _id: oid('module'),
          topics: [
            { _id: oid('t-done'), pedagogy: { I_Do: { Presentation: pdfResource('Presentation', [fileWithMcqs(oid('pdfA'), [mcqA])]) } } },
            { _id: oid('t-partial'), pedagogy: { I_Do: { Presentation: pdfResource('Presentation', [fileWithMcqs(oid('pdfB'), [mcqB])]) } } },
          ],
        },
      ],
    };
    const answers = {
      I_Do: {
        Presentation: [{ questions: [mcqSubmitted(mcqA)] }], // only mcqA
      },
    };
    const map = computeCourseTopicProgress(course, answers);
    assert.equal(map[oid('t-done')].status, 'completed');
    // 0 of 1 done → not_started at leaf-topic level.
    assert.equal(map[oid('t-partial')].status, 'not_started');
    // But the module rolls up 1 completed of 2 required across BOTH topics,
    // so the module row lights in_progress even though one of its topics
    // hasn't been touched. That is the sidebar behaviour the spec wants.
    assert.equal(map[oid('module')].status, 'in_progress');
    assert.equal(map[oid('module')].totalRequiredItems, 2);
    assert.equal(map[oid('module')].completedRequiredItems, 1);
  });
});

group('findStudentAnswers helper', () => {
  test('locates the caller\'s answers by userId + courseId', () => {
    const answers = { We_Do: { Assignments: [] } };
    const course = {
      _id: oid('course-42'),
      batchAndParticipants: [
        {
          users: [
            {
              user: {
                _id: oid('someone-else'),
                courses: [{ courseId: oid('course-42'), answers: { I_Do: {} } }],
              },
            },
            {
              user: {
                _id: oid('me'),
                courses: [{ courseId: oid('course-42'), answers }],
              },
            },
          ],
        },
      ],
    };
    assert.equal(findStudentAnswers(course, oid('me')), answers);
    assert.equal(findStudentAnswers(course, oid('nobody')), null);
    assert.equal(findStudentAnswers(null, oid('me')), null);
  });
});

// ─── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\n\x1b[31mFAILURES:\x1b[0m');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
