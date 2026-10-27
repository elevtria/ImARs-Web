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

test("login preparation reads private data only for the authenticated teacher and never caches it for a changed account", async () => {
  const cache = createViewCache({ storage: storage(), versions: storage() });
  const user = { uid: "a", role: "teacher" }, auth = { currentUser: null };
  const calls = [];
  const docs = (id, data) => ({ id, exists: () => true, data: () => data });
  const list = values => ({ docs: values, size: values.length, empty: !values.length, forEach: action => values.forEach(action) });
  let wait;
  const context = vm.createContext({ Promise, encodeView, teacherViewCache: () => cache, getAuth: () => auth, getFirestore: () => ({}),
    collection: (_, ...parts) => ({ path: parts.join("/") }), doc: (_, ...parts) => ({ path: parts.join("/") }),
    query: (ref, ...filters) => ({ ...ref, filters }), where: (field, op, value) => ({ field, op, value }),
    quietDocs: async ref => {
      calls.push(ref);
      if (ref.filters?.[0]?.field === "uid") { await wait; return list([docs("TEACH1000", { role: "teacher", displayName: "Teacher A", password: "never-cache" })]); }
      if (ref.path === "classes") return list([docs("A", { SectionName: "A" })]);
      if (ref.path === "users") return list([docs("S1", { displayName: "Student", password: "never-cache" })]);
      return list([]);
    }, quietDoc: async () => docs("term_01", { title: "Term 1" })
  });
  const source = readFileSync(new URL("../js/teacher-report-data.js", import.meta.url), "utf8").replace(/^import[^\n]+\r?\n/gm, "").replace(/^export /gm, "");
  const prepare = vm.runInContext(source + "\nprepareDashboard;", context);
  await prepare({}, user);
  auth.currentUser = { uid: "admin", role: "admin" }; await prepare({}, auth.currentUser);
  assert.equal(calls.length, 0, "anonymous and non-teacher pages cannot fetch student reports");
  auth.currentUser = user;
  await prepare({}, user);
  assert.ok(cache.get("a", "dashboard"));
  assert.equal(JSON.stringify(cache.get("a", "dashboard")).includes("never-cache"), false);
  let resolve;
  wait = new Promise(yes => { resolve = yes; });
  const pending = prepare({}, user);
  auth.currentUser = { uid: "b", role: "teacher" }; cache.setOwner("b");
  resolve(); await pending;
  assert.equal(cache.get("b", "dashboard"), null);
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
  const display = options => run({ app: {}, user: auth.currentUser, page: "records", render: value => states.push(value), ...options });
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
