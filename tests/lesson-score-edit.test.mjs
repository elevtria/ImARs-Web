import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./fixtures/web-data.js";
import { activityPercent } from "../js/activity-score.js";
import { testRawScore } from "../js/student-activity-record.js";

const path = "users/0026271000/test_results/term_01/lessons/lesson_01";
const edit = (kind, score, maximum, target = path) => ({ action: "commit", writes: [{ operation: "set", path: target, merge: true,
  data: { lessonId: "lesson_01", timestamp: { $type: "serverTimestamp" }, teacherScoreOverrides: { [kind]: { score, maximum } } } }] });

test("teachers save individual scores without replacing other scores, answers, or lesson progress", async () => {
  const app = fixture(), cookie = await app.login();
  app.data.set(path, { postTestHeatmap: [true, false], lessonTimeMinutes: 12, isLessonCompleted: false });
  for (const [kind, score, maximum] of [["pre", 0, 5], ["post", 7, 10], ["activity", 3.5, 4]]) {
    const response = await app.call(edit(kind, score, maximum), cookie);
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
  }
  const saved = app.data.get(path);
  assert.deepEqual(saved.teacherScoreOverrides, { pre: { score: 0, maximum: 5 }, post: { score: 7, maximum: 10 }, activity: { score: 3.5, maximum: 4 } });
  assert.equal(saved.teacherScoreEditedBy, "TEACH1000");
  assert.equal(saved.isLessonCompleted, false);
  assert.equal(saved.lessonTimeMinutes, 12);
  assert.deepEqual(saved.postTestHeatmap, [true, false]);
  assert.equal(saved.preTestScore, 0);
  assert.equal(saved.postTestScore, 7);
  assert.equal(saved.activityRawScore, 3.5);
  assert.equal(activityPercent(saved), 87.5);
  // A subsequent app sync may update automatic fields; teacher corrections remain authoritative.
  Object.assign(saved, { activityScore: 1, activityTotalQuestions: 10, preTestScore: 5, postTestScore: 10 });
  assert.equal(activityPercent(saved), 87.5);
  assert.deepEqual(testRawScore(saved, "pre"), { score: 0, total: 5 });
  assert.deepEqual(testRawScore(saved, "post"), { score: 7, total: 10 });
  app.store.activityResultsForRoster = async () => [{ studentId: "0026271000", data: {
    activityId: "states-of-matter", classCode: "A", uid: "student-a", status: "completed",
    score: 1, maximum: 10, rawScore: 1, rawMaximum: 10, completedAtUtc: "2026-11-14T12:00:00Z"
  } }];
  const report = await (await app.call({ action: "teacher-report-page", sectionId: "A", termId: "term_01", rawActivityScores: true, includeCounts: false }, cookie)).json();
  assert.deepEqual(report.students[0].lessons[0].data.teacherScoreOverrides, saved.teacherScoreOverrides);
  assert.deepEqual(await (await app.call({ action: "student-activity-average", studentId: "0026271000", termId: "term_01" }, cookie)).json(), { average: 88 });
  assert.equal(app.data.has(path.replace("term_01", "term_02")), false);
});

test("score corrections reject foreign students, invalid points, and unsupported fields without writes", async () => {
  const app = fixture(), cookie = await app.login();
  const committed = app.store.committed;
  assert.equal((await app.call(edit("pre", 2, 5))).status, 401);
  assert.equal((await app.call(edit("pre", 2, 5, path.replace("0026271000", "0026271001")), cookie)).status, 403);
  for (const [kind, score, maximum] of [["pre", -1, 5], ["pre", 6, 5], ["pre", 1.5, 5], ["post", 5, 5], ["activity", 2, 0], ["activity", 1001, 1001], ["activity", "2", 5], ["unknown", 2, 5]]) {
    assert.equal((await app.call(edit(kind, score, maximum), cookie)).status, 400);
  }
  const forged = edit("activity", 3, 5);
  forged.writes[0].data.teacherScoreOverrides.activity.updatedBy = "another-teacher";
  assert.equal((await app.call(forged, cookie)).status, 400);
  assert.equal(app.store.committed, committed);
  assert.equal(app.data.has(path), false);
});
