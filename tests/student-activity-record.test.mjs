import assert from "node:assert/strict";
import test from "node:test";
import { activityMinutes, buildStudentActivityRecords, testRawScore } from "../js/student-activity-record.js";

const doc = (id, data) => ({ id, data: () => data });

test("activity records use lesson results without inventing missing scores or times", () => {
  const curriculum = [{ docs: [doc("lesson_01", { title: "Photosynthesis" })] }];
  const sections = [{ classDoc: doc("A", { SectionName: "Malinao", GradeLevel: 8 }), students: [
    { studentDoc: doc("s1", { displayName: "Ana Cruz" }), results: [{ termId: "term_01", lessonsSnap: { docs: [doc("lesson_01", { activityScore: 8, activityTotalQuestions: 10, lessonTimeMinutes: 34, isLessonCompleted: true })] } }] },
    { studentDoc: doc("s2", { displayName: "Ben Lee" }), results: [{ termId: "term_01", lessonsSnap: { docs: [doc("lesson_01", { isLessonCompleted: true })] } }] },
    { studentDoc: doc("s3", { displayName: "No Result" }), results: [{ termId: "term_01", lessonsSnap: { docs: [] } }] }
  ] }];
  const [record] = buildStudentActivityRecords(curriculum, sections, { term_01: "Term 1" });
  assert.equal(record.section, "Grade 8 – Malinao");
  assert.equal(record.learnerCount, 3);
  assert.equal(record.learners.length, 2);
  assert.equal(record.completedCount, 2);
  assert.equal(record.averageScore, 80);
  assert.equal(record.averageMinutes, 34);
  assert.equal(record.learners[1].score, null);
  assert.equal(record.learners[1].minutes, null);
});

test("activity time falls back to device seconds", () => {
  assert.equal(activityMinutes({ learningTimeByDevice: { tablet: { lessonSeconds: 90 }, phone: { lessonSeconds: 30 } } }), 2);
  assert.equal(activityMinutes({}), null);
});

test("topic results keep raw tests, activity and time scoped to the selected lesson and term", () => {
  const selected = { isPreTestCompleted: true, preTestScore: 0, preTestTotalQuestions: 5,
    isPostTestCompleted: true, postTestScore: 7, postTestTotalQuestions: 10,
    activityScore: 3, activityTotalPoints: 4, lessonTimeMinutes: 12 };
  const curriculum = [{ docs: [doc("lesson_01", { title: "Food Webs" })] }];
  const sections = [{ classDoc: doc("A", { SectionName: "A" }), students: [
    { studentDoc: doc("s1", { displayName: "Student One" }), results: [
      { termId: "term_01", lessonsSnap: { docs: [doc("lesson_01", { ...selected, preTestScore: 5, postTestScore: 10 })] } },
      { termId: "term_02", lessonsSnap: { docs: [doc("lesson_01", selected), doc("lesson_02", { ...selected, preTestScore: 4, postTestScore: 9 })] } }
    ] },
    { studentDoc: doc("s2", { displayName: "Test Only" }), results: [{ termId: "term_02", lessonsSnap: { docs: [doc("lesson_01", { isPreTestCompleted: true, preTestScore: 2, preTestTotalQuestions: 5 })] } }] }
  ] }];
  const [record] = buildStudentActivityRecords(curriculum, sections, { term_02: "Term 2" }, ["term_02"]);
  assert.equal(record.learners.length, 2, "pre-test-only learners must not disappear from topic results");
  assert.deepEqual(record.learners[0].preTest, { score: 0, total: 5 });
  assert.deepEqual(record.learners[0].postTest, { score: 7, total: 10 });
  assert.equal(record.learners[0].rawScore, 3); assert.equal(record.learners[0].totalScore, 4);
  assert.equal(record.learners[0].minutes, 12);
  assert.deepEqual(record.learners[1].preTest, { score: 2, total: 5 });
  assert.equal(record.learners[1].postTest, null); assert.equal(record.learners[1].score, null); assert.equal(record.learners[1].minutes, null);
  assert.equal(record.completedCount, 0, "a recorded test does not invent AR lesson completion");
});

test("uncompleted/default test zeros stay missing and valid legacy post-test heatmaps retain raw scores", () => {
  assert.equal(testRawScore({ preTestScore: 0, preTestTotalQuestions: 5 }, "pre"), null);
  for (const data of [{ preTestScore: -1, preTestTotalQuestions: 5 }, { preTestScore: 6, preTestTotalQuestions: 5 }, { preTestScore: 3, preTestTotalQuestions: 0 }, { preTestTotalQuestions: 5 }]) {
    assert.equal(testRawScore({ isPreTestCompleted: true, ...data }, "pre"), null);
  }
  assert.deepEqual(testRawScore({ isPostTestCompleted: true, postTestTotalQuestions: 3, postTestHeatmap: [true, false, true] }, "post"), { score: 2, total: 3 });
  assert.deepEqual(testRawScore({ isPostTestCompleted: true, postTestTotalQuestions: 2, postTestHeatmap: [false, false] }, "post"), { score: 0, total: 2 });
  assert.equal(testRawScore({ isPostTestCompleted: true, postTestTotalQuestions: 5 }, "post"), null);
  assert.equal(testRawScore({ isPostTestCompleted: true, postTestTotalQuestions: 2, postTestHeatmap: [true] }, "post"), null);
});
