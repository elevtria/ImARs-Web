import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { activityPercent } from "../js/activity-score.js";
import { buildStudentActivityRecords } from "../js/student-activity-record.js";
import { setLoadingState } from "../js/loading.js";
import { encodeView } from "../js/view-cache.js";
import { currentScheduledTerm, schoolTodayISO, sectionSchedule, topicAvailability } from "../js/topic-availability.js";

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
  events = {};
  addEventListener(name, callback) { this.events[name] = callback; }
  setAttribute() {}
  removeAttribute() {}
  appendChild(child) { if (child.fragment) this.children.push(...child.children); else this.children.push(child); }
  replaceChildren(...children) { this.children=children; }
  insertAdjacentHTML(_, value) { this._html += value; }
  querySelectorAll(selector) { return this.children.filter(child => selector === ".student-row" && child.className === "student-row"); }
  html() { return this._html + this.children.map(child => child.html()).join(""); }
}

function page(file, report) {
  const elements = new Map();
  const element = key => { if (!elements.has(key)) elements.set(key, new Element()); return elements.get(key); };
  let authChanged, requested;
  const timing = { data: action => action(), render: action => action(), finish() {} };
  const context = vm.createContext({ console: { error() {} }, escapeHtml, activityPercent, buildStudentActivityRecords, setLoadingState,
    initializeApp: () => ({}), getAuth: () => ({ currentUser: { uid: "teacher-a" } }), getFirestore: () => ({}),
    onAuthStateChanged: (_, callback) => { authChanged = callback; }, createPagePerformance: () => timing,
    initAdminIdleTimeout() {}, webProtectionEnabled: async () => false,
    getDashboardSummary: async () => report?.preparedSummary || { enabled: false },
    showTeacherView: async options => options.render(options.page === "dashboard-summary-v1" ? await options.load() : file === "dashboard.js" ? report.topicOverview || { sectionIds: (report.sections || []).map(row => row.classDoc.id),
      terms: [{id:'term_01',lessons:(report.curriculumSnap?.docs || []).map(row=>({id:row.id,title:row.data().title,isLocked:false,sectionSchedules:{}}))}] } : report),
    currentScheduledTerm, schoolTodayISO, sectionSchedule, topicAvailability,
    setTimeout:()=>1,clearTimeout(){},
    createTeacherReport: options => ({ open: async input => { requested=input; options.render(report); } }),
    showAdminView: async options => { options.verified(); options.render(report); },
    getDocs: async () => snapshot([record("scan", { moduleName: attack })]),
    collection: (...args) => args, query: (...args) => args, orderBy: (...args) => args, limit: value => value,
    window: { location: {},addEventListener(){} },
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

function batchPage({rows=[],existing=[]}={}) {
  const elements=new Map(),calls=[],writes=[],imports=[],checkedIds=[],auth={currentUser:{uid:'teacher-a',id:'TEACH1000'}};let changed,finishCount,download;
  const element=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  const count=new Promise(resolve=>{finishCount=resolve;});
  const cache={version:()=>0,put:(...args)=>writes.push(args),invalidate(){}};
  const context=vm.createContext({console:{error(){},warn(){},log(){}},Date,Map,Set,JSON,encodeView,setLoadingState,escapeHtml,Blob,
    initializeApp:()=>({}),getAuth:()=>auth,getFirestore:()=>({}),onAuthStateChanged:(_,callback)=>{changed=callback;},
    prepareTeacherCache:()=>cache,showTeacherView:async options=>options.render(await options.load({})),
    getStudentPage:async options=>{calls.push(options);return options.includeTeacher?{teacherDoc:record('TEACH1000',{role:'teacher',sections:['Grade 6 – A','Grade 6 – B']}),classes:[record('A',{SectionName:'A'}),record('B',{SectionName:'B'})],counts:null}:options.status?{students:options.status==='active'?existing.map(row=>({classId:'A',studentDoc:record(row.id,row.data)})):[],cursor:null}:count;},
    getDocs:async()=>snapshot([]),checkStudentIds:async ids=>{checkedIds.push(...ids);return existing.map(row=>row.id);},
    doc:(_,collection,id)=>({path:collection+'/'+id}),collection:()=>({}),query:base=>base,where:()=>({}),serverTimestamp:()=>({$type:'serverTimestamp'}),
    setDoc:async(ref,data)=>imports.push({operation:'set',path:ref.path,data}),updateDoc:async(ref,data)=>imports.push({operation:'update',path:ref.path,data}),
    URL:{createObjectURL:blob=>{download=blob;return 'blob:template';},revokeObjectURL(){}},
    window:{location:{},XLSX:{read:()=>({Sheets:{sheet:rows},SheetNames:['sheet']}),utils:{sheet_to_json:sheet=>sheet}}},document:{getElementById:element,createElement:()=>Object.assign(new Element(),{click(){}})},alert:()=>assert.fail('unexpected import alert')
  });
  vm.runInContext(source('batch-upload.js'),context);
  return{element,auth,calls,writes,imports,checkedIds,download:()=>download,
    file:async(name='students.csv')=>{context.testFile={name,size:100,arrayBuffer:async()=>new ArrayBuffer(0)};await vm.runInContext('handleFileSelected(testFile)',context);},
    preview:()=>JSON.parse(vm.runInContext('JSON.stringify(previewData)',context)),
    edit:(index,field,value)=>{context.editValue=value;return vm.runInContext(`updateRowData(${index},${JSON.stringify(field)},editValue)`,context);},
    import:async()=>{await element('confirmPreviewBtn').events.click({stopPropagation(){}});await element('confirmImport').events.click();},
    load:async()=>{changed(auth.currentUser);for(let i=0;i<4;i++)await new Promise(setImmediate);},
    count:async()=>{finishCount({counts:[{classId:'A',active:1000,archived:20}]});for(let i=0;i<4;i++)await new Promise(setImmediate);}};
}

test('Batch Upload renders section choices before totals finish and requests counts only for the selected section',async()=>{
  const app=batchPage();await app.load();
  assert.equal(app.calls.length,2);assert.equal(app.calls[0].includeTeacher,true);assert.equal(app.calls[0].includeCounts,'cached');
  assert.equal(app.calls[1].sectionId,'A');assert.equal(app.calls[1].includeStudents,false);
  assert.equal(app.element('sectionSelect').children.length,2);assert.equal(app.element('sectionName').textContent,'Grade 6 – A');
  assert.equal(app.element('existingCount').textContent,'');const first=app.element('sectionSelect').children[0];
  await app.count();assert.equal(app.element('existingCount').textContent,'(1020 existing students)');
  assert.equal(app.element('sectionSelect').children[0],first,'a count update must not replace the dropdown');
  assert.equal(app.writes.length,1);
});

test('Batch Upload templates and validation preserve full middle names through the normal confirmation and import flow',async()=>{
  const app=batchPage({rows:[['First Name','Middle Name','Last Name','Student ID','Email'],['Ana','María José','Santos','123456789','ANA@example.test']]});await app.load();await app.file();
  assert.deepEqual(app.checkedIds,['0123456789']);assert.equal(app.preview()[0].fullName,'Ana María José Santos');assert.equal(app.preview()[0].isValid,true);
  assert.match(app.element('previewTableBody').html(),/data-field="middleName"/);
  app.element('dlCsv').onclick();assert.match(await app.download().text(),/^First Name,Middle Name,Last Name,Student ID,Email/);
  await app.import();assert.equal(app.imports.length,1);
  assert.equal(app.imports[0].data.middleName,'María José');assert.equal(app.imports[0].data.displayName,'Ana María José Santos');assert.equal(app.imports[0].data.classCode,'A');
});

test('middle initials block import until edited, while full compound names and no-middle-name students work',async()=>{
  const app=batchPage({rows:[['First Name','Middle Name','Last Name','Student ID','Email'],['Ana','M.','Santos','123456789','ana@example.test'],['Luis','','Reyes','123456788','luis@example.test']]});await app.load();await app.file('students.xlsx');
  assert.equal(app.preview()[0].isValid,false);assert.match(app.preview()[0].errors.join(' '),/full Middle Name/);assert.equal(app.preview()[1].isValid,true);
  app.edit(0,'middleName','De la Cruz');assert.equal(app.preview()[0].isValid,true);assert.equal(app.preview()[0].fullName,'Ana De la Cruz Santos');
  await app.import();assert.equal(app.imports.length,2);assert.equal(app.imports[1].data.middleName,'');assert.equal(app.imports[1].data.fullName,'Luis Reyes');
});

test('legacy templates keep an existing full middle name and claimed-account update behavior',async()=>{
  const app=batchPage({existing:[{id:'0123456789',data:{firstName:'Ana',middleName:'Reyes',lastName:'Santos',fullName:'Ana Reyes Santos',role:'student',classCode:'A',uid:'claimed-student',email:'original@example.test'}}],rows:[['First Name','Last Name','Student ID','Email'],['Ana','Santos','123456789','new-contact@example.test']]});await app.load();await app.file();
  assert.equal(app.preview()[0].middleName,'Reyes');assert.equal(app.preview()[0].isValid,false);
  app.edit(0,'allowUpdate',true);assert.equal(app.preview()[0].isValid,true);await app.import();
  assert.equal(app.imports[0].operation,'update');assert.equal(app.imports[0].data.fullName,'Ana Reyes Santos');assert.equal(app.imports[0].data.middleName,'Reyes');assert.equal(app.imports[0].data.email,undefined);
});

test('duplicate-name checking distinguishes full middle names but still rejects identical full names',async()=>{
  const app=batchPage({rows:[['First Name','Middle Name','Last Name','Student ID','Email'],['Ana','Reyes','Santos','123456789','ana@example.test'],['Ana','Cruz','Santos','123456788','ana2@example.test']]});await app.load();await app.file();
  assert.ok(app.preview().every(row=>row.isValid));app.edit(1,'middleName','Reyes');assert.ok(app.preview().every(row=>row.errors.includes('Duplicate Name in file')));
});

test('a late Batch Upload count cannot update another signed-in account',async()=>{
  const app=batchPage();await app.load();app.auth.currentUser={uid:'teacher-b'};await app.count();
  assert.equal(app.element('existingCount').textContent,'');assert.equal(app.writes.length,0);
});

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

test('the dashboard automatically shows released Term 3 topics independently of unchanged all-term averages',async()=>{
  const app=page('dashboard.js',{teacherName:'Teacher',total:1,sections:[{classDoc:record('A',{}),students:[{studentDoc:record('S1',{displayName:'Student'}),results:[{termId:'term_01',lessonsSnap:snapshot([record('lesson_01',{isPreTestCompleted:true,preTestScore:2,preTestTotalQuestions:5})])}]}]}],
    topicOverview:{sectionIds:['A'],terms:[{id:'term_01',lessons:[{id:'lesson_01',title:'Earlier topic',isLocked:false,sectionSchedules:{}}]},
    {id:'term_03',lessons:[{id:'lesson_01',title:'Released Term 3 topic',sectionSchedules:{A:{isLocked:false,scheduledDate:''}}},{id:'lesson_02',title:'Still locked',sectionSchedules:{A:{isLocked:true,scheduledDate:''}}}]}]}});
  await app.render();
  assert.equal(app.element('currentTermHeader').textContent,'Current Term — Term 3');
  assert.match(app.element('modulesContainer').html(),/Released Term 3 topic/);assert.match(app.element('modulesContainer').html(),/Available/);assert.match(app.element('modulesContainer').html(),/Upcoming/);
  assert.doesNotMatch(app.element('modulesContainer').html(),/Earlier topic/);
  assert.equal(app.element('avgPreTestVal').textContent,'2/5');assert.equal(app.requested().includeCurriculum,false);
});

test("dashboard orders activity before limiting rows and keeps earned zeroes",async()=>{
  const students=Array.from({length:30},(_,index)=>({studentDoc:record("S"+index,{displayName:"Learner "+index}),results:[{termId:"term_03",lessonsSnap:snapshot([record("lesson_01",{timestamp:new Date(Date.UTC(2026,9,index+1)).toISOString(),isPreTestCompleted:true,preTestScore:0,preTestTotalQuestions:5})])}]}));
  const app=page("dashboard.js",{teacherName:"Teacher",total:30,sections:[{classDoc:record("A",{SectionName:"A"}),students}],curriculumSnap:snapshot([])});await app.render();
  const rows=app.element("studentTableBody").children;assert.equal(rows.length,25);assert.match(rows[0].innerHTML,/Learner 29/);assert.doesNotMatch(app.element("studentTableBody").html(),/>Learner 0</);assert.equal(app.element("avgPreTestVal").textContent,"0/5");
});

test("the prepared dashboard renders safe summaries without starting the full student report", async () => {
  const app = page("dashboard.js", { sections: [], preparedSummary: { enabled: true, ready: true, teacherName: "Teacher", summary: {
    total: 1000, sectionNames: ["A", "B"], preSum: 0, preCount: 1, postSum: 10, postCount: 1, arMinutes: 6000,
    recent: [{ id: "S1", name: attack, section: attack, preSum: 0, preCount: 1, postSum: 10, postCount: 1, arMinutes: 6, lastActive: Date.now() }] } } });
  await app.render();
  assert.equal(app.requested(), undefined);
  assert.equal(app.element("studentCountVal").textContent, 1000);
  assert.equal(app.element("avgPreTestVal").textContent, "0/5");
  assert.equal(app.element("avgArTimeVal").textContent, "6 min");
  assertTextOnly(app.element("studentTableBody").html());
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
