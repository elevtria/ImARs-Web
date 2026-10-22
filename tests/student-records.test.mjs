import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { encodeView, decodeView } from "../js/view-cache.js";

const source = readFileSync(new URL("../js/student-records.js", import.meta.url), "utf8").replace(/^import[^\n]+\r?\n/gm, "");
const documentSnapshot = (id, data) => ({ id, exists: () => true, data: () => data });
const snapshot = docs => ({ docs, empty: docs.length === 0, size: docs.length, forEach: callback => docs.forEach(callback) });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

class Element {
  constructor(tag = "div") {
    this.tag = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.value = ""; this.disabled = false;
    this.classes = new Set();
    this.classList = { add: value => this.classes.add(value), remove: value => this.classes.delete(value),
      contains: value => this.classes.has(value), toggle: (value, on) => on ? this.classes.add(value) : this.classes.delete(value) };
  }
  set innerHTML(value) {
    this.html = value; this.children = []; this.buttons = {};
    if (this.tag === "select") this.children.push(new Element("option"));
    for (const name of ["edit-student-btn", "delete-student-btn"]) if (value.includes(`class="${name}"`)) this.buttons["." + name] = new Element("button");
  }
  get innerHTML() { return this.html || ""; }
  get options() { return this.children; }
  setAttribute(name, value) { this[name] = value; }
  appendChild(child) { if (child.tag === "fragment") this.children.push(...child.children); else this.children.push(child); }
  querySelector(selector) { return this.buttons?.[selector] || null; }
  addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
  async emit(type, event = {}) { for (const callback of this.listeners[type] || []) await callback({ preventDefault() {}, ...event }); }
}

function harness() {
  const ids = Object.fromEntries(["recordsContainer", "emptyState", "studentSearch", "sectionFilter", "editStudentModal", "editStudentForm",
    "editStudentId", "editFullName", "editEmail", "saveEditBtn", "cancelEditBtn"].map(id => [id, new Element(id === "sectionFilter" ? "select" : "div")]));
  const profiles = new Map([
    ["S1", { displayName: 'A <Student> "One"', email: "one@example.test", active: true }],
    ["S2", { displayName: "Archived Student", email: "two@example.test", active: false }],
    ["S3", { displayName: "Legacy Student", providedEmail: "three@example.test" }]
  ]);
  const lesson = documentSnapshot("lesson", { isPreTestCompleted: true, isPostTestCompleted: true, preTestScore: 1, preTestTotalQuestions: 2,
    postTestScore: 2, postTestTotalQuestions: 2, arTimeMinutes: 4, lessonTimeMinutes: 3 });
  const report = () => [{ classDoc: documentSnapshot("A", { SectionName: "A & B" }), students: [...profiles].map(([id, data]) => ({
    studentDoc: documentSnapshot(id, { ...data }), results: [{ lessonsSnap: snapshot([lesson]) }]
  })) }];
  let authCallback, view, read = async ref => documentSnapshot(ref.id, profiles.get(ref.id)), confirmation = true, rejectWrite = false, reloads = 0;
  const writes = [], reads = [], alerts = [], auth = { currentUser: { uid: "teacher-a" } };
  const docs = async ref => snapshot(ref.path === "classes" ? [documentSnapshot("A", {})] : [documentSnapshot("T1", { role: "teacher" })]);
  const context = vm.createContext({ Date, console: { error() {} }, initializeApp: () => ({}), getAuth: () => auth, getFirestore: () => ({}),
    onAuthStateChanged: (_, callback) => { authCallback = callback; }, getDocs: docs, quietDocs: docs,
    quietDoc: ref => { reads.push(ref); return read(ref); }, doc: (_, collection, id) => ({ collection, id }),
    collection: (_, path) => ({ path }), query: ref => ref, where: () => ({}),
    loadClassReports: async () => report(), createPagePerformance: () => ({ data: action => action(), render: action => action(), finish() {} }),
    showTeacherView: async options => { view = options; options.render(await options.load({ background: false })); },
    updateDoc: async (ref, data) => { if (rejectWrite) throw Error("permission-denied"); writes.push({ ref, data }); Object.assign(profiles.get(ref.id), data); },
    confirm: () => confirmation, alert: value => alerts.push(value), window: { location: { reload: () => { reloads++; } } },
    document: { getElementById: id => ids[id], createElement: tag => new Element(tag), createDocumentFragment: () => new Element("fragment"),
      querySelectorAll: selector => selector === ".record" ? ids.recordsContainer.children : [] }
  });
  vm.runInContext(source, context);
  const click = (selector, button) => ids.recordsContainer.emit("click", { target: { closest: value => value === selector ? button : null } });
  return { ids, auth, profiles, reads, writes, alerts, click,
    load: () => authCallback(auth.currentUser),
    renderSaved: () => view.render(decodeView(JSON.parse(JSON.stringify(encodeView({ sections: report(), message: "" }))))),
    setReader: value => { read = value; }, setConfirm: value => { confirmation = value; }, failWrites: () => { rejectWrite = true; },
    get reloads() { return reloads; } };
}

