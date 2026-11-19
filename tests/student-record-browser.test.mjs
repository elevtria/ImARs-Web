import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

test("opening a record requests fresh results, while repainting the modal does not loop through more reads", () => {
  let mutation, painted = 0, button;
  const requested = [], handlers = {};
  const row = { dataset: { studentId: "S1" }, classList: { contains: () => false },
    querySelector: () => button || null, append: value => { button = value; },
    cloneNode: () => ({ querySelector: () => null }) };
  const list = { querySelectorAll: () => [row], dispatchEvent: event => requested.push(event.detail),
    addEventListener: (name, fn) => { handlers[name] = fn; } };
  const dialog = { open: false, showModal() { this.open = true; }, addEventListener() {} };
  const elements = { recordsContainer: list, studentRecordDialog: dialog,
    studentRecordContent: { replaceChildren() { painted++; }, addEventListener() {} },
    previousStudentRecord: { addEventListener() {} }, nextStudentRecord: { addEventListener() {} },
    closeStudentRecord: { addEventListener() {} }, studentRecordPosition: {}, recordsTerm: { value: "term_01" } };
  const source = readFileSync(new URL("../js/student-record-browser.js", import.meta.url), "utf8").replace(/^import[^\n]+\r?\n/gm, "");
  vm.runInNewContext(source, { getAuth: () => ({ currentUser: null }),
    CustomEvent: class { constructor(_name, options) { this.detail = options.detail; } },
    MutationObserver: class { constructor(callback) { mutation = callback; } observe() {} },
    window: { addEventListener() {} }, document: { getElementById: id => elements[id],
      createElement: () => ({ setAttribute() {} }) } });
  handlers.click({ target: { closest: selector => selector === ".record" ? row : null } });
  assert.equal(requested.length, 1); assert.equal(requested[0].studentId, "S1"); assert.equal(requested[0].refresh, true);
  mutation(); mutation();
  assert.equal(requested.length, 1, "fresh result repaints must not trigger another fresh-result request");
  assert.equal(painted, 3);
});
