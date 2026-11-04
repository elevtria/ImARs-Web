import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { createReadPool } from "../js/data-read-pool.js";
import { wrapFirestoreReads } from "../js/firebase-loading.js";
import { createViewCache } from "../js/view-cache.js";
import { fixture as dataFixture } from "./fixtures/web-data.js";

const source = readFileSync(new URL("../js/firebase-data.js", import.meta.url), "utf8").replace(/^import[^\n]+\n/gm, "").replace(/^export /gm, "");
const flush = async () => { for (let index = 0; index < 3; index++) await new Promise(resolve => setImmediate(resolve)); };
function fixture(transport, { now = Date.now } = {}) {
  const calls = [], timers = new Map(), delays = new Map(), events = new Map();
  const memory = new Map();
  const storage = { get length() { return memory.size; }, key: i => [...memory.keys()][i], getItem: key => memory.get(key) || null, setItem: (key, value) => memory.set(key, value), removeItem: key => memory.delete(key) };
  const cache = createViewCache({ storage, versions: storage, now });
  let uid = "teacher-a";
  cache.setOwner(uid);
  let invalidated = 0, nextTimer = 0;
  const context = vm.createContext({ Date: now === Date.now ? Date : class extends Date { static now() { return now(); } }, crypto, performance, queueMicrotask, createReadPool, wrapFirestoreReads, AbortSignal,
    startLoading: () => () => {}, withLoading: operation => operation(), invalidateTeacherViews: () => { invalidated++; cache.invalidate(); }, teacherViewCache: () => cache, visitUser: () => uid,
    setTimeout(callback, delay) { timers.set(++nextTimer, callback); delays.set(nextTimer, delay); return nextTimer; }, clearTimeout(id) { timers.delete(id); delays.delete(id); },
    window: { location: { pathname: "/index" }, addEventListener(name, callback) { events.set(name, callback); }, removeEventListener(name) { events.delete(name); } },
    document: { visibilityState: "visible", addEventListener(name, callback) { events.set(name, callback); }, removeEventListener(name) { events.delete(name); } },
    webRequest: async (path, body) => { calls.push({ path, body }); return transport(body); },
    fetch: async (path, options) => {
      calls.push({ path, options });
      const result = await transport({ action: "reads", reads: [{ action: "get", reference: { path: "webSettings/schoolYear" } }] });
      return { ok: true, json: async () => result.results[0].document.data };
    }
  });
  const api = vm.runInContext(source + "\n({doc,collection,query,where,orderBy,limit,getDoc,getDocs,setDoc,writeBatch,onSnapshot,serverTimestamp,arrayUnion,getStudentPage,getTeacherReportPage});", context);
  return { api, calls, timers, delays, context, events, cache, setUser: value => { uid = value; cache.setOwner(uid); }, invalidated: () => invalidated };
}
const document = (path, data) => ({ id: path.split("/").at(-1), path, data });

test("batch-upload receives its own verified teacher and assigned sections in one count-free metadata request",async()=>{
  const backend=dataFixture(),cookie=await backend.login();
  backend.data.get('users/TEACH1000').sections=['Grade 6 – A'];
  backend.store.count=()=>assert.fail('metadata must not request totals');
  const app=fixture(async body=>{const response=await backend.call(body,cookie);assert.equal(response.status,200);return response.json();});
  const page=await app.api.getStudentPage({includeStudents:false,includeCounts:'cached',includeTeacher:true});
  assert.equal(app.calls.length,1);assert.equal(page.teacherDoc.id,'TEACH1000');
  assert.deepEqual(Array.from(page.teacherDoc.data().sections),['Grade 6 – A']);
  assert.deepEqual(page.classes.map(row=>row.id),['A']);assert.equal(page.counts,null);
});

