import assert from "node:assert/strict";
import test from "node:test";
import { activityMinutes, buildStudentActivityRecords } from "../js/student-activity-record.js";

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
