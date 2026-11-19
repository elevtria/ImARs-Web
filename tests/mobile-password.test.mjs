import assert from "node:assert/strict";
import test from "node:test";
import { WebLoginState } from "../workers/web-auth-worker.js";
import { accountAccess } from "../server/account-access.js";

function fixture() {
  let time = 1_000_000, upstream = 0;
  const saved = new Map(), actors = new Map();
  const rows = new Map(["A", "B"].flatMap(id => [
    ["users/" + id, { uid: id, role: "student", classCode: "test", active: true, providedEmail: id + "@example.test" }],
    ["_accountAccess/" + id, { profileId: id, role: "student", active: true, authEmail: id + "@example.test" }]
  ]));
  const fetcher = async (_url, options) => {
    upstream++;
    const body = JSON.parse(options.body);
    if (body.password === "offline") throw new Error("Synthetic connection failure");
    if (body.password === "disabled") return Response.json({ error: { message: "USER_DISABLED" } }, { status: 400 });
    return body.password === "correct"
      ? Response.json({ localId: body.email.split("@")[0].toUpperCase(), email: body.email, idToken: "private", refreshToken: "private" })
      : Response.json({ error: { message: "INVALID_LOGIN_CREDENTIALS" } }, { status: 400 });
  };
  const env = { ACCOUNT_ACCESS_ENABLED: "true", WEB_LOGIN_STATE: {
    idFromName: name => name,
    get(name) {
      if (!actors.has(name)) {
        if (!saved.has(name)) saved.set(name, new Map());
        const data = saved.get(name);
        actors.set(name, new WebLoginState({ storage: {
          get: async key => structuredClone(data.get(key)),
          put: async (key, value) => data.set(key, structuredClone(value))
        } }, {}, { fetch: fetcher, now: () => time }));
      }
      return { fetch: (url, options) => actors.get(name).fetch(new Request(url, options)) };
    }
  } };
  const login = async (id = "A", password = "wrong") => {
    const response = await accountAccess({ env, request: new Request("https://test.example/api/account-access/login", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identifier: id, password })
    }) }, { store: { get: async path => rows.has(path) ? { data: rows.get(path) } : null }, fetcher });
    return { status: response.status, header: response.headers.get("Retry-After"), body: await response.json() };
  };
  return { login, saved, rows, env, upstream: () => upstream, restart: () => actors.clear(), advance: ms => { time += ms; } };
}

test("mobile shows counters and enforces a five-minute lock across devices and restarts", async () => {
  const app = fixture();
  assert.equal((await app.login()).body.attemptsRemaining, 2);
  assert.equal((await app.login()).body.attemptsRemaining, 1);
  const locked = await app.login();
  assert.equal(locked.status, 429);
  assert.equal(locked.body.loginProtection, true);
  assert.equal(locked.body.retryAfter, 300);
  assert.equal(locked.header, "300");
  app.restart();
  assert.equal((await app.login("A", "correct")).status, 429);
  assert.equal(app.upstream(), 3, "locked credentials never reach Firebase password verification");
  assert.equal((await app.login("B", "correct")).status, 200);
  app.advance(299_000);
  assert.equal((await app.login("A", "correct")).body.retryAfter, 1);
  app.advance(1_000);
  const success = await app.login("A", "correct");
  assert.deepEqual(success.body, { email: "a@example.test" });
  assert.equal((await app.login()).body.attemptsRemaining, 2);
});

test("parallel failed attempts cannot bypass mobile lockout and another batch repeats the five-minute cooldown", async () => {
  const app = fixture();
  const results = await Promise.all(Array.from({ length: 12 }, () => app.login()));
  assert.equal(results.filter(result => result.status === 401).length, 2);
  assert.equal(results.filter(result => result.status === 429).length, 10);
  assert.equal(app.upstream(), 3);
  app.advance(300_000);
  await app.login(); await app.login();
  assert.equal((await app.login()).body.retryAfter, 300);
  assert.equal(app.saved.get("account:A").has("sessions"), false, "password checks create no website sessions");
  assert.equal(app.saved.get("account:A").has("mobileSessions"), false, "failed passwords create no mobile receipts");
});

test("network failures and disabled identities do not use mobile password attempts", async () => {
  const app = fixture();
  assert.equal((await app.login()).body.attemptsRemaining, 2);
  assert.equal((await app.login("A", "offline")).status, 503);
  assert.equal((await app.login("A", "disabled")).status, 403);
  assert.equal((await app.login()).body.attemptsRemaining, 1);
  assert.equal((await app.login("A", "correct")).status, 200);
  assert.equal((await app.login()).body.attemptsRemaining, 2);
});

test("incorrect mobile passwords and cooldowns preserve existing website and mobile sessions", async () => {
  const app = fixture();
  await app.login();
  const stored = app.saved.get("account:A");
  const websiteSession = { existing: { private: "synthetic-existing-session" } };
  const mobileSessions = ["synthetic-existing-mobile-receipt"];
  stored.set("sessions", structuredClone(websiteSession));
  stored.set("mobileSessions", [...mobileSessions]);
  await app.login();
  assert.equal((await app.login()).status, 429);
  assert.deepEqual(stored.get("sessions"), websiteSession);
  assert.deepEqual(stored.get("mobileSessions"), mobileSessions);
});

test("archived students cannot obtain a login email or reactivate their profile", async () => {
  const app = fixture();
  app.rows.get("users/A").status = "archived";
  const result = await app.login("A", "correct");
  assert.equal(result.status, 401);
  assert.equal(result.body.email, undefined);
  assert.equal(app.upstream(), 0);
  assert.equal(app.rows.get("users/A").status, "archived");
});

test("legacy mobile sign-in is protected while account activation stays disabled", async () => {
  const app = fixture();
  app.env.ACCOUNT_ACCESS_ENABLED = "false";
  app.env.MOBILE_PASSWORD_PROTECTION_ENABLED = "true";
  assert.equal((await app.login()).body.attemptsRemaining, 2);
  assert.equal((await app.login()).body.attemptsRemaining, 1);
  assert.equal((await app.login()).body.retryAfter, 300);
  assert.equal((await app.login("A", "correct")).status, 429);
  app.advance(300_000);
  assert.equal((await app.login("A", "correct")).status, 200);
});