test("concurrent report reads use one authenticated group and preserve document, query, missing-record and timestamp behavior", async () => {
  const app = fixture(body => ({ results: body.reads.map(item => item.action === "get"
    ? { document: document(item.reference.path, item.reference.path.endsWith("missing") ? null : { timestamp: { $type: "timestamp", value: "2026-10-21T00:00:00Z" } }) }
    : { documents: [document(item.reference.path + "/one", { score: 4 })] }) }));
  const { api } = app;
  const [record, missing, rows] = await Promise.all([api.getDoc(api.doc({}, "users", "one")), api.getDoc(api.doc({}, "users", "missing")), api.getDocs(api.query(api.collection({}, "users", "student", "test_results", "term_01", "lessons"), api.orderBy("timestamp", "desc"), api.limit(5)))]);
  assert.equal(app.calls.length, 1); assert.equal(app.calls[0].body.action, "reads");
  assert.equal(record.exists(), true); assert.equal(record.data().timestamp.toDate().toISOString(), "2026-10-21T00:00:00.000Z");
  assert.equal(missing.exists(), false); assert.equal(rows.size, 1); assert.equal(rows.docs[0].data().score, 4);
  assert.equal(rows.docs[0].ref.path, "users/student/test_results/term_01/lessons/one");
  assert.equal(app.calls[0].body.reads[2].reference.limit, 5);
});

test("saves encode archive dates and field transforms while rejected batches keep cached views", async () => {
  let denied = true;
  const app = fixture(() => { if (denied) throw new Error("Denied"); return { ok: true }; });
  const { api } = app, student = api.doc({}, "users", "student");
  await assert.rejects(api.writeBatch().update(student, { active: false }).commit(), /Denied/);
  assert.equal(app.invalidated(), 0);
  denied = false;
  await api.setDoc(student, { deletedAt: new Date("2026-10-21T00:00:00Z"), updatedAt: api.serverTimestamp(), sections: api.arrayUnion("A") }, { merge: true });
  const write = app.calls[1].body.writes[0];
  assert.equal(write.data.deletedAt.$type, "timestamp"); assert.equal(write.data.updatedAt.$type, "serverTimestamp"); assert.equal(write.data.sections.values[0], "A");
  assert.equal(write.merge, true); assert.equal(app.invalidated(), 1);
});

test("subscriptions share their first read, refresh after a save and stop all polling when unsubscribed", async () => {
  let year = 2026;
  const app = fixture(body => body.action === "commit" ? (year = 2027, { ok: true }) : ({ results: body.reads.map(item => ({ document: document(item.reference.path, { startYear: year }) })) }));
  const ref = app.api.doc({}, "webSettings", "schoolYear"), values = [];
  const stopA = app.api.onSnapshot(ref, snapshot => values.push(snapshot.data().startYear));
  const stopB = app.api.onSnapshot(ref, { includeMetadataChanges: true }, snapshot => values.push(snapshot.data().startYear));
  await flush(); assert.deepEqual(values, [2026, 2026]); assert.equal(app.calls.length, 1);
  await app.api.setDoc(ref, { startYear: 2027 }); await flush();
  assert.deepEqual(values, [2026, 2026, 2027, 2027]);
  stopA(); stopB(); assert.equal(app.timers.size, 0); assert.equal(app.events.size, 0);
});

test("a pre-save response cannot repaint an older snapshot after the write succeeds", async () => {
  let finish, reads = 0;
  const app = fixture(body => {
    if (body.action === "commit") return { ok: true };
    if (++reads === 1) return new Promise(resolve => { finish = resolve; });
    return { results: [{ document: document("webSettings/schoolYear", { startYear: 2027 }) }] };
  });
  const ref = app.api.doc({}, "webSettings", "schoolYear"), values = [];
  const stop = app.api.onSnapshot(ref, snapshot => values.push(snapshot.data().startYear));
  await flush(); await app.api.setDoc(ref, { startYear: 2027 });
  finish({ results: [{ document: document(ref.path, { startYear: 2026 }) }] }); await flush();
  assert.deepEqual(values, []);
  for (const callback of [...app.timers.values()]) callback();
  await flush(); assert.deepEqual(values, [2027]); stop();
});

