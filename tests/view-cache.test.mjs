import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createViewCache, encodeView, decodeView } from "../js/view-cache.js";

function storage() {
  const data = new Map();
  return { get length() { return data.size; }, key: i => [...data.keys()][i], getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key) };
}
test("saved views survive navigation within the same teacher session and expire", () => {
  const tab = storage(), versions = storage(); let time = 100;
  const page = () => createViewCache({ storage: tab, versions, now: () => time });
  const first = page(); first.setOwner("teacher-a"); first.put("teacher-a", "records", { count: 30 });
  const reopened = page(); reopened.setOwner("teacher-a");
  assert.deepEqual(reopened.get("teacher-a", "records"), { count: 30 });
  time += 16 * 60 * 1000;
  assert.equal(reopened.get("teacher-a", "records"), null);
});
test("account changes and sign-out erase saved views; another teacher never receives them", () => {
  const cache = createViewCache({ storage: storage(), versions: storage() });
  cache.setOwner("teacher-a"); cache.put("teacher-a", "records", { name: "A's student" });
  assert.equal(cache.get("teacher-b", "records"), null);
  cache.setOwner("teacher-b"); assert.equal(cache.get("teacher-b", "records"), null);
  cache.setOwner("teacher-a"); assert.equal(cache.get("teacher-a", "records"), null);
  cache.put("teacher-a", "records", [1]); cache.setOwner(null); cache.setOwner("teacher-a");
  assert.equal(cache.get("teacher-a", "records"), null);
});
test("successful writes invalidate other tabs' views and prevent an old request from restoring them", () => {
  const versions = storage();
  const first = createViewCache({ storage: storage(), versions });
  const second = createViewCache({ storage: storage(), versions });
  first.setOwner("teacher-a"); second.setOwner("teacher-a");
  const started = first.version(); first.put("teacher-a", "records", [1]);
  second.invalidate();
  assert.equal(first.get("teacher-a", "records"), null);
  assert.equal(first.put("teacher-a", "records", [2], started), false);
});

test("a freshly prepared dashboard avoids a duplicate read while writes still require new data", async () => {
  const app = controller();
  await app.display({ load: async () => ({ score: 8 }) });
  await app.display({ freshForMs: 10000, load: async () => assert.fail("fresh data was just loaded after login") });
  assert.equal(app.main.dataset.viewState, "fresh");
  app.cache.invalidate();
  let reads = 0;
  await app.display({ freshForMs: 10000, load: async () => { reads++; return { score: 9 }; } });
  assert.equal(reads, 1);
  assert.equal(app.states.at(-1).score, 9);
});

test("blocked storage degrades to normal fresh reads and date/snapshot contents round-trip", () => {
  const cache = createViewCache(); cache.setOwner("a");
  assert.equal(cache.get("a", "records"), null); assert.equal(cache.put("a", "records", {}), false);
  const original = { docs: [{ id: "s1", exists: () => true, data: () => ({ timestamp: { toDate: () => new Date("2026-10-16T01:00:00Z") }, preTestScore: 7, password: "synthetic-secret", optional: undefined }) }], forEach() {} };
  const restored = decodeView(JSON.parse(JSON.stringify(encodeView(original))));
  assert.equal(restored.size, 1); assert.equal(restored.docs[0].id, "s1");
  assert.equal(restored.docs[0].data().preTestScore, 7);
  assert.equal(restored.docs[0].data().password, undefined);
  assert.equal(restored.docs[0].data().timestamp.toISOString(), "2026-10-16T01:00:00.000Z");
  assert.equal(restored.docs[0].data().optional, undefined);
});

