import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixtures/web-data.js";
import { confirmAdministratorPassword } from "../server/admin-reauth.js";

async function harness() { const app = fixture(); return { ...app, cookie: await app.login("ADMIN1000", "admin") }; }
const statusWrite = { operation: "update", path: "users/TEACH1001", data: { active: false, status: "inactive" } };

test("admin status changes, removal and account creation reject missing password before writing", async () => {
  const app = await harness();
  for (const body of [{ action: "commit", writes: [statusWrite] }, { action: "commit", writes: [{ operation: "delete", path: "users/TEACH1001" }] },
    { action: "create-teacher", profile: { name: "New Teacher", email: "new@example.test" } }]) {
    const result = await app.call(body, app.cookie); assert.equal(result.status, 400);
  }
  assert.equal(app.store.began, 0); assert.equal(app.store.committed, 0);
  assert.equal(app.data.get("users/TEACH1001").active, true);
});

test("only a correct acting-admin password permits a sensitive mutation and no password is persisted", async () => {
  const app = await harness();
  assert.equal((await app.call({ action: "commit", password: "wrong", writes: [statusWrite] }, app.cookie)).status, 400);
  assert.equal(app.data.get("users/TEACH1001").active, true);
  const response = await app.call({ action: "commit", password: "correct", writes: [statusWrite] }, app.cookie);
  assert.equal(response.status, 200); assert.equal(app.data.get("users/TEACH1001").active, false);
  assert.doesNotMatch(JSON.stringify([...app.data]), /"password":"correct"|"password":"wrong"/);
  assert.doesNotMatch(await response.text(), /correct|private-token/);
});

test("incorrect confirmation lockout applies across mutation endpoints and blocks correct passwords during cooldown", async () => {
  const app = await harness();
  for (let i = 0; i < 3; i++) {
    const response = await app.call({ action: "commit", password: "wrong", writes: [statusWrite] }, app.cookie);
    assert.equal(response.status, i === 2 ? 429 : 400);
  }
  assert.equal((await app.call({ action: "create-teacher", password: "correct", profile: { name: "New Teacher", email: "new@example.test" } }, app.cookie)).status, 429);
  assert.equal((await app.auth("unlock", { identifier: "TEACH1001", password: "correct" }, app.cookie)).status, 429);
  assert.equal(app.store.committed, 0);
});

test("administrative login unlock requires password confirmation", async () => {
  const app = await harness();
  assert.equal((await app.auth("unlock", { identifier: "TEACH1001" }, app.cookie)).status, 400);
  assert.equal((await app.auth("unlock", { identifier: "TEACH1001", password: "wrong" }, app.cookie)).status, 400);
  assert.equal((await app.auth("unlock", { identifier: "TEACH1001", password: "correct" }, app.cookie)).status, 200);
});

test("teacher-scoped work does not acquire an admin prompt or administrative privileges", async () => {
  const app = await harness(), teacher = await app.login();
  assert.equal((await app.call({ action: "commit", writes: [{ operation: "update", path: "users/0026271000", data: { displayName: "Student Updated" } }] }, teacher)).status, 200);
  assert.equal((await app.call({ action: "commit", password: "correct", writes: [statusWrite] }, teacher)).status, 403);
});

test("reauthentication binds the password check to the administrator's Auth identity", async () => {
  let checked;
  const actor = { id: "ADMIN1", uid: "admin-uid", role: "admin" };
  const store = { identity: async uid => ({ localId: uid, email: "administrator@example.test" }) };
  await confirmAdministratorPassword({}, store, actor, "entered-password", async (_env, name, action, body) => { checked = { name, action, body }; return { ok: true }; });
  assert.equal(checked.name, "admin-security:admin-uid");
  assert.deepEqual(checked.body, { uid: "admin-uid", email: "administrator@example.test", password: "entered-password" });
  await assert.rejects(confirmAdministratorPassword({}, store, { ...actor, role: "teacher" }, "entered-password", () => assert.fail("Unauthorized role reached password service")), error => error.status === 403);
});
