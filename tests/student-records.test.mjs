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
    for (const name of ["archive-student-btn", "unarchive-student-btn", "remove-student-btn"]) if (value.includes(`class="${name}"`)) this.buttons["." + name] = new Element("button");
  }
  get innerHTML() { return this.html || ""; }
  get options() { return this.children; }
  setAttribute(name, value) { this[name] = value; }
  appendChild(child) { if (child.tag === "fragment") this.children.push(...child.children); else this.children.push(child); }
  querySelector(selector) { return this.buttons?.[selector] || null; }
  querySelectorAll(selector) { return selector === ".record" ? this.children.filter(child => child.className === "record") : []; }
  focus() {}
  addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
  async emit(type, event = {}) { for (const callback of this.listeners[type] || []) await callback({ preventDefault() {}, ...event }); }
}

function harness() {
  const ids = Object.fromEntries(["recordsContainer", "emptyState", "studentSearch", "sectionFilter", "editStudentModal", "editStudentForm",
    "editStudentId", "editFullName", "editEmail", "saveEditBtn", "cancelEditBtn", "activeStudentsTab", "archivedStudentsTab", "activeStudentsCount", "archivedStudentsCount", "archiveStudentModal", "archiveStudentForm", "archiveReason", "confirmArchiveStudent", "archiveStudentError", "cancelArchiveStudent", "archiveStudentName", "archiveStudentTitle", "archiveSectionBtn"].map(id => [id, new Element(id === "sectionFilter" ? "select" : "div")]));
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
    writeBatch: () => {
      const queued = [];
      return { update(ref, data) { queued.push({ref, data}); }, async commit() {
        if (rejectWrite) throw Error("permission-denied");
        for (const item of queued) { writes.push(item); Object.assign(profiles.get(item.ref.id), item.data); }
      } };
    },
    deleteDoc: async ref => { if (rejectWrite) throw Error("permission-denied"); writes.push({ ref, deleted:true }); profiles.delete(ref.id); },
    confirm: () => confirmation, alert: value => alerts.push(value), window: { confirm: () => confirmation, alert: value => alerts.push(value), location: { reload: () => { reloads++; } } },
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


test("records retain summaries and safe text while active/archive tabs filter and count saved students", async () => {
 const app = harness(); await app.load(); app.renderSaved();
 const cards = app.ids.recordsContainer.children;
 assert.equal(cards.length, 3);
 assert.match(cards[0].innerHTML, /50%/);
 assert.match(cards[0].innerHTML, /A &lt;Student&gt; &quot;One&quot;/);
 assert.equal(cards[1].classList.contains("hidden"), true);
 assert.equal(app.ids.activeStudentsCount.textContent, 2);
 assert.equal(app.ids.archivedStudentsCount.textContent, 1);
 assert.equal(cards[0].querySelector(".edit-student-btn"), null);
 assert.equal(cards[0].querySelector(".delete-student-btn"), null);
 await app.ids.archivedStudentsTab.emit("click");
 assert.equal(cards[0].classList.contains("hidden"), true);
 assert.equal(cards[1].classList.contains("hidden"), false);
 app.ids.studentSearch.value = "legacy"; await app.ids.studentSearch.emit("input");
 assert.equal(cards.every(card => card.classList.contains("hidden")), true);
});
for (const reason of ["graduated", "dropped-out"]) test("archiving for " + reason + " preserves profile and reason in saved views", async () => {
 const app = harness(); await app.load();
 const button = app.ids.recordsContainer.children[0].querySelector(".archive-student-btn");
 await app.click(".archive-student-btn", button);
 app.ids.archiveReason.value = reason;
 await app.ids.archiveStudentForm.emit("submit");
 assert.equal(app.writes.length, 1);
 assert.equal(app.writes[0].data.active, false);
 assert.equal(app.writes[0].data.archiveReason, reason);
 assert.ok(app.writes[0].data.deletedAt instanceof Date);
 assert.equal(app.profiles.has("S1"), true);
 assert.equal(app.reloads, 1);
 app.renderSaved();
 assert.equal(app.ids.recordsContainer.children[0].classList.contains("hidden"), true);
 assert.match(app.ids.recordsContainer.children[0].innerHTML, reason === "graduated" ? /Graduated/ : /Dropped out/);
 await app.ids.archivedStudentsTab.emit("click");
 assert.equal(app.ids.recordsContainer.children[0].classList.contains("hidden"), false);
});
test("cancelled, invalid and denied archives do not remove students", async () => {
 const app = harness(); await app.load();
 await app.click(".archive-student-btn", app.ids.recordsContainer.children[0].querySelector(".archive-student-btn"));
 await app.ids.cancelArchiveStudent.emit("click");
 assert.equal(app.writes.length, 0);
 app.ids.archiveReason.value = "invalid";
 await app.ids.archiveStudentForm.emit("submit");
 assert.equal(app.writes.length, 0);
 app.ids.archiveReason.value = "graduated"; app.failWrites();
 await app.ids.archiveStudentForm.emit("submit");
 assert.equal(app.writes.length, 0); assert.equal(app.reloads, 0);
 assert.equal(app.ids.confirmArchiveStudent.disabled, false);
 assert.match(app.ids.archiveStudentError.textContent, /Could not archive/);
});

test("archived students can be restored, with cancellation and failed writes preserving data", async () => {
 const app = harness(); await app.load();
 const button = app.ids.recordsContainer.children[1].querySelector(".unarchive-student-btn");
 app.setConfirm(false); await app.click(".unarchive-student-btn", button); assert.equal(app.writes.length, 0);
 app.setConfirm(true); app.failWrites(); await app.click(".unarchive-student-btn", button); assert.equal(app.writes.length, 0); assert.equal(button.disabled, false);
});
test("unarchiving clears reason/date and returns a student to Active", async () => {
 const app = harness(); await app.load();
 await app.click(".unarchive-student-btn", app.ids.recordsContainer.children[1].querySelector(".unarchive-student-btn"));
 assert.deepEqual(JSON.parse(JSON.stringify(app.writes[0].data)), {active:true, archiveReason:null, deletedAt:null});
 app.renderSaved(); assert.equal(app.ids.recordsContainer.children[1].classList.contains("hidden"), false);
});
test("archived profile deletion needs confirmation and deletes only the selected profile", async () => {
 const app = harness(); await app.load();
 const button = app.ids.recordsContainer.children[1].querySelector(".remove-student-btn");
 app.setConfirm(false); await app.click(".remove-student-btn", button); assert.equal(app.writes.length, 0);
 app.setConfirm(true); await app.click(".remove-student-btn", button);
 assert.equal(app.profiles.has("S2"), false); assert.equal(app.profiles.has("S1"), true); assert.equal(app.reloads, 1);
});

test("section archive requires one section and includes all its active students despite name search", async () => {
 const app = harness(); await app.load();
 assert.equal(app.ids.archiveSectionBtn.disabled, true);
 app.ids.sectionFilter.value = "A"; await app.ids.sectionFilter.emit("change");
 app.ids.studentSearch.value = "legacy"; await app.ids.studentSearch.emit("input");
 assert.equal(app.ids.archiveSectionBtn.disabled, false);
 await app.ids.archiveSectionBtn.emit("click");
 assert.match(app.ids.archiveStudentName.textContent, /2 active students/);
 assert.match(app.ids.archiveStudentName.textContent, /hidden by the search/);
 app.ids.archiveReason.value = "graduated";
 await app.ids.archiveStudentForm.emit("submit");
 assert.deepEqual(app.writes.map(write => write.ref.id), ["S1", "S3"]);
 assert.ok(app.writes.every(write => write.data.active === false && write.data.archiveReason === "graduated"));
 assert.equal(app.reloads, 1);
});
test("section archiving is disabled in the archive tab and denied writes preserve the roster", async () => {
 const app = harness(); await app.load();
 app.ids.sectionFilter.value = "A"; await app.ids.sectionFilter.emit("change");
 await app.ids.archivedStudentsTab.emit("click"); assert.equal(app.ids.archiveSectionBtn.disabled, true);
 await app.ids.activeStudentsTab.emit("click");
 await app.ids.archiveSectionBtn.emit("click");
 await app.ids.cancelArchiveStudent.emit("click"); assert.equal(app.writes.length, 0);
 await app.ids.archiveSectionBtn.emit("click");
 app.ids.archiveReason.value = "dropped-out"; app.failWrites();
 await app.ids.archiveStudentForm.emit("submit");
 assert.equal(app.writes.length, 0); assert.equal(app.reloads, 0);
 assert.equal(app.ids.confirmArchiveStudent.disabled, false);
});
