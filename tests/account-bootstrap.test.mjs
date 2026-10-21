import assert from "node:assert/strict";
import test from "node:test";
import { validateAccessManifest, prepareAccessBootstrap } from "../server/account-bootstrap.js";
import { decodeFields } from "../server/firestore-admin.js";
const entries = [
  { uid: "admin-a", profileId: "ADMIN1000", role: "admin", active: true, authEmail: "admin@example.test" },
  { uid: "student-a", profileId: "0026271000", role: "student", active: true, authEmail: "student@example.test" }
];
function fixture() {
  const records = new Map(entries.map(entry => ["users/" + entry.profileId, { data: { uid: entry.uid, role: entry.role }, updateTime: "version-1" }]));
  const store = { get: async key => records.get(key), name: key => "projects/fixture/databases/(default)/documents/" + key,
    findUser: async uid => {
      const matches = [...records].filter(([key, value]) => key.startsWith("users/") && value.data.uid === uid);
      return matches.length === 1 ? { id: matches[0][0].split("/")[1] } : null;
    }
  };
  const lookup = async uid => ({ localId: uid, email: entries.find(entry => entry.uid === uid)?.authEmail });
  return { records, store, lookup };
}
test("bootstrap requires a reviewed role/UID/email mapping, rejects duplicates and retains an active administrator", () => {
  assert.equal(validateAccessManifest(entries).length, 2);
  for (const invalid of [[], [entries[1]], [entries[0], entries[0]], [{ ...entries[0], uid: "../other" }], [{ ...entries[0], active: false }]]) {
    assert.throws(() => validateAccessManifest(invalid));
  }
});
test("bootstrap produces guarded verify/create pairs without modifying user profiles", async () => {
  const app = fixture();
  const plan = await prepareAccessBootstrap(entries, app.store, app.lookup);
  assert.equal(plan.writes.length, 4);
  assert.ok(plan.writes[0].verify.endsWith("users/ADMIN1000"));
  assert.deepEqual(plan.writes[0].currentDocument, { updateTime: "version-1" });
  assert.deepEqual(plan.writes[1].currentDocument, { exists: false });
  assert.equal(decodeFields(plan.writes[1].update.fields).role, "admin");
  assert.equal(app.records.size, 2, "planning does not write");
});
test("bootstrap refuses role escalation, Auth mismatches, disabled identities and conflicting existing bindings", async () => {
  const app = fixture();
  app.records.get("users/ADMIN1000").data.role = "student";
  await assert.rejects(prepareAccessBootstrap(entries, app.store, app.lookup));
  app.records.get("users/ADMIN1000").data.role = "admin";
  await assert.rejects(prepareAccessBootstrap(entries, app.store, async () => ({ localId: "other", email: "admin@example.test" })));
  await assert.rejects(prepareAccessBootstrap(entries, app.store, async uid => ({ ...await app.lookup(uid), disabled: true })));
  app.records.set("_accountAccess/admin-a", { data: { profileId: "OTHER", role: "admin", authEmail: "admin@example.test", active: true } });
  await assert.rejects(prepareAccessBootstrap(entries, app.store, app.lookup));
});
test("bootstrap refuses an unreviewed duplicate profile carrying an approved user's UID", async () => {
  const app = fixture();
  app.records.set("users/UNREVIEWED", { data: { uid: "admin-a", role: "student" }, updateTime: "version-1" });
  await assert.rejects(prepareAccessBootstrap(entries, app.store, app.lookup), /duplicated/);
});
test("a completed bootstrap can be checked again without replacing existing bindings", async () => {
  const app = fixture();
  for (const entry of entries) app.records.set("_accountAccess/" + entry.uid, { data: { ...entry } });
  assert.equal((await prepareAccessBootstrap(entries, app.store, app.lookup)).writes.length, 0);
});