test("cached school-year subscriptions wait for expiry; repeated focus events do not trigger extra reads", async () => {
  let now = 1000000;
  const app = fixture(body => ({ results: body.reads.map(item => ({ document: document(item.reference.path, { startYear: 2027 }) })) }), { now: () => now });
  const values = [];
  const stop = app.api.onSnapshot(app.api.doc({}, "webSettings", "schoolYear"), { refreshIntervalMs: 300000, initialDelayMs: 240000 }, snapshot => values.push(snapshot.data().startYear));
  for (let i = 0; i < 100; i++) app.events.get("focus")();
  await flush();
  assert.equal(app.calls.length, 0);
  assert.deepEqual([...app.delays.values()], [240000]);
  now += 240000;
  app.events.get("focus")(); await flush();
  assert.deepEqual(values, [2027]);
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].path, "/api/web-data/school-year");
  for (let i = 0; i < 100; i++) app.events.get("focus")();
  await flush(); assert.equal(app.calls.length, 1);
  assert.deepEqual([...app.delays.values()], [300000]);
  stop(); assert.equal(app.timers.size, 0);
});

test("a save bypasses the school-year cache delay and reads the acknowledged setting immediately", async () => {
  let year = 2027;
  const app = fixture(body => body.action === "commit" ? (year = 2028, { ok: true }) : ({ results: [{ document: document("webSettings/schoolYear", { startYear: year }) }] }));
  const ref = app.api.doc({}, "webSettings", "schoolYear"), values = [];
  const stop = app.api.onSnapshot(ref, { refreshIntervalMs: 300000, initialDelayMs: 240000 }, snapshot => values.push(snapshot.data().startYear));
  await app.api.setDoc(ref, { startYear: 2028 }); await flush();
  assert.deepEqual(values, [2028]); assert.equal(app.calls.length, 2);
  stop();
});

test("hidden subscriptions keep a timer and resume only when their data is due", async () => {
  let now = 1000000;
  const app = fixture(body => ({ results: body.reads.map(item => ({ document: document(item.reference.path, {}) })) }), { now: () => now });
  const stop = app.api.onSnapshot(app.api.doc({}, "terms", "term_01"), { refreshIntervalMs: 60000 }, () => {});
  await flush();
  app.context.document.visibilityState = "hidden";
  now += 60000;
  [...app.timers.values()][0](); await flush();
  assert.equal(app.calls.length, 1); assert.equal(app.timers.size, 1);
  app.context.document.visibilityState = "visible";
  app.events.get("visibilitychange")(); await flush();
  assert.equal(app.calls.length, 2);
  stop();
});

test('empty Term 2 collections survive the real data handler and batched client transport',async()=>{
 const backend=dataFixture(),cookie=await backend.login();
 for(let i=0;i<15;i++)backend.data.set('users/EMPTY'+i,{role:'student',classCode:'A',teacherId:'TEACH1000'});
 const app=fixture(async body=>{const response=await backend.call(body,cookie);assert.equal(response.status,200);return response.json();});
 const rows=await Promise.all(Array.from({length:15},(_,i)=>app.api.getDocs(app.api.collection({},'users','EMPTY'+i,'test_results','term_02','lessons'))));
 assert.ok(rows.every(row=>row.empty&&row.size===0&&row.docs.length===0));
 assert.ok(app.calls.every(call=>call.body.reads.every(item=>item.reference.path.includes('/term_02/'))));
});

test("combined dashboard transport decodes all three terms without changing single-term reports", async () => {
  const backend = dataFixture(), cookie = await backend.login();
  for (let index = 1; index <= 3; index++) {
    backend.data.set(`users/0026271000/test_results/term_0${index}/lessons/lesson_01`, {
      preTestScore: index, preTestTotalQuestions: 5, isPreTestCompleted: true,
      timestamp: { $type: "timestamp", value: `2026-10-2${index}T00:00:00Z` }
    });
  }
  const app = fixture(async body => {
    const response = await backend.call(body, cookie);
    assert.equal(response.status, 200);
    return response.json();
  });
  const combined = await app.api.getTeacherReportPage({ termId: "term_01", allTerms: true });
  const results = combined.students[0].results;
  assert.deepEqual(Array.from(results, result => result.termId), ["term_01", "term_02", "term_03"]);
  assert.deepEqual(Array.from(results, result => result.lessonsSnap.docs[0].data().preTestScore), [1, 2, 3]);
  assert.equal(results[2].lessonsSnap.docs[0].data().timestamp.toDate().toISOString(), "2026-10-23T00:00:00.000Z");
  const single = await app.api.getTeacherReportPage({ termId: "term_02" });
  assert.equal(single.students[0].results.length, 1);
  assert.equal(single.students[0].results[0].termId, "term_02");
  assert.equal(single.students[0].results[0].lessonsSnap.docs[0].data().preTestScore, 2);
});

