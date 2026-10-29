import assert from "node:assert/strict";
import test from "node:test";
import { quizReview, QuizReviewStore } from "../server/quiz-review.js";
import { fixture, quiz } from "./fixtures/student-quizzes.js";

async function setup(type = "essay", assignment = {}) {
  const f = fixture(); f.put("generatedQuizzes/quiz1", quiz("quiz1", type, assignment)); const { request } = await f.begin(), body = f.submission(request);
  Object.assign(body.answers[0], type === "modified-true-false" ? { optionIndex: 1, correction: "Student correction" } : type === "identification-explanation" ? { optionIndex: -1, value: "Student identification", explanation: "Student explanation" } : { optionIndex: -1, value: "Student essay" });
  assert.equal((await f.call("submit", body)).status, 200);
  const path = "users/S1/generated_quiz_attempts/" + request.attemptId;
  const call = (input, actor = { id: "TEACH1", uid: "teacher-a", role: "teacher" }) => quizReview({ env: f.env, request: new Request("https://imars.test/api/quiz-review/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ quizId: "quiz1", studentId: "S1", attemptId: request.attemptId, ...input }) }) }, { store: f.store, authenticate: async () => actor });
  return { ...f, path, callReview: call, body };
}
for (const type of ["essay", "identification-explanation", "modified-true-false"]) test(type + " reviews use the private original revision and preserve submitted answers/receipt", async () => {
  const f = await setup(type), before = structuredClone(f.data.get(f.path));
  f.put("generatedQuizzes/quiz1", { ...f.data.get("generatedQuizzes/quiz1"), title: "Later edited title", questions: [] });
  const opened = await (await f.callReview({ action: "open" })).json(); assert.equal(opened.questions[0].id, "q-original"); assert.equal(opened.answers[0].questionId, "q-original");
  const response = await f.callReview({ action: "grade", revision: opened.revision, scores: [{ questionId: "q-original", score: 1 }], feedback: "Reviewed" }); assert.equal(response.status, 200); assert.equal((await response.json()).persisted, true);
  const after = f.data.get(f.path); assert.equal(after.status, "reviewed"); assert.equal(after.review.reviewerUid, "teacher-a"); assert.deepEqual(after.answers, before.answers); assert.deepEqual(after.receipt, before.receipt);
  assert.equal((await f.callReview({ action: "grade", revision: opened.revision, scores: [{ questionId: "q-original", score: 1 }], feedback: "Again" })).status, 409);
  assert.deepEqual(await (await f.call("submit", f.body)).json(), before.receipt);
});
test("teacher review denies another teacher, a student, moved class and invalid scores", async () => {
  const f = await setup();
  for (const actor of [{ id: "TEACH2", uid: "teacher-b", role: "teacher" }, { id: "S1", uid: "student-a", role: "student" }]) assert.equal((await f.callReview({ action: "open" }, actor)).status, 403);
  const opened = await (await f.callReview({ action: "open" })).json();
  for (const scores of [[{ questionId: "q-original", score: 99 }], [{ questionId: "unknown", score: 1 }], [{ questionId: "q-original", score: -1 }]]) assert.equal((await f.callReview({ action: "grade", revision: opened.revision, scores, feedback: "" })).status, 400);
  f.put("classes/A", { teacherId: "TEACH2" }); assert.equal((await f.callReview({ action: "open" })).status, 403);
});
test("teacher review query is bounded and scoped by quiz, class and current teacher", async () => {
  const store = new QuizReviewStore({}); let request;
  store.request = async (_path, options) => { request = JSON.parse(options.body).structuredQuery; return []; };
  await store.reviewPage({ id: "TEACH1", uid: "teacher-a" }, "quiz1", "A", ["2026-10-29T00:00:00Z", "users/S1/generated_quiz_attempts/" + "a".repeat(32)]);
  assert.equal(request.limit, 21); assert.equal(request.from[0].allDescendants, true); assert.equal(request.select.fields.some(f => ["answers", "review", "snapshotId"].includes(f.fieldPath)), false);
  assert.equal(request.where.compositeFilter.filters.length, 5); assert.equal(request.startAt.before, false);
});

test("all-section quiz reviews retain current class ownership checks", async () => {
  const f = await setup("essay", { assignmentScope: "all", sectionId: "" });
  const opened = await f.callReview({ action: "open" }); assert.equal(opened.status, 200);
  const attempt = await opened.json();
  assert.equal((await f.callReview({ action: "grade", revision: attempt.revision, scores: [{ questionId: "q-original", score: 2 }], feedback: "Reviewed" })).status, 200);
  f.put("classes/A", { teacherId: "TEACH2" });
  assert.equal((await f.callReview({ action: "open" })).status, 403);
  const store = new QuizReviewStore({}); let query;
  store.request = async (_path, options) => { query = JSON.parse(options.body).structuredQuery; return []; };
  await store.reviewPage({ id: "TEACH1", uid: "teacher-a" }, "quiz1", "", null);
  assert.equal(query.limit, 21); assert.equal(query.where.compositeFilter.filters.length, 4);
});
