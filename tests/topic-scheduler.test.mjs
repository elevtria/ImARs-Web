import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import * as availability from "../js/topic-availability.js";
import { encodeView, decodeView } from "../js/view-cache.js";

async function scheduler({ chooseSection = true, sections = ["A", "C"], rememberedSection = null, emitAfterWrite = true } = {}) {
  const elements = new Map();
  const listeners = new Map();
  const savedViews = new Map();
  const records = new Map(["term_01", "term_02", "term_03"].map((term) => [term,
    Array.from({ length: 4 }, (_, index) => ({ id: `lesson_0${index + 1}`, isLocked: true, scheduledDate: "", lessonOrder: index + 1 }))
  ]));
  let authChanged;
  let rejectWrite = false;
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      innerHTML: "", textContent: "", value: "", dataset: {}, events: {},
      classList: { add() {}, remove() {} },
      contains() { return false; },
      addEventListener(name, callback) { this.events[name] = callback; },
      checkValidity() { return true; }, reportValidity() {}
    });
    return elements.get(id);
  }
  function emit(term) {
    const docs = records.get(term).map(({ id, ...data }) => ({ id, exists: () => true, data: () => data }));
    listeners.get(term)?.({
      metadata: { fromCache: false },
      docs, size: docs.length, empty: !docs.length, forEach: callback => docs.forEach(callback)
    });
  }
  function update(ref, fields) {
    const record = records.get(ref[1]).find((record) => record.id === ref[3]);
    const { sectionId, ...schedule } = fields;
    assert.ok(sections.includes(sectionId));
    record.sectionSchedules = { ...record.sectionSchedules, [sectionId]: schedule };
  }
  const context = vm.createContext({
    ...availability, console: { error() {} }, Date,
    document: { getElementById: element, addEventListener() {} },
    window: { setTimeout() {} }, localStorage: { getItem: () => null, setItem() {} },
    getApps: () => [], initializeApp: () => ({}), getAuth: () => ({}), getFirestore: () => ({}),
    prepareTeacherCache: () => ({ get: (_, key) => key === "schedule:section" && rememberedSection ? { id: rememberedSection } : null, put: (_, key, value) => savedViews.set(key, value), invalidate() {} }),
    encodeView, decodeView,
    collection: (_, ...path) => path, doc: (_, ...path) => Object.assign(path, { id: path.at(-1) }),
    query: ref => ref, where: () => ({}),
    getDocsWithLoading: async ref => ref[0] === "users"
      ? { size: 1, docs: [{ id: "TEACH1000", data: () => ({ role: "teacher" }) }] }
      : { docs: sections.map(id => ({ id, data: () => ({ SectionName: `Section ${id}` }) })) },
    onAuthStateChanged: (_, callback) => { authChanged = callback; },
    onSnapshot: (ref, _, callback) => {
      listeners.set(ref[1], callback);
      return () => listeners.delete(ref[1]);
    },
    updateDoc: async (ref, fields) => {
      if (rejectWrite) throw new Error("permission-denied");
      update(ref, fields);
      if (emitAfterWrite) emit(ref[1]);
    },
    writeBatch: () => {
      const changes = [];
      return {
        update: (ref, fields) => changes.push([ref, fields]),
        commit: async () => {
          if (rejectWrite) throw new Error("permission-denied");
          changes.forEach(([ref, fields]) => update(ref, fields));
          if (emitAfterWrite) [...new Set(changes.map(([ref]) => ref[1]))].forEach(emit);
        }
      };
    }
  });
  const source = readFileSync(new URL("../js/topic-scheduler.js", import.meta.url), "utf8")
    .replace(/^import\s[\s\S]*?from\s+"[^"]+";\r?\n/gm, "");
  vm.runInContext(source, context);
  await authChanged({ uid: "test-teacher" });
  for (const term of records.keys()) emit(term);
  if (chooseSection && sections.length) {
    element("scheduleSection").value = sections[0];
    element("scheduleSection").events.change();
  }
  return {
    element, records, emit, listeners, authChanged, savedViews,
    denyWrites: () => { rejectWrite = true; },
    activityClick: (value, mode, date = "") => {
      const card = {
        dataset: { activity: value },
        querySelector: selector => selector === ".activity-schedule-mode"
          ? { value: mode }
          : { value: date, checkValidity: () => true }
      };
      return element("activityScheduleList").events.click({ target: {
        closest: selector => selector === ".activity-schedule-save" ? { closest: () => card } : null
      } });
    },
    activityTermClick: index => element("activityScheduleList").events.click({ target: {
      closest: selector => selector === "[data-activity-term]" ? { dataset: { activityTerm: String(index) } } : null
    } }),
    activityChange: (value, mode, date = "") => {
      const dateControl = { value: date };
      const card = { dataset: { activity: value }, querySelector: selector => selector === ".activity-schedule-mode" ? { value: mode } : dateControl };
      element("activityScheduleList").events.change({ target: { value: mode, matches: selector => selector === ".activity-schedule-mode", closest: () => card } });
    },
    click: (attribute, value) => element("terms").events.click({
      target: { closest: (selector) => selector === `[data-${attribute}]` ? { dataset: { [attribute]: value } } : null }
    })
  };
}

