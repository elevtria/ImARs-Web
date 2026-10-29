import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { StudentQuizStore } from "../server/student-quiz-store.js";
import { studentQuizzes } from "../server/student-quizzes.js";
import { quizReview, QuizReviewStore } from "../server/quiz-review.js";

const project = "demo-imars-generated-quizzes", origin = "http://127.0.0.1:58088";
const env = { STUDENT_QUIZZES_ENABLED: "true", ACCOUNT_ACCESS_ENABLED: "true", WEB_SESSION_SECRET: "emulator-only-cursor-secret-with-32-characters" };
let requests = 0, queryRequests = 0;
function store() {
  const db = new StudentQuizStore(env);
  db.identity = async uid => ({ localId: uid, email: uid + "@example.test", emailVerified: true });
  db.request = async (suffix, options = {}) => {
    requests++; if (suffix.endsWith("runQuery")) queryRequests++;
    const response = await fetch(`${origin}/v1/projects/${project}/databases/(default)/${suffix}`, { ...options,
      headers: { Authorization: "Bearer owner", "Content-Type": "application/json" }, ...(options.body ? { body: options.body.replaceAll("imars-db-a733b", project) } : {}) });
    if (response.status === 404) return null;
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error("Emulator request: " + response.status + " " + JSON.stringify(body)), { status: [400, 409].includes(response.status) && ["ABORTED", "FAILED_PRECONDITION", "ALREADY_EXISTS"].includes(body.error?.status) ? 409 : 503 });
    return body;
  };
  return db;
}
await fetch(`${origin}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: "DELETE" });
const db = store();
const set = (path, data) => ({ operation: "set", path, data });
const users = [["S1", "student-a", "student", "A", "T1"], ["S2", "student-b", "student", "B", "T2"], ["T1", "teacher-a", "teacher"], ["T2", "teacher-b", "teacher"]];
await db.commit(users.flatMap(([id, uid, role, classCode, teacherId]) => [set("users/" + id, { uid, role, active: true, displayName: id, ...(classCode ? { classCode, teacherId } : {}) }), set("_accountAccess/" + uid, { profileId: id, role, active: true, authEmail: uid + "@example.test" })]).concat([set("classes/A", { teacherId: "T1" }), set("classes/B", { teacherId: "T2" })]));
const makeQuiz = i => ({ id: "q" + String(i).padStart(4, "0"), title: "Emulator quiz " + i, sectionId: i < 900 ? "A" : "B", teacherProfileId: i < 900 ? "T1" : "T2", teacherUid: i < 900 ? "teacher-a" : "teacher-b", type: "multiple-choice", schemaVersion: 2, gradingMode: "automatic", availability: "now", availableAt: "", createdAt: "2026-10-28T00:00:00.000Z", questionCount: 1, questions: [{ id: "original-q", text: "Pick one", options: ["First", "Second", "Third", "Fourth"], correctIndex: 0 }] });
for (let i = 0; i < 1000; i += 100) await db.commit(Array.from({ length: 100 }, (_, j) => makeQuiz(i + j)).map(q => set("generatedQuizzes/" + q.id, q)));
const call = (action, body, uid = "student-a") => studentQuizzes({ env, request: new Request("https://imars.test/api/student-quizzes/" + action, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) }, { store: store(), authenticate: async () => ({ uid, email: uid + "@example.test" }), rate: async () => {} });
const passed = [], check = (name, condition) => { assert.ok(condition, name); passed.push(name); };
requests = queryRequests = 0;
let cursor = "", first, pages = 0, count = 0, firstMs; const seen = new Set(), started = performance.now();
do {
  const response = await call("list", { limit: 20, cursor }); assert.equal(response.status, 200, await response.clone().text());
  const page = await response.json(); if (!pages) { first = page; firstMs = performance.now() - started; }
  pages++; count += page.items.length; assert.ok(page.items.length <= 20); assert.doesNotMatch(JSON.stringify(page), /correctIndex|"questions"/);
  for (const item of page.items) { assert.ok(!seen.has(item.id)); seen.add(item.id); } cursor = page.nextCursor;
} while (cursor);
const measured = { records: 1000, eligible: count, apiPageRequests: pages, projectedQueries: queryRequests, totalDatastoreRequests: requests, maxQueryRows: 21, firstPageMs: firstMs, fullTraversalMs: performance.now() - started };
check("1000 emulator records yield 900 authorized records through 45 projected queries", count === 900 && pages === 45 && queryRequests === 45);
const selected = first.items[0], attemptId = "a".repeat(32), request = { quizId: selected.id, revision: selected.revision, attemptId };
const openedResponse = await call("start", request); assert.equal(openedResponse.status, 200, await openedResponse.clone().text()); const opened = await openedResponse.json();
check("REST transaction reserves an attempt and returns only student-safe questions", opened.questions[0].id === "original-q" && !JSON.stringify(opened).includes("correctIndex"));
check("Repeated start reuses its reservation", (await call("start", request)).status === 200);
check("Cross-section token cannot start another class quiz", (await call("start", request, "student-b")).status === 403);
const body = { assignmentId: selected.id, revision: selected.revision, attemptId, startedAtUtc: new Date().toISOString(), completedAtUtc: new Date().toISOString(), answers: [{ questionId: "original-q", optionIndex: 0, value: "", explanation: "", correction: "" }] };
const submission = await call("submit", body); assert.equal(submission.status, 200, await submission.clone().text()); const receipt = await submission.json();
check("REST commit confirms grading and persistence before success", receipt.persisted && receipt.score === 1 && receipt.maximum === 1);
check("Identical retry returns the identical receipt", JSON.stringify(await (await call("submit", body)).json()) === JSON.stringify(receipt));
check("Changed answers under the same attempt ID conflict", (await call("submit", { ...body, answers: [{ ...body.answers[0], optionIndex: 1 }] })).status === 409);
const row = await db.get("generatedQuizzes/" + selected.id); await db.commit([{ operation: "update", path: "generatedQuizzes/" + selected.id, updateTime: row.updateTime, data: { availability: "draft" } }]);
check("Committed receipt still replays after relock", (await call("submit", body)).status === 200);
const refreshed = await call("list", { limit: 20, cursor: first.pageCursor }); assert.equal(refreshed.status, 200, await refreshed.clone().text());
check("Name-IN projected page refresh removes relocked records without shifting members", (await refreshed.json()).items.length === 19);
const boundary = first.items.at(-1).id, boundaryRow = await db.get("generatedQuizzes/" + boundary); await db.commit([{ operation: "delete", path: "generatedQuizzes/" + boundary, updateTime: boundaryRow.updateTime }]);
const next = await call("list", { limit: 20, cursor: first.nextCursor }); assert.equal(next.status, 200); check("Tuple continuation survives deletion of the boundary document", (await next.json()).items.length === 20);
// Rules are checked with an emulator-only unsigned Firebase token, never owner.
const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url"); const now = Math.floor(Date.now() / 1000);
const rulesToken = encode({ alg: "none", typ: "JWT" }) + "." + encode({ aud: project, iss: "https://securetoken.google.com/" + project, sub: "student-a", user_id: "student-a", iat: now, exp: now + 3600, email: "student-a@example.test", email_verified: true, firebase: { sign_in_provider: "password", identities: {} } }) + ".";
for (const path of ["generatedQuizzes/q0001", "users/S1/generated_quiz_attempts/" + attemptId]) {
  const read = await fetch(`${origin}/v1/projects/${project}/databases/(default)/documents/${path}`, { headers: { Authorization: "Bearer " + rulesToken } }); check("Student cannot read raw private " + path.split("/").at(-2), read.status === 403);
}
for (const path of ["generatedQuizzes/q0001", "generatedQuizRevisions/private", "_accountAccess/student-a", "users/S1/generated_quiz_attempts/" + attemptId]) {
  const response = await fetch(`${origin}/v1/projects/${project}/databases/(default)/documents/${path}`);
  check("Anonymous direct private read denied: " + path.split("/").at(-2), response.status === 403);
}
for (const [path, field, value] of [["users/S1","classCode","B"],["users/S1","uid","student-b"],["classes/A","teacherId","T2"]]) {
  const response = await fetch(`${origin}/v1/projects/${project}/databases/(default)/documents/${path}?updateMask.fieldPaths=${field}`, {method:"PATCH",headers:{Authorization:"Bearer "+rulesToken,"Content-Type":"application/json"},body:JSON.stringify({fields:{[field]:{stringValue:value}}})});
  check("Direct membership spoofing denied: " + field, response.status === 403);
}
const avatar = await fetch(`${origin}/v1/projects/${project}/databases/(default)/documents/users/S1?updateMask.fieldPaths=avatarId`, {method:"PATCH",headers:{Authorization:"Bearer "+rulesToken,"Content-Type":"application/json"},body:JSON.stringify({fields:{avatarId:{stringValue:"avatar-fixture"}}})});
check("Existing student avatar updates remain available", avatar.status === 200);
await db.commit([set("generatedQuizzes/shared", {...makeQuiz(1),id:"shared",sectionId:"",assignmentScope:"all"})]);
const sharedPage = await call("list",{limit:20,cursor:""});
check("Actual section-IN query includes all-section quizzes without exposing another teacher", (await sharedPage.json()).items.some(q=>q.id==="shared"));
const essay = { ...makeQuiz(1), id: "essay", type: "essay", gradingMode: "teacher-review", questions: [{ id: "original-essay", text: "Explain your answer", options: [], correctIndex: -1, answer: "PRIVATE MODEL", rubric: "PRIVATE RUBRIC", points: 5 }] };
await db.commit([set("generatedQuizzes/essay", essay)]);
const essayRow = await db.get("generatedQuizzes/essay"), essayAttemptId = "b".repeat(32);
assert.equal((await call("start", { quizId: "essay", revision: essayRow.updateTime, attemptId: essayAttemptId })).status, 200);
const essayBody = { assignmentId: "essay", revision: essayRow.updateTime, attemptId: essayAttemptId, startedAtUtc: new Date().toISOString(), completedAtUtc: new Date().toISOString(), answers: [{ questionId: "original-essay", optionIndex: -1, value: "My student essay", explanation: "", correction: "" }] };
const pendingResponse = await call("submit", essayBody); assert.equal(pendingResponse.status, 200, await pendingResponse.clone().text());
check("Essay persistence awaits teacher review", (await pendingResponse.json()).status === "pending-review");
const reviewCall = async (action, extra = {}, actor = { id: "T1", uid: "teacher-a", role: "teacher" }) => {
  const reviewStore = new QuizReviewStore(env); reviewStore.request = db.request;
  return quizReview({ env, request: new Request("https://imars.test/api/quiz-review/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, quizId: "essay", studentId: "S1", attemptId: essayAttemptId, ...extra }) }) }, { store: reviewStore, authenticate: async (_request, _env, currentStore) => { await currentStore.get("users/" + actor.id); return actor; } });
};
const reviewPage = await reviewCall("list", { cursor: "" }); assert.equal(reviewPage.status, 200, await reviewPage.clone().text()); check("Collection-group review query is scoped and returns the submitted essay", (await reviewPage.json()).items.length === 1);
const reviewOpenedResponse = await reviewCall("open"); assert.equal(reviewOpenedResponse.status, 200, await reviewOpenedResponse.clone().text()); const reviewOpened = await reviewOpenedResponse.json();
check("Staff review loads the preserved private guide", reviewOpened.questions[0].rubric === "PRIVATE RUBRIC");
check("Another teacher cannot review the submission", (await reviewCall("open", {}, { id: "T2", uid: "teacher-b", role: "teacher" })).status === 403);
const graded = await reviewCall("grade", { revision: reviewOpened.revision, scores: [{ questionId: "original-essay", score: 4 }], feedback: "Good explanation" }); assert.equal(graded.status, 200, await graded.clone().text());
check("Teacher review persists transactionally with bounded scores", (await graded.json()).score === 4);
check("Submission receipt stays idempotent after teacher grading", (await call("submit", essayBody)).status === 200);
const storedEssay = await db.get("users/S1/generated_quiz_attempts/" + essayAttemptId);
const snapshotRead = await fetch(`${origin}/v1/projects/${project}/databases/(default)/documents/generatedQuizRevisions/${storedEssay.data.snapshotId}`, { headers: { Authorization: "Bearer " + rulesToken } });
check("Students cannot read private revision snapshots", snapshotRead.status === 403);
const result = { passed, failed: [], measured };
await writeFile(process.env.STUDENT_QUIZ_RESULTS_PATH ? pathToFileURL(process.env.STUDENT_QUIZ_RESULTS_PATH) : new URL("../.wrangler/student-quiz-emulator-results.json", import.meta.url), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