test("section totals are shared across records, reports and navigation for one minute, then expire", async () => {
  let now = 1000000, counts = 0;
  const backend = dataFixture(), cookie = await backend.login(), count = backend.store.count.bind(backend.store);
  backend.store.count = (...args) => { counts++; return count(...args); };
  const app = fixture(async body => (await backend.call(body, cookie)).json(), { now: () => now });
  const first = await app.api.getStudentPage();
  assert.equal(counts, 2);
  const report = await app.api.getTeacherReportPage({ termId: "term_01", sectionId: "A", includeCurriculum: false });
  assert.equal(counts, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(report.counts)), JSON.parse(JSON.stringify(first.counts)));
  assert.equal(app.calls.at(-1).body.includeCounts, false);
  now += 60001;
  await app.api.getStudentPage();
  assert.equal(counts, 4);
});

test("acknowledged writes invalidate cached counts; account changes cannot reuse another teacher's totals", async () => {
  const backend = dataFixture(), cookie = await backend.login();
  const app = fixture(async body => { const response = await backend.call(body, cookie); assert.equal(response.status, 200); return response.json(); });
  await app.api.getStudentPage();
  await app.api.setDoc(app.api.doc({}, "users", "0026271000"), { active: false }, { merge: true });
  const archived = await app.api.getStudentPage();
  assert.equal(app.calls.at(-1).body.includeCounts, undefined);
  assert.equal(archived.counts[0].active, 0); assert.equal(archived.counts[0].archived, 1);
  app.setUser("teacher-b");
  assert.equal(app.cache.get("teacher-b", "student-counts:all"), null);
});

test("changed class membership rejects cached totals and refreshes them without caching the old class list", async () => {
  const backend = dataFixture(), cookie = await backend.login();
  const app = fixture(async body => { const response = await backend.call(body, cookie); assert.equal(response.status, 200); return response.json(); });
  await app.api.getStudentPage();
  backend.data.set("classes/C", { teacherId: "TEACH1000", SectionName: "C" });
  const page = await app.api.getStudentPage();
  assert.equal(page.counts.length, 2);
  assert.equal(app.calls.length, 3);
  await app.api.getStudentPage();
  assert.equal(app.calls.length, 4);
  assert.equal(app.calls.at(-1).body.includeCounts, false);
});

test("malformed cached totals fall back to a live count instead of breaking the student page", async () => {
  const backend = dataFixture(), cookie = await backend.login();
  const app = fixture(async body => (await backend.call(body, cookie)).json());
  app.cache.put("teacher-a", "student-counts:all", { classes: ["A"], counts: null });
  const result = await app.api.getStudentPage();
  assert.equal(result.counts[0].active, 1);
  assert.equal(app.calls[0].body.includeCounts, undefined);
});

test("cached-only counts never block an initial roster, and prefetched selected-term results retain empty and timestamp behavior",async()=>{
  const backend=dataFixture(),cookie=await backend.login();let counts=0;
  const count=backend.store.count.bind(backend.store);backend.store.count=(...args)=>{counts++;return count(...args);};
  backend.data.set('users/0026271000/test_results/term_02/lessons/lesson_01',{postTestScore:0,timestamp:{$type:'timestamp',value:'2026-11-04T00:00:00Z'}});
  const app=fixture(async body=>{const response=await backend.call(body,cookie);assert.equal(response.status,200);return response.json();});
  const page=await app.api.getStudentPage({includeCounts:'cached',includeResults:{termId:'term_02',limit:8}});
  assert.equal(counts,0);assert.equal(page.counts,null);assert.equal(app.calls[0].body.includeCounts,false);
  assert.equal(page.students[0].results[0].lessonsSnap.docs[0].data().postTestScore,0);
  assert.equal(page.students[0].results[0].lessonsSnap.docs[0].data().timestamp.toDate().toISOString(),'2026-11-04T00:00:00.000Z');
  await app.api.getStudentPage({includeStudents:false});assert.equal(counts,2);
  const next=await app.api.getStudentPage({includeCounts:'cached'});assert.equal(counts,2);assert.equal(next.counts[0].active,1);
});
