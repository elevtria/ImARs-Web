import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { createReadPool } from "../js/data-read-pool.js";
import { wrapFirestoreReads } from "../js/firebase-loading.js";

const source = readFileSync(new URL("../js/firebase-data.js", import.meta.url), "utf8").replace(/^import[^\n]+\n/gm, "").replace(/^export /gm, "");
const flush = async () => { for (let index = 0; index < 3; index++) await new Promise(resolve => setImmediate(resolve)); };
function fixture(transport) {
  const calls = [], timers = new Map(), events = new Map();
  let invalidated = 0, nextTimer = 0;
  const context = vm.createContext({ Date, crypto, performance, queueMicrotask, createReadPool, wrapFirestoreReads,
    startLoading: () => () => {}, withLoading: operation => operation(), invalidateTeacherViews: () => { invalidated++; },
    setTimeout(callback) { timers.set(++nextTimer, callback); return nextTimer; }, clearTimeout(id) { timers.delete(id); },
    window: { location: { pathname: "/index" }, addEventListener(name, callback) { events.set(name, callback); }, removeEventListener(name) { events.delete(name); } },
    document: { visibilityState: "visible", addEventListener(name, callback) { events.set(name, callback); }, removeEventListener(name) { events.delete(name); } },
    webRequest: async (path, body) => { calls.push({ path, body }); return transport(body); }
  });
  const api = vm.runInContext(source + "\n({doc,collection,query,where,orderBy,limit,getDoc,getDocs,setDoc,writeBatch,onSnapshot,serverTimestamp,arrayUnion});", context);
  return { api, calls, timers, context, events, invalidated: () => invalidated };
}
const document = (path, data) => ({ id: path.split("/").at(-1), path, data });

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
