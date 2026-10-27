import assert from "node:assert/strict";
import test from "node:test";
import { webData } from "../server/web-data.js";
import { requireStaff, protectWebsite, staffProfile } from "../server/web-auth.js";
import { onRequestPost as generateQuiz } from "../functions/api/generate-quiz.js";

import { fixture, accounts } from "./fixtures/web-data.js";
const stamp = { $type: "serverTimestamp" };
const union = (...values) => ({ $type: "arrayUnion", values });

const get = path => ({ action: "get", reference: { kind: "document", path } });
const query = (path, filters = []) => ({ action: "query", reference: { kind: "query", path, filters: filters.map(([field, value]) => ({ field, op: "==", value })) } });
const save = (path, data, merge = true) => ({ action: "commit", writes: [{ operation: "set", path, data, merge }] });

test("website identity uses an HttpOnly cookie; anonymous, forged, cross-site and wrong-tab requests fail before database writes", async () => {
  const app = fixture(), cookie = await app.login();
  assert.equal((await app.auth("identity", {}, cookie)).status, 200);
  for (const [credential, headers, status] of [[null, {}, 401], [cookie + "tampered", {}, 401], [cookie, { Origin: "https://evil.example" }, 403], [cookie, { "Sec-Fetch-Site": "cross-site" }, 403], [cookie, { "X-Web-User": "another-user" }, 401]]) {
    assert.equal((await app.call(save("classes/A", {}), credential, headers)).status, status);
  }
  assert.equal(app.store.began, 0); assert.equal(app.store.committed, 0);
  app.data.get("users/TEACH1000").active = false;
  assert.equal((await app.call(get("users/TEACH1000"), cookie)).status, 403);
});

test("teacher dashboard, class reports, QR history, schedules and marker progress load only within the teacher's scope", async () => {
  const app = fixture(), cookie = await app.login();
  for (const operation of [get("users/TEACH1000"), query("users", [["uid", "teacher-a"]]), query("classes", [["teacherId", "TEACH1000"]]), query("users", [["role", "student"], ["classCode", "A"]]),
    get("users/0026271000"), query("users/0026271000/test_results/term_01/lessons"), query("users/TEACH1000/recent_scans"), get("users/TEACH1000/offlineSync/markerDownloads"), query("terms/term_01/lessons"), get("webSettings/schoolYear"), query("generatedQuizzes", [["teacherUid", "teacher-a"]])]) {
    const response = await app.call(operation, cookie);
    assert.equal(response.status, 200, JSON.stringify(operation));
    assert.doesNotMatch(await response.text(), /must-never-leave-server|private-marker/);
  }
  for (const operation of [get("users/TEACH1001"), get("users/0026271001"), query("users"), query("users", [["role", "student"]]), query("users", [["role", "student"], ["classCode", "B"]]), get("classes/B"), query("users/TEACH1001/recent_scans"), query("users/0026271001/test_results/term_01/lessons"), get("_accountAccess/teacher-a"), get("users/TEACH1000/secret/token"), get("users/../ADMIN1000")]) assert.ok([400, 403].includes((await app.call(operation, cookie)).status));
  const duplicate = await app.call({ action: "check-student-ids", ids: ["0026271000", "0026271001", "new-student"] }, cookie);
  assert.deepEqual((await duplicate.json()).existing.sort(), ["0026271000", "0026271001"]);
});

test("grouped reads share authorization while an unauthorized record rejects the whole response", async () => {
  const app = fixture(), cookie = await app.login();
  const response = await app.call({ action: "reads", reads: [get("classes/A"), query("users", [["role", "student"], ["classCode", "A"]])] }, cookie);
  assert.equal(response.status, 200); assert.equal((await response.json()).results.length, 2);
  const denied = await app.call({ action: "reads", reads: [get("users/0026271000"), get("users/0026271001")] }, cookie);
  assert.equal(denied.status, 403); assert.doesNotMatch(await denied.text(), /Student A/);
});

test("forged UID matches and old quiz ownership cannot leak profiles or other teachers' quiz answers", async () => {
  const app = fixture(), cookie = await app.login();
  app.data.get("users/0026271001").uid = "teacher-a";
  app.data.set("generatedQuizzes/forged", { teacherUid: "teacher-a", teacherProfileId: "TEACH1001", sectionId: "B", questions: ["Secret answers"] });
  const profile = await app.call(query("users", [["uid", "teacher-a"]]), cookie);
  assert.deepEqual((await profile.json()).documents.map(row => row.id), ["TEACH1000"]);
  const quizzes = await app.call(query("generatedQuizzes", [["teacherUid", "teacher-a"]]), cookie);
  assert.deepEqual((await quizzes.json()).documents, []);
});

