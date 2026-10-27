import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createViewCache, encodeView, decodeView } from "../js/view-cache.js";
import { summarizeAssessments } from "../js/activity-score.js";
const source = readFileSync(new URL("../js/student-records.js", import.meta.url), "utf8").replace(/^import[^\n]+\r?\n/gm, "");
const doc = (id, data) => ({ id, exists: () => true, data: () => data });
const snap = docs => ({ docs, size: docs.length, empty: !docs.length, forEach: action => docs.forEach(action) });
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function storage() {
  const rows = new Map(); return { get length() { return rows.size; }, key: i => [...rows.keys()][i], getItem: k => rows.get(k) ?? null,
    setItem: (k, v) => rows.set(k, String(v)), removeItem: k => rows.delete(k) };
}
class Element {
  children = []; dataset = {}; listeners = {}; value = ""; disabled = false; attributes = {}; classes = new Set();
  classList = { add: v => this.classes.add(v), remove: v => this.classes.delete(v), contains: v => this.classes.has(v), toggle: (v,on) => on ? this.classes.add(v) : this.classes.delete(v) };
  constructor(tag = "div") { this.tag = tag; }
  set innerHTML(value) {
    this.html = value; this.children = []; this.buttons = {};
    if (this.tag === "select") this.children.push(new Element("option"));
    for (const name of ["archive-student-btn","unarchive-student-btn","remove-student-btn","load-student-results"]) if(value.includes(`class="${name}`)) {
      this.buttons["."+name] = new Element("button"); this.buttons["."+name].dataset.id = this.dataset.studentId;
    }
  }
  get innerHTML() { return this.html || ""; } get options() { return this.children; }
  setAttribute(k,v) { this.attributes[k]=v; } getAttribute(k) { return this.attributes[k] ?? null; } removeAttribute(k) { delete this.attributes[k]; }
  appendChild(child) { for(const item of child.tag === "fragment" ? child.children : [child]) { item.parent=this; this.children.push(item); } }
  replaceChildren(...children) { this.children=[]; for(const child of children) this.appendChild(child); }
  replaceWith(other) { other.parent=this.parent; this.parent.children.splice(this.parent.children.indexOf(this),1,other); }
  remove() { this.parent.children.splice(this.parent.children.indexOf(this),1); }
  querySelector(k) { return this.buttons?.[k] || null; } querySelectorAll(k) { return k === ".record" ? this.children.filter(c=>c.className === "record") : []; }
  focus() {} addEventListener(k,fn) { (this.listeners[k] ||= []).push(fn); }
  async emit(k,event={}) { for(const fn of this.listeners[k] || []) await fn({preventDefault(){},stopPropagation(){},...event}); }
}
function harness(size=3) {
  const names=["recordsContainer","emptyState","studentSearch","sectionFilter","activeStudentsTab","archivedStudentsTab","activeStudentsCount","archivedStudentsCount","archiveStudentModal","archiveStudentForm","archiveReason","confirmArchiveStudent","archiveStudentError","cancelArchiveStudent","archiveStudentName","archiveStudentTitle","archiveSectionBtn","previousRecordsPage","nextRecordsPage","recordsPageStatus","recordsTerm"];
  const ids=Object.fromEntries(names.map(id=>[id,new Element(id === "sectionFilter" ? "select" : "div")]));
  const profiles=new Map(Array.from({length:size},(_,i)=>["S"+String(i).padStart(4,"0"),{displayName:i===0?'A <Student> "One"':"Student "+i,active:size===3&&i===1?false:true,classCode:"A"}]));
  const cache=createViewCache({storage:storage(),versions:storage()}), auth={currentUser:{uid:"teacher-a"}};
  const classes=[doc("A",{SectionName:"A & B"})], lesson=doc("lesson_01",{isPreTestCompleted:true,isPostTestCompleted:true,preTestScore:1,preTestTotalQuestions:2,postTestScore:2,postTestTotalQuestions:2,arTimeMinutes:4});
  const pageReads=[],resultReads=[],writes=[],alerts=[];
  let authChanged,refresh,confirmation=true,denied=false,failBatch=0,batches=0,pageReader,resultReader;
  async function readPage(options) {
    if(auth.currentUser.uid !== "teacher-a") return {classes:[],students:[],counts:[],cursor:null};
    const all=[...profiles], search=(options.search||"").toLowerCase();
    const matches=all.filter(([id,row])=>(row.active===false)===(options.status==="archived") && (!options.cursor || id>options.cursor.id) && (!search || (id+" "+row.displayName).toLowerCase().includes(search)));
    const rows=matches.slice(0,options.limit||25);
    return {classes,students:rows.map(([id,row])=>({classId:"A",studentDoc:doc(id,{...row})})),counts:options.includeCounts===false?null:[{classId:"A",active:all.filter(([,r])=>r.active!==false).length,archived:all.filter(([,r])=>r.active===false).length}],cursor:matches.length>rows.length?{classId:"A",id:rows.at(-1)[0]}:null};
  }
  const context=vm.createContext({Date,Promise,AbortController,setTimeout,clearTimeout,encodeView,decodeView,summarizeAssessments,console:{error(){}},
    reportContext:(_,user,changes)=>{const value={termId:"term_01",sectionId:"first",...cache.get(user.uid,"report:context"),...changes};if(changes)cache.put(user.uid,"report:context",value);return value;},
    initializeApp:()=>({}),getAuth:()=>auth,getFirestore:()=>({}),onAuthStateChanged:(_,fn)=>{authChanged=fn;},
    watchVisibleData:(_,user,fn)=>{refresh=fn;return ()=>{};},prepareTeacherCache:(_,user)=>{cache.setOwner(user.uid);return cache;},
    collection:(_, ...parts)=>({path:parts.join("/")}),doc:(_,name,id)=>({path:name+"/"+id,id}),
    getStudentPage:async options=>{pageReads.push(options);return (pageReader||readPage)(options);},
    quietDocs:async ref=>{resultReads.push(ref);return resultReader?resultReader(ref):snap([lesson]);},
    updateDoc:async(ref,data)=>{if(denied)throw Error("Denied");writes.push({ref,data});Object.assign(profiles.get(ref.id),data);cache.invalidate();},
    deleteDoc:async ref=>{if(denied)throw Error("Denied");writes.push({ref,deleted:true});profiles.delete(ref.id);cache.invalidate();},
    writeBatch:()=>{const group=[];return {update(ref,data){group.push({ref,data});},async commit(){if(denied||++batches===failBatch)throw Error("Denied");for(const item of group){writes.push(item);Object.assign(profiles.get(item.ref.id),item.data);}cache.invalidate();}};},
    window:{innerHeight:800,confirm:()=>confirmation,alert:v=>alerts.push(v),location:{reload(){assert.fail("data changes must not reload the page");}}},
    document:{getElementById:id=>ids[id],createElement:tag=>new Element(tag),createDocumentFragment:()=>new Element("fragment")}
  });
  vm.runInContext(source,context);
  const click=async(selector,button)=>{await ids.recordsContainer.emit("click",{target:{closest:k=>k===selector?button:null}});await flush();};
  const performance=async id=>{await ids.recordsContainer.emit("student-record-open",{detail:{studentId:id}});await flush();};
  const archive=async id=>{await click(".archive-student-btn",ids.recordsContainer.children.find(c=>c.dataset.studentId===id).querySelector(".archive-student-btn"));ids.archiveReason.value="graduated";await ids.archiveStudentForm.emit("submit");};
  return {ids,cache,auth,profiles,pageReads,resultReads,writes,alerts,click,performance,archive,load:()=>authChanged(auth.currentUser),refresh:()=>refresh(),
    setEncoder:encode=>{context.encodeView=encode;},
    staleResults:()=>vm.runInContext('for(const section of recordData.sections) for(const student of section.students) student.resultsAt=0; cacheCurrentPage();',context),
    setPageReader:fn=>{pageReader=fn;},setResultReader:fn=>{resultReader=fn;},setConfirm:v=>{confirmation=v;},deny:()=>{denied=true;},failBatch:v=>{failBatch=v;}};
}
test("1000 students render only 25 profile cards and fetching one visible student reads only that student's selected term",async()=>{
  const app=harness(1000);await app.load();
  assert.equal(app.pageReads.length,1);assert.equal(app.ids.recordsContainer.children.length,25);assert.equal(app.resultReads.length,0);
  assert.equal(app.ids.activeStudentsCount.textContent,1000);assert.doesNotMatch(app.ids.recordsContainer.children[0].innerHTML,/0% overall|No activity recorded/);
  await app.performance("S0000");assert.equal(app.resultReads.length,1);assert.ok(app.resultReads.every(r=>r.path.startsWith("users/S0000/")));
  assert.match(app.ids.recordsContainer.children[0].innerHTML,/50%/);await app.performance("S0000");assert.equal(app.resultReads.length,1);
});
test("next, previous and a return visit reuse page caches without reading the entire roster or any results",async()=>{
  const app=harness(1000);await app.load();await app.ids.nextRecordsPage.emit("click");assert.equal(app.pageReads.length,2);
  assert.equal(app.ids.recordsContainer.children[0].dataset.studentId,"S0025");await app.ids.previousRecordsPage.emit("click");await app.load();
  assert.equal(app.pageReads.length,2);assert.equal(app.resultReads.length,0);
});
test("archiving changes only the selected card, retains safe names and adjusts exact totals without additional reads",async()=>{
  const app=harness();await app.load();await app.performance("S0000");const untouched=app.ids.recordsContainer.children[1];await app.archive("S0000");
  assert.equal(app.ids.recordsContainer.children[1],untouched);assert.equal(app.ids.recordsContainer.children[0].classList.contains("hidden"),true);
  assert.equal(app.ids.activeStudentsCount.textContent,1);assert.equal(app.ids.archivedStudentsCount.textContent,2);
  assert.equal(app.pageReads.length,1);assert.equal(app.resultReads.length,1);assert.equal(app.writes[0].data.archiveReason,"graduated");
  assert.match(app.ids.recordsContainer.children[0].innerHTML,/A &lt;Student&gt; &quot;One&quot;/);
});
test("archived profiles retain restore and delete confirmations; cancelled and denied writes preserve rows",async()=>{
  const app=harness();await app.load();await app.ids.archivedStudentsTab.emit("click");await flush();
  assert.equal(app.ids.recordsContainer.children.length,1);const button=app.ids.recordsContainer.children[0].querySelector(".unarchive-student-btn");
  app.setConfirm(false);await app.click(".unarchive-student-btn",button);assert.equal(app.writes.length,0);
  app.setConfirm(true);await app.click(".unarchive-student-btn",button);assert.equal(app.ids.activeStudentsCount.textContent,3);assert.equal(app.ids.archivedStudentsCount.textContent,0);
  const other=harness();await other.load();await other.ids.archivedStudentsTab.emit("click");await flush();
  await other.click(".remove-student-btn",other.ids.recordsContainer.children[0].querySelector(".remove-student-btn"));assert.equal(other.profiles.has("S0001"),false);
  const denied=harness();await denied.load();denied.deny();await denied.archive("S0000");assert.equal(denied.writes.length,0);assert.equal(denied.ids.activeStudentsCount.textContent,2);
  assert.match(denied.ids.archiveStudentError.textContent,/Could not archive/);
});
test("section archive covers other pages and retries only the remaining students after partial failure",async()=>{
  const app=harness(130);await app.load();app.ids.sectionFilter.value="A";await app.ids.sectionFilter.emit("change");await app.ids.archiveSectionBtn.emit("click");
  assert.match(app.ids.archiveStudentName.textContent,/130 active students/);app.ids.archiveReason.value="dropped-out";app.failBatch(2);await app.ids.archiveStudentForm.emit("submit");
  assert.equal(app.writes.length,100);assert.equal(app.ids.activeStudentsCount.textContent,30);assert.match(app.ids.archiveStudentError.textContent,/100 students archived/);
  await app.ids.archiveStudentForm.emit("submit");assert.equal(app.writes.length,130);assert.equal(new Set(app.writes.map(r=>r.ref.id)).size,130);assert.equal(app.resultReads.length,0);
});
test("a slow result cannot undo an archive and a failed performance request has a local retry",async()=>{
  const app=harness();await app.load();const pending=deferred();app.setResultReader(()=>pending.promise);await app.performance("S0000");await app.archive("S0000");pending.resolve(snap([]));await flush();
  assert.equal(app.ids.recordsContainer.children[0].dataset.archived,"true");
  const other=harness();await other.load();other.setResultReader(async()=>{throw Error("Offline");});await other.performance("S0000");assert.match(other.ids.recordsContainer.children[0].innerHTML,/Retry performance/);
  other.setResultReader(async()=>snap([]));await other.performance("S0000");assert.doesNotMatch(other.ids.recordsContainer.children[0].innerHTML,/Retry performance/);
});
test("unchanged background data keeps existing cards and late results from another account cannot paint",async()=>{
  const app=harness();await app.load();const row=app.ids.recordsContainer.children[0];await app.refresh();assert.equal(app.ids.recordsContainer.children[0],row);
  const pending=deferred();app.setPageReader(()=>pending.promise);const update=app.refresh();app.auth.currentUser={uid:"teacher-b"};app.setPageReader(null);await app.load();pending.resolve({classes:[],students:[],counts:[],cursor:null});await update;
  assert.equal(app.ids.recordsContainer.children.length,0);
});

