import assert from "node:assert/strict";
import test from "node:test";
import { decision, emptyState, passwordFailed, verifiedSuccess, resetAfterApproval, cooldowns } from "../server/web-lockout.js";
import { WebLoginState, default as privateWorker } from "../workers/web-auth-worker.js";
import { authApi, protectWebsite, signSession, webSession } from "../server/web-auth.js";
import { RENEW_AFTER_MS, IDLE_AFTER_MS, ABSOLUTE_AFTER_MS, PREVIOUS_GRACE_MS } from "../server/web-session.js";
import { accountAccess } from "../server/account-access.js";
import { onRequest, CONTENT_SECURITY_POLICY } from "../functions/_middleware.js";

const accounts = [
  { id: "TEACH1000", uid: "teacher-a", email: "teacher@example.test", role: "teacher" },
  { id: "TEACH1001", uid: "teacher-b", email: "other@example.test", role: "teacher" },
  { id: "ADMIN1000", uid: "admin-a", email: "admin@example.test", role: "admin" }
];

test("security headers prevent HTML caching and preserve API bodies and existing session cookies", async () => {
  for (const [path, status, type, body] of [
    ["/login", 200, "text/html", "<h1>Login</h1>"],
    ["/api/generate-quiz", 401, "application/json", '{"error":"Sign in"}']
  ]) {
    const response = await onRequest({ request: new Request(`https://imars.example.test${path}`), env: {},
      next: async () => new Response(body, { status, headers: { "Content-Type": type, "Cache-Control": "no-store", "Set-Cookie": "existing=value; Secure; HttpOnly" } }) });
    assert.equal(response.status, status);
    assert.equal(await response.text(), body);
    assert.equal(response.headers.get("Cache-Control"), type === "text/html" ? "private, no-store" : "no-store");
    assert.match(response.headers.get("Set-Cookie"), /existing=value/);
    assert.equal(response.headers.get("Content-Security-Policy"), CONTENT_SECURITY_POLICY);
    const scriptPolicy = CONTENT_SECURITY_POLICY.split(";").map(rule => rule.trim()).find(rule => rule.startsWith("script-src "));
    assert.ok(!scriptPolicy.includes("'unsafe-inline'") && !scriptPolicy.includes("'unsafe-eval'"));
    assert.ok(CONTENT_SECURITY_POLICY.includes("script-src-attr 'none'"));
    assert.ok(CONTENT_SECURITY_POLICY.includes("object-src 'none'"));
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(response.headers.get("X-Frame-Options"), "DENY");
    assert.match(response.headers.get("Permissions-Policy"), /camera=\(self\)/);
  }
});

test("security headers also cover redirects from protected routes", async () => {
  const app = fixture();
  const response = await onRequest({ request: new Request("https://imars.example.test/admin-dashboard"), env: app.env,
    next: async () => { throw new Error("An unauthenticated request must not open the page"); } });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), "/login?reason=web-session");
  assert.equal(response.headers.get("Content-Security-Policy"), CONTENT_SECURITY_POLICY);
});