test("merged records retain score summaries, filters and both controls; archived students stay hidden in saved views", async () => {
  const app = harness(); await app.load(); app.renderSaved();
  const cards = app.ids.recordsContainer.children;
  assert.equal(cards.length, 2);
  assert.equal(cards[0].dataset.name, 'a <student> "one"');
  assert.match(cards[0].innerHTML, /50%/); assert.match(cards[0].innerHTML, /100% overall/);
  assert.match(cards[0].innerHTML, /4 min/); assert.match(cards[0].innerHTML, /3 min/);
  assert.match(cards[0].innerHTML, /A &lt;Student&gt; &quot;One&quot;/);
  assert.match(cards[0].innerHTML, /A &amp; B/);
  assert.match(cards[0].innerHTML, /record-progress-tile/);
  assert.match(cards[0].innerHTML, /Overall performance<\/span>/);
  assert.match(cards[0].innerHTML, /role="progressbar"[^>]*aria-valuenow="100"/);
  assert.ok(cards.every(card => card.querySelector(".edit-student-btn") && card.querySelector(".delete-student-btn")));
  app.ids.studentSearch.value = "legacy"; await app.ids.studentSearch.emit("input");
  assert.equal(cards[0].classList.contains("hidden"), true); assert.equal(cards[1].classList.contains("hidden"), false);
});

test("editing from a saved report reads the current email without caching it, then saves the incoming profile fields", async () => {
  const app = harness(); await app.load(); app.renderSaved();
  const pending = deferred(); app.setReader(() => pending.promise);
  const edit = app.click(".edit-student-btn", app.ids.recordsContainer.children[0].querySelector(".edit-student-btn"));
  assert.equal(app.ids.saveEditBtn.disabled, true); assert.equal(app.ids.editEmail.value, "");
  pending.resolve(documentSnapshot("S1", { displayName: "Current Name", email: "current@example.test" })); await edit;
  assert.equal(app.reads.at(-1).id, "S1"); assert.equal(app.ids.editEmail.value, "current@example.test");
  assert.equal(app.ids.editFullName.value, "Current Name"); assert.equal(app.ids.saveEditBtn.disabled, false);
  app.ids.editFullName.value = " Updated Name "; app.ids.editEmail.value = " UPDATED@example.test ";
  await app.ids.editStudentForm.emit("submit");
  assert.equal(app.writes.length, 1); assert.equal(app.writes[0].ref.id, "S1");
  assert.deepEqual(JSON.parse(JSON.stringify(app.writes[0].data)), { displayName: "Updated Name", fullName: "Updated Name", email: "updated@example.test", providedEmail: "updated@example.test" });
  assert.equal(app.reloads, 1);
  const encoded = JSON.stringify(encodeView(documentSnapshot("S1", app.profiles.get("S1"))));
  assert.equal(encoded.includes("updated@example.test"), false);
});

test("cancelled or stale editor reads cannot overwrite a newer student's form", async () => {
  const app = harness(); await app.load();
  const first = deferred(), second = deferred();
  app.setReader(ref => ref.id === "S1" ? first.promise : second.promise);
  const cards = app.ids.recordsContainer.children;
  const old = app.click(".edit-student-btn", cards[0].querySelector(".edit-student-btn"));
  await app.ids.cancelEditBtn.emit("click");
  const current = app.click(".edit-student-btn", cards[1].querySelector(".edit-student-btn"));
  first.resolve(documentSnapshot("S1", { email: "wrong-student@example.test" })); await old;
  assert.equal(app.ids.editStudentId.value, "S3"); assert.equal(app.ids.editEmail.value, ""); assert.equal(app.ids.saveEditBtn.disabled, true);
  second.resolve(documentSnapshot("S3", { providedEmail: "three@example.test" })); await current;
  assert.equal(app.ids.editEmail.value, "three@example.test"); assert.equal(app.ids.saveEditBtn.disabled, false);
});

test("archive cancellation or a denied write preserves the record; confirmed archival hides it without deleting data", async () => {
  const app = harness(); await app.load();
  const button = app.ids.recordsContainer.children[0].querySelector(".delete-student-btn");
  app.setConfirm(false); await app.click(".delete-student-btn", button);
  assert.equal(app.writes.length, 0); assert.equal(app.reloads, 0);
  app.setConfirm(true); await app.click(".delete-student-btn", button);
  assert.equal(app.writes[0].data.active, false); assert.ok(app.writes[0].data.deletedAt instanceof Date);
  assert.equal(app.profiles.has("S1"), true); assert.equal(app.reloads, 1);
  app.renderSaved(); assert.equal(app.ids.recordsContainer.children.length, 1);
  app.failWrites(); await app.click(".delete-student-btn", button);
  assert.equal(app.writes.length, 1); assert.equal(app.reloads, 1); assert.equal(app.alerts.at(-1), "Failed to archive student.");
});