test("returning while a previous result was pending does not restore a permanently busy card",async()=>{
  const app=harness();await app.load();const pending=deferred();
  app.setResultReader(ref=>ref.path.startsWith("users/S0000/")?pending.promise:Promise.resolve(snap([])));
  await app.performance("S0000");await app.performance("S0002");await app.load();
  assert.match(app.ids.recordsContainer.children[0].innerHTML,/Performance loads when viewed/);
  assert.doesNotMatch(app.ids.recordsContainer.children[0].innerHTML,/Loading performance…/);
  pending.resolve(snap([]));await flush();
});

test("an initial network failure does not report zero students or a successful empty result",async()=>{
  const app=harness();app.setPageReader(async()=>{throw Error("Network unavailable");});await app.load();
  assert.equal(app.ids.activeStudentsCount.textContent,"—");assert.equal(app.ids.emptyState.hidden,true);
  assert.match(app.ids.recordsPageStatus.textContent,/Could not update/);
});

test("switching student record terms reads only the selected term and ignores late previous-term results",async()=>{
  const app=harness();await app.load();const pending=deferred();app.setResultReader(ref=>ref.path.includes('/term_01/')?pending.promise:Promise.resolve(snap([])));
  await app.performance('S0000');
  app.ids.recordsTerm.value='term_02';await app.ids.recordsTerm.emit('change');await app.performance('S0000');
  assert.equal(app.pageReads.length,1,'changing term must reuse the roster instead of fetching its profiles again');
  assert.equal(app.resultReads.length,2);assert.ok(app.resultReads[1].path.includes('/term_02/'));
  pending.resolve(snap([]));await flush();
  assert.match(app.ids.recordsContainer.children[0].innerHTML,/Term 2/);
  assert.equal(app.cache.get('teacher-a','records:results:term_01:S0000'),null);
});