test("student imports, profile edits, QR scores, schedules, downloads and quiz saves retain their existing data shapes", async () => {
  const app = fixture(), cookie = await app.login();
  const quiz = { id: "quiz1", teacherUid: "teacher-a", teacherProfileId: "TEACH1000", sectionId: "A", section: "A", title: "Water", sourceFile: "water.pdf", type: "multiple-choice", difficulty: "Easy", questions: [{ id: "q1", text: "Water?", options: ["A", "B", "C", "D"], correctIndex: 0 }], availability: "draft", availableAt: "", demo: false };
  const operations = [
    save("classes/NEW", { teacherId: "TEACH1000", SectionName: "New", gradeLevel: "Grade 6", createdAt: stamp }),
    { action: "commit", writes: [{ operation: "update", path: "users/TEACH1000", data: { sections: union("New") } }] },
    save("users/0026279999", { schoolId: "0026279999", role: "student", displayName: "New Student", classCode: "A", teacherId: "TEACH1000", avatarId: "scientist_01", completedQuizzes: {}, gamification: { badgeCounts: { AccuracyBadgeCount: 0, OnFireBadgeCount: 0 } }, createdAt: stamp, updatedAt: stamp }),
    save("users/0026271000", { displayName: "Changed", providedEmail: "student@example.test" }),
    save("users/0026271000/test_results/term_01/lessons/lesson_01", { lessonId: "lesson_01", preTestScore: 4, preTestTotalQuestions: 5, isPreTestCompleted: true, postTestScore: 8, postTestTotalQuestions: 10, isPostTestCompleted: true, isLessonCompleted: true, timestamp: stamp }),
    save("users/TEACH1000/recent_scans/scan1", { moduleName: "Student report", scanType: "qr", timestamp: stamp }),
    save("users/TEACH1000/offlineSync/markerDownloads", { requestedFiles: union("markers.zip"), updatedAt: stamp }),
    { action: "commit", writes: [{ operation: "update", path: "terms/term_01/lessons/lesson_01", data: { sectionId: "A", isLocked: true, scheduledDate: "2027-01-01" } }] },
    save("generatedQuizzes/quiz1", quiz, false)
  ];
  for (const operation of operations) { const response = await app.call(operation, cookie); assert.equal(response.status, 200, JSON.stringify(await response.json()) + JSON.stringify(operation)); }
  assert.equal(app.data.get("users/0026271000").uid, "student-a");
  assert.deepEqual(app.data.get("users/TEACH1000/offlineSync/markerDownloads").requestedFiles, ["markers.zip"]);
  assert.equal((await app.call({ action: "commit", writes: [{ operation: "delete", path: "generatedQuizzes/quiz1" }] }, cookie)).status, 200);
});

test("quiz releases can change between assigned sections while preserving questions and rejecting another teacher's section", async () => {
  const app = fixture(), cookie = await app.login();
  app.data.set("classes/C", { teacherId: "TEACH1000", SectionName: "Section C" });
  const quiz = { id: "section-release", teacherUid: "teacher-a", teacherProfileId: "TEACH1000", sectionId: "A", section: "Section A", title: "Water", sourceFile: "water.pdf", type: "multiple-choice", difficulty: "Easy", questions: [{ id: "q1", text: "Which process turns ice into water?", options: ["Melting", "Freezing", "Evaporation", "Condensation"], correctIndex: 0 }], availability: "draft", availableAt: "", demo: false };
  assert.equal((await app.call(save("generatedQuizzes/section-release", quiz, false), cookie)).status, 200);
  const assigned = { ...app.data.get("generatedQuizzes/section-release"), sectionId: "C", section: "Section C", availability: "scheduled", availableAt: "2099-10-20T01:30:00.000Z" };
  assert.equal((await app.call(save("generatedQuizzes/section-release", assigned, false), cookie)).status, 200);
  const saved = structuredClone(app.data.get("generatedQuizzes/section-release"));
  assert.equal(saved.sectionId, "C"); assert.equal(saved.section, "Section C");
  assert.equal(saved.availableAt, assigned.availableAt); assert.deepEqual(saved.questions, quiz.questions);
  assert.equal((await app.call(save("generatedQuizzes/section-release", { ...saved, sectionId: "B", section: "Section B" }, false), cookie)).status, 403);
  const other = await app.login("TEACH1001");
  assert.equal((await app.call(save("generatedQuizzes/section-release", { ...saved, teacherUid: "teacher-b", teacherProfileId: "TEACH1001", sectionId: "B" }, false), other)).status, 403);
  assert.deepEqual(app.data.get("generatedQuizzes/section-release"), saved);
});

