import test from "node:test";
import assert from "node:assert/strict";
import { accountAccess } from "../server/account-access.js";

function fixture() {
  const records = new Map([["users/STUDENT", { uid: "student-a", role: "student", active: true, providedEmail: "old@example.test" }]]);
  const sent = [];
  let verified = true;
  const store = {
    get: async path => records.has(path) ? { data: records.get(path), updateTime: "v1" } : null,
    identity: async () => ({ email: "verified@example.test", emailVerified: verified }),
    begin: async () => {}, rollback: async () => {},
    commit: async writes => { for (const write of writes) records.set(write.path, write.data); }
  };
  const call = (body = { identifier: "STUDENT" }) => accountAccess({
    env: { MOBILE_PASSWORD_PROTECTION_ENABLED: "true" },
    request: new Request("https://test.example/api/account-access/password-recovery", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    })
  }, { store, fetcher: async (url, options) => { sent.push({ url, body: JSON.parse(options.body) }); return Response.json({}); } });
  return { records, sent, call, unverify: () => { verified = false; } };
}

test("mobile recovery sends Firebase reset mail only to the verified account email and limits resends", async () => {
  const f = fixture();
  assert.equal((await f.call()).status, 200);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].url, /accounts:sendOobCode/);
  assert.deepEqual(f.sent[0].body, { requestType: "PASSWORD_RESET", email: "verified@example.test" });
  assert.deepEqual(await (await f.call()).json(), { ok: true });
  assert.equal(f.sent.length, 1);
  assert.equal((await f.call({ identifier: "STUDENT", email: "attacker@example.test" })).status, 400);
});

test("unknown, archived and unverified accounts get no reset email or account disclosure", async () => {
  const f = fixture();
  assert.deepEqual(await (await f.call({ identifier: "UNKNOWN" })).json(), { ok: true });
  f.records.get("users/STUDENT").status = "archived";
  assert.deepEqual(await (await f.call()).json(), { ok: true });
  f.records.get("users/STUDENT").status = "active";
  f.unverify();
  assert.deepEqual(await (await f.call()).json(), { ok: true });
  assert.equal(f.sent.length, 0);
});
