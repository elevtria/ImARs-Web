import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { archivedSchoolReport, schoolYearHistory } from "../server/school-year-history.js";
import { encodeFields } from "../server/firestore-admin.js";
import { fixture } from "./fixtures/web-data.js";
import { layoutSchoolYearHistory, renderScoreReport, REPORT_PAGE } from "../js/score-report-renderer.js";
import { PDFDocument } from "../js/vendor/pdf-lib.esm.min.js";

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
  const response = await app.call({ action: "commit", password: "correct", writes: [{ operation: "set", path: "webSettings/schoolYear", merge: true,
    data: { startYear: 2028, endYear: 2029, updatedBy: "admin-a", updatedAt: { $type: "serverTimestamp" } } }] }, cookie);
  assert.equal(response.status, 409); assert.equal(app.data.get("webSettings/schoolYear").startYear, 2027);
});

function printableArchive(count = 32) {
  const rows = [];
  for (let index = 0; index < count; index++) {
    const base = Array(19).fill("");
    Object.assign(base, { 0: "2025–2026", 2: `S${String(index).padStart(4, "0")}`,
      3: index === 0 ? "José María de la Cruz Peña Santos" : `Archived student ${index + 1}`,
      4: "Hydrogen", 5: "Archived Teacher", 6: "term_02" });
    rows.push(Object.assign([...base], { 1: "Roster", 18: "Active at year close" }));
    rows.push(Object.assign([...base], { 1: "Lesson", 7: "Properties of Water and Sound Waves",
      8: 0, 9: 5, 10: 8, 11: 10, 12: 9, 13: 10, 16: 0, 17: 7.5, 18: "Recorded" }));
    rows.push(Object.assign([...base], { 1: "Generated quiz", 7: "Long written assessment title",
      14: "", 15: "", 18: "pending-review" }));
    rows.push(Object.assign([...base], { 1: "AR activity", 7: "Separation Techniques", 12: 0, 13: 100, 18: "completed" }));
  }
  return { startYear: 2025, schoolName: "Pintong Gubat Elementary School", schoolAddress: "City of Dasmariñas, Cavite",
    teacherName: "School Administrator", closedLabel: "5/1/2026, 8:00:00 AM", generatedLabel: "11/20/2026, 6:00:00 PM",
    generatedAt: "2026-11-20T10:00:00Z", reportTitle: "Archived School Year Report 2025-2026", rows };
}

test("archived PDF layout contains every historical record, raw zero, pending grade and learning-time value", () => {
  const report = printableArchive();
  const font = { widthOfTextAtSize: (value, size) => value.length * size * 0.55 };
  const pages = layoutSchoolYearHistory(report, { regular: font, bold: font });
  const text = pages.flatMap(page => page.ops.filter(op => op.type === "text").map(op => op.value)).join("\n");
  for (const label of ["Archived student roster", "Lesson assessment results", "Recorded lesson and AR time",
    "Teacher-generated quiz results", "AR activity results", "0 / 5", "0 / 100", "7.5", "pending-review"])
    assert.ok(text.includes(label), label);
  for (let index = 0; index < 32; index++)
    assert.equal(text.match(new RegExp(`S${String(index).padStart(4, "0")}`, "g")).length, 5, "each student appears in all five report tables");
  assert.ok(pages.length > 5);
  for (const [index, page] of pages.entries()) {
    assert.equal(page.ops.filter(op => op.type === "logo").length, 1);
    assert.ok(page.ops.some(op => op.value === `Page ${index + 1} of ${pages.length}`));
    for (const op of page.ops) {
      assert.ok(op.x >= 0 && op.y >= 0 && op.y < REPORT_PAGE.height);
      if (op.type === "rect") assert.ok(op.x + op.w <= REPORT_PAGE.width + 0.01 && op.y + op.h < REPORT_PAGE.height);
    }
  }
});

test("an empty archived year still produces a branded report and historical exports create a readable PDF", async () => {
  const assets = Object.fromEntries(["logo", "regular", "bold"].map((key, index) => [key,
    new Uint8Array(readFileSync(new URL(["../assets/school-logo.png", "../assets/fonts/NotoSans-Regular.ttf",
      "../assets/fonts/NotoSans-Bold.ttf"][index], import.meta.url)))]));
  for (const count of [0, 2]) {
    const output = await renderScoreReport(printableArchive(count), assets, { mode: "download", layout: layoutSchoolYearHistory });
    const pdf = await PDFDocument.load(output.pdfBytes);
    assert.equal(pdf.getPageCount(), count ? 5 : 1);
    assert.equal(pdf.getTitle(), "Archived School Year Report 2025-2026");
    assert.equal(output.html, undefined);
  }
});

test("the archived-year PDF button fetches the selected saved year and cancels on account changes", async () => {
  const elements = new Map(), requests = [], outputs = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, { innerHTML: "", textContent: "", disabled: false,
      events: {}, addEventListener(name, handler) { this.events[name] = handler; } });
    return elements.get(id);
  };
  let authChanged, complete, deferred = false;
  const user = { uid: "admin-a", role: "admin", displayName: "Test Administrator" }, auth = { currentUser: user };
  const context = vm.createContext({
    console, AbortController,
    initializeApp: () => ({}), getAuth: () => auth, onAuthStateChanged: (_, callback) => { authChanged = callback; },
    document: { getElementById: element }, showAdminView: async () => {},
    escapeHtml: value => String(value), teacherViewCache: () => ({ invalidate() {} }), confirmAdminAction: async () => null,
    webRequest: async (path, body) => {
      requests.push({ path, body });
      if (deferred) await new Promise(resolve => { complete = resolve; });
      return { startYear: 2025, rows: [] };
    },
    createSchoolYearHistoryOutput: async (report, options) => {
      assert.equal(options.preparedBy, "Test Administrator");
      assert.equal(report.startYear, 2025);
      return { filename: "ImARs-SY-2025-2026-report.pdf" };
    },
    showScoreReport: async output => outputs.push(output)
  });
  const source = readFileSync(new URL("../js/school-year-history.js", import.meta.url), "utf8")
    .replace(/^import\s[\s\S]*?from\s+"[^"]+";\r?\n/gm, "").replace(/^export /gm, "");
  vm.runInContext(source, context);
  const button = { disabled: false, dataset: { yearReport: revision, format: "pdf" } };
  const click = () => element("schoolYearArchives").events.click({ target: { closest: () => button } });
  await click();
  assert.equal(requests[0].path, "/api/school-years/action");
  assert.equal(requests[0].body.action, "report");
  assert.equal(requests[0].body.archiveId, revision);
  assert.equal(outputs[0].filename, "ImARs-SY-2025-2026-report.pdf");
  assert.equal(element("schoolYearHistoryStatus").textContent, "Archived PDF report downloaded.");
  assert.equal(button.disabled, false);
  deferred = true;
  const pending = click();
  assert.equal(button.disabled, true);
  auth.currentUser = null;
  authChanged(null);
  complete();
  await pending;
  assert.equal(outputs.length, 1, "the former administrator's late response cannot download");
  auth.currentUser = { uid: "teacher-a", role: "teacher" };
  await click();
  assert.equal(requests.length, 2, "teachers cannot request this admin download");
});