function controller() {
  const cache = createViewCache({ storage: storage(), versions: storage() });
  const auth = { currentUser: { uid: "a" } };
  const states = [], main = { dataset: {}, prepend() {} };
  const context = vm.createContext({ console: { warn() {} }, WeakSet, JSON,
    getAuth: () => auth, onAuthStateChanged: (_, cb) => cb(auth.currentUser), teacherViewCache: () => cache,
    encodeView, decodeView,
    document: { querySelector: () => main, getElementById: () => null, createElement: () => ({ setAttribute() {} }) }
  });
  const source = readFileSync(new URL("../js/teacher-view.js", import.meta.url), "utf8").replace(/^import[^\n]+\r?\n/gm, "").replace(/^export /gm, "");
  const run = vm.runInContext(source + "\nshowTeacherView;", context);
  const display = options => run({ app: {}, user: auth.currentUser, page: "records", freshForMs: 0, render: value => states.push(value), ...options });
  return { cache, auth, states, main, display };
}
test("return visits paint saved results immediately, refresh quietly, and keep unchanged filters intact", async () => {
  const app = controller(); await app.display({ load: async ({ background }) => { assert.equal(background, false); return { score: 5 }; } });
  let resolve;
  const refresh = new Promise(yes => { resolve = yes; });
  const pending = app.display({ load: ({ background }) => { assert.equal(background, true); return refresh; } });
  assert.equal(app.main.dataset.viewState, "saved"); assert.equal(app.states.length, 2);
  resolve({ score: 6 }); await pending;
  assert.equal(app.main.dataset.viewState, "fresh"); assert.deepEqual(app.states.at(-1), { score: 6 });
  const renders = app.states.length;
  await app.display({ load: async () => ({ score: 6 }) });
  assert.equal(app.states.length, renders + 1); // one cached paint, no duplicate unchanged repaint
});
test("a background connection failure keeps saved content, but permission failures evict it", async () => {
  const app = controller(); await app.display({ load: async () => ({ score: 5 }) });
  await app.display({ load: async () => { throw new Error("offline"); } });
  assert.equal(app.main.dataset.viewState, "saved");
  await assert.rejects(app.display({ load: async () => { throw Object.assign(new Error("denied"), { code: "permission-denied" }); } }), /denied/);
  assert.equal(app.cache.get("a", "records"), null);
});
test("a late result from the old account cannot paint or cache over the new account", async () => {
  const app = controller(); let resolve;
  const pending = app.display({ load: () => new Promise(yes => { resolve = yes; }) });
  app.auth.currentUser = { uid: "b" }; app.cache.setOwner("b");
  resolve({ score: 9 }); await pending;
  assert.equal(app.states.length, 0); assert.equal(app.cache.get("b", "records"), null);
});
test("an older background read cannot overwrite a confirmed local update or erase its refreshed cache", async () => {
  const app = controller();
  await app.display({ load: async () => ({ active: true }) });
  let finish;
  const pending = app.display({ load: () => new Promise(resolve => { finish = resolve; }) });
  app.cache.invalidate();
  app.cache.put("a", "records", { active: false });
  app.states.push({ active: false });
  finish({ active: true }); await pending;
  assert.deepEqual(app.states.at(-1), { active: false });
  assert.deepEqual(app.cache.get("a", "records"), { active: false });
});

test("unsupported cache contents still render fresh data normally", async () => {
  const app = controller(); const circular = { score: 7 }; circular.self = circular;
  await app.display({ load: async () => circular });
  assert.equal(app.states[0], circular);
  assert.equal(app.main.dataset.viewState, "fresh");
  assert.equal(app.cache.get("a", "records"), null);
});

test("automatic data checks pause in hidden tabs, coalesce overlapping updates, and stop after the account changes", async () => {
  let now = 0, calls = 0, release;
  const events = new Map(), timers = new Map(); let timerId = 0;
  const auth = { currentUser: { uid: "a" } }, document = { visibilityState: "visible", addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name) };
  const context = vm.createContext({ console: { warn() {} }, WeakSet, Map, Date: { now: () => now }, getAuth: () => auth, document,
    window: { addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name) },
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id) });
  const source = readFileSync(new URL("../js/teacher-view.js", import.meta.url), "utf8").replace(/^import[^\n]+\r?\n/gm, "").replace(/^export /gm, "");
  const watch = vm.runInContext(source + "\nwatchVisibleData;", context);
  watch({}, { uid: "a" }, async () => { calls++; await new Promise(resolve => { release = resolve; }); });
  now = 60000; document.visibilityState = "hidden"; events.get("focus")(); assert.equal(calls, 0);
  document.visibilityState = "visible"; events.get("visibilitychange")(); assert.equal(calls, 1);
  now += 60000; events.get("focus")(); assert.equal(calls, 1);
  release(); await new Promise(setImmediate);
  auth.currentUser = { uid: "b" }; events.get("focus")();
  assert.equal(events.size, 0); assert.equal(timers.size, 0);
});

