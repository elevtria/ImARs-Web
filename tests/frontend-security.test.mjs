import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { activityPercent } from "../js/activity-score.js";
import { buildStudentActivityRecords } from "../js/student-activity-record.js";

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
  get childNodes() { return this.children; }
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
  let authChanged, requested;
  const timing = { data: action => action(), render: action => action(), finish() {} };
  const context = vm.createContext({ console: { error() {} }, escapeHtml, activityPercent, buildStudentActivityRecords,
    initializeApp: () => ({}), getAuth: () => ({ currentUser: { uid: "teacher-a" } }), getFirestore: () => ({}),
    onAuthStateChanged: (_, callback) => { authChanged = callback; }, createPagePerformance: () => timing,
    initAdminIdleTimeout() {}, webProtectionEnabled: async () => false,
    showTeacherView: async options => options.render(report),
    createTeacherReport: options => ({ open: async input => { requested=input; options.render(report); } }),
    showAdminView: async options => { options.verified(); options.render(report); },
    getDocs: async () => snapshot([record("scan", { moduleName: attack })]),
    collection: (...args) => args, query: (...args) => args, orderBy: (...args) => args, limit: value => value,
    window: { location: {} },
    document: { getElementById: element, querySelector: element, querySelectorAll: () => [], addEventListener() {},
      createElement: () => new Element(), createDocumentFragment: () => Object.assign(new Element(), { fragment: true }) }
  });
  vm.runInContext(source(file), context);
  return { element, context, requested:()=>requested, render: () => authChanged({ uid: "teacher-a" }) };
}

function assertTextOnly(html) {
  assert.ok(html.includes("&lt;img"), "untrusted text must still be displayed");
  assert.ok(html.includes("&quot;alert(1)&quot;"));
  assert.ok(!html.includes("<img src=x"), "database text must not create an image/event handler");
  assert.ok(!html.includes("<svg/onload"), "database text must not create an SVG/event handler");
}

test("dashboard names, sections, and lesson titles render as text rather than executable markup", async () => {
  const student = record("S1", { displayName: attack });
  const app = page("dashboard.js", { teacherName: "Teacher", total: 1, counts: [{ classId: "A", active: 1 }],
    sections: [{ classDoc: record("A", { SectionName: attack }), students: [{ studentDoc: student, results: [{ lessonsSnap: snapshot([record("lesson_01",{timestamp:"2026-10-27T00:00:00Z"})]) }] }] }],
    termSnap: record("term_01", { title: "Term 1" }), curriculumSnap: snapshot([record("lesson_01", { title: attack })]) });
  await app.render();
  assertTextOnly(app.element("studentTableBody").html());
  assertTextOnly(app.element("modulesContainer").html());
});

test("dashboard cards combine sections and terms while recent activity excludes unused accounts and sorts newest first",async()=>{
  const lesson=(id,pre,post,time,ar)=>record(id,{isPreTestCompleted:pre!==null,preTestScore:pre,preTestTotalQuestions:5,isPostTestCompleted:post!==null,postTestScore:post,postTestTotalQuestions:10,timestamp:time,arTimeMinutes:ar});
  const student=(id,name,results)=>({studentDoc:record(id,{displayName:name,updatedAt:"2099-01-01T00:00:00Z"}),results});
  const term=(termId,docs)=>({termId,lessonsSnap:snapshot(docs)});
  const app=page("dashboard.js",{teacherName:"Teacher",total:3,termSnap:record("term_01",{title:"Term 1"}),curriculumSnap:snapshot([]),sections:[
    {classDoc:record("A",{SectionName:"A"}),students:[student("S1","Older learner",[term("term_01",[lesson("lesson_01",1,3,"2026-10-20T00:00:00Z",10)]),term("term_03",[lesson("lesson_01",5,null,"2026-10-25T00:00:00Z",0)])]),student("S3","Never used app",[term("term_01",[])])]},
    {classDoc:record("C",{SectionName:"C"}),students:[student("S2","Newest learner",[term("term_02",[lesson("lesson_01",3,9,"2026-10-26T00:00:00Z",20)])])]}]});
  await app.render();
  assert.equal(app.requested().allTerms,true);assert.equal(app.requested().sectionId,"");
  assert.equal(app.element("studentCountVal").textContent,3);assert.equal(app.element("avgPreTestVal").textContent,"3/5");assert.equal(app.element("avgPostTestVal").textContent,"6/10");assert.equal(app.element("avgArTimeVal").textContent,"10 min");
  const html=app.element("studentTableBody").html();assert.doesNotMatch(html,/Never used app/);assert.ok(html.indexOf("Newest learner")<html.indexOf("Older learner"));assert.match(html,/Grade 6 – C/);
});

test("dashboard orders activity before limiting rows and keeps earned zeroes",async()=>{
  const students=Array.from({length:30},(_,index)=>({studentDoc:record("S"+index,{displayName:"Learner "+index}),results:[{termId:"term_03",lessonsSnap:snapshot([record("lesson_01",{timestamp:new Date(Date.UTC(2026,9,index+1)).toISOString(),isPreTestCompleted:true,preTestScore:0,preTestTotalQuestions:5})])}]}));
  const app=page("dashboard.js",{teacherName:"Teacher",total:30,sections:[{classDoc:record("A",{SectionName:"A"}),students}],curriculumSnap:snapshot([])});await app.render();
  const rows=app.element("studentTableBody").children;assert.equal(rows.length,25);assert.match(rows[0].innerHTML,/Learner 29/);assert.doesNotMatch(app.element("studentTableBody").html(),/>Learner 0</);assert.equal(app.element("avgPreTestVal").textContent,"0/5");
});

