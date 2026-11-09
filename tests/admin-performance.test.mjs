import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createViewCache, encodeView, decodeView } from "../js/view-cache.js";
import { summarizeAdminReports } from "../server/admin-report-data.js";

const stripImports = source => source.replace(/^import[^\n]+\r?\n/gm, "").replace(/^export /gm, "");
const source = file => stripImports(readFileSync(new URL(`../js/${file}`, import.meta.url), "utf8"));
test("admin summaries preserve score rounding, heatmap fallback, attribution, sections, and AR time", () => {
  const teachers = [{ id: "T1", data: { fullName: "First Teacher", displayName: "Teacher One", sections: ["A", "B"], email: "one@example.test", password: "never-cache" } },
    { id: "T2", data: { name: "Second Teacher", active: false, section: "C" } }];
  const lesson = { isPreTestCompleted: true, preTestScore: 1, preTestTotalQuestions: 3,
    isPostTestCompleted: true, postTestHeatmap: [true, true, false], postTestTotalQuestions: 3, arTimeMinutes: 40 };
  const result = summarizeAdminReports(teachers, [
    { data: { teacherId: "T2", section: "C" }, lessons: [lesson] },
    { data: { classCode: "A" }, lessons: [lesson, { ...lesson, preTestScore: 2, postTestScore: 3, arTimeMinutes: 5.2 }] },
    { data: { adviserId: "T1", gradeSection: "B" }, lessons: [{ ...lesson, isPreTestCompleted: false, isPostTestCompleted: false, arTimeMinutes: 0 }] }
  ], [{ id: "A", data: { SectionName: "A", teacherId: "T1" } }]);
  assert.equal(result.totalStudents, 3); assert.equal(result.pre, 44); assert.equal(result.post, 78); assert.equal(result.gain, 34); assert.equal(result.hours, "1 h 25 min");
  assert.equal(result.teachers[0].name, "First Teacher"); assert.equal(result.teachers[0].analyticsName, "Teacher One");
  assert.equal(result.teachers[0].students, 2); assert.equal(result.teachers[0].pre, 50); assert.equal(result.teachers[0].post, 83); assert.equal(result.teachers[0].hours, "45 min");
  assert.equal(result.teachers[1].active, false); assert.equal(result.teachers[1].students, 1);
  assert.deepEqual(Array.from(result.sections, section => section.name), ["C", "A", "B"]);
  assert.equal(JSON.stringify(result).includes("never-cache"), false);
  const empty = summarizeAdminReports([], []);
  assert.equal(empty.pre, null); assert.equal(empty.post, null); assert.equal(empty.gain, null); assert.equal(empty.hours, "0 min");
  assert.equal(result.sections.find(section => section.name === "B").gain, null);
});

function storage() {
  const data = new Map();
  return { get length() { return data.size; }, key: i => [...data.keys()][i], getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key) };
}
function adminHarness() {
  let now = Date.now(), signouts = 0;
  const cache = createViewCache({ storage: storage(), versions: storage(), now: () => now });
  const auth = { currentUser: { uid: "admin-a", role: "admin" } };
  const main = { dataset: {}, prepend() {}, replaceChildren() { this.cleared = true; } };
  const context = vm.createContext({ revealContent() {}, console: { warn() {} }, encodeView, decodeView,
    getAuth: () => auth, onAuthStateChanged: (_, cb) => cb(auth.currentUser), teacherViewCache: () => cache,
    signOut: async () => { signouts++; auth.currentUser = null; }, window: { location: {} },
    document: { querySelector: selector => selector === "main" ? main : null, getElementById: () => null, createElement: () => ({ setAttribute() {} }) }
  });
  context.showTeacherView = vm.runInContext(source("teacher-view.js") + "\nshowTeacherView;", context);
  const show = vm.runInContext(source("admin-view.js") + "\nshowAdminView;", context);
  const renders = [], verifications = [];
  const display = options => show({ app: {}, user: auth.currentUser, load: async () => ({ post: 60 }),
    render: value => renders.push(value), verified: () => verifications.push(auth.currentUser.role), ...options });
  return { cache, auth, main, context, renders, verifications, display, advance: ms => { now += ms; }, get signouts() { return signouts; } };
}

test("admin tabs reuse one fresh report and keep it visible when refreshing", async () => {
  const app = adminHarness(); await app.display();
  const warmLoad = () => assert.fail("warm navigation should not reload the report");
  await app.display({ load: warmLoad });
  assert.deepEqual(app.verifications, ["admin", "admin"]);
  app.advance(5 * 60_000 + 1);
  let resolve;
  const pending = app.display({ load: ({ background }) => {
    assert.equal(background, true);
    return new Promise(yes => { resolve = yes; });
  } });
  assert.equal(app.main.dataset.viewState, "saved");
  assert.equal(app.renders.at(-1).post, 60);
  resolve({ post: 70 });
  await pending;
  assert.equal(app.renders.at(-1).post, 70);
  assert.equal(app.main.dataset.viewState, "fresh");
});

test("an identity without the admin role cannot display or fetch a saved admin report", async () => {
  const app = adminHarness(); await app.display();
  app.auth.currentUser = { uid: "admin-a", role: "teacher" };
  await app.display({ load: () => assert.fail("denied users must not read admin reports"),
    render: () => assert.fail("denied users must not see saved admin reports") });
  assert.equal(app.signouts, 1);
  assert.equal(app.context.window.location.href, "admin-login.html");
  assert.equal(app.cache.get("admin-a", "admin:reports-v2"), null);
  assert.equal(app.main.cleared, true);
});

test("an admin write during background refresh discards older results and loads the new values", async () => {
  const app = adminHarness(); await app.display();
  app.advance(5 * 60_000 + 1);
  let reads = 0;
  await app.display({ load: async () => {
    if (++reads === 1) { app.cache.invalidate(); return { post: 10 }; }
    return { post: 80 };
  } });
  assert.equal(reads, 2); assert.equal(app.renders.at(-1).post, 80);
  assert.equal(app.renders.some(value => value.post === 10), false);
});