function fixture() {
  let time = Date.now(), verifications = 0, outage = false, wrongUid = false;
  const stores = new Map(), actors = new Map();
  const namespace = {
    idFromName: name => name,
    get(name) {
      if (!actors.has(name)) {
        const values = stores.get(name) || new Map(); stores.set(name, values);
        const storage = { get: async key => structuredClone(values.get(key)), put: async (key, value) => values.set(key, structuredClone(value)) };
        actors.set(name, new WebLoginState({ storage }, {}, { now: () => time, fetch: async (_, options) => {
          verifications++;
          if (outage) throw new Error("Network outage");
          await new Promise(resolve => setTimeout(resolve, 1));
          const body = JSON.parse(options.body);
          if (body.password !== "correct") return Response.json({ error: { message: "INVALID_LOGIN_CREDENTIALS" } }, { status: 400 });
          const account = accounts.find(item => item.email === body.email);
          return Response.json({ localId: wrongUid ? "different-person" : account.uid, idToken: "upstream-token", refreshToken: "upstream-refresh" });
        } }));
      }
      return { fetch: (url, options) => actors.get(name).fetch(new Request(url, options)) };
    }
  };
  const env = { WEB_LOGIN_ENABLED: "true", WEB_STAFF_ACCOUNTS: JSON.stringify(accounts),
    WEB_SESSION_SECRET: "unit-test-session-key-not-a-real-secret", WEB_MAINTENANCE_KEY: "unit-test-maintenance-key-not-a-real-secret", WEB_LOGIN_STATE: namespace };
  const request = (action, body, cookie, extraHeaders = {}) => new Request(`https://imars.example.test/api/web-auth/${action}`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://imars.example.test", ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders }, body: JSON.stringify(body)
  });
  const call = (action, body = {}, cookie, headers) => authApi({ env, request: request(action, body, cookie, headers) }, time);
  const login = (identifier = "TEACH1000", password = "wrong", portal = "teacher", extra = {}) => call("login", { identifier, password, portal, ...extra });
  const cookieOf = response => response.headers.get("Set-Cookie")?.split(";")[0];
  const page = (path, cookie, headers = {}) => protectWebsite({ env,
    request: new Request(`https://imars.example.test${path}`, { headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } }),
    next: async () => new Response("portal-page") }, time);
  return { env, stores, actors, namespace, call, login, page, cookieOf, request,
    now: () => time, advance: amount => { time += amount; }, count: () => verifications,
    outage: () => { outage = true; }, wrongUid: () => { wrongUid = true; } };
}

test("three failures cause five minutes, the next three five hours, and the final three require manual recovery", () => {
  let state = emptyState(), now = 1000;
  for (let stage = 0; stage < 3; stage++) {
    for (let failure = 0; failure < 3; failure++) state = passwordFailed(state, now);
    assert.equal(state.stage, stage + 1);
    assert.equal(decision(state, now).allowed, false);
    if (stage < 2) {
      assert.equal(state.until, now + cooldowns[stage]);
      assert.equal(decision(state, state.until - 1).allowed, false);
      now = state.until;
      assert.equal(decision(state, now).allowed, true);
    }
  }
  assert.equal(decision(state, now + 365 * 86400_000).manual, true);
  assert.throws(() => verifiedSuccess(state, now), /locked/);
  const unlocked = resetAfterApproval(state);
  assert.equal(decision(unlocked, now).allowed, true);
  assert.equal(unlocked.version, state.version + 1);
});

test("a verified success resets the streak; repeated requests during a lock do not extend it", () => {
  let state = emptyState();
  for (let i = 0; i < 3; i++) state = passwordFailed(state, 1000);
  assert.deepEqual(passwordFailed(state, 2000), state);
  const restored = verifiedSuccess(state, state.until);
  assert.equal(restored.stage, 0);
  assert.equal(restored.failures, 0);
  assert.equal(restored.version, state.version);
  assert.throws(() => decision({ ...state, failures: -1 }, 0), /Invalid/);
});

test("parallel requests cannot all verify against a stale two-attempt counter", async () => {
  const app = fixture();
  const responses = await Promise.all(Array.from({ length: 12 }, () => app.login()));
  assert.equal(app.count(), 3);
  assert.deepEqual(responses.slice(0, 3).map(response => response.status), [401, 401, 429]);
  assert.ok(responses.slice(3).every(response => response.status === 429));
  const stored = app.stores.get("account:teacher-a").get("account");
  assert.equal(stored.stage, 1);
});