test("lesson dates and locks are scoped to an owned section and retain other sections, defaults and lesson content", async () => {
  const app = fixture(), cookie = await app.login();
  app.data.set("classes/C", { teacherId: "TEACH1000", SectionName: "Section C" });
  const path = "terms/term_01/lessons/lesson_01", record = app.data.get(path);
  Object.assign(record, { title: "Original lesson", preTest: ["kept"], sectionSchedules: { B: { isLocked: true, scheduledDate: "2099-11-01" } } });
  const change = data => ({ action: "commit", writes: [{ operation: "update", path, data }] });
  const first = { sectionId: "A", isLocked: true, scheduledDate: "2099-10-20" };
  assert.equal((await app.call(change(first), cookie)).status, 200);
  assert.equal((await app.call(change({ sectionId: "C", isLocked: false, scheduledDate: "" }), cookie)).status, 200);
  const saved = structuredClone(app.data.get(path));
  assert.deepEqual(saved.sectionSchedules, {
    A: { isLocked: true, scheduledDate: "2099-10-20" },
    B: { isLocked: true, scheduledDate: "2099-11-01" }, C: { isLocked: false, scheduledDate: "" }
  });
  assert.equal(saved.isLocked, false); assert.equal(saved.scheduledDate, "");
  assert.equal(saved.title, "Original lesson"); assert.deepEqual(saved.preTest, ["kept"]);
  for (const data of [
    { isLocked: false, scheduledDate: "" },
    { ...first, sectionId: "B" }, { ...first, sectionId: "missing" },
    { ...first, sectionSchedules: { B: { isLocked: false, scheduledDate: "" } } },
    { ...first, scheduledDate: "2027-02-30" }
  ]) assert.ok([400, 403].includes((await app.call(change(data), cookie)).status));
  assert.deepEqual(app.data.get(path), saved);
  app.store.conflict = true;
  assert.equal((await app.call(change(first), cookie)).status, 409);
  assert.deepEqual(app.data.get(path), saved);
});

test("forged roles, UIDs, ownership, credentials, scores and arbitrary fields cannot reach the commit", async () => {
  const app = fixture(), cookie = await app.login();
  for (const operation of [save("users/0026271000", { role: "admin" }), save("users/0026271000", { uid: "teacher-a" }), save("users/0026271000", { password: "changed" }), save("users/0026271000", { classCode: "B" }), save("users/0026271001", { classCode: "A" }), save("users/TEACH1000", { role: "admin" }), save("webSettings/schoolYear", { startYear: 2028, endYear: 2029, updatedBy: "teacher-a", updatedAt: stamp }), save("users/0026271000/test_results/term_01/lessons/lesson_01", { lessonId: "lesson_01", preTestScore: 99, preTestTotalQuestions: 5, timestamp: stamp }), save("users/0026271000", { displayName: "Replacement" }, false)]) {
    const response = await app.call(operation, cookie); assert.ok([400, 403].includes(response.status), await response.text());
  }
  assert.equal(app.store.committed, 0); assert.equal(app.store.rolledBack, app.store.began);
});

test("batched writes are all-or-nothing and actor access is checked again inside the transaction", async () => {
  const app = fixture(), cookie = await app.login();
  const response = await app.call({ action: "commit", writes: [{ operation: "update", path: "users/0026271000", data: { displayName: "Must not save" } }, { operation: "update", path: "users/0026271001", data: { displayName: "Forbidden" } }] }, cookie);
  assert.equal(response.status, 403); assert.equal(app.data.get("users/0026271000").displayName, "Student A");
  app.store.onBegin = () => { app.data.get("users/TEACH1000").active = false; };
  assert.equal((await app.call(save("users/0026271000", { displayName: "Must not save" }), cookie)).status, 403);
  assert.equal(app.store.committed, 0);
});

