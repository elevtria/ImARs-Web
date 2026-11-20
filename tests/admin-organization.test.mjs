import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fixture } from "./fixtures/web-data.js";
import { adminSecurity } from "../server/admin-security.js";
import { loadAdminReports } from "../server/admin-report-data.js";
import { securityAudit, auditCollection } from "../server/security-audit.js";
import { staffProfile } from "../server/web-auth.js";
import { SupabaseAppStore } from "../server/supabase-app-store.js";

async function harness() {
  const app = fixture();
  for (const id of ["ADMIN1000", "TEACH1000", "TEACH1001"]) app.data.get("users/" + id).authEmailVerified = true;
  const cookie = await app.login("ADMIN1000", "admin");
  const calls = [], emails = [];
  const dependencies = { store: app.store,
    callState: async (_env, name, action, body) => { calls.push({ name, action }); return { ok: action !== "mobile-password" || body.password === "correct", status: 400 }; },
    fetcher: async (url, options) => { emails.push({ url, body: JSON.parse(options.body) }); return Response.json({ email: "private@example.test" }); }
  };
  const call = (body, session = cookie, overrides = {}) => adminSecurity({ env: app.env, request: app.request("/api/admin-security/action", body, session) }, { ...dependencies, ...overrides });
  return { ...app, call, cookie, calls, emails };
}

test("admin security rejects unsigned, cross-site, and teacher requests", async () => {
  const app = await harness();
  assert.equal((await app.call({ action: "directory" }, "")).status, 401);
  const teacher = await app.login();
  for (const action of ["directory", "audit", "reset-password", "end-sessions", "transfer-section"]) assert.equal((await app.call({ action }, teacher)).status, 403);
  const request = app.request("/api/admin-security/action", { action: "directory" }, app.cookie, { Origin: "https://attacker.test" });
  assert.equal((await adminSecurity({ request, env: app.env }, { store: app.store })).status, 403);
});

test("directory exposes only staff display fields and aggregate roster counts", async () => {
  const app = await harness();
  const response = await app.call({ action: "directory" });
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const body = await response.json();
  assert.equal(body.sections[0].students, 1);
  assert.equal(body.teachers.length, 2);
  assert.doesNotMatch(JSON.stringify(body), /must-never-leave-server|private-marker|student-a|private-token/);
});

test("transfer atomically updates canonical ownership and stale student links without altering results or activation", async () => {
  const app = await harness();
  app.data.get("users/0026271000").teacherId = "STALE";
  app.data.get("users/0026271000").active = false;
  app.data.set("users/0026271000/test_results/term_01/lessons/lesson_01", { preTestScore: 4, postTestScore: 8 });
  const before = structuredClone(app.data.get("users/0026271000"));
  const result = await app.call({ action: "transfer-section", sectionId: "A", previousTeacherId: "TEACH1000", teacherId: "TEACH1001", password: "correct" });
  assert.equal(result.status, 200, JSON.stringify(await result.clone().json()));
  assert.equal(app.data.get("classes/A").teacherId, "TEACH1001");
  assert.deepEqual(app.data.get("users/0026271000"), { ...before, teacherId: "TEACH1001" });
  assert.deepEqual(app.data.get("users/0026271000/test_results/term_01/lessons/lesson_01"), { preTestScore: 4, postTestScore: 8 });
  assert.deepEqual(app.data.get("users/TEACH1000").sections, []);
  assert.deepEqual(app.data.get("users/TEACH1001").sections, ["A", "B"]);
  assert.equal([...app.data].filter(([path]) => path.startsWith(auditCollection + "/")).length, 1);
});

test("incorrect confirmation, stale assignment, and database conflicts do not transfer records", async () => {
  for (const scenario of ["password", "stale", "conflict"]) {
    const app = await harness();
    if (scenario === "conflict") app.store.conflict = true;
    const body = { action: "transfer-section", sectionId: "A", previousTeacherId: scenario === "stale" ? "TEACH1001" : "TEACH1000", teacherId: "TEACH1001", password: scenario === "password" ? "wrong" : "correct" };
    assert.equal((await app.call(body)).status, scenario === "password" ? 400 : 409);
    assert.equal(app.data.get("classes/A").teacherId, "TEACH1000");
    assert.equal(app.data.get("users/0026271000").teacherId, "TEACH1000");
  }
});

test("recovery sends only to the verified Auth email, rate limits, and never returns a code", async () => {
  const app = await harness();
  const body = { action: "reset-password", targetId: "TEACH1000", password: "correct", email: "attacker@example.test" };
  const response = await app.call(body);
  assert.equal(response.status, 200);
  assert.deepEqual(app.emails[0].body, { requestType: "PASSWORD_RESET", email: "teacher@example.test" });
  assert.doesNotMatch(await response.text(), /oobCode|private-token|private@example.test|password=/);
  assert.equal((await app.call(body)).status, 429);
  assert.equal(app.emails.length, 1);
  const logs = [...app.data].filter(([path]) => path.startsWith(auditCollection));
  assert.equal(logs.length, 2);
  assert.doesNotMatch(JSON.stringify(logs), /correct|attacker|private-token/);
});

test("recovery rejects unverified, inactive, student, and another administrator targets", async () => {
  for (const kind of ["unverified", "inactive", "student", "admin"]) {
    const app = await harness(); let targetId = "TEACH1001";
    if (kind === "unverified") app.data.get("users/TEACH1001").authEmailVerified = false;
    if (kind === "inactive") app.data.get("users/TEACH1001").active = false;
    if (kind === "student") targetId = "0026271000";
    if (kind === "admin") app.data.get("users/TEACH1001").role = "admin";
    assert.equal((await app.call({ action: "reset-password", targetId, password: "correct" })).status, ["unverified", "inactive"].includes(kind) ? 409 : 403);
    assert.equal(app.emails.length, 0);
  }
});