test("temporary and permanent web locks survive new requests, actor restart, and browser-provided fake state", async () => {
  const app = fixture();
  for (let stage = 0; stage < 3; stage++) {
    for (let i = 0; i < 3; i++) await app.login("teach1000", "wrong", "teacher", { failures: -100, until: 0, blocked: false, now: 999999999999999 });
    app.actors.delete("account:teacher-a");
    const denied = await app.login("TEACH1000", "correct");
    assert.equal(denied.status, 429);
    const body = await denied.json();
    if (stage < 2) { assert.equal(body.retryAfter, cooldowns[stage] / 1000); app.advance(cooldowns[stage]); }
    else { assert.equal(body.manual, true); assert.match(body.error, /Contact your administrator/); }
  }
  app.advance(365 * 86400_000);
  assert.equal((await app.login("TEACH1000", "correct")).status, 429);
});

test("successful login mints a secure signed cookie and never returns Firebase tokens", async () => {
  const app = fixture();
  const response = await app.login("TEACH1000", "correct");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { email: "teacher@example.test" });
  for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) assert.ok(response.headers.get("Set-Cookie").includes(flag));
  assert.ok(!/Max-Age=|Expires=/i.test(response.headers.get("Set-Cookie")), "a website login must not set a persistent cookie");
  const page = await app.page("/index", app.cookieOf(response));
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("Cache-Control"), "private, no-store");
});

test("forged cookies, Firebase tokens alone, alternate URL spellings, and expired cookies cannot open admin pages", async () => {
  const app = fixture();
  const teacherCookie = app.cookieOf(await app.login("TEACH1000", "correct"));
  for (const path of ["/manage-teachers", "/manage-teachers.html", "/manage%2Dteachers", "//manage-teachers", "/assets/%2e%2e%2fmanage-teachers"]) {
    assert.equal((await app.page(path, teacherCookie)).status, 403, path);
  }
  assert.equal((await app.page("/index", undefined, { Authorization: "Bearer legitimate-firebase-token" })).status, 302);
  assert.equal((await app.page("/api/generate-quiz", undefined, { Authorization: "Bearer legitimate-firebase-token" })).status, 401);
  const [name, token] = teacherCookie.split("=");
  const [payload, signature] = token.split(".");
  const data = JSON.parse(Buffer.from(payload, "base64url"));
  data.role = "admin"; data.id = "ADMIN1000"; data.uid = "admin-a";
  const forged = `${name}=${Buffer.from(JSON.stringify(data)).toString("base64url")}.${signature}`;
  assert.equal((await app.page("/admin-dashboard", forged)).status, 302);
  const expired = await signSession(app.env, accounts[0], { ...data, rotatedAt: Date.now() - 13 * 3600_000, absoluteUntil: Date.now() - 3600_000 }, "imars.example.test");
  assert.equal(await webSession(new Request("https://imars.example.test/index", { headers: { Cookie: `${name}=${expired}` } }), app.env), null);
});

test("a new lock revokes old website sessions; waiting does not resurrect them", async () => {
  const app = fixture();
  const cookie = app.cookieOf(await app.login("TEACH1000", "correct"));
  for (let i = 0; i < 3; i++) await app.login();
  assert.equal((await app.page("/index", cookie)).status, 302);
  app.advance(cooldowns[0]);
  assert.equal((await app.page("/index", cookie)).status, 302);
  const fresh = app.cookieOf(await app.login("TEACH1000", "correct"));
  assert.equal((await app.page("/index", fresh)).status, 200);
});

test("teachers cannot unlock themselves or others; approved admins can restore teacher access", async () => {
  const app = fixture();
  const teacher = app.cookieOf(await app.login("TEACH1001", "correct"));
  const admin = app.cookieOf(await app.login("admin@example.test", "correct", "admin"));
  for (let i = 0; i < 3; i++) await app.login();
  assert.equal((await app.call("unlock", { identifier: "TEACH1000" }, teacher)).status, 403);
  assert.equal((await app.call("unlock", { identifier: "TEACH1000" })).status, 403);
  assert.equal((await app.call("unlock", { identifier: "TEACH1000" }, admin)).status, 200);
  assert.equal((await app.login("TEACH1000", "correct")).status, 200);
  assert.equal((await app.call("unlock", { identifier: "ADMIN1000" }, admin)).status, 403);
});

