import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./fixtures/web-data.js";
import { syncClassesAndTeachersFromFirestore } from "../server/web-data.js";
import { resolveStaff, stateCall } from "../server/web-auth.js";
import { loadAdminReports } from "../server/admin-report-data.js";

async function admin() {
  const app = fixture();
  app.data.get("users/ADMIN1000").authEmailVerified = true;
  app.data.get("users/TEACH1000").authEmailVerified = true;
  return { ...app, cookie: await app.login("ADMIN1000", "admin") };
}

const remove = id => ({ action: "commit", writes: [{ operation: "delete", path: "users/" + id }] });

test("teacher removal survives repeated directory imports and report refreshes", async () => {
  const app = await admin();
  const path = "users/TEACH1000";
  const oldTeacher = { ...app.data.get(path), sections: ["New Section"] };
  const originalStudent = structuredClone(app.data.get("users/0026271000"));
  const teacherCookie = await app.login();
  assert.equal((await app.call(remove("TEACH1000"), app.cookie)).status, 200);
  const removed = structuredClone(app.data.get(path));
  assert.equal(removed.active, false);
  assert.equal(removed.status, "deleted");
  assert.ok(removed.deletedAt);

  const firestoreWrites = [];
  const firestore = {
    async query(collection, { filters = [] } = {}) {
      return collection === "users" && filters[0]?.value === "teacher"
        ? [{ id: "TEACH1000", data: oldTeacher }] : [];
    },
    async begin() {},
    async commit(writes) { firestoreWrites.push(...writes); }
  };
  // Simulate an older Firestore copy after its deletion mirror failed.
  for (let refresh = 0; refresh < 2; refresh++) {
    await syncClassesAndTeachersFromFirestore(app.store, app.env, null, { firestore });
    assert.deepEqual(app.data.get(path), removed);
    const report = await app.call({ action: "admin-report" }, app.cookie);
    assert.equal(report.status, 200);
    assert.deepEqual((await report.json()).teachers.map(row => row.id), ["TEACH1001"]);
  }
  assert.deepEqual(firestoreWrites, []);
  assert.equal([...app.data.values()].some(row => row.SectionName === "New Section"), false);
  assert.deepEqual(app.data.get("users/0026271000"), originalStudent);
  assert.equal(app.data.get("classes/A").teacherId, "TEACH1000");
  const denied = await app.call({ action: "admin-report" }, teacherCookie);
  assert.equal(denied.status, 401);

  // Resolving a deleted account must stop before any Firestore import/sign-in.
  app.env.IMARS_SUPABASE_WEB_DATA = "true";
  assert.equal(await resolveStaff(app.env, "TEACH1000", [], app.store), null);
  assert.deepEqual(app.data.get(path), removed);
});

test("only administrators may remove teachers, and stale activation cannot undo removal", async () => {
  const app = await admin();
  const teacher = await app.login();
  assert.equal((await app.call(remove("TEACH1001"), teacher)).status, 403);
  assert.equal(app.data.get("users/TEACH1001").active, true);
  assert.equal((await app.call(remove("ADMIN1000"), app.cookie)).status, 403);
  assert.equal((await app.call(remove("TEACH1001"), app.cookie)).status, 200);
  assert.equal((await app.call({ action: "commit", writes: [{ operation: "update", path: "users/TEACH1001",
    data: { active: true, status: "active" } }] }, app.cookie)).status, 403);
  assert.equal(app.data.get("users/TEACH1001").status, "deleted");
  assert.equal((await app.call(remove("TEACH1001"), app.cookie)).status, 200);
});

test("reports hide deleted teachers while retaining ordinary inactive staff", async () => {
  const app = await admin();
  app.data.get("users/TEACH1000").status = "deleted";
  Object.assign(app.data.get("users/TEACH1001"), { active: false, status: "inactive" });
  const report = await loadAdminReports(app.store);
  assert.deepEqual(report.teachers.map(row => row.id), ["TEACH1001"]);
  assert.equal(report.teachers[0].active, false);
});

test("removing an invitation disables its reservation and imports respect tombstones outside the roster page", async () => {
  const app = await admin();
  const response = await app.call({ action: "create-teacher", profile: { name: "Test Teacher", email: "new@example.test" } }, app.cookie);
  assert.equal(response.status, 200);
  const { id } = await response.json();
  const oldTeacher = structuredClone(app.data.get("users/" + id));
  assert.equal((await app.call(remove(id), app.cookie)).status, 200);
  const invitation = await stateCall(app.env, "staff-roster", "roster-get", { id });
  assert.equal(invitation.result.account.active, false);

  const query = app.store.query.bind(app.store);
  app.store.query = async (...args) => (await query(...args)).filter(row => row.id !== id);
  await syncClassesAndTeachersFromFirestore(app.store, app.env, null, { firestore: {
    async query(collection, { filters = [] } = {}) {
      return collection === "users" && filters[0]?.value === "teacher" ? [{ id, data: oldTeacher }] : [];
    }
  } });
  assert.equal(app.data.get("users/" + id).status, "deleted");
  assert.equal(app.data.get("users/" + id).active, false);
});

test("directory imports still add legitimate teachers and their assigned sections", async () => {
  const app = await admin();
  const mirrored = [];
  await syncClassesAndTeachersFromFirestore(app.store, app.env, null, { firestore: {
    async query(collection, { filters = [] } = {}) {
      return collection === "users" && filters[0]?.value === "teacher" ? [{ id: "TEACH1010",
        data: { role: "teacher", displayName: "Real Teacher", active: true, status: "active", sections: ["Oxygen"] } }] : [];
    },
    async begin() {},
    async commit(writes) { mirrored.push(...writes); }
  } });
  assert.equal(app.data.get("users/TEACH1010").displayName, "Real Teacher");
  const section = mirrored.find(write => write.path.startsWith("classes/"));
  assert.equal(section.data.SectionName, "Oxygen");
  assert.equal(app.data.get(section.path).teacherId, "TEACH1010");
});
