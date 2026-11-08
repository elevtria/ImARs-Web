import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { DashboardSummary, summarizeStudent } from "../server/dashboard-summary.js";
import { WebLoginState } from "../workers/web-auth-worker.js";
import { fixture } from "./fixtures/web-data.js";
import { accountAccess } from "../server/account-access.js";

function setup(count = 1) {
  const f = fixture(), values = new Map(); let alarm, now = Date.now();
  const scope = { id: "TEACH1000", uid: "teacher-a", sections: [{ id: "A", name: "A" }] };
  f.store.data.delete("users/0026271000");
  for (let i = 0; i < count; i++) {
    const id = "S" + String(i).padStart(5, "0");
    f.store.data.set("users/" + id, { role: "student", active: true, classCode: "A", displayName: "Student " + i });
    f.store.data.set(`users/${id}/test_results/term_03/lessons/lesson_01`, { isPreTestCompleted: true, preTestScore: 0, preTestTotalQuestions: 5,
      isPostTestCompleted: true, postTestScore: 8, postTestTotalQuestions: 10, arTimeMinutes: 6, timestamp: new Date(now - i * 1000).toISOString() });
  }
  const storage = {
    async get(key) { return structuredClone(values.get(key)); },
    async put(key, value) { values.set(key, structuredClone(value)); },
    async delete(key) { return values.delete(key); },
    async getAlarm() { return alarm; }, async setAlarm(value) { alarm = value; },
    async list({ prefix, limit, startAfter }) { return new Map([...values].filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter)).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([key, value]) => [key, structuredClone(value)])); }
  };
  const batches = [], original = f.store.getAll;
  f.store.getAll = async paths => { batches.push(paths); return original(paths); };
  const engine = new DashboardSummary(storage, {}, { store: f.store, now: () => now });
  async function finish() {
    for (let i = 0; i < 1000; i++) {
      alarm = null; await engine.step();
      if (!await storage.get("dashboard:job") && !(await storage.list({ prefix: "dashboard:dirty:", limit: 1 })).size) return;
    }
    throw new Error("Background summary did not finish");
  }
  return { ...f, scope, storage, values, engine, batches, finish, advance: ms => now += ms };
}

test("prepared dashboard keeps all-term metrics, zero scores and the latest 25 students", async () => {
  const f = setup(30);
  assert.deepEqual(await f.engine.configure(f.scope), { ready: false });
  await f.finish();
  const { summary } = await f.engine.read(f.scope);
  assert.equal(summary.total, 30); assert.equal(summary.preSum, 0); assert.equal(summary.preCount, 30);
  assert.equal(summary.postSum, 240); assert.equal(summary.arMinutes, 180);
  assert.equal(summary.recent.length, 25); assert.equal(summary.recent[0].id, "S00000");
  assert.ok(!JSON.stringify(summary).includes("postTestScore"));
  assert.equal(summary.notifications.length, 50);
  assert.equal(new Set(summary.notifications.map(item => item.id)).size, 50);
  assert.ok(summary.notifications.some(item => item.studentId === "S00000" && item.kind === "pre"));
});

test("1,000-student preparation is bounded and warm reads fetch zero Firestore result documents", async t => {
  const f = setup(1000); await f.engine.configure(f.scope); await f.finish();
  assert.equal(f.batches.flat().filter(path => path.includes("/test_results/")).length, 12000);
  assert.ok(f.batches.every(paths => paths.length <= 100));
  f.batches.length = 0;
  const started = performance.now();
  for (let i = 0; i < 20; i++) assert.equal((await f.engine.read(f.scope)).summary.total, 1000);
  t.diagnostic(`20 in-memory warm reads: ${(performance.now() - started).toFixed(1)} ms; zero Firestore result reads (not production latency).`);
  assert.equal(f.batches.length, 0);
});

test("a confirmed mobile lesson change rereads only that lesson and updates totals", async () => {
  const f = setup(3); await f.engine.configure(f.scope); await f.finish(); f.batches.length = 0;
  const path = "users/S00000/test_results/term_03/lessons/lesson_01";
  f.data.set(path, { ...f.data.get(path), postTestScore: 10 });
  await f.engine.invalidate(["S00000"], "term_03/lessons/lesson_01"); await f.finish();
  assert.equal((await f.engine.read(f.scope)).summary.postSum, 26);
  assert.deepEqual(f.batches.flat().filter(path => path.includes("/test_results/")), [path]);
  await f.engine.invalidate(["S00000"], "term_03/lessons/lesson_01"); await f.finish();
  assert.equal((await f.engine.read(f.scope)).summary.postSum, 26, "retries must not double-count points");
  assert.equal((await f.engine.read(f.scope)).summary.notifications.length, 6, "grading must not create another completion notification");
});

test("archiving and moving a student removes their contribution without a full roster scan", async () => {
  const f = setup(2); await f.engine.configure(f.scope); await f.finish();
  f.data.get("users/S00000").active = false;
  await f.engine.invalidate(["S00000"]); await f.finish();
  assert.equal((await f.engine.read(f.scope)).summary.total, 1);
  assert.ok((await f.engine.read(f.scope)).summary.notifications.every(item => item.studentId !== "S00000"));
  f.data.get("users/S00001").classCode = "B";
  await f.engine.invalidate(["S00001"]); await f.finish();
  assert.equal((await f.engine.read(f.scope)).summary.total, 0);
});