test('background student refresh preserves the existing section options while its menu is open',async()=>{
 const app=harness();await app.load();const option=app.ids.sectionFilter.children[1];
 await app.refresh();
 assert.equal(app.ids.sectionFilter.children[1],option,'unchanged native options must not be replaced during background work');
});

test('quiet record updates refresh only visible selected-term results and keep unchanged cards',async()=>{
 const app=harness(1000);await app.load();await app.performance('S0000');
 let card=app.ids.recordsContainer.children[0];card.getBoundingClientRect=()=>({top:0,bottom:200});
 app.staleResults();await app.refresh();await flush();
 assert.equal(app.resultReads.length,2);assert.ok(app.resultReads.every(ref=>ref.path.includes('/term_01/')));
 assert.equal(app.ids.recordsContainer.children[0],card,'an unchanged background result must not redraw its card');
 app.setResultReader(async()=>snap([doc('lesson_01',{isPreTestCompleted:true,isPostTestCompleted:true,preTestScore:5,preTestTotalQuestions:5,postTestScore:10,postTestTotalQuestions:10})]));
 app.staleResults();await app.refresh();await flush();
 assert.equal(app.resultReads.length,3);assert.match(app.ids.recordsContainer.children[0].innerHTML,/100%/);
});

test('empty Term 2 results use a genuine empty state, without an error or zero score',async()=>{
 const app=harness();app.setResultReader(async()=>snap([]));await app.load();
 app.ids.recordsTerm.value='term_02';await app.ids.recordsTerm.emit('change');await app.performance('S0000');
 const html=app.ids.recordsContainer.children[0].innerHTML;
 assert.match(html,/No Term 2 results yet/);assert.doesNotMatch(html,/Retry performance|could not load|0%/);
});

