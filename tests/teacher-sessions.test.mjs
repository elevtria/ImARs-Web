import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixtures/web-data.js";
import { authApi, webSession } from "../server/web-auth.js";
import { accountAccess } from "../server/account-access.js";
import { openTeacherSession, checkTeacherSession } from "../server/teacher-sessions.js";

const teacher = { id: "TEACH1000", uid: "teacher-a", email: "teacher@example.test", role: "teacher" };
const other = { id: "TEACH1001", uid: "teacher-b", email: "other@example.test", role: "teacher" };
const env = { TEACHER_SESSION_SYNC_ENABLED: "true" };
const receipt = char => char.repeat(64);

function sharedStore() {
  let revision = 0; const rows = new Map();
  return { rows, async get(path) { return structuredClone(rows.get(path) || null); },
    async commit(writes) {
      for (const write of writes) {
        const current = rows.get(write.path);
        if (write.updateTime ? current?.updateTime !== write.updateTime : current) throw Object.assign(new Error("Conflict"), { status: 409 });
        rows.set(write.path, { data: structuredClone(write.data), updateTime: String(++revision) });
      }
    }
  };
}

test("one shared teacher record enforces both login directions across independent hosts", async () => {
  const store = sharedStore();
  const webEpoch = await openTeacherSession(env, store, teacher, "web");
  assert.equal(await checkTeacherSession(env, store, teacher, "web", webEpoch), true);
  assert.equal(await openTeacherSession(env, store, teacher, "web"), webEpoch, "same-platform tabs can coexist");
  await openTeacherSession(env, store, teacher, "mobile", receipt("a"));
  assert.equal(await checkTeacherSession(env, store, teacher, "web", webEpoch), false);
  assert.equal(await checkTeacherSession(env, store, teacher, "mobile", receipt("a")), true);
  const backupEpoch = await openTeacherSession({ ...env }, store, teacher, "web");
  assert.notEqual(backupEpoch, webEpoch);
  assert.equal(await checkTeacherSession(env, store, teacher, "mobile", receipt("a")), false);
  assert.equal(await checkTeacherSession(env, store, teacher, "web", webEpoch), false, "an old cookie cannot revive after switching back");
  assert.equal(await checkTeacherSession(env, store, teacher, "web", backupEpoch), true);
  assert.ok(!JSON.stringify([...store.rows]).includes(receipt("a")), "only hashes of mobile receipts are stored");
});

test("concurrent claims retry storage conflicts and never revive the losing platform", async () => {
  const store = sharedStore();
  const epochs = await Promise.all([openTeacherSession(env, store, teacher, "web"), openTeacherSession(env, store, teacher, "mobile", receipt("b"))]);
  const allowed = await Promise.all([checkTeacherSession(env, store, teacher, "web", epochs[0]), checkTeacherSession(env, store, teacher, "mobile", receipt("b"))]);
  assert.equal(allowed.filter(Boolean).length, 1);
});

test("takeovers remain teacher scoped, legacy receipts fail closed and storage failures are retryable", async () => {
  const store = sharedStore();
  const b = await openTeacherSession(env, store, other, "web");
  await openTeacherSession(env, store, teacher, "mobile", receipt("c"));
  assert.equal(await checkTeacherSession(env, store, other, "web", b), true);
  assert.equal(await checkTeacherSession(env, store, teacher, "web", undefined), false);
  assert.equal(await checkTeacherSession(env, store, teacher, "mobile", receipt("d")), false);
  assert.equal(await openTeacherSession(env, store, { ...teacher, role: "admin" }, "web"), undefined);
  await assert.rejects(checkTeacherSession(env, { get: async () => { throw new Error("Unavailable"); } }, teacher, "mobile", receipt("c")), /Unavailable/);
});

test("cookie rotation preserves the shared epoch and session-store outages do not claim a logout", async t => {
  let clock = Date.now(); t.mock.method(Date, "now", () => clock);
  const f = fixture(); f.env.TEACHER_SESSION_SYNC_ENABLED = "true";
  const original = await f.login();
  clock += 14 * 60_000;
  assert.equal((await f.auth("session", { active: true }, original)).status, 200);
  clock += 2 * 60_000;
  const rotated = await f.auth("session", { active: false }, original);
  assert.equal(rotated.status, 200);
  const cookie = rotated.headers.get("Set-Cookie").split(";")[0];
  assert.notEqual(cookie, original);
  const payload = value => JSON.parse(Buffer.from(value.split("=")[1].split(".")[0], "base64url"));
  assert.equal(payload(cookie).teacherSession, payload(original).teacherSession);
  const get = f.store.get;
  f.store.get = path => path.startsWith("_accountAccess/") ? Promise.reject(new Error("Offline")) : get(path);
  assert.equal((await f.auth("session", { active: false }, cookie)).status, 503);
  f.store.get = get;
  assert.equal((await f.auth("session", { active: false }, cookie)).status, 200);
  await openTeacherSession(f.env, f.store, teacher, "mobile", receipt("e"));
  assert.equal((await f.auth("session", { active: false }, cookie)).status, 401);
});