test("recovery failure is logged without claiming delivery", async () => {
  const app = await harness();
  const response = await app.call({ action: "reset-password", targetId: "TEACH1000", password: "correct" }, app.cookie,
    { fetcher: async () => Response.json({ error: "provider failure" }, { status: 500 }) });
  assert.equal(response.status, 503);
  assert.ok([...app.data.values()].some(row => row.action === "password-reset-failed"));
  assert.ok(![...app.data.values()].some(row => row.action === "password-reset-sent"));
});

test("ending sessions rotates the shared teacher epoch and clears web/mobile portal access", async () => {
  const app = await harness();
  const key = "_accountAccess/teacher-a/sessions/teacher";
  app.data.set(key, { epoch: "old", mobileReceiptHash: "old-receipt" });
  const response = await app.call({ action: "end-sessions", targetId: "TEACH1000", password: "correct" });
  assert.equal(response.status, 200);
  assert.match(app.data.get(key).epoch, /^[a-f0-9]{64}$/);
  assert.equal(app.data.get(key).mobileReceiptHash, "");
  assert.deepEqual(app.calls.slice(-2).map(call => call.action), ["logout", "mobile-revoke"]);
  assert.ok([...app.data.values()].some(row => row.action === "portal-sessions-ended"));
});

test("audit pagination is newest first and never exposes account data", async () => {
  const app = await harness();
  for (let i = 0; i < 28; i++) { const write = securityAudit({ id: "ADMIN1000", role: "admin" }, "test", String(i), "", 1000 + i); app.data.set(write.path, write.data); }
  const first = await (await app.call({ action: "audit" })).json();
  const next = await (await app.call({ action: "audit", cursor: first.cursor })).json();
  assert.equal(first.entries.length, 25); assert.equal(first.entries[0].targetId, "27");
  assert.equal(next.entries.length, 3); assert.equal(next.cursor, null);
  assert.equal(new Set([...first.entries, ...next.entries].map(row => row.id)).size, 28);
});

test("term/section reports preserve zeros, exclude missing scores, and use canonical class ownership", async () => {
  const app = await harness();
  app.data.get("users/0026271000").teacherId = "TEACH1001";
  app.data.set("users/0026271000/test_results/term_01/lessons/lesson_01", { isPreTestCompleted: true, preTestScore: 0, preTestTotalQuestions: 5 });
  app.data.set("users/0026271000/test_results/term_02/lessons/lesson_01", { isPostTestCompleted: true, postTestScore: 10, postTestTotalQuestions: 10 });
  const report = await loadAdminReports(app.store, { termId: "term_01", sectionId: "A" });
  assert.equal(report.totalStudents, 1); assert.equal(report.pre, 0); assert.equal(report.post, null);
  assert.equal(report.preCount, 1); assert.equal(report.expectedTests, 8);
  assert.equal(report.teachers[0].id, "TEACH1000");
  assert.deepEqual(report.teachers[0].sections, ["A"]);
  const response = await app.call({ action: "directory" }); assert.equal(response.status, 200);
  assert.equal((await app.call({ action: "audit", cursor: "../users" })).status, 400);
  assert.equal((await app.call({ action: "unknown" })).status, 400);
});

test("security paths are denied through generic browser data operations", async () => {
  const app = await harness();
  for (const path of [auditCollection, "webSettings/security/resetLimits"]) {
    const response = await (await import("../server/web-data.js")).webData({ env: app.env, request: app.request("/api/web-data", { action: "query", reference: { kind: "query", path } }, app.cookie) }, { store: app.store, directorySync() {} });
    assert.equal(response.status, 403);
  }
});

test("Supabase security events are never mirrored to Firestore", async () => {
  const store = Object.create(SupabaseAppStore.prototype); let calls = 0;
  store.firestoreMirror = { commit: async () => { calls++; } };
  await store.mirrorWritesToFirestore([securityAudit({ id: "ADMIN1000", role: "admin" }, "test", "T1")]);
  assert.equal(calls, 0);
});

test("Firebase password changes invalidate older website sessions", async () => {
  const store = { env: {}, get: async () => ({ data: { uid: "admin-a", role: "admin", active: true } }),
    identity: async () => ({ email: "admin@example.test", validSince: "2000" }) };
  await assert.rejects(staffProfile({ uid: "admin-a", id: "ADMIN1000", role: "admin", email: "admin@example.test", authenticatedAt: 1000_000 }, store), error => error.status === 401);
  await assert.doesNotReject(staffProfile({ uid: "admin-a", id: "ADMIN1000", role: "admin", email: "admin@example.test", authenticatedAt: 3000_000 }, store));
});

test("all admin pages link account security and protected routing recognizes it", () => {
  for (const page of ["admin-dashboard", "manage-teachers", "school-analytics", "admin-security", "admin-manual"]) {
    const html = readFileSync(new URL(`../${page}.html`, import.meta.url), "utf8");
    assert.match(html, /href="admin-security.html"/); assert.match(html, /admin-organization.css/);
  }
  const auth = readFileSync(new URL("../server/web-auth.js", import.meta.url), "utf8");
  assert.match(auth, /const adminOnly = \["\/admin-security"/);
});
