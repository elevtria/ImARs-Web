import assert from "node:assert/strict";
import test from "node:test";
import { accountAccess } from "../server/account-access.js";
import { decodeFields, encodeFields, FirestoreAdmin, serviceToken } from "../server/firestore-admin.js";

function fixture() {
  const records = new Map([
    ["users/0026271000", { uid: "student-a", role: "student", providedEmail: "student@example.test", classCode: "A" }],
    ["users/TEACH1000", { uid: "teacher-a", role: "teacher", providedEmail: "teacher@example.test", active: true }],
    ["users/TEACH1001", { role: "teacher", providedEmail: "invited@example.test", active: true, isRegistered: false }],
    ["users/0026271001", { classCode: "A", providedEmail: "invited-student@example.test", isRegistered: false }],
    ["_accountAccess/student-a", { profileId: "0026271000", role: "student", active: true, authEmail: "student@example.test" }],
    ["_accountAccess/teacher-a", { profileId: "TEACH1000", role: "teacher", active: true, authEmail: "teacher@example.test" }]
  ]);
  let verified = true, uid = "new-teacher", userEmail = "invited@example.test", disabled = false, outage = false, wrongPassword = false, commits = 0;
  const env = { ACCOUNT_ACCESS_ENABLED: "true" };
  const store = {
    get: async path => records.has(path) ? { data: structuredClone(records.get(path)), updateTime: "fixture-version" } : null,
    findUser: async value => {
      const matches = [...records].filter(([path, value2]) => path.startsWith("users/") && value2.uid === value);
      return matches.length === 1 ? { id: matches[0][0].split("/")[1] } : null;
    },
    async activate(id, _profile, value, updates, role, authEmail) {
      if (records.has("_accountAccess/" + value) || records.get("users/" + id).uid) throw Object.assign(new Error("Conflict"), { status: 409 });
      records.set("users/" + id, { ...records.get("users/" + id), ...updates });
      records.set("_accountAccess/" + value, { profileId: id, role, active: true, authEmail }); commits++;
    }
  };
  const fetcher = async (url, options) => {
    if (outage) throw Error("Offline");
    const body = JSON.parse(options.body);
    assert.match(url, /^https:\/\/identitytoolkit.googleapis.com\/v1\/accounts:/);
    if (url.includes("signInWithPassword")) {
      if (wrongPassword) return Response.json({ error: { message: "INVALID_LOGIN_CREDENTIALS" } }, { status: 400 });
      const mapped = [...records].find(([path, value]) => path.startsWith("_accountAccess/") && value.authEmail === body.email);
      return Response.json({ localId: mapped?.[0].split("/")[1] || uid, email: body.email, idToken: "private-upstream-token" });
    }
    return Response.json({ users: [{ localId: uid, email: userEmail, emailVerified: verified, disabled, displayName: "Verified Name" }] });
  };
  const call = (action, body = {}, options = {}) => accountAccess({ env, request: new Request("https://imars.example.test/api/account-access/" + action, {
    method: "POST", headers: { "Content-Type": "application/json", ...(options.auth === false ? {} : { Authorization: "Bearer firebase-id-token" }), ...options.headers }, body: JSON.stringify(body)
  }) }, { store, fetcher, rate: options.rate });
  return { call, records, env, store, commits: () => commits, set(options) {
    if ("verified" in options) verified = options.verified;
    if ("uid" in options) uid = options.uid;
    if ("email" in options) userEmail = options.email;
    if ("disabled" in options) disabled = options.disabled;
    if ("outage" in options) outage = options.outage;
    if ("wrongPassword" in options) wrongPassword = options.wrongPassword;
  } };
}

