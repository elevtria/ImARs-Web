import test from "node:test";
import assert from "node:assert/strict";
import { lessonNotifications, latestNotifications, reportNotifications } from "../js/test-notifications.js";

const complete = data => lessonNotifications("S1", "Ana", "A", "term_01", "lesson_02", data);
test("only saved completions notify, including zero scores and ungraded completed tests", () => {
  assert.deepEqual(complete({ preTestScore: 5, isLessonCompleted: true }), []);
  assert.equal(complete({ isPreTestCompleted: true, preTestScore: 0 }).length, 1);
  assert.equal(complete({ isPostTestCompleted: true }).length, 1);
  assert.equal(complete({ isPreTestCompleted: "true" }).length, 0);
});
test("pre and post are distinct and grading or activity updates cannot create duplicates", () => {
  const before = complete({ isPreTestCompleted: true, isPostTestCompleted: true, timestamp: "2026-11-08T01:00:00Z" });
  const after = complete({ isPreTestCompleted: true, isPostTestCompleted: true, lastUpdated: "2026-11-08T02:00:00Z", preTestScore: 4 });
  assert.equal(new Set(before.map(item => item.id)).size, 2);
  assert.deepEqual(before.map(item => item.id), after.map(item => item.id));
  assert.equal(latestNotifications([...before, ...after]).length, 2);
});
test("feed is sorted and bounded with safe ordering for missing timestamps", () => {
  const items = Array.from({ length: 80 }, (_, at) => ({ id: String(at), at }));
  const result = latestNotifications(items);
  assert.equal(result.length, 50); assert.equal(result[0].at, 79); assert.equal(result.at(-1).at, 30);
  assert.equal(complete({ isPreTestCompleted: true, timestamp: "invalid" })[0].at, 0);
});
test("report fallback preserves student, section, term and lesson and excludes archived students", () => {
  const student = active => ({ studentDoc: { id: "S1", data: () => ({ displayName: "Ana", active }) },
    results: [{ termId: "term_03", lessonsSnap: { docs: [{ id: "lesson_04", data: () => ({ isPostTestCompleted: true }) }] } }] });
  const section = { classDoc: { id: "A", data: () => ({ SectionName: "Section A" }) }, students: [student(true)] };
  const [item] = reportNotifications([section]);
  assert.equal(item.id, "S1:term_03:lesson_04:post"); assert.equal(item.name, "Ana"); assert.equal(item.section, "Section A");
  assert.deepEqual(reportNotifications([{ ...section, students: [student(false)] }]), []);
});
