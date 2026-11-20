import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { setLoadingState } from "../js/loading.js";

const source = readFileSync(new URL("../js/school-year.js", import.meta.url), "utf8")
  .replace(/^import\s[\s\S]*?from\s+"[^"]+";\r?\n/gm, "");
function database() {
  return {
    value: null, reads: 0, writes: [], failSave: false,
    snapshot() { this.reads++; return { exists: () => this.value !== null, data: () => this.value }; },
    publish(year) { this.value = { startYear: year }; }
  };
}
async function mount(store, { role = "teacher", selector = false, storage = new Map() } = {}) {
  const uid = `${role}-uid`, profile = { uid, role, active: true };
  const auth = { currentUser: { uid, role } };
  const labels = [{ textContent: "SY 2026–27" }, { textContent: "SY 2026–27" }];
  const select = { value: "2026", disabled: true, options: [], events: {}, replaceChildren(...options) { this.options = options; },
    addEventListener(name, callback) { this.events[name] = callback; } };
  const status = { textContent: "", classList: { toggle() {} }, setAttribute() {}, removeAttribute() {} };
  let authenticate;
  const events = new Map();
  const context = vm.createContext({
    setLoadingState,
    document: { querySelectorAll: () => labels, getElementById: id => selector ? (id === "schoolYearSelect" ? select : status) : null,
      createElement: () => ({ value: "", textContent: "" }) },
    window: { location: { pathname: selector ? "/admin-dashboard" : "/teacher-manual" },
      addEventListener: (name, callback) => events.set(name, callback),
      localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) } },
    getApps: () => [{}], initializeApp: () => ({}), getAuth: () => auth, getFirestore: () => ({}),
    doc: (_, ...path) => path, collection: () => ({}), query: () => ({}), where: () => ({}), limit: () => ({}),
    onAuthStateChanged: (_, callback) => { authenticate = callback; },
    getDoc: async () => store.snapshot(),
    getDocs: async () => ({ size: 1, docs: [{ data: () => profile }] }), serverTimestamp: () => "server-time",
    setDoc: async (path, fields) => {
      if (store.failSave) throw new Error("permission-denied");
      store.writes.push({ path: [...path], fields: structuredClone(fields) });
      store.publish(fields.startYear);
    }
  });
  vm.runInContext(source, context);
  await authenticate(auth.currentUser);
  return { labels, select, status, profile, storage, events, location: context.window.location, restore: () => authenticate(auth.currentUser),
    change: async year => { select.value = String(year); await select.events.change(); } };
}

test("the school-year chip opens the managed rollover page without changing data or labels", async () => {
  const store = database(), storage = new Map(); store.publish(2026);
  const admin = await mount(store, { role: "admin", selector: true, storage });
  const teacher = await mount(store, { storage });
  await admin.change(2027);
  assert.equal(store.writes.length, 0);
  assert.equal(admin.select.value, "2026");
  assert.equal(admin.location.href, "admin-school-years.html");
  assert.ok(teacher.labels.every(element => element.textContent === "SY 2026–27"));
});
test("non-admins cannot use the school-year control", async () => {
  const store = database(); const teacher = await mount(store, { selector: true });
  assert.equal(teacher.select.disabled, true); await teacher.change(2029);
  assert.equal(store.writes.length, 0); assert.equal(teacher.location.href, undefined);
});

test("navigation and history restoration reuse a fresh school year without polling", async () => {
  const store = database(), storage = new Map();
  store.publish(2028);
  const first = await mount(store, { storage });
  const next = await mount(store, { storage });
  await first.restore();
  assert.ok(next.labels.every(element => element.textContent === "SY 2028–29"));
  assert.equal(store.reads, 1);
  assert.deepEqual(Object.keys(JSON.parse(storage.get("imars-school-year-v1"))).sort(), ["checkedAt", "startYear"]);
  const admin = await mount(store, { role: "admin", selector: true, storage });
  assert.equal(store.reads, 1, "the admin editor reuses the recent school year");
  assert.equal(admin.select.disabled, false);
  storage.set("imars-school-year-v1", JSON.stringify({ startYear: 2029, checkedAt: Date.now() }));
  next.events.get("storage")({ key: "imars-school-year-v1" });
  assert.ok(next.labels.every(element => element.textContent === "SY 2029–30"));
});

test("expired or corrupt school-year labels never suppress a fresh read", async () => {
  for (const saved of ['bad json', JSON.stringify({ startYear: 2028, checkedAt: Date.now() - 86_400_001 }), JSON.stringify({ startYear: 4000, checkedAt: Date.now() })]) {
    const store = database(); store.publish(2030);
    const app = await mount(store, { storage: new Map([["imars-school-year-v1", saved]]) });
    assert.equal(store.reads, 1);
    assert.equal(app.labels[0].textContent, "SY 2030–31");
  }
});
