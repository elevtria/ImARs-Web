import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../js/teacher-notifications.js", import.meta.url), "utf8")
  .replace(/^import .*;\r?\n/gm, "").replace("export function", "function");
const item = { id: "S1:term_01:lesson_02:pre", name: "Ana <script>", section: "A", termId: "term_01", lessonId: "lesson_02", kind: "pre" };
function setup({ enabled = true, blocked = false } = {}) {
  const nodes = [], storage = new Map(), timers = new Map(); let listener, fallback;
  function node(tag) {
    const el = { tag, children: [], events: {}, attributes: {}, hidden: false,
      append(...children) { this.children.push(...children); }, prepend(child) { this.children.unshift(child); },
      replaceChildren(...children) { this.children = children; }, setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener(name, callback) { this.events[name] = callback; },
      contains(target) { return this === target || this.children.some(child => child.contains(target)); },
      querySelector() { return null; }, focus() { this.focused = true; }
    }; nodes.push(el); return el;
  }
  const toolbar = node("toolbar"), document = node("document"), window = node("window");
  document.querySelector = () => toolbar; document.createElement = node;
  const auth = { currentUser: { uid: "teacher-a", role: "teacher" } };
  const context = { document, window, console,
    localStorage: { getItem: key => { if (blocked) throw Error(); return storage.get(key) || null; }, setItem: (key, value) => { if (blocked) throw Error(); storage.set(key, value); } },
    onAuthStateChanged: (_, callback) => { listener = callback; },
    getDashboardSummary: async () => ({ enabled, ready: true, summary: { notifications: [item] } }),
    watchVisibleData: () => () => {},
    reportNotifications: () => [item],
    createTeacherReport: options => (fallback = { async open() { options.render({ sections: [], complete: true }); }, stop() { this.stopped = true; } }),
    setTimeout: callback => { timers.set(timers.size + 1, callback); return timers.size; }, clearTimeout: id => timers.delete(id)
  };
  vm.runInNewContext(source + "\ninitTeacherNotifications({}, auth);", vm.createContext({ ...context, auth }));
  const find = className => nodes.find(el => el.className === className);
  const settle = async () => { await new Promise(resolve => setImmediate(resolve)); };
  return { auth, document, window, storage, find, settle, get fallback() { return fallback; },
    async signIn(user = auth.currentUser) { auth.currentUser = user; listener(user); await settle(); } };
}

test("bell shows unread completions, safe student text and persistent mark-all-read", async () => {
  const f = setup(); await f.signIn();
  const bell = f.find("theme-toggle notification-toggle"), panel = f.find("notification-panel");
  assert.equal(f.find("notification-badge").textContent, "1");
  assert.equal(panel.hidden, true); bell.events.click(); await f.settle(); assert.equal(panel.hidden, false);
  const link = f.find("notification-list").children[0].children[0];
  assert.equal(link.children[0].textContent, item.name); assert.equal(link.children[0].innerHTML, undefined);
  assert.match(link.children[1].textContent, /pre-test.*Term 1, Lesson 2/);
  f.find("notification-mark").events.click();
  assert.equal(f.find("notification-badge").hidden, true);
  await f.signIn(); assert.equal(f.find("notification-badge").hidden, true);
  await f.signIn({ uid: "teacher-b", role: "teacher" }); assert.equal(f.find("notification-badge").hidden, false);
  assert.equal(f.storage.size, 1);
});
test("clicking a completion marks it read; Escape and outside clicks close the menu", async () => {
  const f = setup(); await f.signIn();
  const bell = f.find("theme-toggle notification-toggle"), panel = f.find("notification-panel");
  bell.events.click();
  f.find("teacher-notifications").events.keydown({ key: "Escape" });
  assert.equal(panel.hidden, true); assert.equal(bell.focused, true);
  bell.events.click(); f.document.events.click({ target: {} }); assert.equal(panel.hidden, true);
  const link = f.find("notification-list").children[0].children[0]; link.events.click();
  assert.equal(link.href, "student-records.html"); assert.equal(f.find("notification-badge").hidden, true);
});
test("legacy report fallback works with blocked storage and stops when the account changes", async () => {
  const f = setup({ enabled: false, blocked: true }); await f.signIn();
  const report = f.fallback;
  assert.equal(f.find("notification-badge").textContent, "1");
  f.find("notification-mark").events.click(); assert.equal(f.find("notification-badge").hidden, true);
  await f.signIn(null); assert.equal(report.stopped, true); assert.equal(f.find("teacher-notifications").hidden, true);
  assert.equal(f.find("notification-list").children.length, 0);
});
