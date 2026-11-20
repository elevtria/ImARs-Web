import assert from "node:assert/strict";
import test from "node:test";
import { authApi } from "../server/web-auth.js";
import { fixture } from "./fixtures/web-data.js";

function recoveryApp() {
  const app = fixture(), emails = [], jobs = [];
  const fetcher = async (url, options) => {
    assert.match(String(url), /^https:\/\/identitytoolkit\.googleapis\.com\/v1\/accounts:sendOobCode\?/);
    emails.push(JSON.parse(options.body));
    return Response.json({ email: "private@example.test", oobCode: "never-expose" });
  };
  const call = (identifier = "TEACH1000", { headers = {}, body = {}, background = false, send = fetcher } = {}) => authApi({ env: app.env,
    request: app.request("/api/web-auth/forgot-password", { identifier, ...body }, null, headers),
    ...(background ? { waitUntil: job => jobs.push(job) } : {}) }, Date.now(), { store: app.store, fetcher: send });
  return { ...app, emails, jobs, call };
}

test("teacher recovery uses the verified Auth email, shares the admin cooldown, and exposes no credentials", async () => {
  const app = recoveryApp();
  app.store.identity = async uid => ({ localId: uid, email: "verified-auth@example.test", emailVerified: true });
  const before = structuredClone(app.data.get("users/TEACH1000"));
  const result = await app.call(" teach1000 ", { body: { email: "attacker@example.test", password: "ignored" } });
  assert.equal(result.status, 200);
  const text = await result.text();
  assert.match(text, /If that Teacher ID/);
  assert.doesNotMatch(text, /verified-auth|attacker|oobCode|never-expose|private@example/);
  assert.deepEqual(app.emails, [{ requestType: "PASSWORD_RESET", email: "verified-auth@example.test" }]);
  assert.deepEqual(app.data.get("users/TEACH1000"), before, "requesting recovery cannot change passwords, status or roles");
  assert.equal(result.headers.get("Set-Cookie"), null);
  assert.equal(result.headers.get("Cache-Control"), "no-store");
  assert.ok(app.data.get("webSettings/security/resetLimits/TEACH1000").until > Date.now());
  const repeat = await app.call(); assert.equal(await repeat.text(), text);
  assert.equal(app.emails.length, 1);
  assert.ok([...app.data.values()].some(row => row.action === "password-reset-sent" && row.actorId === "SELF_SERVICE"));
});

test("unknown, inactive, unverified, disabled and nonteacher accounts get the same generic response without email", async () => {
  const success = recoveryApp(); const expected = await (await success.call()).text();
  for (const scenario of ["unknown", "inactive", "archived", "unverified", "disabled", "student", "admin", "wrong-uid"]) {
    const app = recoveryApp(); const profile = app.data.get("users/TEACH1000");
    if (scenario === "unknown") app.data.delete("users/TEACH1000");
    if (scenario === "inactive") profile.active = false;
    if (scenario === "archived") profile.status = "archived";
    if (scenario === "unverified") profile.authEmailVerified = false;
    if (scenario === "disabled") profile.authDisabled = true;
    if (["student", "admin"].includes(scenario)) profile.role = scenario;
    if (scenario === "wrong-uid") app.store.identity = async () => ({ localId: "other", email: "other@example.test", emailVerified: true });
    const result = await app.call();
    assert.equal(result.status, 200, scenario); assert.equal(await result.text(), expected, scenario);
    assert.equal(app.emails.length, 0, scenario);
  }
});

test("recovery rejects cross-site, invalid IDs and excessive requests before sending", async () => {
  const app = recoveryApp();
  assert.equal((await app.call("TEACH1000", { headers: { Origin: "https://evil.example" } })).status, 403);
  assert.equal((await app.call("TEACH1000", { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
  for (const value of ["ADMIN1000", "0026271000", "teacher@example.test", "../users/TEACH1000", {}, ""]) assert.equal((await app.call(value)).status, 400);
  for (let index = 0; index < 6; index++) assert.equal((await app.call("TEACH9999")).status, 200);
  const limited = await app.call("TEACH9999");
  assert.equal(limited.status, 429); assert.equal(limited.headers.get("Retry-After"), "60");
  assert.equal(app.emails.length, 0);
});

test("IP limits cover different IDs and database conflicts or changed ownership never send", async () => {
  const app = recoveryApp();
  for (let index = 0; index < 6; index++) assert.equal((await app.call("TEACH" + (9000 + index), { headers: { "CF-Connecting-IP": "192.0.2.1" } })).status, 200);
  assert.equal((await app.call("TEACH1000", { headers: { "CF-Connecting-IP": "192.0.2.1" } })).status, 429);
  assert.equal(app.emails.length, 0);
  for (const kind of ["conflict", "changed"]) {
    const app = recoveryApp();
    if (kind === "conflict") app.store.conflict = true;
    else app.store.onBegin = () => { app.data.get("users/TEACH1000").active = false; };
    assert.equal((await app.call()).status, 200); assert.equal(app.emails.length, 0);
    assert.equal(app.store.transaction, false);
  }
});

test("background lookup does not delay the generic response, and provider failures stay private", async () => {
  const app = recoveryApp(); let release;
  const gate = new Promise(resolve => { release = resolve; });
  const identity = app.store.identity.bind(app.store);
  app.store.identity = async uid => { await gate; return identity(uid); };
  const response = await app.call("TEACH1000", { background: true, send: async () => Response.json({ error: "PRIVATE_PROVIDER_ERROR" }, { status: 500 }) });
  assert.equal(response.status, 200); assert.equal(app.jobs.length, 1);
  assert.equal(app.store.began, 0); release(); await Promise.all(app.jobs);
  assert.ok([...app.data.values()].some(row => row.action === "password-reset-failed"));
  assert.doesNotMatch(await response.text(), /PRIVATE_PROVIDER_ERROR/);
});

test("a reset request leaves existing sign-in cooldowns in place", async () => {
  const app = recoveryApp();
  for (let index = 0; index < 3; index++) await app.auth("login", { identifier: "TEACH1000", password: "wrong", portal: "teacher" });
  assert.equal((await app.call()).status, 200);
  assert.equal((await app.auth("login", { identifier: "TEACH1000", password: "correct", portal: "teacher" })).status, 429);
});
