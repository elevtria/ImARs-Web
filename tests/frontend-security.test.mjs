import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = file => readFileSync(new URL(`../js/${file}`, import.meta.url), "utf8")
  .replace(/^import\s[\s\S]*?from\s+"[^"]+";\r?\n/gm, "").replace(/^export /gm, "");
const escapeHtml = vm.runInNewContext(source("teacher-view.js") + "\nescapeHtml;");
const attack = '<img src=x onerror="alert(1)"> & \' " <svg/onload=alert(2)>';
const record = (id, data) => ({ id, exists: () => true, data: () => data });
const snapshot = docs => ({ docs, size: docs.length, empty: !docs.length, forEach: callback => docs.forEach(callback) });

class Element {
  children = []; dataset = {}; style = {}; value = ""; textContent = ""; selectedIndex = 0;
  classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
  _html = "";
  set innerHTML(value) { this._html = value; this.children = []; }
  get innerHTML() { return this._html; }
  get options() { return this.children; }
  addEventListener() {}
  setAttribute() {}
  appendChild(child) { if (child.fragment) this.children.push(...child.children); else this.children.push(child); }
  insertAdjacentHTML(_, value) { this._html += value; }
  querySelectorAll(selector) { return this.children.filter(child => selector === ".student-row" && child.className === "student-row"); }
  html() { return this._html + this.children.map(child => child.html()).join(""); }
}

function page(file, report) {
  const elements = new Map();
  const element = key => { if (!elements.has(key)) elements.set(key, new Element()); return elements.get(key); };
  let authChanged;
  const timing = { data: action => action(), render: action => action(), finish() {} };
  const context = vm.createContext({ console: { error() {} }, escapeHtml,
    initializeApp: () => ({}), getAuth: () => ({ currentUser: { uid: "teacher-a" } }), getFirestore: () => ({}),
    onAuthStateChanged: (_, callback) => { authChanged = callback; }, createPagePerformance: () => timing,
    initAdminIdleTimeout() {}, webProtectionEnabled: async () => false,
    showTeacherView: async options => options.render(report),
    showAdminView: async options => { options.verified(); options.render(report); },
    getDocs: async () => snapshot([record("scan", { moduleName: attack })]),
    collection: (...args) => args, query: (...args) => args, orderBy: (...args) => args, limit: value => value,
    window: { location: {} },
    document: { getElementById: element, querySelector: element, querySelectorAll: () => [], addEventListener() {},
      createElement: () => new Element(), createDocumentFragment: () => Object.assign(new Element(), { fragment: true }) }
  });
  vm.runInContext(source(file), context);
  return { element, context, render: () => authChanged({ uid: "teacher-a" }) };
}

function assertTextOnly(html) {
  assert.ok(html.includes("&lt;img"), "untrusted text must still be displayed");
  assert.ok(html.includes("&quot;alert(1)&quot;"));
  assert.ok(!html.includes("<img src=x"), "database text must not create an image/event handler");
  assert.ok(!html.includes("<svg/onload"), "database text must not create an SVG/event handler");
}

test("dashboard names, sections, and lesson titles render as text rather than executable markup", async () => {
  const student = record("S1", { displayName: attack });
  const app = page("dashboard.js", { teacherName: "Teacher", sectionName: attack, studentSnap: snapshot([student]),
    reports: [{ studentDoc: student, lessonsSnap: snapshot([]) }],
    termSnap: record("term_01", { title: "Term 1" }), curriculumSnap: snapshot([record("lesson_01", { title: attack })]) });
  await app.render();
  assertTextOnly(app.element("studentTableBody").html());
  assertTextOnly(app.element("modulesContainer").html());
});

test("analytics names, sections, and topic titles cannot inject HTML into reports", async () => {
  const lesson = record("lesson_01", { isPreTestCompleted: true, preTestScore: 4, preTestTotalQuestions: 5,
    isPostTestCompleted: true, postTestScore: 9, postTestTotalQuestions: 10 });
  const app = page("analytics.js", { curriculum: [snapshot([record("lesson_01", { title: attack })]), snapshot([]), snapshot([])],
    sections: [{ classDoc: record("A", { SectionName: attack }), students: [{ studentDoc: record("S1", { displayName: attack }),
      results: [{ termId: "term_01", lessonsSnap: snapshot([lesson]) }] }] }] });
  await app.render();
  assertTextOnly(app.element("#studentGrid tbody").html());
  assertTextOnly(app.element("topicsContainer").html());
});

test("scan-history labels cannot execute markup saved from a scanned code", async () => {
  const app = page("scan-qr-ar.js");
  await vm.runInContext('activeTeacherId = "T1"; loadRecentScans();', app.context);
  assertTextOnly(app.element("recentScansList").html());
});

test("teacher document IDs cannot break out of action-button attributes", async () => {
  const app = page("manage-teachers.js", { teachers: [{ id: attack, name: "Teacher", email: "teacher@example.test",
    subject: "Science", sections: ["A"], joined: "Today", active: true, students: 1, pre: 80, post: 90, hours: "0m" }] });
  await app.render();
  const html = app.element("teacherList").html();
  assertTextOnly(html);
  assert.ok(html.includes('data-delete-id="&lt;img'));
  assert.ok(html.includes('data-toggle-id="&lt;img'));
});
