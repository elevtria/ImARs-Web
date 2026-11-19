import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildAnalyticsOverview } from "../js/analytics-overview.js";

const doc = (id, data) => ({ id, data: () => data });
const student = (id, data, profile = {}) => ({ studentDoc: doc(id, { displayName: id, ...profile }),
  results: [{ termId: "term_01", lessonsSnap: { docs: [doc("lesson_01", data)] } }] });
const report = students => ({ curriculumSnap: { docs: [doc("lesson_01", { title: "Food Webs" })] },
  sections: [{ classDoc: doc("A", {}), students }, { classDoc: doc("B", {}), students: [student("Other", {})] }] });
test("overview uses normalized paired scores, real zeroes and recorded learning minutes", () => {
  const result = buildAnalyticsOverview(report([
    student("Ana", { isPreTestCompleted: true, preTestScore: 0, preTestTotalQuestions: 5,
      isPostTestCompleted: true, postTestScore: 4, postTestTotalQuestions: 10,
      arTimeMinutes: 0, learningTimeByDevice: { phone: { lessonSeconds: 180 } } }),
    student("Ben", { isPostTestCompleted: true, postTestScore: 10, postTestTotalQuestions: 10 }),
    student("Missing", {}), student("Archived", {}, { active: false })
  ]), "A", "term_01");
  assert.equal(result.students, 3); assert.equal(result.pre, 0); assert.equal(result.post, 70);
  assert.equal(result.change, 40, "unpaired post-tests do not inflate the change");
  assert.equal(result.assessments, 3); assert.equal(result.possibleAssessments, 6);
  assert.equal(result.lessons[0].ar, 0); assert.equal(result.lessons[0].arCount, 1);
  assert.equal(result.lessons[0].module, 3);
  assert.deepEqual(result.support.map(row => row.id), ["Ana"]);
  assert.equal(buildAnalyticsOverview(report([]), "A", "term_01").pre, null);
  assert.equal(buildAnalyticsOverview(report([]), "A", "term_03").lessons[0].module, null);
});
test("spreadsheet moves to Student Records with unique IDs and Analytics keeps completion last", () => {
  const records = readFileSync(new URL("../student-records.html", import.meta.url), "utf8");
  const analytics = readFileSync(new URL("../analytics.html", import.meta.url), "utf8");
  const ids = [...records.matchAll(/id="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size);
  assert.match(records, /id="score-studentGrid"/); assert.match(records, /id="recordsContainer"/);
  assert.match(records, /id="score-editScores"/); assert.match(records, /id="score-downloadScoreReport"/);
  assert.doesNotMatch(analytics, /id="studentGrid"|Student Score Summary/);
  assert.ok(analytics.indexOf('id="topicsContainer"') > analytics.indexOf('id="questionHeatmapRows"'));
});
