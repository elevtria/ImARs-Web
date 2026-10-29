import assert from "node:assert/strict";
import test from "node:test";
import { studentQuizzes } from "../server/student-quizzes.js";
import { StudentQuizStore, SUMMARY_FIELDS } from "../server/student-quiz-store.js";
import { encodeFields } from "../server/firestore-admin.js";
import { protectWebsite } from "../server/web-auth.js";
import { backfillQuizMetadata } from "../scripts/backfill-quiz-metadata.mjs";

import { NOW, fixture, quiz, token } from "./fixtures/student-quizzes.js";

test("all-section quizzes stay scoped to the current teacher and refresh removes reassigned cards", async () => {
  const f = fixture();
  f.put("classes/C", { teacherId: "TEACH1" });
  f.put("users/S3", { uid: "student-c", role: "student", active: true, classCode: "C", teacherId: "TEACH1" });
  f.put("_accountAccess/student-c", { profileId: "S3", role: "student", active: true, authEmail: "student-c@example.test" });
  f.identities.set("student-c", { localId: "student-c", email: "student-c@example.test", emailVerified: true, validSince: "0" });
  f.put("generatedQuizzes/shared", quiz("shared", "multiple-choice", { sectionId: "", assignmentScope: "all" }));
  f.put("generatedQuizzes/draft", quiz("draft", "multiple-choice", { sectionId: "", assignmentScope: "unassigned", availability: "draft" }));
  const pages = [];
  for (const uid of ["student-a", "student-c"]) {
    const response = await f.call("list", { limit: 20, cursor: "" }, { uid });
    assert.equal(response.status, 200);
    const page = await response.json(); pages.push(page);
    assert.ok(page.items.some(item => item.id === "shared"));
    assert.equal(page.items.some(item => item.id === "draft"), false);
    assert.ok(page.items.every(item => item.sectionId === (uid === "student-a" ? "A" : "C")));
    assert.equal((await f.call("start", { quizId: "shared", revision: f.versions.get("generatedQuizzes/shared"), attemptId: "a".repeat(32) }, { uid })).status, 200);
  }
  const foreign = await (await f.call("list", { limit: 20, cursor: "" }, { uid: "student-b" })).json();
  assert.equal(foreign.items.length, 0);
  assert.equal((await f.call("start", { quizId: "shared", revision: f.versions.get("generatedQuizzes/shared"), attemptId: "a".repeat(32) }, { uid: "student-b" })).status, 403);
  f.put("generatedQuizzes/shared", { ...f.data.get("generatedQuizzes/shared"), sectionId: "A", assignmentScope: "section" });
  const refreshed = await f.call("list", { limit: 20, cursor: pages[1].pageCursor }, { uid: "student-c" });
  assert.equal(refreshed.status, 200); assert.equal((await refreshed.json()).items.length, 0);
  assert.equal((await f.call("access", { quizId: "shared", revision: pages[1].items[0].revision, attemptId: "a".repeat(32) }, { uid: "student-c" })).status, 403);
  assert.ok(f.store.queries.every(query => query.limit <= 21));
  const refresh = f.store.queries.at(-1);
  assert.equal(refresh.where.compositeFilter.filters.some(f => f.fieldFilter.field.fieldPath === "sectionId"), false, "membership refresh must not multiply 20 IDs by a section IN filter");
});

