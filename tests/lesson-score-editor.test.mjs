import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { validLessonScore } from "../js/lesson-score.js";

function editor(onSave) {
  const element = () => ({ value: "", style: {}, events: {}, setAttribute() {}, focus() {}, select() {}, addEventListener(name, callback) { this.events[name] = callback; } });
  const score = element(), maximum = element(), status = element(), cancel = element(), save = element();
  const form = Object.assign(element(), { elements: { namedItem: name => name === "score" ? score : maximum }, reportValidity: () => true });
  const dialog = Object.assign(element(), { querySelector: selector => ({ form, "[role=status]": status, "button[type=button]": cancel, "button[type=submit]": save })[selector],
    close() { this.closed = true; }, remove() { this.removed = true; }, showModal() { this.open = true; } });
  let saved = 0;
  const context = vm.createContext({ validLessonScore, escapeHtml: value => String(value).replaceAll("<", "&lt;"), window: { addEventListener() {} },
    document: { createElement: () => dialog, body: { append() {} } }, onSave, onSaved: () => saved++ });
  const source = readFileSync(new URL("../js/lesson-score-editor.js", import.meta.url), "utf8")
    .replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
  vm.runInContext(source + '\nopenLessonScoreEditor({kind:"pre",studentName:"Student",lessonTitle:"Topic",score:2,maximum:5,onSave,onSaved});', context);
  return { score, maximum, status, cancel, save, dialog, saved: () => saved, submit: () => form.events.submit({ preventDefault() {} }) };
}

test("Cancel and invalid scores do not write; failed saves keep the editor available to retry", async () => {
  let writes = 0;
  const app = editor(async () => { writes++; throw new Error("Please retry."); });
  app.score.value = "6";
  await app.submit();
  assert.equal(writes, 0);
  assert.match(app.status.textContent, /between 0/);
  app.score.value = "3";
  await app.submit();
  assert.equal(writes, 1);
  assert.equal(app.status.textContent, "Please retry.");
  assert.equal(app.save.disabled, false);
  assert.equal(app.dialog.removed, undefined);
  app.cancel.events.click();
  assert.equal(app.dialog.removed, true);
  assert.equal(writes, 1);
  assert.equal(app.saved(), 0);
});

test("a pending save prevents duplicates and a saved zero closes the editor", async () => {
  let finish, writes = 0, savedScore;
  const app = editor(value => { writes++; savedScore = value.score; return new Promise(resolve => { finish = resolve; }); });
  app.score.value = "0";
  const pending = app.submit();
  await app.submit();
  assert.equal(writes, 1);
  assert.equal(app.save.disabled, true);
  assert.equal(app.cancel.disabled, true);
  finish();
  await pending;
  assert.equal(savedScore, 0);
  assert.equal(app.dialog.closed, true);
  assert.equal(app.dialog.removed, true);
  assert.equal(app.saved(), 1);
});