test("only the private maintenance key can recover an administrator and it never authenticates portal pages", async () => {
  const app = fixture();
  const headers = { Authorization: `Bearer ${app.env.WEB_MAINTENANCE_KEY}` };
  assert.equal((await app.call("unlock", { identifier: "ADMIN1000" }, undefined, { Authorization: `Bearer ${"x".repeat(40)}` })).status, 403);
  assert.equal((await app.call("unlock", { identifier: "ADMIN1000" }, undefined, headers)).status, 200);
  assert.equal((await app.page("/admin-dashboard", undefined, headers)).status, 302);
});

test("admin email and school ID aliases share one server attempt counter", async () => {
  const app = fixture();
  await app.login("admin@example.test", "wrong", "admin");
  await app.login("ADMIN1000", "wrong", "admin");
  assert.equal((await app.login("admin@example.test", "wrong", "admin")).status, 429);
  assert.equal((await app.login("ADMIN1000", "correct", "admin")).status, 429);
});

test("network errors and identity mismatches do not count as incorrect passwords or issue a session", async () => {
  for (const mode of ["outage", "wrongUid"]) {
    const app = fixture(); app[mode]();
    const response = await app.login("TEACH1000", "correct");
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Set-Cookie"), null);
    assert.equal(app.stores.get("account:teacher-a").has("account"), false);
  }
});

test("logout clears the cookie and invalidates captured old sessions", async () => {
  const app = fixture();
  const cookie = app.cookieOf(await app.login("TEACH1000", "correct"));
  const response = await app.call("logout", {}, cookie);
  assert.match(response.headers.get("Set-Cookie"), /Max-Age=0/);
  assert.equal((await app.page("/index", cookie)).status, 302);
});

test("cross-origin unlocks, non-JSON bodies, and malformed configuration fail closed", async () => {
  const app = fixture();
  const admin = app.cookieOf(await app.login("ADMIN1000", "correct", "admin"));
  assert.equal((await app.call("unlock", { identifier: "TEACH1000" }, admin, { Origin: "https://attacker.test" })).status, 403);
  assert.equal((await app.call("unlock", {}, admin, { "Content-Type": "text/plain" })).status, 415);
  app.env.WEB_STAFF_ACCOUNTS = JSON.stringify([...accounts, accounts[0]]);
  assert.equal((await app.page("/index", admin)).status, 503);
  assert.equal((await app.login()).status, 503);
});