test("scope changes, disabled teachers and cross-owner reads cannot expose a cached summary", async () => {
  const f = setup(); await f.engine.configure(f.scope); await f.finish();
  assert.equal(await f.engine.read({ ...f.scope, uid: "teacher-b" }), null);
  assert.equal(await f.engine.read({ ...f.scope, sections: [] }), null);
  assert.deepEqual(await f.engine.configure({ ...f.scope, sections: [] }), { ready: false });
  await f.finish(); assert.equal((await f.engine.read({ ...f.scope, sections: [] })).summary.total, 0);
  f.data.get("users/TEACH1000").active = false;
  await f.engine.invalidate(["S00000"]); await f.engine.step();
  assert.deepEqual(await f.engine.read({ ...f.scope, sections: [] }), { ready: false });
});

test("updates during initial preparation survive and a failed rebuild keeps the previous summary", async () => {
  const f = setup(26); await f.engine.configure(f.scope); await f.engine.step();
  f.data.get("users/S00000/test_results/term_03/lessons/lesson_01").postTestScore = 10;
  await f.engine.invalidate(["S00000"], "term_03/lessons/lesson_01"); await f.finish();
  const before = await f.engine.read(f.scope); assert.equal(before.summary.postSum, 210);
  await f.engine.start(); f.store.getAll = async () => { throw new Error("Network failure"); };
  await assert.rejects(f.engine.step(), /Network failure/);
  const after = await f.engine.read(f.scope);
  assert.deepEqual(after.summary, before.summary); assert.equal(after.pending, true);
});

test("a warm Durable Object read does not wait for background Firestore work", async () => {
  const jobs = [], object = new WebLoginState({ storage: {}, waitUntil: job => jobs.push(job) }, {});
  let release; object.pending = new Promise(resolve => { release = resolve; });
  object.dashboard = { read: async () => ({ ready: true, summary: { total: 1 } }), configure: async () => ({ ready: true }) };
  const response = await object.fetch(new Request("https://private/dashboard-get", { method: "POST", body: "{}" }));
  assert.equal((await response.json()).summary.total, 1); release(); await Promise.all(jobs);
});

test("assessment validation and AR fallback match the dashboard's existing rules", () => {
  const row = summarizeStudent("S", {}, "A", [{ isPreTestCompleted: true, preTestScore: -1, preTestTotalQuestions: 5,
    isPostTestCompleted: true, postTestHeatmap: [false, true], postTestTotalQuestions: 2, arTimeMinutes: 0, arNavigationTimeMinutes: 4 }]);
  assert.equal(row.preCount, 0); assert.equal(row.postSum, 5); assert.equal(row.arMinutes, 4);
});

test("website summaries require teacher authentication and ignore client-supplied owners", async () => {
  const f = fixture(); f.env.DASHBOARD_SUMMARIES_ENABLED = "true";
  assert.equal((await f.call({ action: "dashboard-summary" })).status, 401);
  const cookie = await f.login(); const original = f.env.WEB_LOGIN_STATE, calls = [];
  f.env.WEB_LOGIN_STATE = { ...original, get(name) {
    if (!name.startsWith("dashboard:")) return original.get(name);
    calls.push(name);
    return { async fetch(_url, options) { calls.push(JSON.parse(options.body)); return Response.json({ ready: true, summary: { total: 1 } }); } };
  } };
  const response = await f.call({ action: "dashboard-summary", uid: "teacher-b", sections: ["B"] }, cookie);
  assert.equal(response.status, 200); assert.deepEqual(calls, ["dashboard:teacher-a", { id: "TEACH1000", uid: "teacher-a", sections: [{ id: "A", name: "A" }] }]);
  f.data.get("users/TEACH1000").active = false;
  assert.equal((await f.call({ action: "dashboard-summary" }, cookie)).status, 403);
  assert.equal(calls.length, 2);
});

test("mobile notifications derive the owner from verified membership and accept no scores or other student IDs", async () => {
  const f = setup(); f.env.DASHBOARD_SUMMARIES_ENABLED = "true";
  f.data.set("users/S00000", { uid: "student-a", role: "student", active: true, classCode: "A", teacherId: "TEACH1000", email: "s@example.test", authEmailVerified: true });
  f.data.get("users/TEACH1000").authEmailVerified = true;
  const now = Math.floor(Date.now() / 1000), encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = encode({ alg: "RS256", kid: "fixture" }) + "." + encode({ sub: "student-a", aud: "imars-db-a733b", iss: "https://securetoken.google.com/imars-db-a733b", email_verified: true, auth_time: now - 20, iat: now - 10, exp: now + 3600 }) + ".signature";
  const calls = [];
  f.env.WEB_LOGIN_STATE = { idFromName: value => value, get: name => ({ fetch: async (url, options) => { calls.push({ name, action: new URL(url).pathname, body: options?.body && JSON.parse(options.body) }); return Response.json({ ready: true }); } }) };
  const call = (body, auth = true) => accountAccess({ env: f.env, request: new Request("https://imars.test/api/account-access/progress-synced", {
    method: "POST", headers: { "Content-Type": "application/json", ...(auth ? { Authorization: "Bearer " + token } : {}) }, body: JSON.stringify(body)
  }) }, { store: f.store, fetcher: async () => Response.json({ users: [{ localId: "student-a", emailVerified: true }] }) });
  const body = { termId: "term_03", lessonId: "lesson_01" };
  assert.equal((await call(body, false)).status, 401);
  assert.equal((await call({ ...body, studentId: "S00001", score: 10 })).status, 400);
  assert.equal((await call(body)).status, 200);
  const dirty = calls.find(call => call.action === "/dashboard-dirty");
  assert.deepEqual(dirty, { name: "dashboard:teacher-a", action: "/dashboard-dirty", body: { ids: ["S00000"], lesson: "term_03/lessons/lesson_01" } });
  f.data.get("users/S00000").active = false;
  assert.equal((await call(body)).status, 403);
});
