import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const source = readFileSync(new URL("../js/analytics-print.js", import.meta.url), "utf8")
  .replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "").replaceAll("import.meta.url", JSON.stringify(import.meta.url));
function harness() {
  const events = {}, body = { classList: { add() {}, remove() {} }, append(node) { this.printed = node; } };
  let calls = 0;
  const context = vm.createContext({ escapeHtml, SCHOOL_NAME: "School", SCHOOL_ADDRESS: "Address", URL,
    window: { addEventListener: (name, callback) => { events[name] = callback; }, print: () => { calls++; events.beforeprint(); } },
    document: { body, createElement: () => ({ remove() { this.removed = true; } }) } });
  vm.runInContext(source, context);
  const cell = text => ({ textContent: text, cloneNode: () => ({ textContent: text, querySelectorAll: () => [] }) });
  const table = { tHead: { rows: [{ cells: [cell("Student"), cell("Topic <script>"), cell("Quiz")] }, { cells: [cell("Activity"), cell("Pre-test"), cell("Post-test"), cell("Quiz one")] }] },
    querySelectorAll: () => [{ cells: [cell('Demo <img onerror="x">'), cell("3/4"), cell("0/5"), cell("8/10"), cell("Pending review")] }] };
  return { context, events, body, calls: () => calls, view: { table, section: "A", term: "Term 1", schoolYear: "SY 2026-27", teacher: "Teacher", scope: "Showing 1-1 of 30 students", generatedLabel: "14 Nov 2026" } };
}

test("Print analytics opens the native dialog immediately and restores the page after printing", () => {
  const app = harness();
  const install = vm.runInContext("installAnalyticsPrint", app.context);
  let note;
  const print = install({ readView: () => app.view, available: () => true, notify: text => { note = text; } });
  print();
  assert.equal(app.calls(), 1);
  assert.match(note, /current table page/);
  const printed = app.body.printed;
  assert.match(printed.innerHTML, /Current table page/);
  assert.match(printed.innerHTML, /0\/5/);
  assert.match(printed.innerHTML, /Pending review/);
  assert.match(printed.innerHTML, /&lt;img onerror=&quot;x&quot;&gt;/);
  assert.doesNotMatch(printed.innerHTML, /<script>|<img onerror/);
  assert.match(printed.innerHTML, /Teacher quiz results/);
  app.events.afterprint();
  assert.equal(printed.removed, true);
  app.events.beforeprint();
  assert.ok(app.body.printed !== printed, "browser print shortcuts rebuild the current table");
});

test("Teacher Manual retains the same native print action and restores collapsed sections", () => {
  const events = {}, button = {}, dropdowns = [{ open: false }, { open: true }];
  let prints = 0;
  const context = vm.createContext({ window: { location: { hash: "" }, addEventListener: (name, callback) => { events[name] = callback; },
    print: () => { prints++; events.beforeprint(); } }, document: {
    querySelectorAll: selector => selector === ".manual-dropdown" ? dropdowns : [], getElementById: () => button
  } });
  vm.runInContext(readFileSync(new URL("../js/teacher-manual.js", import.meta.url), "utf8"), context);
  button.onclick();
  assert.equal(prints, 1);
  assert.ok(dropdowns.every(item => item.open));
  events.afterprint();
  assert.deepEqual(dropdowns.map(item => item.open), [false, true]);
});
