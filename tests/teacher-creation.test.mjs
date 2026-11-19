import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./fixtures/web-data.js";

async function admin() {
  const app = fixture();
  app.data.get("users/ADMIN1000").authEmailVerified = true;
  return { ...app, cookie: await app.login("ADMIN1000", "admin") };
}

test("Add Teacher accepts a name and email without creating sections or requiring a subject", async () => {
  for (const name of ["Alex Reyes", "Ma. José Niño", "Mary-Jane O'Connor", "Ana O’Reyes", "李老师"]) {
    const app = await admin();
    const before = [...app.data.keys()].filter(path => path.startsWith("classes/"));
    const response = await app.call({ action: "create-teacher", profile: { name, email: "new@example.test" } }, app.cookie);
    assert.equal(response.status, 200, await response.clone().text());
    const { id } = await response.json();
    const saved = app.data.get("users/" + id);
    assert.equal(saved.fullName, name);
    assert.equal(saved.displayName, name);
    assert.equal(saved.subject, "");
    assert.deepEqual(saved.sections, []);
    assert.deepEqual([...app.data.keys()].filter(path => path.startsWith("classes/")), before);
    assert.equal(saved.status, "invited");
  }
});

test("numeric and malformed teacher names are rejected before any account is saved", async () => {
  const app = await admin();
  for (const name of [123, null, "", "   ", "123", "Alex Reyes2", "１２３", "Alex_Reyes", "<script>", "Alex\nReyes", "A".repeat(121)]) {
    const response = await app.call({ action: "create-teacher", profile: { name, email: "new@example.test" } }, app.cookie);
    assert.equal(response.status, 400, String(name));
  }
  assert.equal(app.store.committed, 0);
  assert.equal(app.data.has("users/TEACH1002"), false);
});

test("teacher creation retains valid older invitations and still requires an administrator", async () => {
  const app = await admin();
  const input = { action: "create-teacher", profile: { name: "New Teacher", email: "new@example.test", subject: "Science", sections: ["Hydrogen"] } };
  app.data.get("users/TEACH1000").authEmailVerified = true;
  const teacher = await app.login();
  assert.equal((await app.call(input, teacher)).status, 403);
  assert.equal(app.store.committed, 0);
  const response = await app.call(input, app.cookie);
  assert.equal(response.status, 200, await response.clone().text());
  const { id } = await response.json();
  assert.equal(app.data.get("users/" + id).subject, "Science");
  assert.deepEqual(app.data.get("users/" + id).sections, ["Hydrogen"]);
});
