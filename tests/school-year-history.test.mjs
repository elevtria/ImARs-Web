import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { archivedSchoolReport, schoolYearHistory } from "../server/school-year-history.js";
import { encodeFields } from "../server/firestore-admin.js";
import { fixture } from "./fixtures/web-data.js";

const dataset = "a176e0fd-0b7e-4840-99c5-413452160b6a";
const revision = "00000000-0000-4000-8000-000000000001";
async function harness() {
  const app = fixture(); app.env.IMARS_SUPABASE_WEB_DATA = "true";
  const calls = [];
  app.store.dataset = dataset;
  app.store.begin = async () => { app.store.revision = revision; };
  app.store.request = async (...args) => { calls.push(args); return Response.json(args[0].startsWith("rpc/") ? { id: revision, nextYear: 2028 } : []); };
  const admin = { id: "ADMIN1000", uid: "admin-a", role: "admin" };
  const call = (body, overrides = {}) => schoolYearHistory({ env: app.env, request: app.request("/api/school-years/action", body) },
    { store: app.store, authenticate: async () => admin, callState: async () => ({ ok: true }), ...overrides });
  return { ...app, calls, call, admin };
}

test("opening the history preview reads metadata and never archives or resets records", async () => {
  const app = await harness(); const before = JSON.stringify([...app.data]);
  const response = await app.call({ action: "overview" }); assert.equal(response.status, 200);
  const body = await response.json(); assert.equal(body.currentYear, 2027); assert.equal(body.revision, revision);
  assert.equal(body.counts.students, 2); assert.equal(body.storageReady, true);
  assert.equal(JSON.stringify([...app.data]), before);
  assert.ok(app.calls.every(row => row[1] === "GET" && row[2].select.indexOf("documents") < 0));
});

test("only administrators can access previews, archives or rollover", async () => {
  const app = await harness();
  for (const role of ["teacher", "student"]) for (const action of ["overview", "report", "close"]) {
    assert.equal((await app.call({ action }, { authenticate: async () => ({ ...app.admin, role }) })).status, 403);
  }
  assert.equal((await app.call({ action: "overview" }, { authenticate: async () => { throw Object.assign(Error("Sign in"), { status: 401 }); } })).status, 401);
  assert.equal(app.calls.length, 0);
});

test("rollover requires exact phrase, year, revision and administrator reauthentication", async () => {
  const app = await harness(); const body = { action: "close", startYear: 2027, revision, password: "correct", confirmation: "CLOSE 2027-2028" };
  for (const edits of [{ confirmation: "yes" }, { revision: "bad" }, { startYear: "2027" }, { password: "" }]) {
    assert.equal((await app.call({ ...body, ...edits })).status, 400);
  }
  assert.equal(app.calls.length, 0);
  assert.equal((await app.call(body, { callState: async () => ({ ok: false, status: 429 }) })).status, 429);
  assert.equal(app.calls.length, 0);
  assert.equal((await app.call(body)).status, 200);
  assert.deepEqual(app.calls[0], ["rpc/imars_close_school_year", "POST", {}, { p_dataset: dataset, p_revision: revision, p_start_year: 2027, p_admin_id: "ADMIN1000" }]);
});

test("a stale database preview returns a retry without claiming success", async () => {
  const app = await harness(); app.store.request = async () => { throw Object.assign(Error("Refresh the preview"), { status: 409 }); };
  const response = await app.call({ action: "close", startYear: 2027, revision, password: "correct", confirmation: "CLOSE 2027-2028" });
  assert.equal(response.status, 409); assert.doesNotMatch(await response.text(), /was archived/);
});

test("archive downloads use the configured dataset and reject unknown or malformed archive IDs", async () => {
  const app = await harness();
  assert.equal((await app.call({ action: "report", archiveId: "../users" })).status, 400);
  assert.equal((await app.call({ action: "report", archiveId: revision })).status, 404);
  assert.equal(app.calls[0][2].dataset_id, "eq." + dataset);
});

test("archived reports retain zero raw scores, names and learning time while excluding credentials and answer keys", () => {
  const documents = [
    ["users/S1", { uid: "student-secret-uid", role: "student", displayName: "Student One", classCode: "A", password: "DO_NOT_EXPORT" }],
    ["users/T1", { role: "teacher", fullName: "Teacher One" }], ["classes/A", { SectionName: "Hydrogen", teacherId: "T1" }],
    ["terms/term_01/lessons/lesson_01", { title: "Food Webs", postTest: [{ correctIndex: 1 }] }],
    ["users/S1/test_results/term_01/lessons/lesson_01", { isPreTestCompleted: true, preTestScore: 0, preTestTotalQuestions: 5,
      isPostTestCompleted: true, postTestScore: 8, postTestTotalQuestions: 10, arTimeMinutes: 4, lessonTimeMinutes: 7 }],
    ["generatedQuizzes/Q1", { title: "Teacher title", termId: "term_01", questions: [{ correctIndex: 2, answer: "PRIVATE_KEY" }] }],
    ["users/S1/generated_quiz_attempts/A1", { quizId: "Q1", status: "reviewed", review: { score: 7, maximum: 10 } }]
  ].map(([path, data]) => ({ path, fields: encodeFields(data) }));
  const report = archivedSchoolReport({ start_year: 2026, closed_at: "2027-05-01", documents, mobile_runs: [] });
  assert.equal(report.rows.length, 3);
  const lesson = report.rows.find(row => row[1] === "Lesson"); assert.equal(lesson[8], 0); assert.equal(lesson[10], 8); assert.equal(lesson[16], 4); assert.equal(lesson[17], 7);
  assert.equal(report.rows.find(row => row[1] === "Generated quiz")[14], 7);
  assert.doesNotMatch(JSON.stringify(report), /DO_NOT_EXPORT|PRIVATE_KEY|correctIndex|student-secret-uid/);
});

test("CSV downloads escape formula cells and preserve raw numeric zero", () => {
  const source = readFileSync(new URL("../js/school-year-history.js", import.meta.url), "utf8");
  const fn = source.slice(source.indexOf("export function reportCsv"), source.indexOf('archives.addEventListener', source.indexOf("export function reportCsv"))).replace("export ", "");
  const csv = vm.runInNewContext(fn + '\nreportCsv({columns:["Name","Score"],rows:[["=SUM(A1)",0],["Quote \\"test\\"",5]]})');
  assert.match(csv, /'=SUM\(A1\)/); assert.match(csv, /"0"/); assert.match(csv, /Quote ""test""/);
});

test("the old generic year-label write cannot bypass archival", async () => {
  const app = fixture(); const cookie = await app.login("ADMIN1000", "admin");
  const response = await app.call({ action: "commit", writes: [{ operation: "set", path: "webSettings/schoolYear", merge: true,
    data: { startYear: 2028, endYear: 2029, updatedBy: "admin-a", updatedAt: { $type: "serverTimestamp" } } }] }, cookie);
  assert.equal(response.status, 409); assert.equal(app.data.get("webSettings/schoolYear").startYear, 2027);
});