test("student route bypasses staff cookies but does not open the staff data endpoint", async () => {
  for (const [path, status] of [["/api/student-quizzes/list", 218], ["/api/web-data/query", 401]]) {
    const response = await protectWebsite({ env: { WEB_LOGIN_ENABLED: "true", WEB_DATA_ENABLED: "true", WEB_SESSION_SECRET: "x".repeat(32), WEB_STAFF_ACCOUNTS: JSON.stringify([{ id: "ADMIN1", uid: "admin", role: "admin", email: "a@example.test" }]), WEB_LOGIN_STATE: {} }, request: new Request("https://imars.test" + path), next: async () => new Response(null, { status: 218 }) });
    assert.equal(response.status, status);
  }
});
test("token authentication rejects missing, expired, wrong project, unverified, disabled and revoked users", async () => {
  for (const claims of [{ exp: NOW / 1000 }, { aud: "wrong-project" }, { iss: "wrong-issuer" }, { email_verified: false }, { auth_time: NOW / 1000 + 1 }]) {
    const f = fixture(); assert.equal((await f.call("list", { limit: 20, cursor: "" }, { token: token("student-a", claims) })).status, 401); assert.equal(f.store.queries.length, 0);
  }
  for (const changes of [{ disabled: true }, { emailVerified: false }, { validSince: String(NOW / 1000) }]) {
    const f = fixture(); Object.assign(f.identities.get("student-a"), changes); assert.equal((await f.call("list", { limit: 20, cursor: "" })).status, 401);
  }
  const f = fixture(); assert.equal((await f.call("list", { limit: 20, cursor: "" }, { headers: { Authorization: "" } })).status, 401);
  assert.equal((await f.call("list", { limit: 20, cursor: "" }, { dependencies: { fetcher: async () => Response.json({}, { status: 400 }) } })).status, 401);
});
test("strict profile linkage rejects wrong section, teacher, inactive profiles and account changes", async () => {
  for (const [path, changes] of [["users/S1", { teacherId: "TEACH2" }], ["users/S1", { role: "teacher" }], ["users/S1", { active: false }], ["users/TEACH1", { active: false }], ["classes/A", { teacherId: "TEACH2" }], ["_accountAccess/student-a", { active: false }], ["_accountAccess/teacher-a", { active: false }]]) {
    const f = fixture(); f.put(path, { ...f.data.get(path), ...changes }); assert.equal((await f.call("list", { limit: 20, cursor: "" })).status, 403); assert.equal(f.store.queries.length, 0);
  }
  const f = fixture(); f.put("users/S1", { ...f.data.get("users/S1"), teacherId: "" }); assert.equal((await f.call("list", { limit: 20, cursor: "" })).status, 200);
});
test("1000 records paginate with 20 summaries, one projected query per page and no question reads", async () => {
  const f = fixture(); f.data.delete("generatedQuizzes/quiz1");
  for (let i = 0; i < 1000; i++) { const id = "q" + String(i).padStart(4, "0"); f.put("generatedQuizzes/" + id, quiz(id, "multiple-choice", i < 900 ? {} : { sectionId: "B", teacherUid: "teacher-b", teacherProfileId: "TEACH2" })); }
  const seen = new Set(); let cursor = "", requests = 0, firstMs, first;
  const start = performance.now();
  do {
    const response = await f.call("list", { limit: 20, cursor }); assert.equal(response.status, 200); const page = await response.json();
    if (!requests) { first = page; firstMs = performance.now() - start; }
    requests++; assert.ok(page.items.length <= 20); for (const q of page.items) { assert.ok(!seen.has(q.id)); seen.add(q.id); }
    assert.doesNotMatch(JSON.stringify(page), /correctIndex|PRIVATE|"questions"|"answer"|"rubric"/); cursor = page.nextCursor;
  } while (cursor);
  assert.equal(seen.size, 900); assert.equal(requests, 45); assert.equal(f.store.queries.length, 45);
  assert.ok(f.store.queries.every(q => q.limit <= 21 && q.select.fields.every(field => SUMMARY_FIELDS.includes(field.fieldPath))));
  assert.equal(f.store.reads.some(path => path.startsWith("generatedQuizzes/")), false);
  assert.equal((await f.call("list", { limit: 20, cursor: first.nextCursor }, { uid: "student-b" })).status, 400);
  console.log(JSON.stringify({ benchmark: "student-quiz-projected-list-fixture", records: 1000, eligible: seen.size, requests, maximumReturned: 20, maximumQueryRows: 21, firstPageMs: firstMs, totalMs: performance.now() - start }));
});
test("signed page refresh preserves membership across inserts, relocks, re-release and deleted boundaries", async () => {
  const f = fixture(); f.data.delete("generatedQuizzes/quiz1"); for (let i = 0; i < 30; i++) f.put("generatedQuizzes/q" + i, quiz("q" + i));
  const page = await (await f.call("list", { limit: 20, cursor: "" })).json(); const boundary = page.items.at(-1).id;
  f.put("generatedQuizzes/new", quiz("new", "multiple-choice", { createdAt: "2026-10-29T00:00:00.000Z" }));
  const hiddenId = page.items[0].id; f.put("generatedQuizzes/" + hiddenId, { ...f.data.get("generatedQuizzes/" + hiddenId), availability: "draft" });
  let refreshed = await (await f.call("list", { limit: 20, cursor: page.pageCursor })).json(); assert.equal(refreshed.items.length, 19); assert.equal(refreshed.items.some(q => q.id === "new"), false); assert.equal(refreshed.nextCursor, page.nextCursor);
  const refreshQuery = f.store.queries.at(-1); assert.equal(refreshQuery.where.compositeFilter.filters.filter(f => f.fieldFilter.op === "IN").length, 1); assert.equal(refreshQuery.limit, 20);
  f.put("generatedQuizzes/" + hiddenId, { ...f.data.get("generatedQuizzes/" + hiddenId), availability: "now" }); refreshed = await (await f.call("list", { limit: 20, cursor: page.pageCursor })).json(); assert.equal(refreshed.items.length, 20);
  f.data.delete("generatedQuizzes/" + boundary); const next = await (await f.call("list", { limit: 20, cursor: page.nextCursor })).json(); assert.equal(next.items.length, 10); assert.equal(next.items.some(q => page.items.some(p => p.id === q.id)), false);
  assert.equal((await f.call("list", { limit: 20, cursor: page.nextCursor + "forged" })).status, 400); f.setNow(NOW + 13 * 60 * 60_000); assert.equal((await f.call("list", { limit: 20, cursor: page.pageCursor }, { token: token("student-a", { iat: NOW / 1000 + 13 * 3600, exp: NOW / 1000 + 14 * 3600 }) })).status, 400);
});
test("drafts and foreign assignments are hidden; scheduled content opens only at server release time", async () => {
  const f = fixture();
  for (const [id, extra] of [["draft", { availability: "draft" }], ["foreign", { sectionId: "B" }], ["teacher", { teacherUid: "teacher-b" }]]) {
    f.put("generatedQuizzes/" + id, quiz(id, "multiple-choice", extra)); const res = await f.call("start", { quizId: id, revision: f.versions.get("generatedQuizzes/" + id), attemptId: "a".repeat(32) }); assert.equal(res.status, 403);
  }
  const page = await (await f.call("list", { limit: 20, cursor: "" })).json(); assert.deepEqual(page.items.map(q => q.id), ["quiz1"]);
  f.put("generatedQuizzes/scheduled", quiz("scheduled", "multiple-choice", { availability: "scheduled", availableAt: new Date(NOW + 1000).toISOString() }));
  const request = { quizId: "scheduled", revision: f.versions.get("generatedQuizzes/scheduled"), attemptId: "b".repeat(32) };
  assert.equal((await f.call("start", request)).status, 403); f.setNow(NOW + 1000); assert.equal((await f.call("start", request)).status, 200); f.setNow(NOW + 1_000_000); assert.equal((await f.call("access", request)).status, 200);
});
for (const type of ["multiple-choice", "true-false", "essay", "identification-explanation", "modified-true-false"]) test(type + " preserves IDs, strips guides, validates answers and persists the right grading status", async () => {
  const f = fixture(); f.put("generatedQuizzes/quiz1", quiz("quiz1", type)); const { request, opened } = await f.begin();
  assert.equal(opened.questions[0].text, "Choose the correct response"); assert.equal(opened.questions[0].id, "q-original"); assert.doesNotMatch(JSON.stringify(opened), /PRIVATE|correctIndex|"rubric"|"answer"|"explanation"|"correction"/);
  const body = f.submission(request); const a = body.answers[0];
  if (type === "essay") Object.assign(a, { optionIndex: -1, value: "My essay" });
  if (type === "identification-explanation") Object.assign(a, { optionIndex: -1, value: "Identification", explanation: "My explanation" });
  if (type === "modified-true-false") Object.assign(a, { optionIndex: 1, correction: "My correction" });
  const bad = structuredClone(body); bad.answers[0].questionId = "unknown"; assert.equal((await f.call("submit", bad)).status, 400);
  const response = await f.call("submit", body); assert.equal(response.status, 200); const receipt = await response.json(); assert.equal(receipt.persisted, true);
  assert.equal(receipt.status, ["multiple-choice", "true-false"].includes(type) ? "graded" : "pending-review"); assert.equal(f.data.get("users/S1/generated_quiz_attempts/" + request.attemptId).answers[0].questionId, "q-original");
  assert.equal([...f.data.keys()].some(path => path.includes("test_results")), false);
  const commits = f.store.commits; assert.deepEqual(await (await f.call("submit", body)).json(), receipt); assert.equal(f.store.commits, commits);
});
test("lost response retry returns the committed receipt after relock, and changed payload conflicts", async () => {
  const f = fixture(), { request } = await f.begin(), body = f.submission(request);
  const receipt = await (await f.call("submit", body)).json(); f.put("generatedQuizzes/quiz1", { ...f.data.get("generatedQuizzes/quiz1"), availability: "draft" });
  assert.deepEqual(await (await f.call("submit", body)).json(), receipt); body.answers[0].optionIndex = 1; assert.equal((await f.call("submit", body)).status, 409);
});
test("relocking, revision changes, student/teacher reassignment and transaction races prevent new submissions", async () => {
  for (const [path, changes] of [["generatedQuizzes/quiz1", { availability: "draft" }], ["generatedQuizzes/quiz1", { title: "Edited" }], ["classes/A", { teacherId: "TEACH2" }], ["users/S1", { classCode: "B" }]]) {
    const f = fixture(), { request } = await f.begin(); f.put(path, { ...f.data.get(path), ...changes }); assert.ok([403, 409].includes((await f.call("submit", f.submission(request))).status)); assert.equal(f.data.get("users/S1/generated_quiz_attempts/" + request.attemptId).status, "started");
  }
  const f = fixture(), { request } = await f.begin(); f.store.beforeCommit = () => f.put("classes/A", { teacherId: "TEACH2" });
  assert.equal((await f.call("submit", f.submission(request))).status, 503); assert.equal(f.data.get("users/S1/generated_quiz_attempts/" + request.attemptId).status, "started");
});
test("a stolen attempt, stale start, missing reservation, client score and reused ID cannot write", async () => {
  const f = fixture(), { request } = await f.begin();
  assert.equal((await f.call("submit", f.submission(request), { uid: "student-b" })).status, 403);
  assert.equal((await f.call("start", { ...request, revision: "old" })).status, 409);
  assert.equal((await f.call("submit", { ...f.submission(request), score: 100 })).status, 400);
  assert.equal((await f.call("submit", { ...f.submission(request), attemptId: "b".repeat(32) })).status, 409);
  f.put("generatedQuizzes/quiz2", quiz("quiz2")); assert.equal((await f.call("start", { ...request, quizId: "quiz2", revision: f.versions.get("generatedQuizzes/quiz2") })).status, 409);
});
test("metadata migration is bounded, dry by default, resumable and never overwrites concurrent edits", async () => {
  const f = fixture(); for (let i = 0; i < 150; i++) { const q = quiz("q" + String(i).padStart(3, "0")); delete q.questionCount; f.put("generatedQuizzes/" + q.id, q); }
  const dry = await backfillQuizMetadata(f.store); assert.equal(dry.checked, 100); assert.equal(dry.changed, 100); assert.equal(f.store.commits, 0);
  const applied = await backfillQuizMetadata(f.store, { apply: true }); assert.equal(applied.checked, 100); assert.equal(f.store.commits, 1);
  const last = await backfillQuizMetadata(f.store, { apply: true, after: applied.nextCursor }); assert.equal(last.done, true); assert.equal(last.changed, 50);
});
test("API fails closed when disabled, limits body/page sizes, rate-limits and never redirects", async () => {
  const f = fixture(); assert.equal((await f.call("list", { limit: 21, cursor: "" })).status, 400);
  const response = await f.call("list", { limit: 20, cursor: "" }, { dependencies: { rate: async () => { throw Object.assign(new Error(), { status: 429 }); } } }); assert.equal(response.status, 429); assert.equal(response.headers.get("Retry-After"), "60");
  assert.equal((await f.call("list", {}, { method: "GET" })).status, 405); assert.equal((await f.call("list", { data: "a".repeat(1_000_001) })).status, 413);
  f.env.STUDENT_QUIZZES_ENABLED = "false"; const disabled = await f.call("list", { limit: 20, cursor: "" }); assert.equal(disabled.status, 503); assert.equal(disabled.headers.get("Location"), null);
});