test("analytics names, sections, and topic titles cannot inject HTML into reports", async () => {
  const lesson = record("lesson_01", { isPreTestCompleted: true, preTestScore: 4, preTestTotalQuestions: 5,
    isPostTestCompleted: true, postTestScore: 9, postTestTotalQuestions: 10,
    activityScore: 3, activityTotalQuestions: 4 });
  const app = page("analytics.js", { curriculumSnap: snapshot([record("lesson_01", { title: attack })]), termId: "term_01", total: 1,
    classes: [record("A", { SectionName: attack })], counts: [{ classId: "A", active: 1 }],
    sections: [{ classDoc: record("A", { SectionName: attack }), students: [{ studentDoc: record("S1", { displayName: attack }),
      results: [{ termId: "term_01", lessonsSnap: snapshot([lesson]) }] }] }] });
  await app.render();
  assertTextOnly(app.element("#studentGrid tbody").html());
  assert.ok(app.element("#studentGrid tbody").html().includes("75%"));
  assertTextOnly(app.element("topicsContainer").html());
  assertTextOnly(app.element("studentActivityBody").html());
});

test("scan-history labels cannot execute markup saved from a scanned code", async () => {
  const app = page("sync-offline-results.js");
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

function queuedScanner() {
  const app = page("sync-offline-results.js"), pending = new Map(), remote = new Map();
  const modal = app.element("qrResultModal");
  modal.showModal = () => { modal.open = true; };
  let connected = false, reads = 0;
  const storage = {
    createObjectStore: () => ({ createIndex() {} }),
    transaction() {
      const transaction = {};
      const operation = action => {
        const request = {};
        queueMicrotask(() => { request.result = action(); request.onsuccess?.(); queueMicrotask(() => transaction.oncomplete?.()); });
        return request;
      };
      transaction.objectStore = () => ({
        index: () => ({ getAll: (owner, maximum) => operation(() => [...pending.values()].filter(entry => entry.owner === owner).slice(0, maximum)) }),
        put: entry => operation(() => { pending.set(entry.key, structuredClone(entry)); return entry.key; }),
        delete: key => operation(() => pending.delete(key))
      });
      return transaction;
    }
  };
  Object.assign(app.context, {
    crypto: globalThis.crypto, navigator: { onLine: false },
    indexedDB: { open() {
      const request = {};
      queueMicrotask(() => { request.result = storage; request.onupgradeneeded?.(); request.onsuccess?.(); });
      return request;
    } },
    collection: (_, ...parts) => ({ path: parts.join("/") }),
    doc: (parent, ...parts) => ({ path: [parent.path, ...parts].filter(Boolean).join("/") }),
    getDoc: async reference => {
      reads++;
      if (!connected) throw new TypeError("Network unavailable");
      return { exists: () => remote.has(reference.path), data: () => remote.get(reference.path) };
    },
    setDoc: async (reference, values) => {
      if (!connected) throw new TypeError("Network unavailable");
      remote.set(reference.path, { ...remote.get(reference.path), ...values });
    },
    serverTimestamp: () => ({ $type: "serverTimestamp" })
  });
  vm.runInContext('activeTeacherId = "TEACH1000"; activeTeacherClassCode = "A";', app.context);
  remote.set("users/0026271000", { role: "student", classCode: "A" });
  return { ...app, pending, remote, reads: () => reads, connect() { connected = true; app.context.navigator.onLine = true; } };
}
const gradeQr = "0026271000|Student A|term_01lesson_01_Pre:60%_Post:80%";

test("offline grade scans persist until reconnect, preserve class assignment and reuse one history record on retry", async () => {
  const app = queuedScanner();
  app.context.gradeQr = gradeQr;
  assert.equal(await vm.runInContext("processScannedQR(gradeQr)", app.context), false);
  assert.equal(app.pending.size, 1);
  assert.equal(app.reads(), 0, "offline scanning must not wait for a database request");
  assert.match(app.element("modalSyncText").textContent, /Saved on this device/);
  assert.equal(app.remote.size, 1);
  const entry = structuredClone([...app.pending.values()][0]);
  app.connect();
  await vm.runInContext("flushPendingScans()", app.context);
  assert.equal(app.pending.size, 0);
  assert.equal(app.remote.get("users/0026271000").classCode, "A");
  const result = app.remote.get("users/0026271000/test_results/term_01/lessons/lesson_01");
  assert.equal(result.preTestScore, 3); assert.equal(result.postTestScore, 8);
  app.pending.set(entry.key, entry);
  await vm.runInContext("flushPendingScans()", app.context);
  assert.equal(app.pending.size, 0);
  assert.equal([...app.remote.keys()].filter(path => path.includes("/recent_scans/")).length, 1);
});

test("another teacher or a signed-out tab cannot replay queued QR results", async () => {
  const app = queuedScanner();
  app.pending.set("foreign", { key: "foreign", owner: "teacher-b", teacherId: "TEACH1001", text: gradeQr });
  app.connect();
  await vm.runInContext("flushPendingScans()", app.context);
  assert.equal(app.pending.size, 1); assert.equal(app.remote.size, 1);
  vm.runInContext("auth.currentUser = null;", app.context);
  await vm.runInContext("flushPendingScans()", app.context);
  assert.equal(app.pending.size, 1); assert.equal(app.remote.size, 1);
});

test("blocked device storage never claims an offline QR scan was saved", async () => {
  const app = queuedScanner();
  app.context.indexedDB = undefined;
  app.context.gradeQr = gradeQr;
  assert.equal(await vm.runInContext("processScannedQR(gradeQr)", app.context), false);
  assert.equal(app.pending.size, 0);
  assert.match(app.element("modalSyncText").textContent, /Not saved/);
});
