import test from "node:test";
import assert from "node:assert/strict";
import { FirestoreAdmin, databaseQuotaFailure } from "../server/firestore-admin.js";
import { fixture } from "./fixtures/web-data.js";

test("database quota errors pause repeated reads and recover after the cooldown", async t => {
  let clock = Date.now(); t.mock.method(Date, "now", () => clock);
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ["sign", "verify"]);
  const key = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
  const env = { FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({ project_id: "imars-db-a733b", client_email: "quota-fixture@imars-db-a733b.iam.gserviceaccount.com", private_key: `-----BEGIN PRIVATE KEY-----\n${key}\n-----END PRIVATE KEY-----` }) };
  let calls = 0, exhausted = true;
  const store = new FirestoreAdmin(env, async url => {
    if (url.includes("oauth2.googleapis.com")) return Response.json({ access_token: "fixture", expires_in: 3600 });
    calls++;
    return exhausted ? Response.json({ error: { status: "RESOURCE_EXHAUSTED", message: "Quota exceeded." } }, { status: 429 }) : Response.json({ fields: { startYear: { integerValue: "2026" } } });
  });
  await assert.rejects(store.get("webSettings/schoolYear"), error => databaseQuotaFailure(error) && error.status === 503);
  await assert.rejects(store.get("webSettings/schoolYear"), error => databaseQuotaFailure(error));
  assert.equal(calls, 1, "do not hammer the exhausted database on retries");
  clock += 60_001; exhausted = false;
  assert.equal((await store.get("webSettings/schoolYear")).data.startYear, 2026);
  assert.equal(calls, 2);
});

test("a quota failure explains the login problem without granting access or counting a wrong password", async () => {
  const f = fixture(); const quota = Object.assign(new Error("Limit reached"), { code: "DATABASE_QUOTA_EXCEEDED", status: 503 });
  await f.login();
  f.store.get = async () => { throw quota; };
  const response = await f.auth("login", { identifier: "TEACH1000", portal: "teacher", password: "correct" });
  assert.equal(response.status, 503); assert.equal((await response.json()).code, "DATABASE_QUOTA_EXCEEDED");
  assert.equal(response.headers.get("Set-Cookie"), null);
  assert.equal(databaseQuotaFailure(new Error("Login state unavailable", { cause: quota })), true);
});