test("admin data access works through middleware, invitations use private reservations and deleted teacher IDs are never reused", async () => {
  const app = fixture(), admin = await app.login("ADMIN1000", "admin"), teacher = await app.login();
  const response = await protectWebsite({ env: app.env, request: new Request("https://imars.example.test/api/web-data", { headers: { Cookie: admin } }), next: async () => new Response("data") });
  assert.equal(response.status, 200);
  assert.equal((await app.call(query("users", [["role", "teacher"]]), admin)).status, 200);
  const invite = { action: "create-teacher", profile: { name: "New Teacher", email: "new@example.test", subject: "Science", sections: ["C"] } };
  assert.equal((await app.call(invite, teacher)).status, 403);
  const created = await app.call(invite, admin); assert.equal(created.status, 200);
  const { id } = await created.json(); assert.equal(id, "TEACH1002");
  assert.ok(app.data.get("users/" + id).webInvitationNonce);
  // Existing mobile registration adds a UID with UpdateAsync; it preserves the invitation marker.
  app.data.get("users/" + id).uid = "new-teacher";
  app.data.get("users/" + id).authEmailVerified = true;
  const dynamic = await app.login(id); assert.equal((await app.auth("identity", {}, dynamic)).status, 200);
  assert.equal((await app.call({ action: "commit", writes: [{ operation: "delete", path: "users/" + id }] }, admin)).status, 200);
  assert.equal((await app.auth("identity", {}, dynamic)).status, 401);
  const again = await app.call(invite, admin); assert.equal((await again.json()).id, "TEACH1003");
});

test("a forged public teacher profile cannot enroll itself in the private website roster", async () => {
  const app = fixture();
  app.data.set("users/TEACH9999", { uid: "student-a", role: "teacher", email: "student@example.test", active: true, webInvitationNonce: "made-up" });
  const response = await app.auth("login", { identifier: "TEACH9999", password: "correct", portal: "teacher" });
  assert.equal(response.status, 401); assert.equal(response.headers.get("Set-Cookie"), null);
});

test("a public invitation and an unverified Auth account cannot grant website access; verification permits a fresh login", async () => {
  const app = fixture(), admin = await app.login("ADMIN1000", "admin");
  const created = await app.call({ action: "create-teacher", profile: { name: "Invited Teacher", email: "invited@example.test", subject: "Science", sections: ["C"] } }, admin);
  assert.equal(created.status, 200);
  const { id } = await created.json(), profile = app.data.get("users/" + id);
  profile.uid = "invited-teacher";
  for (const verified of [undefined, false]) {
    profile.authEmailVerified = verified;
    const response = await app.auth("login", { identifier: id, password: "correct", portal: "teacher" });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("Set-Cookie"), null);
    assert.match((await response.json()).error, /verify your assigned email/i);
  }
  profile.authEmailVerified = true;
  const cookie = await app.login(id);
  assert.equal((await app.auth("identity", {}, cookie)).status, 200);
});

test("public school-year reads expose only the year, and disabled Auth identities fail verification", async () => {
  const app = fixture();
  const response = await webData({ env: app.env, request: new Request("https://imars.example.test/api/web-data/school-year") }, { store: app.store });
  assert.deepEqual(await response.json(), { startYear: 2027 });
  app.data.get("users/TEACH1000").authDisabled = true;
  await assert.rejects(staffProfile(accounts[0], app.store), error => error.status === 401);
});

test("oversized streamed JSON, invalid dates and duplicate batch paths are rejected without a partial save", async () => {
  const app = fixture(), cookie = await app.login();
  const request = new Request("https://imars.example.test/api/web-data", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ value: "x".repeat(1_000_001) }) });
  assert.equal((await webData({ env: app.env, request }, { store: app.store })).status, 413);
  assert.equal((await app.call(save("terms/term_01/lessons/lesson_01", { isLocked: true, scheduledDate: "2026-99-99" }), cookie)).status, 403);
  const write = { operation: "update", path: "users/0026271000", data: { displayName: "Name" } };
  assert.equal((await app.call({ action: "commit", writes: [write, write] }, cookie)).status, 400);
  assert.equal(app.store.committed, 0);
});

