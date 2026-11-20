import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createViewCache, encodeView, decodeView } from "../js/view-cache.js";
import { summarizeAdminReports } from "../server/admin-report-data.js";

const stripImports = source => source.replace(/^import[^\n]+\r?\n/gm, "").replace(/^export /gm, "");
const source = file => stripImports(readFileSync(new URL(`../js/${file}`, import.meta.url), "utf8"));

test("admin Overview keeps the school comparison and attention counts without duplicate teacher panels", () => {
  const elements = new Map();
  const element = id => { if (!elements.has(id)) elements.set(id, { textContent: "", innerHTML: "", attributes: {}, setAttribute(name,value) { this.attributes[name]=value; } }); return elements.get(id); };
  const context = vm.createContext({ initializeApp: () => ({}), getAuth: () => ({}), onAuthStateChanged() {}, formatAdminPercent: value => Number.isFinite(value) ? value + "%" : "—", formatAdminGain: value => Number.isFinite(value) ? value + " pp" : "—", document: { getElementById: element } });
  vm.runInContext(source("admin-dashboard.js"), context);
  context.report = { teachers: [{ id: "T1", active: true }], totalStudents: 2, pre: 40, post: 80, gain: 40, hours: "9 min", preCount: 2, postCount: 1, expectedTests: 48, sectionDirectory: [{ id:"A", teacherId:"T1" }, { id:"B", teacherId:"missing" }] };
  vm.runInContext("renderDashboard(report)", context);
  assert.equal(element("schoolPreBar").attributes.height, "68");
  assert.equal(element("schoolPostBar").attributes.height, "136");
  assert.equal(element("totalStudentsVal").textContent, 2);
  assert.match(element("adminAttention").innerHTML, /3\/48/);
  assert.match(element("adminAttention").innerHTML, /<dd>45<\/dd>/);
  assert.match(element("adminAttention").innerHTML, /active teacher<\/dt><dd>1<\/dd>/);
  const html = readFileSync(new URL("../admin-dashboard.html", import.meta.url), "utf8");
  assert.match(html, /Pre-\/Post-test Comparison/);
  assert.doesNotMatch(html, /teacherSnapshot|teacherScoreChart/);
});

test("admin and teacher summary cards share pointer movement, reset, and reduced-motion behavior", () => {
  const properties = new Map(), events = {};
  const card = { dataset: {}, style: { setProperty: (name, value) => properties.set(name, value), removeProperty: name => properties.delete(name) },
    addEventListener: (name, callback) => { events[name] = callback; }, getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 100 }) };
  const reduced = { matches: false, addEventListener() {} };
  const context = vm.createContext({ initializeApp: () => ({}), getAuth: () => ({}), onAuthStateChanged() {},
    document: { querySelectorAll: selector => {
      assert.ok(selector.includes(".admin-overview .stats .stat-link"));
      assert.ok(selector.includes(".teacher-dashboard .stats .stat-link"));
      return [card];
    }, getElementById: () => null, addEventListener() {} },
    window: { matchMedia: query => query.includes("reduced-motion") ? reduced : { matches: true }, addEventListener() {} } });
  vm.runInContext(source("dashboard-card-hover.js"), context);
  events.pointermove({ pointerType: "mouse", clientX: 200, clientY: 0 });
  assert.equal(card.dataset.tiltActive, "true");
  assert.equal(properties.get("--summary-rotate-x"), "4deg");
  assert.equal(properties.get("--summary-rotate-y"), "4deg");
  assert.equal(properties.get("--summary-glow-x"), "100%");
  events.pointerleave();
  assert.equal(card.dataset.tiltActive, undefined);
  assert.equal(properties.size, 0);
  reduced.matches = true;
  events.pointermove({ pointerType: "mouse", clientX: 100, clientY: 50 });
  assert.equal(properties.size, 0);
  reduced.matches = false;
  events.pointermove({ pointerType: "touch", clientX: 100, clientY: 50 });
  assert.equal(properties.size, 0);
});

test("the school summary card show before/after labels, hover explanations, and expandable calculation details", () => {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { style: {}, addEventListener() {} });
    return elements.get(id);
  };
  const context = vm.createContext({ initializeApp: () => ({}), getAuth: () => ({}), onAuthStateChanged() {},
    formatAdminPercent: value => Number.isFinite(value) ? `${value}%` : "—", formatAdminGain: value => Number.isFinite(value) ? `+${value} pp` : "—",
    document: { getElementById: element, querySelectorAll: () => [] } });
  vm.runInContext(source("school-analytics.js"), context);
  context.report = { totalStudents: 132, pre: 46, post: 75, gain: 29,
    teachers: [{ id: "T1", analyticsName: "Teacher One", sections: ["A"], students: 132, pre: 46, post: 75, gain: 29,
      preCount: 20, prePctSum: 920, postCount: 20, postPctSum: 1500, active: true }],
    sections: [{ name: "A", students: 132, pre: 46, post: 75, gain: 29, preCount: 20, postCount: 20 }] };
  vm.runInContext("renderSchoolAnalytics(report)", context);
  const html = element("overallAnalytics").innerHTML;
  assert.equal((html.match(/class="analytics-performance-details"/g) || []).length, 1);
  assert.equal((html.match(/View performance details/g) || []).length, 1);
  assert.ok(html.includes("School Performance"));
  assert.match(html, /not a paired student comparison/);
  assert.match(html, /Pre-test average/);
  assert.match(html, /Post-test average/);
  assert.match(html, /Before learning/);
  assert.match(html, /After learning/);
  assert.match(html, /20 completed lesson test results/);
  assert.match(html, /75% minus 46%/);
  assert.match(html, /Students included/);
  assert.match(html, /role="tooltip"/);
  assert.doesNotMatch(html, /avg post-test|>Pre:/);
});
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

test("admin report cache keys isolate terms and sections", async () => {
  const app = adminHarness();
  await app.display({ page: "admin:reports-v3:term_01:A", watchKey: "admin:analytics", load: async () => ({ post: 20 }) });
  await app.display({ page: "admin:reports-v3:term_02:A", watchKey: "admin:analytics", load: async () => ({ post: 80 }) });
  assert.equal(app.renders.at(-1).post, 80);
  await app.display({ page: "admin:reports-v3:term_01:A", watchKey: "admin:analytics", load: async () => assert.fail("The matching term should reuse its own cached report") });
  assert.equal(app.renders.at(-1).post, 20);
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