test("live snapshots update badges, unlocked counts, and progress together", async () => {
  const app = await scheduler();
  assert.match(app.element("terms").innerHTML, /0\/4 unlocked/);
  assert.match(app.element("yearProgress").innerHTML, /aria-valuenow="0"/);
  app.records.get("term_01")[0].isLocked = false;
  app.emit("term_01");
  assert.match(app.element("terms").innerHTML, /1\/4 unlocked/);
  assert.match(app.element("terms").innerHTML, /Partly unlocked/);
  assert.match(app.element("yearProgress").innerHTML, /aria-valuenow="25"/);
});

test("individual and bulk buttons persist lock changes and update progress", async () => {
  const app = await scheduler();
  await app.click("lock", "0-0");
  assert.equal(availability.sectionSchedule(app.records.get("term_01")[0], "A").isLocked, false);
  assert.match(app.element("yearProgress").innerHTML, /aria-valuenow="25"/);
  await app.click("lockall", "0");
  assert.ok(app.records.get("term_01").every((topic) => availability.sectionSchedule(topic, "A").isLocked));
  await app.click("lockall", "0");
  assert.ok(app.records.get("term_01").every((topic) => !availability.sectionSchedule(topic, "A").isLocked));
  assert.match(app.element("terms").innerHTML, /4\/4 unlocked/);
  assert.match(app.element("yearProgress").innerHTML, /aria-valuenow="100"/);
});

test("activity schedule uses the same lesson records and updates the topic tiles", async () => {
  const app = await scheduler();
  assert.match(app.element("activityScheduleStatus").textContent, /11 lesson/);
  await app.activityClick("0-0", "scheduled", "2099-10-20");
  assert.equal(availability.sectionSchedule(app.records.get("term_01")[0], "A").scheduledDate, "2099-10-20");
  assert.match(app.element("activityScheduleList").innerHTML, /Scheduled/);
  await app.activityClick("0-0", "now");
  assert.equal(availability.sectionSchedule(app.records.get("term_01")[0], "A").scheduledDate, "");
  assert.equal(availability.sectionSchedule(app.records.get("term_01")[0], "A").isLocked, false);
  assert.match(app.element("yearProgress").innerHTML, /aria-valuenow="25"/);
});

test("a confirmed activity lock stays selected before the delayed listener refresh arrives", async () => {
  const app = await scheduler({ emitAfterWrite: false });
  app.records.get("term_01")[0].isLocked = false;
  app.emit("term_01");
  await app.activityClick("0-0", "locked");
  assert.equal(availability.sectionSchedule(app.records.get("term_01")[0], "A").isLocked, true);
  const saved = decodeView(app.savedViews.get("schedule:sections"));
  assert.equal(availability.sectionSchedule(saved[0].docs[0].data(), "A").isLocked, true, "return-visit cache contains the acknowledged lock");
  const card = app.element("activityScheduleList").innerHTML.match(/data-activity="0-0"([\s\S]*?)<\/article>/)[1];
  assert.match(card, /value="locked" selected/);
  app.element("scheduleSection").value = "C"; app.element("scheduleSection").events.change();
  app.element("scheduleSection").value = "A"; app.element("scheduleSection").events.change();
  assert.match(app.element("activityScheduleList").innerHTML.match(/data-activity="0-0"([\s\S]*?)<\/article>/)[1], /value="locked" selected/);
  app.emit("term_01");
  assert.match(app.element("activityScheduleList").innerHTML.match(/data-activity="0-0"([\s\S]*?)<\/article>/)[1], /value="locked" selected/);
});

