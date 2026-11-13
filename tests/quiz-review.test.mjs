import assert from "node:assert/strict";
import test from "node:test";
import { quizReview, QuizReviewStore } from "../server/quiz-review.js";
import { fixture, quiz } from "./fixtures/student-quizzes.js";

async function setup(type = "essay", assignment = {}, submittedAnswers) {
  const f = fixture(); f.put("generatedQuizzes/quiz1", quiz("quiz1", type, assignment)); const { request } = await f.begin(), body = f.submission(request);
  if (!["multiple-choice", "true-false"].includes(type)) {
    Object.assign(body.answers[0], type === "modified-true-false" ? { optionIndex: 1, correction: "Student correction" } : type === "identification-explanation" ? { optionIndex: -1, value: "Student identification", explanation: "Student explanation" } : { optionIndex: -1, value: "Student essay" });
  }
  if (submittedAnswers) body.answers = submittedAnswers;
  assert.equal((await f.call("submit", body)).status, 200);
  const path = "users/S1/generated_quiz_attempts/" + request.attemptId;
  const call = (input, actor = { id: "TEACH1", uid: "teacher-a", role: "teacher" }) => quizReview({ env: f.env, request: new Request("https://imars.test/api/quiz-review/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ quizId: "quiz1", studentId: "S1", attemptId: request.attemptId, ...input }) }) }, { store: f.store, authenticate: async () => actor });
  return { ...f, path, callReview: call, body };
}

test("Modified True or False scores taps automatically and publishes a combined score after written review", async () => {
  const original = quiz("quiz1", "modified-true-false").questions[0];
  const trueQuestion = { ...original, id: "q-true", correctIndex: 0, correction: "" };
  const tap = questionId => ({ questionId, optionIndex: 0, value: "", explanation: "", correction: "" });
  const questions = [trueQuestion, original];
  const choiceOnly = await setup("modified-true-false", { questions, questionCount: 2 }, [tap("q-true"), tap("q-original")]);
  const automatic = await (await choiceOnly.call("list", { limit: 20, cursor: "" })).json();
  assert.deepEqual(automatic.items[0].result, { status: "graded", score: 1, maximum: 2 });

  const mixed = await setup("modified-true-false", { questions, questionCount: 2 },
    [tap("q-true"), { ...tap("q-original"), optionIndex: 1, correction: "A written correction" }]);
  const pending = await (await mixed.call("list", { limit: 20, cursor: "" })).json();
  assert.equal(pending.items[0].result.status, "pending-review");
  const opened = await (await mixed.callReview({ action: "open" })).json();
  assert.deepEqual(opened.automaticScores, [{ questionId: "q-true", score: 1 }]);
  assert.equal(opened.answers[1].correction, "A written correction");
  const grade = { action: "grade", revision: opened.revision, feedback: "", scores: [{ questionId: "q-true", score: 0 }, { questionId: "q-original", score: 1 }] };
  assert.equal((await mixed.callReview(grade)).status, 400);
  grade.scores[0].score = 1;
  assert.deepEqual(await (await mixed.callReview(grade)).json(), { persisted: true, score: 2, maximum: 2 });
  const published = await (await mixed.call("list", { limit: 20, cursor: pending.pageCursor })).json();
  assert.deepEqual(published.items[0].result, { status: "reviewed", score: 2, maximum: 2 });
});
for (const type of ["essay", "identification-explanation", "modified-true-false"]) test(type + " reviews use the private original revision and preserve submitted answers/receipt", async () => {
  const f = await setup(type), before = structuredClone(f.data.get(f.path));
  f.put("generatedQuizzes/quiz1", { ...f.data.get("generatedQuizzes/quiz1"), title: "Later edited title", questions: [] });
  const pendingPage = await (await f.call("list", { limit: 20, cursor: "" })).json();
  assert.deepEqual(pendingPage.items[0].result, { status: "pending-review", score: 0, maximum: 0 });
  const opened = await (await f.callReview({ action: "open" })).json(); assert.equal(opened.questions[0].id, "q-original"); assert.equal(opened.answers[0].questionId, "q-original");
  const response = await f.callReview({ action: "grade", revision: opened.revision, scores: [{ questionId: "q-original", score: 1 }], feedback: "Reviewed" }); assert.equal(response.status, 200); assert.equal((await response.json()).persisted, true);
  const after = f.data.get(f.path); assert.equal(after.status, "reviewed"); assert.equal(after.review.reviewerUid, "teacher-a"); assert.deepEqual(after.answers, before.answers); assert.deepEqual(after.receipt, before.receipt);
  const reopened = await (await f.callReview({ action: "open" })).json();
  assert.equal(reopened.score, 1);
  assert.equal(reopened.feedback, "Reviewed");
  assert.deepEqual(reopened.scores, [{ questionId: "q-original", score: 1 }]);
  assert.equal((await f.callReview({ action: "grade", revision: opened.revision, scores: [{ questionId: "q-original", score: 1 }], feedback: "Again" })).status, 409);
  const updated = await f.callReview({ action: "grade", revision: reopened.revision,
    scores: [{ questionId: "q-original", score: 0 }], feedback: "Updated feedback" });
  assert.deepEqual(await updated.json(), { persisted: true, score: 0, maximum: after.review.maximum });
  const saved = await (await f.callReview({ action: "open" })).json();
  assert.equal(saved.score, 0);
  assert.equal(saved.feedback, "Updated feedback");
  const gradedPage = await (await f.call("list", { limit: 20, cursor: pendingPage.pageCursor })).json();
  assert.deepEqual(gradedPage.items[0].result, { status: "reviewed", score: 0, maximum: opened.questions[0].points || 1 });
  assert.doesNotMatch(JSON.stringify(gradedPage), /Student essay|Student correction|Student explanation|PRIVATE|feedback|reviewerUid/);
  assert.deepEqual(await (await f.call("submit", f.body)).json(), before.receipt);
});
test("a teacher can adjust an automatically graded submission within its original point limit", async () => {
  const f = await setup("multiple-choice");
  const response = await f.callReview({ action: "open" });
  assert.equal(response.status, 200);
  const attempt = await response.json();
  assert.equal(attempt.score, 1);
  assert.equal(attempt.maximum, 1);
  assert.equal(attempt.answers[0].optionIndex, attempt.questions[0].correctIndex);
  const review = { action: "grade", revision: attempt.revision, scores: [{ questionId: "q-original", score: 0 }], feedback: "" };
  assert.equal((await f.callReview({ ...review, scores: [{ questionId: "q-original", score: 2 }] })).status, 400);
  assert.deepEqual(await (await f.callReview(review)).json(), { persisted: true, score: 0, maximum: 1 });
  assert.equal((await f.callReview(review)).status, 409);
  const updated = await (await f.callReview({ action: "open" })).json();
  assert.equal(updated.status, "reviewed");
  assert.equal(updated.score, 0);
  assert.equal((await f.callReview({ action: "open" }, { id: "TEACH2", uid: "teacher-b", role: "teacher" })).status, 403);
});

test("term results return only raw scores for the selected term and eligible roster rows", async () => {
  const f = await setup("multiple-choice", { termId: "term_02" });
  f.put("generatedQuizzes/other-term", quiz("other-term", "multiple-choice", { termId: "term_01" }));
  f.put("generatedQuizzes/scheduled", quiz("scheduled", "multiple-choice", {
    title: "Scheduled Quiz", termId: "term_02", availability: "scheduled", availableAt: "2099-01-01T00:00:00Z"
  }));
  const original = f.store.get.bind(f.store);
  f.store.getAll = async paths => new Map(await Promise.all(paths.map(async path => [path, await original(path)])));
  f.store.quizReport = async (_actor, sectionId, quizId, studentIds) => {
    assert.equal(sectionId, "A");
    assert.deepEqual(studentIds, ["S1"]);
    if (quizId === "scheduled") return { items: [] };
    assert.equal(quizId, "quiz1");
    return { items: [{ studentId: "S1", status: "graded", score: 1, maximum: 1, answers: ["private"] }] };
  };
  const input = { action: "term-results", termId: "term_02", sectionId: "A", studentIds: ["S1", "S2"] };
  const response = await f.callReview(input);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.quizzes.map(item => item.id), ["quiz1", "scheduled"]);
  assert.equal(result.quizzes[1].title, "Scheduled Quiz");
  assert.deepEqual(result.items, [{ quizId: "quiz1", studentId: "S1", status: "graded", score: 1, maximum: 1 }]);
  assert.equal((await f.callReview({ ...input, sectionId: "B" })).status, 403);
  assert.equal((await f.callReview({ ...input, termId: "term_04" })).status, 400);
});
test("a teacher can grade a submitted essay after moving the quiz, while ownership still applies", async () => {
  const f = await setup();
  f.put("classes/C", { teacherId: "TEACH1" });
  f.put("users/S4", { role: "student", classCode: "A", teacherId: "TEACH1" });
  f.put("generatedQuizzes/quiz1", { ...f.data.get("generatedQuizzes/quiz1"), sectionId: "C" });
  f.store.reviewPage = async (_actor, _quiz, sectionId) => {
    assert.equal(sectionId, "");
    return [{ path: f.path, data: { context: { studentId: "S1", sectionId: "A" }, submittedAt: "2026-10-29T00:00:00Z" } }];
  };
  f.store.getAll = async paths => new Map(await Promise.all(paths.map(async path => [path, await f.store.get(path)])));
  f.store.scorePage = async (_actor, studentId) => studentId === "S1" ? [{ path: f.path, data: f.data.get(f.path) }] : [];
  const history = await f.callReview({ action: "list" });
  assert.equal(history.status, 200);
  assert.equal((await history.json()).items[0].sectionId, "A");
  const table = await f.callReview({ action: "section-results", sectionId: "A" });
  assert.equal(table.status, 200);
  assert.deepEqual((await table.json()).items.map(row => row.studentId), ["S1"]);
  const result = await f.callReview({ action: "open", sectionId: "A" });
  assert.equal(result.status, 200);
  const opened = await result.json();
  const grade = await f.callReview({ action: "grade", sectionId: "A", revision: opened.revision,
    scores: [{ questionId: "q-original", score: 2 }], feedback: "Reviewed" });
  assert.deepEqual(await grade.json(), { persisted: true, score: 2, maximum: 4 });
  f.put("classes/A", { teacherId: "TEACH2" });
  assert.equal((await f.callReview({ action: "open" })).status, 403);
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

test("submission filters and cursors cannot cross sections", async () => {
  const f = await setup("essay", { assignmentScope: "all", sectionId: "" });
  f.put("classes/C", { teacherId: "TEACH1" });
  f.put("users/S1", { role: "student", classCode: "A", displayName: " ", firstName: "Test", lastName: "Student" });
  f.store.getAll = async paths => new Map(await Promise.all(paths.map(async path => [path, await f.store.get(path)])));
  let reads = 0;
  f.store.reviewPage = async (_actor, _quiz, sectionId) => {
    reads++;
    assert.equal(sectionId, "A");
    return Array.from({ length: 21 }, (_, i) => ({
      path: "users/S1/generated_quiz_attempts/" + i.toString(16).padStart(32, "0"),
      data: { context: { sectionId: "A", studentId: "S1" }, submittedAt: "2026-10-29T00:00:00Z" }
    }));
  };
  const response = await f.callReview({ action: "list", sectionId: "A" });
  assert.equal(response.status, 200);
  const page = await response.json();
  assert.equal(page.items.length, 20);
  assert.equal(page.items[0].name, "Test Student");
  assert.ok(page.nextCursor);
  assert.equal((await f.callReview({ action: "list", sectionId: "C", cursor: page.nextCursor })).status, 400);
  assert.equal((await f.callReview({ action: "open", sectionId: "C" })).status, 403);
  assert.equal((await f.callReview({ action: "list", sectionId: "B" })).status, 403);
  assert.equal(reads, 1);
});

test("quiz scores distinguish pending, auto-graded, reviewed and missing submissions within the teacher's sections", async () => {
  const f = await setup();
  const submittedAt = "2026-10-29T00:00:00Z";
  f.put("users/S3", { role: "student", classCode: "A", displayName: "Student Three" });
  f.put("users/S4", { role: "student", classCode: "A", active: false });
  f.store.scorePage = async (actor, studentId, sectionId, { quizId }) => {
    assert.equal(actor.uid, "teacher-a");
    assert.equal(sectionId, "A");
    if (studentId && studentId !== "S1") return [];
    const essay = { path: f.path, data: { ...f.data.get(f.path), submittedAt } };
    return quizId ? [essay] : [essay, { path: f.path, data: {
      quizId: "automatic", status: "graded", submittedAt, receipt: { score: 0, maximum: 1 }
    } }, { path: f.path, data: {
      quizId: "automatic", status: "graded", submittedAt: "2026-10-28T00:00:00Z", receipt: { score: 1, maximum: 1 }
    } }];
  };
  const summary = await (await f.callReview({ action: "section-summary", sectionId: "A" })).json();
  assert.deepEqual(summary, { learners: 2, items: [
    { quizId: "quiz1", submitted: 1, average: null }, { quizId: "automatic", submitted: 1, average: 0 }
  ] });
  const section = () => f.callReview({ action: "section-results", sectionId: "A" });
  assert.deepEqual((await (await section()).json()).items.map(({ studentId, status }) => [studentId, status]),
    [["S1", "pending-review"], ["S3", "not-submitted"]]);
  const opened = await (await f.callReview({ action: "open" })).json();
  assert.equal((await f.callReview({ action: "grade", revision: opened.revision,
    scores: [{ questionId: "q-original", score: 3 }], feedback: "Private comment" })).status, 200);
  const reviewed = (await (await section()).json()).items[0];
  assert.equal(reviewed.status, "reviewed");
  assert.equal(reviewed.score, 3);
  assert.equal(reviewed.maximum, 4);
  assert.equal(Object.hasOwn(reviewed, "feedback"), false);
  assert.deepEqual(await (await f.callReview({ action: "student-average" })).json(), { average: 38 });
  assert.equal((await f.callReview({ action: "section-summary", sectionId: "B" })).status, 403);
  assert.equal((await f.callReview({ action: "section-results", sectionId: "B" })).status, 403);
  assert.equal((await f.callReview({ action: "student-average", studentId: "S2" })).status, 403);
});

test("locking a quiz preserves its submitted results and archived rows do not consume a page", async () => {
  const f = await setup();
  f.put("generatedQuizzes/quiz1", { ...f.data.get("generatedQuizzes/quiz1"), availability: "draft" });
  for (let index = 0; index < 12; index++) f.put("users/A" + index, { role: "student", classCode: "A", status: "archived" });
  for (let index = 0; index < 10; index++) f.put("users/Z" + index, { role: "student", classCode: "A" });
  const requests = [];
  f.store.quizReport = async (actor, section, quizId, ids) => {
    assert.equal(actor.uid, "teacher-a");
    assert.equal(section, "A");
    assert.equal(quizId, "quiz1");
    requests.push(ids);
    return { items: ids.includes("S1") ? [{ studentId: "S1", status: "pending-review", attemptId: f.path.split("/").at(-1) }] : [] };
  };
  const first = await (await f.callReview({ action: "section-results", sectionId: "A" })).json();
  assert.equal(first.items.length, 10);
  assert.equal(first.items[0].status, "pending-review");
  assert.ok(first.nextCursor);
  const second = await (await f.callReview({ action: "section-results", sectionId: "A", cursor: first.nextCursor })).json();
  assert.equal(second.items.length, 1);
  assert.equal(second.nextCursor, "");
  assert.equal(new Set(requests.flat()).size, 11);
  assert.deepEqual(requests.map(ids => ids.length), [10, 1]);
});