test("school ID lookup reveals only the login email after password verification, without returning upstream tokens", async () => {
  const app = fixture();
  const response = await app.call("login", { identifier: "TEACH1000", password: "correct" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { email: "teacher@example.test" });
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  app.set({ wrongPassword: true });
  const denied = await app.call("login", { identifier: "TEACH1000", password: "wrong" });
  assert.equal(denied.status, 401);
  assert.ok(!(await denied.text()).includes("teacher@example.test"));
});
test("display-email edits do not change the registered Firebase login address", async () => {
  const app = fixture(); app.records.get("users/TEACH1000").providedEmail = "contact-only@example.test";
  assert.deepEqual(await (await app.call("login", { identifier: "teach1000", password: "correct" })).json(), { email: "teacher@example.test" });
});
test("invitation checks expose no profile and reject mismatched roles, emails and claimed IDs", async () => {
  const app = fixture();
  assert.deepEqual(await (await app.call("invitation", { identifier: "TEACH1001", role: "teacher", email: "INVITED@example.test" })).json(), { approved: true });
  for (const change of [{ role: "student" }, { email: "attacker@example.test" }, { identifier: "TEACH1000" }]) {
    const response = await app.call("invitation", { identifier: "TEACH1001", role: "teacher", email: "invited@example.test", ...change });
    assert.equal(response.status, 403); assert.ok(!(await response.text()).includes("invited@example.test"));
  }
});
test("only a verified assigned email can atomically activate an unused teacher invitation", async () => {
  const app = fixture();
  app.set({ verified: false }); assert.equal((await app.call("claim", { identifier: "TEACH1001" })).status, 403);
  app.set({ verified: true, email: "attacker@example.test" }); assert.equal((await app.call("claim", { identifier: "TEACH1001" })).status, 403);
  assert.equal(app.commits(), 0);
  app.set({ email: "invited@example.test" });
  const response = await app.call("claim", { identifier: "TEACH1001", role: "admin", uid: "forged" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, profileId: "TEACH1001" });
  assert.equal(app.records.get("_accountAccess/new-teacher").role, "teacher");
  assert.equal(app.records.get("users/TEACH1001").uid, "new-teacher");
  assert.equal(app.commits(), 1);
  assert.equal((await app.call("claim", { identifier: "TEACH1001" })).status, 200, "retry is idempotent");
  assert.equal(app.commits(), 1);
});
test("student invitations from mobile CSVs without a role keep their class and gamification", async () => {
  const app = fixture();
  app.records.get("users/0026271001").gamification = { totalPoints: 0, level: 1 };
  app.set({ uid: "new-student", email: "invited-student@example.test" });
  assert.equal((await app.call("claim", { identifier: "0026271001" })).status, 200);
  const profile = app.records.get("users/0026271001");
  assert.equal(profile.role, "student"); assert.equal(profile.classCode, "A");
  assert.deepEqual(profile.gamification, { totalPoints: 0, level: 1 });
});
test("registered accounts require an independently provisioned mapping, and cannot claim a different profile", async () => {
  const app = fixture(); app.set({ uid: "teacher-a", email: "teacher@example.test" });
  assert.equal((await app.call("claim", {})).status, 200, "restore signed-in account without trusting PlayerPrefs");
  app.records.delete("_accountAccess/teacher-a");
  assert.equal((await app.call("claim", { identifier: "TEACH1000" })).status, 403);
  app.set({ uid: "attacker" });
  assert.equal((await app.call("claim", { identifier: "TEACH1000" })).status, 403);
});
test("an existing Auth UID cannot be rebound through a second unused invitation", async () => {
  const app = fixture();
  app.records.delete("_accountAccess/teacher-a");
  app.records.get("users/TEACH1001").providedEmail = "teacher@example.test";
  app.set({ uid: "teacher-a", email: "teacher@example.test" });
  assert.equal((await app.call("claim", { identifier: "TEACH1001" })).status, 403);
  assert.equal(app.commits(), 0);
});

test("a concurrent activation of the same profile requests a retry instead of a permanent denial", async () => {
  const app = fixture();
  // The binding/profile reads happened before another request completed its
  // atomic activation; the later UID query now sees that same profile.
  app.store.findUser = async () => ({ id: "TEACH1001" });
  assert.equal((await app.call("claim", { identifier: "TEACH1001" })).status, 409);
  assert.equal(app.commits(), 0);
});
test("disabled profiles, disabled Auth users, missing credentials, rate limits and upstream failures fail closed", async () => {
  const app = fixture();
  assert.equal((await app.call("claim", {}, { auth: false })).status, 401);
  app.set({ disabled: true }); assert.equal((await app.call("claim", { identifier: "TEACH1001" })).status, 403);
  app.set({ disabled: false, outage: true }); assert.equal((await app.call("claim", {})).status, 503);
  app.set({ outage: false }); app.records.get("users/TEACH1000").active = false;
  assert.equal((await app.call("login", { identifier: "TEACH1000", password: "correct" })).status, 401);
  const limited = await app.call("invitation", {}, { rate: () => { throw Object.assign(Error("Wait"), { status: 429 }); } });
  assert.equal(limited.status, 429);
});
test("gateway is disabled by default, rejects cross-origin mutations, and enabled configuration requires private server setup", async () => {
  const app = fixture();
  app.env.ACCOUNT_ACCESS_ENABLED = "false";
  assert.deepEqual(await (await accountAccess({ env: app.env, request: new Request("https://imars.example.test/api/account-access/config") })).json(), { enabled: false });
  assert.equal((await app.call("login", {})).status, 409);
  app.env.ACCOUNT_ACCESS_ENABLED = "true";
  assert.equal((await app.call("claim", {}, { headers: { Origin: "https://attacker.test" } })).status, 403);
  assert.equal((await accountAccess({ env: app.env, request: new Request("https://imars.example.test/api/account-access/config") })).status, 503);
});
test("Firestore REST serialization preserves nested invitation data and activation uses one preconditioned atomic commit", async () => {
  const fields = { role: "student", count: 3, active: true, items: ["a", false, null], gamification: { level: 1 }, time: 1.5 };
  assert.deepEqual(decodeFields(encodeFields(fields)), fields);
  const store = new FirestoreAdmin({}); let body;
  store.request = async (path, options) => { assert.equal(path, "documents:commit"); body = JSON.parse(options.body); };
  await store.activate("TEACH1001", { updateTime: "2026-10-16T00:00:00Z" }, "new-uid", { uid: "new-uid", isRegistered: true }, "teacher", "invited@example.test");
  assert.equal(body.writes.length, 2);
  assert.deepEqual(body.writes[0].currentDocument, { updateTime: "2026-10-16T00:00:00Z" });
  assert.deepEqual(body.writes[1].currentDocument, { exists: false });
  assert.equal(decodeFields(body.writes[1].update.fields).authEmail, "invited@example.test");
  assert.throws(() => store.name("users/../admin"), /Invalid/);
});
test("administrative OAuth proof is signed on the server and has a fixed audience and bounded lifetime", async () => {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ["sign", "verify"]);
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
  const env = { FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({ project_id: "imars-db-a733b", client_email: "fixture@imars-db-a733b.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\n" + pkcs8 + "\n-----END PRIVATE KEY-----" }) };
  let calls = 0;
  const fetcher = async function (url, options) {
    assert.ok(this === undefined, "The fetch transport must not receive the application instance as its receiver.");
    if (url.startsWith("https://firestore.googleapis.com/")) return Response.json({ fields: { startYear: { integerValue: "2026" } } });
    if (url.startsWith("https://identitytoolkit.googleapis.com/")) return Response.json({ users: [{ localId: "fixture-uid", email: "fixture@example.test" }] });
    calls++; assert.equal(url, "https://oauth2.googleapis.com/token");
    const [header, payload, signature] = options.body.get("assertion").split(".");
    assert.equal(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pair.publicKey, Buffer.from(signature, "base64url"), new TextEncoder().encode(header + "." + payload)), true);
    const claims = JSON.parse(Buffer.from(payload, "base64url"));
    assert.equal(claims.aud, "https://oauth2.googleapis.com/token"); assert.equal(claims.exp - claims.iat, 3600);
    assert.deepEqual(claims.scope.split(" "), ["https://www.googleapis.com/auth/datastore", "https://www.googleapis.com/auth/identitytoolkit"]);
    return Response.json({ access_token: "fixture-private-token", expires_in: 3600 });
  };
  assert.equal(await serviceToken(env, fetcher, 1000), "fixture-private-token");
  assert.equal(await serviceToken(env, fetcher, 2000), "fixture-private-token"); assert.equal(calls, 1);
  assert.equal(await serviceToken(env, fetcher, 3_601_000), "fixture-private-token"); assert.equal(calls, 2);
  const store = new FirestoreAdmin(env, fetcher);
  assert.equal((await store.get("webSettings/schoolYear")).data.startYear, 2026);
  assert.equal((await store.identity("fixture-uid")).localId, "fixture-uid");
});