test("the quiz service rejects anonymous/admin/foreign-class requests before contacting AI", async t => {
  const app = fixture(), cookie = await app.login(), admin = await app.login("ADMIN1000", "admin");
  app.env.GEMINI_API_KEY = "fixture-not-a-real-key";
  const provider = t.mock.method(globalThis, "fetch", () => { throw new Error("Rejected requests must not call AI"); });
  const body = { sectionId: "B", fileName: "science.docx", fileMimeType: "text/plain", sourceText: "Water freezes.", questionCount: 1, difficulty: "Easy", questionType: "multiple-choice" };
  for (const [session, status] of [[null, 401], [admin, 403], [cookie, 403]]) assert.equal((await generateQuiz({ env: app.env, request: app.request("/api/generate-quiz", body, session) }, { store: app.store })).status, status);
  assert.equal(provider.mock.callCount(), 0);
  provider.mock.mockImplementation(async (_url, options) => {
    assert.equal(options.headers.Authorization, undefined);
    if (JSON.parse(options.body).response_format.schema.properties.checks) return Response.json({ output_text: JSON.stringify({ checks: [{ questionIndex: 0, topicRelevant: true, plausibleDistractors: true, singleCorrect: true, supportedAnswer: true }] }) });
    return Response.json({ output_text: JSON.stringify({ questions: [{ text: "What does freezing produce?", options: ["Ice", "Liquid water", "Water vapour", "Water droplets"], correctIndex: 0 }] }) });
  });
  const success = await generateQuiz({ env: app.env, request: app.request("/api/generate-quiz", { ...body, sectionId: "A" }, cookie) }, { store: app.store, authenticate: requireStaff });
  assert.equal(success.status, 200); assert.equal((await success.json()).questions.length, 1);
});

for (const [type, question] of [
  ["essay", { answer: "Cooling makes water freeze.", rubric: "Explain cooling and the change to a solid.", points: 5, options: [], correctIndex: -1 }],
  ["identification-explanation", { answer: "Ice", explanation: "Ice is frozen water.", points: 2, options: [], correctIndex: -1 }],
  ["modified-true-false", { options: ["True", "False"], correctIndex: 1, correction: "Water freezes into ice." }]
]) {
  test(`${type} saves its answer guide and preserves teacher ownership`, async () => {
    const app = fixture(), cookie = await app.login();
    const quiz = { id: "written1", teacherUid: "teacher-a", teacherProfileId: "TEACH1000", sectionId: "A", section: "A", title: "Water", sourceFile: "water.pdf", type, difficulty: "Easy", questions: [{ id: "q1", text: "Explain freezing.", ...question }], availability: "draft", availableAt: "", demo: false, schemaVersion: 2, gradingMode: "teacher-review" };
    const response = await app.call(save("generatedQuizzes/written1", quiz, false), cookie);
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
    assert.deepEqual(app.data.get("generatedQuizzes/written1").questions[0], quiz.questions[0]);
    assert.equal((await app.call(save("generatedQuizzes/foreign", { ...quiz, id: "foreign", sectionId: "B" }, false), cookie)).status, 403);
    assert.equal((await app.call(save("generatedQuizzes/written1", { ...quiz, gradingMode: "automatic" }, false), cookie)).status, 400);
    const invalid = structuredClone(quiz);
    if (type === "modified-true-false") invalid.questions[0].correction = "";
    else invalid.questions[0].points = 0;
    assert.equal((await app.call(save("generatedQuizzes/written1", invalid, false), cookie)).status, 400);
  });
}

test("teacher archives keep readable student records and validate reasons within class ownership", async () => {
  const app = fixture(), cookie = await app.login();
  const archive = reason => ({ action:"commit", writes:[{ operation:"update", path:"users/0026271000", data:{ active:false, archiveReason:reason, deletedAt:{ $type:"timestamp", value:new Date().toISOString() } } }] });
  assert.equal((await app.call(archive("invalid"), cookie)).status, 400);
  assert.equal((await app.call(archive("graduated"), cookie)).status, 200);
  const result = await app.call(get("users/0026271000"), cookie);
  assert.equal(result.status, 200);
  assert.equal(JSON.stringify(await result.json()).includes("graduated"), true);
  const other = archive("dropped-out"); other.writes[0].path = "users/0026271001";
  assert.equal((await app.call(other, cookie)).status, 403);
});

test("teachers may restore or delete only archived student profiles in their assigned classes", async () => {
 const app = fixture(), cookie = await app.login();
 const remove = path => ({action:"commit", writes:[{operation:"delete", path}]});
 assert.equal((await app.call(remove("users/0026271000"), cookie)).status, 403);
 app.data.get("users/0026271000").active = false;
 assert.equal((await app.call(save("users/0026271000", {active:true, archiveReason:null, deletedAt:null}), cookie)).status, 200);
 assert.equal(app.data.get("users/0026271000").active, true);
 assert.equal((await app.call(remove("users/0026271000"), cookie)).status, 403);
 app.data.get("users/0026271001").active = false;
 assert.equal((await app.call(remove("users/0026271001"), cookie)).status, 403);
 app.data.get("users/0026271000").active = false;
 assert.equal((await app.call(remove("users/0026271000"), cookie)).status, 200);
 assert.equal(app.data.has("users/0026271000"), false);
});