test('a failed card is not cached as a permanent failure on returning to the page',async()=>{
 const app=harness();await app.load();app.setResultReader(async()=>{throw Error('Offline');});await app.performance('S0000');
 assert.match(app.ids.recordsContainer.children[0].innerHTML,/Retry performance/);
 await app.load();assert.match(app.ids.recordsContainer.children[0].innerHTML,/Performance loads when viewed/);
 app.setResultReader(async()=>snap([]));await app.performance('S0000');
 assert.match(app.ids.recordsContainer.children[0].innerHTML,/No Term 1 results yet/);
});

test('a successful performance read stays successful if optional caching cannot encode it',async()=>{
 const app=harness();await app.load();app.setEncoder(()=>{throw TypeError('Unsupported cached value');});
 await app.performance('S0000');const html=app.ids.recordsContainer.children[0].innerHTML;
 assert.match(html,/50%/);assert.doesNotMatch(html,/could not load|Retry performance/);
});

test('a temporary result failure retries once and an access denial never retries',async()=>{
 const app=harness();await app.load();let attempts=0;
 app.setResultReader(async()=>{if(++attempts===1)throw Object.assign(Error('Unavailable'),{status:503,code:'unavailable'});return snap([]);});
 await app.performance('S0000');await new Promise(resolve=>setTimeout(resolve,400));await flush();
 assert.equal(attempts,2);assert.match(app.ids.recordsContainer.children[0].innerHTML,/No Term 1 results yet/);
 const denied=harness();await denied.load();denied.setResultReader(async()=>{throw Object.assign(Error('Denied'),{code:'permission-denied',status:403});});
 await denied.performance('S0000');assert.equal(denied.resultReads.length,1);assert.equal(denied.ids.recordsContainer.children.length,0);
});

