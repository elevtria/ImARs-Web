import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../js/school-year.js", import.meta.url), "utf8")
  .replace(/^import\s[\s\S]*?from\s+"[^"]+";\r?\n/gm, "");
function database() {
  const listeners = new Set();
  return {
    value: null, writes: [], failSave: false,
    snapshot() { return { metadata: { hasPendingWrites: false }, exists: () => this.value !== null, data: () => this.value }; },
    publish(year) { this.value = { startYear: year }; for (const listener of listeners) listener(this.snapshot()); },
    listen(callback) { listeners.add(callback); callback(this.snapshot()); return () => listeners.delete(callback); }
  };
}
async function mount(store, { role = "teacher", selector = false } = {}) {
  const uid = `${role}-uid`, profile = { uid, role, active: true };
  const auth = { currentUser: { uid } };
  const labels = [{ textContent: "SY 2026–27" }, { textContent: "SY 2026–27" }];
  const select = { value: "2026", disabled: true, options: [], events: {}, replaceChildren(...options) { this.options = options; },
    addEventListener(name, callback) { this.events[name] = callback; } };
  const status = { textContent: "", classList: { toggle() {} } };
  let ready;
  const context = vm.createContext({
    document: { querySelectorAll: () => labels, getElementById: id => selector ? (id === "schoolYearSelect" ? select : status) : null,
      createElement: () => ({ value: "", textContent: "" }) },
    window: { location: { pathname: selector ? "/admin-dashboard" : "/teacher-manual" } },
    getApps: () => [{}], initializeApp: () => ({}), getAuth: () => auth, getFirestore: () => ({}),
    doc: (_, ...path) => path, collection: () => ({}), query: () => ({}), where: () => ({}), limit: () => ({}),
    onAuthStateChanged: (_, callback) => { ready = callback(auth.currentUser); },
    onSnapshot: (_, __, callback) => store.listen(callback),
    getDocs: async () => ({ size: 1, docs: [{ data: () => profile }] }), serverTimestamp: () => "server-time",
    setDoc: async (path, fields) => {
      if (store.failSave) throw new Error("permission-denied");
      store.writes.push({ path: [...path], fields: structuredClone(fields) });
      store.publish(fields.startYear);
    }
  });
  vm.runInContext(source, context);
  await ready;
  return { labels, select, status, profile, change: async year => { select.value = String(year); await select.events.change(); } };
}

test("an admin change persists a shared school year and updates teacher labels and later page loads", async () => {
  const store = database();
  const admin = await mount(store, { role: "admin", selector: true });
  const teacher = await mount(store);
  assert.equal(admin.select.disabled, false);
  await admin.change(2027);
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
