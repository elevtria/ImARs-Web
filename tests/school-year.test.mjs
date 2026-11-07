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
  const auth = { currentUser: { uid } };
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
  return { labels, select, status, profile, storage, events, restore: () => authenticate(auth.currentUser),
    change: async year => { select.value = String(year); await select.events.change(); } };
}

test("an admin change persists a shared school year and updates teacher labels and later page loads", async () => {
  const store = database(), storage = new Map();
  const admin = await mount(store, { role: "admin", selector: true, storage });
  const teacher = await mount(store, { storage });
  assert.equal(admin.select.disabled, false);
  await admin.change(2027);
  teacher.events.get("storage")({ key: "imars-school-year-v1" });
  assert.equal(store.writes.length, 1);
  assert.deepEqual(store.writes[0], { path: ["webSettings", "schoolYear"], fields: {
    startYear: 2027, endYear: 2028, updatedBy: "admin-uid", updatedAt: "server-time"
  } });
  assert.ok(teacher.labels.every(element => element.textContent === "SY 2027–28"));
  assert.match(admin.status.textContent, /Saved for all teachers/);
  const reopened = await mount(store);
  assert.ok(reopened.labels.every(element => element.textContent === "SY 2027–28"));
});

test("a failed save restores the confirmed year without changing teacher labels", async () => {
  const store = database(); store.publish(2027);
  const admin = await mount(store, { role: "admin", selector: true });
  const teacher = await mount(store);
  store.failSave = true;
  await admin.change(2028);
  assert.equal(admin.select.value, "2027");
  assert.equal(admin.select.disabled, false);
  assert.equal(store.writes.length, 0);
  assert.match(admin.status.textContent, /Could not save/);
  assert.ok(teacher.labels.every(element => element.textContent === "SY 2027–28"));
});

test("the control refuses non-admins and rechecks an administrator's role before saving", async () => {
  const store = database();
  const teacher = await mount(store, { selector: true });
  assert.equal(teacher.select.disabled, true);
  await teacher.change(2029);
  assert.equal(store.writes.length, 0);
  const admin = await mount(store, { role: "admin", selector: true });
  admin.profile.role = "teacher";
  await admin.change(2029);
  assert.equal(store.writes.length, 0);
  assert.match(admin.status.textContent, /Could not save/);
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
  assert.equal(store.reads, 2, "the admin editor opens with a fresh server read");
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