test("upstream failure at rotation leaves the old cookie usable, and logout revokes it without Firestore", async t => {
  let clock = Date.now(); t.mock.method(Date, "now", () => clock);
  const f = fixture(); f.env.TEACHER_SESSION_SYNC_ENABLED = "true";
  const original = await f.login();
  clock += 14 * 60_000;
  assert.equal((await f.auth("session", { active: true }, original)).status, 200);
  clock += 60_000;
  const get = f.store.get;
  f.store.get = async () => { throw new Error("Offline"); };
  const unavailable = await f.auth("session", { active: false }, original);
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get("Set-Cookie"), null);
  clock += 60_000;
  f.store.get = get;
  const recovered = await f.auth("session", { active: false }, original);
  assert.equal(recovered.status, 200);
  const rotated = recovered.headers.get("Set-Cookie").split(";")[0];
  f.store.get = async () => assert.fail("logout must not read Firestore");
  assert.equal((await f.auth("logout", {}, rotated)).status, 200);
  f.store.get = get;
  assert.equal((await f.auth("session", { active: false }, rotated)).status, 401);
});

test("real web and mobile handlers revoke one another without changing endpoint contracts", async () => {
  const f = fixture();
  f.env.TEACHER_SESSION_SYNC_ENABLED = "true"; f.env.TEACHER_MOBILE_SESSIONS_ENABLED = "true";
  const config = await accountAccess({ env: f.env, request: new Request("https://imars.example.test/api/account-access/config") });
  assert.equal((await config.json()).teacherSessionSync, true);
  const makeRequest = (host, path, body, cookie, bearer) => new Request(host + path, { method: "POST", headers: {
    "Content-Type": "application/json", Origin: host, ...(cookie ? { Cookie: cookie } : {}), ...(bearer ? { Authorization: "Bearer " + bearer } : {})
  }, body: JSON.stringify(body) });
  const host = "https://imars.example.test", backup = "https://imars-backup.test";
  const fetcher = async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.includes("signInWithPassword")) return body.password === "correct" ? Response.json({ localId: teacher.uid, idToken: "private-token" }) : Response.json({ error: { message: "INVALID_PASSWORD" } }, { status: 400 });
    return Response.json({ users: [{ localId: teacher.uid, email: teacher.email, emailVerified: true }] });
  };
  const mobile = (action, body) => accountAccess({ env: f.env, request: makeRequest(host, "/api/account-access/" + action, body, null, "mobile-proof") }, { store: f.store, fetcher });
  const cookie = await f.login();
  const adminCookie = await f.login("ADMIN1000", "admin");
  const otherCookie = await f.login(other.id);
  assert.equal((await f.auth("session", { active: false }, cookie)).status, 200);
  assert.equal((await mobile("teacher-session-login", { password: "wrong" })).status, 401);
  assert.equal((await f.auth("session", { active: false }, cookie)).status, 200);
  const opened = await mobile("teacher-session-login", { password: "correct" }); assert.equal(opened.status, 200);
  const { mobileSession } = await opened.json(); assert.match(mobileSession, /^[a-f0-9]{64}$/);
  assert.equal((await f.auth("session", { active: false }, cookie)).status, 401);
  assert.equal((await f.auth("session", { active: false }, adminCookie)).status, 200);
  assert.equal((await f.auth("session", { active: false }, otherCookie)).status, 200);
  assert.equal((await mobile("mobile-session", { mobileSession })).status, 200);
  const wrong = await f.auth("login", { identifier: teacher.id, portal: "teacher", password: "wrong" }); assert.equal(wrong.status, 401);
  assert.equal((await mobile("mobile-session", { mobileSession })).status, 200);
  const backupEnv = { ...f.env, WEB_SESSION_SECRET: "backup-only-distinct-cookie-secret-for-tests" };
  const response = await authApi({ env: backupEnv, request: makeRequest(backup, "/api/web-auth/login", { identifier: teacher.id, portal: "teacher", password: "correct" }) }, Date.now(), { store: f.store });
  assert.equal(response.status, 200);
  const backupCookie = response.headers.get("Set-Cookie").split(";")[0];
  assert.equal((await mobile("mobile-session", { mobileSession })).status, 401, "Netlify-style host must revoke the Cloudflare mobile receipt");
  assert.ok(await webSession(makeRequest(backup, "/index", {}, backupCookie), backupEnv, Date.now(), f.store));
  const signed = await mobile("teacher-session-login", { password: "correct" }); assert.equal(signed.status, 200);
  assert.equal(await webSession(makeRequest(backup, "/index", {}, backupCookie), backupEnv, Date.now(), f.store), null);
});
