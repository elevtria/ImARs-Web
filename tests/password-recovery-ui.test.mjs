import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";

function page(request) {
  const elements = new Map(), calls = [];
  const get = id => {
    if (!elements.has(id)) elements.set(id, { value: "", textContent: "", dataset: {}, hidden: false, disabled: false,
      events: {}, addEventListener(name, handler) { this.events[name] = handler; },
      setAttribute() {}, removeAttribute(name) { if (name === "data-error") delete this.dataset.error; },
      focus() { this.focused = true; }, showModal() { this.open = true; }, close() { this.open = false; this.events.close?.(); } });
    return elements.get(id);
  };
  vm.runInNewContext(readFileSync(new URL("../js/teacher-password-recovery.js", import.meta.url), "utf8").replace(/^import .*;\r?\n/, ""), {
    document: { getElementById: get }, webRequest: async (path, body) => { calls.push({ path, body }); return request(); }
  });
  return { get, calls, open: () => get("forgotPasswordButton").events.click(), submit: () => get("teacherRecoveryForm").events.submit({ preventDefault() {} }) };
}

test("recovery dialog pre-fills only the Teacher ID, prevents duplicate sends, and returns to sign-in", async () => {
  let done;
  const app = page(() => new Promise(resolve => { done = resolve; }));
  app.get("teacherId").value = " teach1000 "; app.open();
  assert.equal(app.get("teacherRecoveryDialog").open, true);
  assert.equal(app.get("recoveryTeacherId").value, "teach1000");
  const pending = app.submit(); await app.submit();
  assert.equal(app.calls.length, 1);
  assert.deepEqual(app.calls[0].body.identifier, "TEACH1000");
  assert.equal(app.get("sendTeacherRecovery").disabled, true);
  done({ message: "If eligible, check your email." }); await pending;
  assert.equal(app.get("teacherRecoveryStatus").textContent, "If eligible, check your email.");
  assert.equal(app.get("sendTeacherRecovery").hidden, true);
  app.get("closeTeacherRecovery").events.click();
  assert.equal(app.get("teacherRecoveryDialog").open, false);
  assert.equal(app.get("recoveryTeacherId").value, "");
});

test("invalid IDs do not send and recovery errors allow retry without clearing the login form", async () => {
  const app = page(async () => { throw new Error("Offline"); });
  app.get("teacherId").value = "TEACH1000"; app.open();
  app.get("recoveryTeacherId").value = "ADMIN1000"; await app.submit();
  assert.equal(app.calls.length, 0);
  app.get("recoveryTeacherId").value = "TEACH1000"; await app.submit();
  assert.equal(app.get("sendTeacherRecovery").disabled, false);
  assert.equal(app.get("teacherId").value, "TEACH1000");
  assert.equal(app.get("teacherRecoveryStatus").dataset.error, "true");
});