test("background snapshots retain unsaved activity access choices", async () => {
  const app = await scheduler();
  app.records.get("term_01")[0].isLocked = false; app.emit("term_01");
  app.activityChange("0-0", "locked");
  app.emit("term_02");
  assert.match(app.element("activityScheduleList").innerHTML.match(/data-activity="0-0"([\s\S]*?)<\/article>/)[1], /value="locked" selected/);
});

test("release-date drafts survive background updates and are cleared when changing sections", async () => {
  const app = await scheduler();
  app.records.get("term_01")[0].isLocked = false; app.emit("term_01");
  app.activityChange("0-0", "scheduled", "2099-10-20"); app.emit("term_03");
  const html = app.element("activityScheduleList").innerHTML.match(/data-activity="0-0"([\s\S]*?)<\/article>/)[1];
  assert.match(html, /value="scheduled" selected/);
  assert.match(html, /value="2099-10-20"/);
  assert.match(html, /<p>Unlocked<\/p>/, "drafts do not claim a completed save");
  app.element("scheduleSection").value = "C"; app.element("scheduleSection").events.change();
  const otherSection = app.element("activityScheduleList").innerHTML.match(/data-activity="0-0"([\s\S]*?)<\/article>/)[1];
  assert.match(otherSection, /value="now" selected/);
  assert.doesNotMatch(otherSection, /value="2099-10-20"/);
});

test("topic lock, bulk access and dates acknowledge successful writes before delayed subscription updates", async () => {
  const app = await scheduler({ emitAfterWrite: false });
  await app.click("lock", "0-0");
  assert.match(app.element("yearProgress").innerHTML, /aria-valuenow="25"/);
  await app.click("lockall", "0");
  await app.click("lockall", "0");
  assert.match(app.element("terms").innerHTML, /4\/4 unlocked/);
  await app.click("date", "0-0"); app.element("dateInput").value = "2099-10-20";
  await app.element("dateSave").onclick();
  assert.match(app.element("terms").innerHTML, /Scheduled/);
  const card = app.element("activityScheduleList").innerHTML.match(/data-activity="0-0"([\s\S]*?)<\/article>/)[1];
  assert.match(card, /value="scheduled" selected/);
});