function pagedReportHarness() {
  let now=0, refresh, reader;
  const timers=new Map(), events=new Map(),calls=[],paints=[],errors=[];
  const auth={currentUser:{uid:'a',displayName:'Teacher A'}}, cache=createViewCache({storage:storage(),versions:storage()});
  const document={visibilityState:'visible',querySelector:()=>({replaceChildren(){}})};
  const record=(id,data)=>({id,exists:()=>true,data:()=>data});
  const snap=docs=>({docs,size:docs.length,forEach:fn=>docs.forEach(fn)});
  const makePage=options=>{
    const start=options.cursor?25:0;
    return {classes:[record('A',{SectionName:'A'})],counts:options.includeCounts===false?null:[{classId:'A',active:50,archived:0}],
      students:Array.from({length:25},(_,i)=>({classId:'A',studentDoc:record('S'+(start+i),{displayName:'Student '+(start+i)}),results:[{termId:options.termId,lessonsSnap:snap([])}]})),
      curriculum:options.includeCurriculum?{termSnap:record(options.termId,{title:options.termId}),curriculumSnap:snap([])}:null,
      cursor:start?null:{classId:'A',id:'S24'}};
  };
  const context=vm.createContext({Date:class extends Date {static now(){return now;}},Map,Promise,AbortController,encodeView,decodeView,document,
    window:{addEventListener:(name,fn)=>events.set(name,fn)},setTimeout:fn=>{const id={};timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),
    getAuth:()=>auth,prepareTeacherCache:(_,user)=>{cache.setOwner(user.uid);return cache;},watchVisibleData:(_,user,fn)=>{refresh=fn;return ()=>{};},
    getTeacherReportPage:async options=>{calls.push(options);return reader?reader(options):makePage(options);}
  });
  const source=readFileSync(new URL('../js/teacher-report-data.js',import.meta.url),'utf8').replace(/^import[^\n]+\r?\n/gm,'').replace(/^export /gm,'');
  const create=vm.runInContext(source+'\ncreateTeacherReport;',context);
  const report=create({app:{},render:value=>paints.push(value),failed:error=>errors.push(error)});
  return {auth,cache,calls,paints,errors,document,makePage,open:options=>report.open({user:auth.currentUser,...options}),stop:report.stop,
    time:value=>{now=value;},refresh:()=>refresh(),read:fn=>{reader=fn;},leave:()=>events.get('pagehide')(),
    tick:async()=>{const entry=timers.entries().next().value;if(entry){timers.delete(entry[0]);entry[1]();for(let i=0;i<5;i++)await new Promise(setImmediate);}}};
}

test('reports paint the first 25 students before further background work and reuse cached pages on return',async()=>{
  const app=pagedReportHarness();await app.open({});
  assert.equal(app.calls.length,1);assert.equal(app.paints.at(-1).loaded,25);assert.equal(app.paints.at(-1).complete,false);
  assert.equal(app.calls[0].termId,'term_01');assert.equal(app.calls[0].firstSection,true);
  await app.tick();assert.equal(app.calls.length,2);assert.equal(app.paints.at(-1).loaded,50);assert.equal(app.paints.at(-1).complete,true);
  assert.equal(app.calls[1].includeCounts,false);assert.equal(app.paints.at(-1).total,50,'later pages reuse the first page totals');
  await app.open({});assert.equal(app.calls.length,2,'a recent return must not reload the report');
  app.time(60001);await app.refresh();assert.equal(app.calls.length,3,'one automatic check updates one page only');
  assert.equal(app.calls[2].includeCurriculum,false);assert.equal(app.paints.at(-1).loaded,50);
  app.leave();await app.tick();assert.equal(app.calls.length,3,'leaving stops further background reads');
});

test('changing terms cancels old work; a late old term or account response cannot paint',async()=>{
  const app=pagedReportHarness();let release;
  app.read(options=>options.termId==='term_02'?new Promise(resolve=>{release=()=>resolve(app.makePage(options));}):app.makePage(options));
  const old=app.open({termId:'term_02'});await new Promise(setImmediate);
  await app.open({termId:'term_03'});release();await old;
  assert.ok(app.paints.every(value=>value.termId==='term_03'));
  app.document.visibilityState='hidden';await app.tick();assert.equal(app.calls.length,2,'hidden tabs do not continue the class report');
  app.document.visibilityState='visible';app.auth.currentUser={uid:'b'};await app.refresh();assert.equal(app.calls.length,2);
});

test('combined dashboard reports retain bounded background loading and a separate cache from single-term analytics',async()=>{
  const app=pagedReportHarness();await app.open({allTerms:true,sectionId:""});assert.equal(app.calls[0].allTerms,true);assert.equal(app.calls[0].firstSection,false);
  await app.tick();assert.equal(app.calls.length,2);assert.equal(app.calls[1].includeCounts,false);
  await app.open({allTerms:true,sectionId:""});assert.equal(app.calls.length,2);
  await app.open({termId:"term_01"});assert.equal(app.calls.length,3);assert.equal(app.calls[2].allTerms,undefined);assert.equal(app.calls[2].firstSection,true);
});
