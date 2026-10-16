import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import * as availability from "../js/topic-availability.js";

function scheduler() {
  const elements = new Map();
  const listeners = new Map();
  const records = new Map(["term_01", "term_02", "term_03"].map((term) => [term,
    Array.from({ length: 4 }, (_, index) => ({ id: `lesson_0${index + 1}`, isLocked: true, scheduledDate: "", lessonOrder: index + 1 }))
  ]));
  let authChanged;
  let rejectWrite = false;
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      innerHTML: "", textContent: "", value: "", dataset: {}, events: {},
      classList: { add() {}, remove() {} },
      addEventListener(name, callback) { this.events[name] = callback; },
      checkValidity() { return true; }, reportValidity() {}
    });
    return elements.get(id);
  }
  function emit(term) {
    listeners.get(term)?.({
      metadata: { fromCache: false },
      docs: records.get(term).map(({ id, ...data }) => ({ id, data: () => data }))
    });
  }
  function update(ref, fields) {
    Object.assign(records.get(ref[1]).find((record) => record.id === ref[3]), fields);
  }
  const context = vm.createContext({
    ...availability, console: { error() {} }, Date,
    document: { getElementById: element, addEventListener() {} },
    window: { setTimeout() {} }, localStorage: { getItem: () => null, setItem() {} },
    getApps: () => [], initializeApp: () => ({}), getAuth: () => ({}), getFirestore: () => ({}),
    collection: (_, ...path) => path, doc: (_, ...path) => path,
    onAuthStateChanged: (_, callback) => { authChanged = callback; },
    onSnapshot: (ref, _, callback) => {
      listeners.set(ref[1], callback);
      return () => listeners.delete(ref[1]);
    },
    updateDoc: async (ref, fields) => {
      if (rejectWrite) throw new Error("permission-denied");
      update(ref, fields);
      emit(ref[1]);
    },
    writeBatch: () => {
      const changes = [];
      return {
        update: (ref, fields) => changes.push([ref, fields]),
        commit: async () => {
          if (rejectWrite) throw new Error("permission-denied");
          changes.forEach(([ref, fields]) => update(ref, fields));
          [...new Set(changes.map(([ref]) => ref[1]))].forEach(emit);
        }
      };
    }
  });
  const source = readFileSync(new URL("../js/topic-scheduler.js", import.meta.url), "utf8")
    .replace(/^import\s[\s\S]*?from\s+"[^"]+";\r?\n/gm, "");
  vm.runInContext(source, context);
  authChanged({ uid: "test-teacher" });
  for (const term of records.keys()) emit(term);
  return {
    element, records, emit, listeners, authChanged,
    denyWrites: () => { rejectWrite = true; },
    click: (attribute, value) => element("terms").events.click({
      target: { closest: (selector) => selector === `[data-${attribute}]` ? { dataset: { [attribute]: value } } : null }
    })
  };
}

test("live snapshots update badges, unlocked counts, and progress together", () => {
  const app = scheduler();
  assert.match(app.element("terms").innerHTML, /0\/4 unlocked/);
  assert.match(app.element("yearProgress").innerHTML, /aria-valuenow="0"/);
  app.records.get("term_01")[0].isLocked = false;
  app.emit("term_01");
  assert.match(app.element("terms").innerHTML, /1\/4 unlocked/);
  assert.match(app.element("terms").innerHTML, /Partly unlocked/);
  assert.match(app.element("yearProgress").innerHTML, /aria-valuenow="25"/);
});

test("individual and bulk buttons persist lock changes and update progress", async () => {
  const app = scheduler();
  await app.click("lock", "0-0");
  assert.equal(app.records.get("term_01")[0].isLocked, false);
  assert.match(app.element("yearProgress").innerHTML, /aria-valuenow="25"/);
  await app.click("lockall", "0");
  assert.ok(app.records.get("term_01").every((topic) => topic.isLocked && topic.scheduledDate === ""));
  await app.click("lockall", "0");
  assert.ok(app.records.get("term_01").every((topic) => !topic.isLocked && topic.scheduledDate === ""));
  assert.match(app.element("terms").innerHTML, /4\/4 unlocked/);
  assert.match(app.element("yearProgress").innerHTML, /aria-valuenow="100"/);
});

test("date save locks an unlocked topic until release and manual unlock cancels it", async () => {
  const app = scheduler();
  await app.click("lock", "0-0");
  await app.click("date", "0-0");
  app.element("dateInput").value = "2099-10-20";
  await app.element("dateSave").onclick();
  const topic = app.records.get("term_01")[0];
  assert.equal(topic.isLocked, true);
  assert.equal(topic.scheduledDate, "2099-10-20");
  assert.match(app.element("terms").innerHTML, /Scheduled/);
  await app.click("lock", "0-0");
  assert.equal(topic.isLocked, false);
  assert.equal(topic.scheduledDate, "");
});

test("a denied write leaves persisted state and progress unchanged", async () => {
  const app = scheduler();
  app.denyWrites();
  await app.click("lock", "0-0");
  assert.equal(app.records.get("term_01")[0].isLocked, true);
  assert.match(app.element("yearProgress").innerHTML, /aria-valuenow="0"/);
  assert.match(app.element("syncStatus").textContent, /Could not save lock/);
});

test("signing out unsubscribes live listeners and removes progress claims", () => {
  const app = scheduler();
  app.authChanged(null);
  assert.equal(app.listeners.size, 0);
  assert.match(app.element("terms").innerHTML, /Waiting for data/);
  assert.match(app.element("yearProgress").innerHTML, /Waiting for data/);
});