test('changing terms during retry backoff cannot request or paint the previous term again',async()=>{
 const app=harness();await app.load();app.setResultReader(async ref=>{if(ref.path.includes('/term_01/'))throw Object.assign(Error('Unavailable'),{status:503});return snap([]);});
 await app.performance('S0000');app.ids.recordsTerm.value='term_02';await app.ids.recordsTerm.emit('change');await app.performance('S0000');
 await new Promise(resolve=>setTimeout(resolve,400));await flush();
 assert.equal(app.resultReads.length,2);assert.match(app.ids.recordsContainer.children[0].innerHTML,/No Term 2 results yet/);
});

test('a late denied result from the previous account cannot clear the new account cards',async()=>{
 const app=harness();await app.load();const pending=deferred();app.setResultReader(()=>pending.promise);await app.performance('S0000');
 app.auth.currentUser={uid:'teacher-b'};
 app.setPageReader(async()=>({classes:[doc('B',{SectionName:'B'})],students:[{classId:'B',studentDoc:doc('B1',{displayName:'Other student',classCode:'B'})}],counts:[{classId:'B',active:1,archived:0}],cursor:null}));
 await app.load();pending.reject(Object.assign(Error('Denied'),{code:'permission-denied',status:403}));await flush();
 assert.equal(app.ids.recordsContainer.children.length,1);assert.equal(app.ids.recordsContainer.children[0].dataset.studentId,'B1');
});