test("activity schedule groups lessons in collapsible terms", async () => {
  const app = await scheduler();
  const list = app.element("activityScheduleList");
  assert.equal((list.innerHTML.match(/class="activity-term /g) || []).length, 3);
  assert.match(list.innerHTML, /data-activity-term="0" aria-expanded="false"/);
  assert.match(list.innerHTML, /id="activityTermRows0" hidden/);
  await app.activityTermClick(0);
  assert.match(list.innerHTML, /data-activity-term="0" aria-expanded="true"/);
  assert.match(list.innerHTML, /id="activityTermRows0"><article/);
  await app.activityClick("0-0", "now");
  assert.match(list.innerHTML, /data-activity-term="0" aria-expanded="true"/);
});

test("activity schedule omits the repeated Term 2 activity and retains the Term 3 lesson mapping", async () => {
  const app = await scheduler();
  const html = app.element("activityScheduleList").innerHTML;
  assert.equal((html.match(/data-activity="\d-\d"/g) || []).length, 11);
  assert.equal((html.match(/data-activity="1-\d"/g) || []).length, 3);
  assert.doesNotMatch(html, /data-activity="1-3"/);
  assert.match(html, /data-activity="2-0"/);
  assert.match(app.element("terms").innerHTML, /data-lock="1-3"/, "the curriculum topic is retained");
  await app.activityClick("2-0", "scheduled", "2099-10-20");
  assert.equal(availability.sectionSchedule(app.records.get("term_03")[0], "A").scheduledDate, "2099-10-20");
  assert.equal(availability.sectionSchedule(app.records.get("term_02")[3], "A").scheduledDate, "");
});

test("a rejected activity access change keeps the confirmed lesson state", async () => {
  const app = await scheduler();
  app.denyWrites();
  await app.activityClick("0-0", "now");
  assert.equal(app.records.get("term_01")[0].isLocked, true);
  assert.match(app.element("activityScheduleStatus").textContent, /Could not save activity access/);
});

test("date save locks an unlocked topic until release and manual unlock cancels it", async () => {
  const app = await scheduler();
  await app.click("lock", "0-0");
  await app.click("date", "0-0");
  app.element("dateInput").value = "2099-10-20";
  await app.element("dateSave").onclick();
  const topic = app.records.get("term_01")[0];
  assert.equal(availability.sectionSchedule(topic, "A").isLocked, true);
  assert.equal(availability.sectionSchedule(topic, "A").scheduledDate, "2099-10-20");
  assert.match(app.element("terms").innerHTML, /Scheduled/);
  await app.click("lock", "0-0");
  assert.equal(availability.sectionSchedule(topic, "A").isLocked, false);
  assert.equal(availability.sectionSchedule(topic, "A").scheduledDate, "");
});

test("a denied write leaves persisted state and progress unchanged", async () => {
  const app = await scheduler();
  app.denyWrites();
  await app.click("lock", "0-0");
  assert.equal(app.records.get("term_01")[0].isLocked, true);
  assert.match(app.element("yearProgress").innerHTML, /aria-valuenow="0"/);
  assert.match(app.element("syncStatus").textContent, /Could not save lock/);
});

test("signing out unsubscribes live listeners and removes progress claims", async () => {
  const app = await scheduler();
  await app.authChanged(null);
  assert.equal(app.listeners.size, 0);
  assert.match(app.element("terms").innerHTML, /Waiting for data/);
  assert.match(app.element("yearProgress").innerHTML, /Waiting for data/);
});

test("topic and activity saves follow one assigned section without changing other sections or legacy defaults", async () => {
  const app = await scheduler();
  await app.click("lock", "0-0");
  const record = app.records.get("term_01")[0];
  assert.equal(record.isLocked, true, "legacy app default must be retained");
  assert.equal(availability.sectionSchedule(record, "A").isLocked, false);
  app.element("scheduleSection").value = "C";
  app.element("scheduleSection").events.change();
  assert.match(app.element("yearProgress").innerHTML, /aria-valuenow="0"/);
  await app.activityClick("0-0", "scheduled", "2099-10-20");
  assert.equal(availability.sectionSchedule(record, "C").scheduledDate, "2099-10-20");
  assert.equal(availability.sectionSchedule(record, "A").isLocked, false);
  app.element("scheduleSection").value = "B";
  app.element("scheduleSection").events.change();
  assert.equal(app.element("scheduleSection").value, "C", "foreign sections cannot become the target");
  app.element("scheduleSection").value = "A";
  app.element("scheduleSection").events.change();
  assert.match(app.element("yearProgress").innerHTML, /aria-valuenow="25"/);
});

test("editing requires an explicit section and teachers without sections cannot change schedules", async () => {
  for (const app of [await scheduler({ chooseSection: false }), await scheduler({ sections: [] })]) {
    await app.click("lock", "0-0");
    assert.equal(app.records.get("term_01")[0].sectionSchedules, undefined);
    assert.match(app.element("terms").innerHTML, /Waiting for data/);
  }
});

test("return visits restore an assigned section but never a stale foreign section", async () => {
  const restored = await scheduler({ chooseSection: false, rememberedSection: "C" });
  assert.equal(restored.element("scheduleSection").value, "C");
  await restored.click("lock", "0-0");
  assert.equal(availability.sectionSchedule(restored.records.get("term_01")[0], "C").isLocked, false);
  const removed = await scheduler({ chooseSection: false, rememberedSection: "B" });
  await removed.click("lock", "0-0");
  assert.equal(removed.records.get("term_01")[0].sectionSchedules, undefined);
});