test("protection is opt-in, static assets stay public, and the state Worker has no public interface", async () => {
  const app = fixture();
  assert.equal((await app.page("/assets/markers/apple.png")).status, 200);
  assert.equal((await app.page("/assets/site-0123456789abcdefabcd/js/login.js")).status, 200);
  app.env.WEB_LOGIN_ENABLED = "false";
  assert.equal((await app.page("/index")).status, 200);
  const config = await authApi({ env: app.env, request: new Request("https://imars.example.test/api/web-auth/config") });
  assert.deepEqual(await config.json(), { enabled: false });
  assert.equal((await privateWorker.fetch(new Request("https://worker.example.test/unlock"))).status, 404);
});
test("mobile gateway configuration is reachable without a web cookie while other protected APIs still require one", async () => {
  const app = fixture();
  const request = new Request("https://imars.example.test/api/account-access/config");
  const response = await protectWebsite({ env: app.env, request, next: () => accountAccess({ env: app.env, request }) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { enabled: false });
  assert.equal((await app.page("/api/generate-quiz")).status, 401);
});

test("successful logins at the same instant have independent random website sessions", async () => {
  const app = fixture();
  const first = app.cookieOf(await app.login("TEACH1000", "correct"));
  const second = app.cookieOf(await app.login("TEACH1000", "correct"));
  assert.notEqual(first, second);
  assert.equal((await app.page("/index", first)).status, 200);
  assert.equal((await app.page("/index", second)).status, 200);
  assert.equal(Object.keys(app.stores.get("account:teacher-a").get("sessions")).length, 2);
});

test("active sessions renew after 15 minutes; previous credentials cannot upgrade or extend activity", async () => {
  const app = fixture();
  const original = app.cookieOf(await app.login("TEACH1000", "correct"));
  app.advance(RENEW_AFTER_MS - 60_000);
  await app.call("session", { active: true }, original);
  app.advance(60_000);
  const responses = await Promise.all(Array.from({ length: 4 }, () => app.call("session", { active: true }, original)));
  assert.ok(responses.every(response => response.status === 200));
  assert.equal(responses.filter(response => app.cookieOf(response)).length, 1, "one rotation across concurrent tabs");
  const rotated = app.cookieOf(responses.find(response => app.cookieOf(response)));
  assert.notEqual(original, rotated);
  const timing = await responses[0].json();
  assert.deepEqual(Object.keys(timing).sort(), ["absoluteUntil", "idleUntil", "renewAt", "serverNow"]);
  app.advance(PREVIOUS_GRACE_MS - 1);
  const overlapping = await app.call("session", { active: true }, original);
  assert.equal(overlapping.status, 200);
  assert.equal(overlapping.headers.get("Set-Cookie"), null);
  assert.equal((await overlapping.json()).idleUntil, timing.idleUntil, "old credentials do not extend idle time");
  app.advance(1);
  assert.equal((await app.call("session", { active: true }, original)).status, 401);
  assert.equal((await app.page("/index", original)).status, 302);
  assert.equal((await app.call("session", { active: false }, rotated)).status, 200);
  const decode = value => JSON.parse(Buffer.from(value.split("=")[1].split(".")[0], "base64url"));
  assert.notEqual(decode(original).sid, decode(rotated).sid);
  assert.equal(decode(original).exp, decode(rotated).exp, "renewal cannot slide the absolute deadline");
});

test("teacher and admin page navigation can renew the cookie without changing page content or role", async () => {
  for (const [identifier, portal, path] of [["TEACH1000", "teacher", "/index"], ["ADMIN1000", "admin", "/admin-dashboard"]]) {
    const app = fixture();
    const cookie = app.cookieOf(await app.login(identifier, "correct", portal));
    app.advance(RENEW_AFTER_MS - 1);
    assert.equal((await app.page(path, cookie)).status, 200);
    app.advance(1);
    const page = await app.page(path, cookie);
    assert.equal(await page.text(), "portal-page");
    assert.ok(app.cookieOf(page));
    assert.equal(page.headers.get("Cache-Control"), "private, no-store");
  }
});

test("passive checks cannot keep an idle session alive or revive it using browser timestamps", async () => {
  const app = fixture();
  const cookie = app.cookieOf(await app.login("TEACH1000", "correct"));
  for (let minute = 1; minute < 15; minute++) {
    app.advance(60_000);
    const response = await app.call("session", { active: false, now: 0, idleUntil: 99999999999999 }, cookie);
    assert.equal(response.status, 200);
  }
  app.advance(60_000);
  assert.equal((await app.call("session", { active: true, now: 0 }, cookie)).status, 401);
  assert.equal((await app.page("/index", cookie)).status, 302);
  assert.equal(Object.keys(app.stores.get("account:teacher-a").get("sessions")).length, 0);
});

test("12-hour absolute expiry survives continuous activity and many renewals", async () => {
  const app = fixture();
  let cookie = app.cookieOf(await app.login("TEACH1000", "correct"));
  for (let elapsed = 10 * 60_000; elapsed < ABSOLUTE_AFTER_MS; elapsed += 10 * 60_000) {
    app.advance(10 * 60_000);
    const response = await app.call("session", { active: true }, cookie);
    assert.equal(response.status, 200, String(elapsed));
    cookie = app.cookieOf(response) || cookie;
  }
  app.advance(10 * 60_000);
  assert.equal((await app.call("session", { active: true }, cookie)).status, 401);
  assert.equal((await app.page("/index", cookie)).status, 302);
});

test("renewed sessions survive Durable Object restart, but absent server state never authenticates a signed cookie", async () => {
  const app = fixture();
  let cookie = app.cookieOf(await app.login("TEACH1000", "correct"));
  app.advance(10 * 60_000);
  await app.call("session", { active: true }, cookie);
  app.advance(5 * 60_000);
  cookie = app.cookieOf(await app.call("session", { active: true }, cookie));
  app.actors.delete("account:teacher-a");
  assert.equal((await app.page("/index", cookie)).status, 200);
  app.stores.get("account:teacher-a").delete("sessions");
  app.actors.delete("account:teacher-a");
  assert.equal((await app.page("/index", cookie)).status, 302);
});

test("logout revokes every browser session and retained previous credentials for that web account", async () => {
  const app = fixture();
  const first = app.cookieOf(await app.login("TEACH1000", "correct"));
  let second = app.cookieOf(await app.login("TEACH1000", "correct"));
  app.advance(10 * 60_000);
  await app.call("session", { active: true }, second);
  app.advance(5 * 60_000);
  second = app.cookieOf(await app.call("session", { active: true }, second));
  assert.equal((await app.call("logout", {}, second)).status, 200);
  for (const cookie of [first, second]) assert.equal((await app.call("session", { active: true }, cookie)).status, 401);
});

test("session storage is bounded and retiring the oldest browser does not invalidate newer ones", async () => {
  const app = fixture();
  const cookies = [];
  for (let i = 0; i < 21; i++) { cookies.push(app.cookieOf(await app.login("TEACH1000", "correct"))); app.advance(1); }
  assert.equal(Object.keys(app.stores.get("account:teacher-a").get("sessions")).length, 20);
  assert.equal((await app.page("/index", cookies[0])).status, 302);
  assert.equal((await app.page("/index", cookies.at(-1))).status, 200);
});

test("session endpoint rejects cross-origin / malformed activity and distinguishes state outages from expiry", async () => {
  const app = fixture();
  const cookie = app.cookieOf(await app.login("TEACH1000", "correct"));
  assert.equal((await app.call("session", { active: true }, cookie, { Origin: "https://attacker.test" })).status, 403);
  assert.equal((await app.call("session", { active: "true" }, cookie)).status, 400);
  app.env.WEB_LOGIN_STATE = { idFromName: name => name, get() { throw new Error("Unavailable"); } };
  assert.equal((await app.call("session", { active: false }, cookie)).status, 503);
  assert.equal((await app.page("/index", cookie)).status, 503);
});

test("automatic data refreshes cannot extend an idle website session", async () => {
  const app = fixture(), cookie = app.cookieOf(await app.login("TEACH1000", "correct"));
  app.advance(IDLE_AFTER_MS - 1000);
  assert.equal((await app.page("/api/web-data", cookie)).status, 200);
  app.advance(1001);
  assert.equal((await app.call("session", { active: false }, cookie)).status, 401);
});

test("a stale tab cannot rotate, clear or revoke another account's shared cookie", async () => {
  const app = fixture(), cookie = app.cookieOf(await app.login("ADMIN1000", "correct", "admin"));
  app.advance(RENEW_AFTER_MS - 1000);
  for (const action of ["session", "logout"]) {
    const response = await app.call(action, { active: true }, cookie, { "X-Web-User": "teacher-a" });
    assert.equal(response.status, 401); assert.equal(response.headers.get("Set-Cookie"), null);
  }
  assert.equal((await app.call("session", { active: true }, cookie, { "X-Web-User": "admin-a" })).status, 200);
});
