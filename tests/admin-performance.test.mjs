import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createViewCache, encodeView, decodeView } from "../js/view-cache.js";

const stripImports = source => source.replace(/^import[^\n]+\r?\n/gm, "").replace(/^export /gm, "");
const source = file => stripImports(readFileSync(new URL(`../js/${file}`, import.meta.url), "utf8"));
const doc = (id, data) => ({ id, data: () => data });
const snapshot = docs => ({ docs, size: docs.length, empty: !docs.length });
const refs = {
  collection: (_, ...parts) => ({ path: parts.join("/") }),
  query: (ref, ...filters) => ({ ...ref, filters }), where: (field, op, value) => ({ field, op, value }), limit: count => ({ count })
};
const reportContext = vm.createContext({ ...refs, Map, Date, Promise });
vm.runInContext(source("admin-report-data.js"), reportContext);
const { summarizeAdminReports, loadAdminReports } = reportContext;

test("admin summaries preserve score rounding, heatmap fallback, attribution, sections, and AR time", () => {
  const teachers = [{ id: "T1", data: { fullName: "First Teacher", displayName: "Teacher One", sections: ["A", "B"], email: "one@example.test", password: "never-cache" } },
    { id: "T2", data: { name: "Second Teacher", active: false, section: "C" } }];
  const lesson = { isPreTestCompleted: true, preTestScore: 1, preTestTotalQuestions: 3,
    isPostTestCompleted: true, postTestHeatmap: [true, true, false], postTestTotalQuestions: 3, arTimeMinutes: 40 };
  const result = summarizeAdminReports(teachers, [
    { data: { teacherId: "T2", section: "C" }, lessons: [lesson] },
    { data: {}, lessons: [lesson, { ...lesson, preTestScore: 2, postTestScore: 3, arTimeMinutes: 5 }] },
    { data: { adviserId: "T1", gradeSection: "B" }, lessons: [{ ...lesson, isPreTestCompleted: false, isPostTestCompleted: false, arTimeMinutes: 0 }] }
  ]);
  assert.equal(result.totalStudents, 3); assert.equal(result.pre, 44); assert.equal(result.post, 78); assert.equal(result.gain, 34); assert.equal(result.hours, "1h");
  assert.equal(result.teachers[0].name, "First Teacher"); assert.equal(result.teachers[0].analyticsName, "Teacher One");
  assert.equal(result.teachers[0].students, 2); assert.equal(result.teachers[0].pre, 50); assert.equal(result.teachers[0].post, 83); assert.equal(result.teachers[0].hours, "45m");
  assert.equal(result.teachers[1].active, false); assert.equal(result.teachers[1].students, 1);
  assert.deepEqual(Array.from(result.sections, section => section.name), ["C", "A", "B"]);
  assert.equal(JSON.stringify(result).includes("never-cache"), false);
  const empty = summarizeAdminReports([], []);
  assert.equal(empty.pre, 0); assert.equal(empty.post, 0); assert.equal(empty.hours, "0m");
});

test("admin report reads overlap without changing student order, and failed reports are not partial successes", async () => {
  const pending = [], calls = [];
  const read = ref => { calls.push(ref); return new Promise((resolve, reject) => pending.push({ resolve, reject })); };
  const report = loadAdminReports({}, read);
  assert.equal(calls.length, 2, "teacher and student requests must start together");
  pending[0].resolve(snapshot([doc("T1", { name: "Teacher" })]));
  pending[1].resolve(snapshot([doc("S1", { section: "First" }), doc("S2", { section: "Second" })]));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 4, "both students must start before either finishes");
  pending[3].resolve(snapshot([])); pending[2].resolve(snapshot([]));
  const result = await report;
  assert.deepEqual(Array.from(result.sections, section => section.name), ["First", "Second"]);
  assert.ok(calls.slice(2).every(ref => ref.path.endsWith("/test_results/term_01/lessons")));
  await assert.rejects(loadAdminReports({}, async ref => {
    if (ref.path !== "users") throw new Error("unavailable");
    return snapshot(ref.filters[0].value === "teacher" ? [] : [doc("S1", {})]);
  }), /unavailable/);
});

