import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const source = readFileSync(new URL("../js/analytics-print.js", import.meta.url), "utf8")
  .replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "").replaceAll("import.meta.url", JSON.stringify(import.meta.url));
function harness({ images = [] } = {}) {
  const events = {}, body = { classList: { add() {}, remove() {} }, append(node) { this.printed = node; } };
  let calls = 0;
  const context = vm.createContext({ escapeHtml, SCHOOL_NAME: "School", SCHOOL_ADDRESS: "Address", URL,
    window: { addEventListener: (name, callback) => { events[name] = callback; }, print: () => { calls++; events.beforeprint(); } },
    document: { body, createElement: () => ({ querySelectorAll: () => images, remove() { this.removed = true; } }) } });
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
  assert.match(printed.innerHTML, /Lesson and generated quiz results/);
  assert.match(printed.innerHTML, /<th scope="colgroup" colspan="1">Generated quizzes<\/th>/);
  assert.match(printed.innerHTML, /<img[^>]*alt="Pintong Gubat Elementary School logo"/);
  assert.match(printed.innerHTML, /@page \{ size: A4 landscape; margin: 0 !important; \}/);
  app.events.afterprint();
  assert.equal(printed.removed, true);
  app.events.beforeprint();
  assert.ok(app.body.printed !== printed, "browser print shortcuts rebuild the current table");
});

test("printed pages repeat the school heading and retain every student and overflow quiz score", () => {
  const app = harness();
  const cell = text => ({ textContent: text, cloneNode: () => ({ textContent: text, querySelectorAll: () => [] }) });
  app.view.table.tHead.rows[1].cells = ["Activity", "Pre-test", "Post-test", ...Array.from({ length: 7 }, (_, i) => `Quiz ${i + 1}`)].map(cell);
  app.view.table.querySelectorAll = () => Array.from({ length: 25 }, (_, i) => ({ cells: [`Learner ${i + 1}`, "3/4", "2/5", "8/10", ...Array.from({ length: 7 }, (_, q) => `${i + 1}-${q + 1}/10`)].map(cell) }));
  const html = vm.runInContext("analyticsPrintHtml", app.context)(app.view);
  const pages = [...html.matchAll(/<section class="analytics-print-panel">(.*?)<\/section>/gs)].map(match => match[1]);
  assert.equal(pages.length, 6, "three student pages for each of the combined and overflow-quiz tables");
  for (const page of pages) {
    assert.match(page, /Pintong Gubat Elementary School logo/);
    assert.ok(page.indexOf("analytics-print-heading") < page.indexOf("<table>"));
    assert.ok((page.match(/<th scope="row">/g) || []).length <= 10);
  }
  for (let student = 1; student <= 25; student++) {
    for (let quiz = 1; quiz <= 7; quiz++) assert.equal((html.match(new RegExp(`>${student}-${quiz}/10<`, "g")) || []).length, 1);
  }
  assert.match(pages[0], /Generated quizzes.*Quiz 1.*Quiz 2/s);
  assert.match(pages[3], /Quiz 3.*Quiz 7/s);
});

test("Print report waits for the school logo before opening the dialog", async () => {
  let loaded;
  const app = harness({ images: [{ complete: false, naturalWidth: 0, decode: () => new Promise(resolve => { loaded = resolve; }) }] });
  const print = vm.runInContext("installAnalyticsPrint", app.context)({ readView: () => app.view, available: () => true, notify() {} });
  const pending = print();
  assert.equal(app.calls(), 0);
  const prepared = app.body.printed;
  loaded();
  await pending;
  assert.equal(app.calls(), 1);
  assert.equal(app.body.printed, prepared, "beforeprint keeps the decoded logo and prepared report");
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
