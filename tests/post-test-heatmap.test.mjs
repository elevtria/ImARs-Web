import test from "node:test";
import assert from "node:assert/strict";
import { buildPostTestHeatmap } from "../js/post-test-heatmap.js";
import { encodeView, decodeView } from "../js/view-cache.js";

const doc = (id, data) => ({ id, exists: () => true, data: () => data });
const lesson = doc("lesson_01", { title: "Topic", postTest: [{ question: "Question A", answer: "private-answer" }, { question: "Question B" }, { question: "Question C" }] });
const student = (id, data, termId = "term_02", lessonId = "lesson_01") => ({ studentDoc: doc(id, {}), results: [{ termId, lessonsSnap: { docs: [doc(lessonId, data)] } }] });
const result = (answers, order) => ({ isPostTestCompleted: true, postTestHeatmap: answers, postTestQuestionOrder: order, postTestTotalQuestions: 3 });

test("wrong answers map back from shuffled presentation order to the correct question", () => {
  const sections = [{ students: [student("one", result([false, true, true], [2, 0, 1])), student("two", result([false, true, false], [0, 1, 2]))] }];
  const chart = buildPostTestHeatmap(lesson, sections, "term_02");
  assert.equal(chart.mapped, 2); assert.equal(chart.unmapped, 0);
  assert.deepEqual(chart.rows.map(row => [row.text, row.wrong, row.answered, row.rate]), [["Question A", 1, 2, 50], ["Question B", 0, 2, 0], ["Question C", 2, 2, 100]]);
});

test("legacy, corrupt and incomplete mappings never invent wrong answers or count pre-tests", () => {
  const sections = [{ students: [
    student("legacy", result([false, false, false], undefined)),
    student("duplicate", result([false, false, false], [0, 0, 2])),
    student("string", result([false, "false", true], [0, 1, 2])),
    student("partial", result([false], [0])),
    student("mismatch", { ...result([false, true, true], [0, 1, 2]), postTestScore: 3 }),
    student("pre-only", { preTestHeatmap: [false, false, false], isPreTestCompleted: true }),
    student("unfinished", { ...result([false, false, false], [0, 1, 2]), isPostTestCompleted: false }),
    student("other-term", result([false, false, false], [0, 1, 2]), "term_01"),
    student("other-topic", result([false, false, false], [0, 1, 2]), "term_02", "lesson_02")
  ] }];
  const chart = buildPostTestHeatmap(lesson, sections, "term_02");
  assert.equal(chart.mapped, 0); assert.equal(chart.unmapped, 5);
  assert.ok(chart.rows.every(row => row.wrong === 0 && row.rate === null));
});

test("zero errors are distinguishable from missing data and a student is counted once", () => {
  const one = student("one", result({ 0: true, 1: true, 2: true }, [2, 1, 0]));
  const chart = buildPostTestHeatmap(lesson, [{ students: [one, one] }], "term_02");
  assert.equal(chart.mapped, 1); assert.ok(chart.rows.every(row => row.rate === 0 && row.answered === 1));
});

test("saved report caches retain question labels and mappings without answer keys", () => {
  const savedLesson = decodeView(encodeView(lesson));
  assert.deepEqual(savedLesson.data().postTest, [{ question: "Question A" }, { question: "Question B" }, { question: "Question C" }]);
  assert.ok(!JSON.stringify(encodeView(lesson)).includes("private-answer"));
  const savedResult = decodeView(encodeView(doc("lesson_01", result([false, true, true], [2, 0, 1]))));
  assert.deepEqual(savedResult.data().postTestQuestionOrder, [2, 0, 1]);
});