function storage() {
  const data = new Map();
  return { get length() { return data.size; }, key: i => [...data.keys()][i], getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key) };
}
function adminHarness() {
  const cache = createViewCache({ storage: storage(), versions: storage() });
  const auth = { currentUser: { uid: "admin-a" } }, main = { dataset: {}, prepend() {}, replaceChildren() { this.cleared = true; } };
  let reader = async () => snapshot([doc("ADMIN1", { uid: "admin-a", role: "admin", displayName: "Admin", password: "never-cache" })]);
  let foreground = 0, signouts = 0;
  const context = vm.createContext({ ...refs, JSON, WeakSet, console: { warn() {} }, encodeView, decodeView,
    getAuth: () => auth, onAuthStateChanged: (_, cb) => cb(auth.currentUser), teacherViewCache: () => cache,
    getFirestore: () => ({}), getDocs: ref => reader(ref), getDocsWithLoading: ref => { foreground++; return reader(ref); },
    signOut: async () => { signouts++; auth.currentUser = null; }, window: { location: {} },
    document: { querySelector: selector => selector === "main" ? main : null, getElementById: () => null, createElement: () => ({ setAttribute() {} }) }
  });
  context.showCachedView = vm.runInContext(source("teacher-view.js") + "\nshowTeacherView;", context);
  const show = vm.runInContext(source("admin-view.js") + "\nshowAdminView;", context);
  const renders = [], verifications = [];
  const display = options => show({ app: {}, user: { uid: "admin-a" }, page: "reports", load: async () => ({ post: 60 }),
    render: value => renders.push(value), verified: id => verifications.push(id), ...options });
  return { cache, auth, main, context, renders, verifications, display, setReader: value => { reader = value; }, get foreground() { return foreground; }, get signouts() { return signouts; } };
}

test("admin pages reuse saved summaries quietly, but verify a live UID-linked profile before enabling edits", async () => {
  const app = adminHarness(); await app.display();
  assert.equal(app.foreground, 1);
  assert.equal(JSON.stringify(app.cache.get("admin-a", "admin:reports")).includes("never-cache"), false);
  let resolve;
  app.setReader(() => new Promise(yes => { resolve = yes; }));
  const pending = app.display({ load: async ({ background }) => { assert.equal(background, true); return { post: 70 }; } });
  assert.equal(app.main.dataset.viewState, "saved"); assert.equal(app.verifications.length, 1);
  assert.equal(app.foreground, 1, "cached visits must not reveal a loader during role verification");
  resolve(snapshot([doc("ADMIN1", { uid: "admin-a", role: "admin", displayName: "Admin" })]));
  await pending;
  assert.equal(app.verifications.length, 2); assert.equal(app.renders.at(-1).post, 70); assert.equal(app.main.dataset.viewState, "fresh");
});

test("revoked admin access clears saved views and redirects; it never falls back to another admin", async () => {
  const app = adminHarness(); await app.display();
  app.setReader(async () => snapshot([doc("TEACH1", { uid: "admin-a", role: "teacher" })]));
  await app.display({ load: async () => { assert.fail("denied users must not read admin reports"); } });
  assert.equal(app.signouts, 1); assert.equal(app.context.window.location.href, "login.html");
  assert.equal(app.cache.get("admin-a", "admin:reports"), null); assert.equal(app.main.cleared, true);
});

test("an admin write during background refresh discards older results and loads the new values", async () => {
  const app = adminHarness(); await app.display();
  let reads = 0;
  await app.display({ load: async () => {
    if (++reads === 1) { app.cache.invalidate(); return { post: 10 }; }
    return { post: 80 };
  } });
  assert.equal(reads, 2); assert.equal(app.renders.at(-1).post, 80);
  assert.equal(app.renders.some(value => value.post === 10), false);
});
