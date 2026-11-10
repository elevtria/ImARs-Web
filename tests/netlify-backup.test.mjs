import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { NetlifyState } from "../server/netlify-state.js";
import { netlifyEnvironment, dispatchJob, verifyJob } from "../server/netlify-runtime.js";
import { netlifyRouter } from "../server/netlify-router.js";
import { netlifyQuizJobs, runNetlifyQuiz, QUIZ_CHUNK_BYTES } from "../server/netlify-quiz-jobs.js";
import { fixture } from "./fixtures/web-data.js";
import { blobStore } from "./fixtures/netlify-blobs.js";
import { staffProfile } from "../server/web-auth.js";

const callState = (state, name, action, body) => state.get(name).fetch("https://private/" + action, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("Netlify loads session configuration for a signed-in dashboard at the root", async () => {
  const source = readFileSync(new URL("../netlify/edge-functions/portal.js", import.meta.url), "utf8")
    .replace(/^import .*;\r?\n/gm, "").replace("export default", "globalThis.edge =");
  const context = vm.createContext({ URL, Response,
    Netlify: { env: { get: () => "configured" } },
    netlifyEnvironment: () => ({ env: { fullSessionConfiguration: true } }),
    onRequest: async input => input.env
  });
  vm.runInContext(source, context);
  for (const [path, cookie, full] of [
    ["/", "", false], ["/", "analytics=public", false],
    ["/", "analytics=public; __Host-imars-web=session", true],
    ["/index.html", "__Host-imars-web=session", true],
    ["/welcome", "__Host-imars-web=session", false], ["/login", "", false]
  ]) {
    const result = await context.edge(new Request("https://imars.netlify.app" + path, { headers: cookie ? { Cookie: cookie } : {} }), {});
    assert.equal(Boolean(result.fullSessionConfiguration), full, path + " " + cookie);
  }
});

test("independent Netlify instances share atomic login lockouts under concurrent requests", async () => {
  const store = blobStore(); let upstream = 0;
  const fetcher = async () => { upstream++; await Promise.resolve(); return Response.json({ error: { message: "INVALID_PASSWORD" } }, { status: 400 }); };
  const a = new NetlifyState(store, {}, { fetcher }), b = new NetlifyState(store, {}, { fetcher });
  const requests = await Promise.all(Array.from({ length: 12 }, (_, index) => callState(index % 2 ? a : b, "account:teacher-a", "login", { uid: "teacher-a", email: "t@example.test", password: "wrong" })));
  assert.ok(requests.every(response => [401, 429].includes(response.status)));
  const status = await (await callState(new NetlifyState(store, {}), "account:teacher-a", "status")).json();
  assert.equal(status.allowed, false); assert.equal(status.stage, 1); assert.ok(status.retryAfter > 0 && status.retryAfter <= 300);
  const before = upstream;
  assert.equal((await callState(a, "account:teacher-a", "login", { uid: "teacher-a", email: "t@example.test", password: "wrong" })).status, 429);
  assert.equal(upstream, before, "locked accounts must not contact Firebase again");
  assert.ok(!JSON.stringify([...store.values.values()]).includes('"password"'));
});

test("Netlify sessions survive a new function instance and logout invalidates the saved session", async () => {
  const store = blobStore(), state = new NetlifyState(store, {}, { fetcher: async () => Response.json({ localId: "teacher-a", idToken: "upstream-never-returned" }) });
  const opened = await (await callState(state, "account:teacher-a", "login", { uid: "teacher-a", email: "t@example.test", password: "correct" })).json();
  assert.ok(opened.session.sid); assert.ok(!opened.idToken);
  const credentials = { family: opened.session.family, sid: opened.session.sid, version: opened.session.version };
  assert.equal((await callState(new NetlifyState(store, {}), "account:teacher-a", "session", credentials)).status, 200);
  await callState(state, "account:teacher-a", "logout", {});
  assert.equal((await callState(new NetlifyState(store, {}), "account:teacher-a", "session", credentials)).status, 401);
  assert.ok(!JSON.stringify([...store.values.values()]).includes("upstream-never-returned"));
});

test("passive Netlify session checks read current state without writing unchanged blobs", async () => {
  let clock = Date.now();
  const store = blobStore(), state = new NetlifyState(store, {}, { now: () => clock,
    fetcher: async () => Response.json({ localId: "teacher-a", idToken: "not-returned" }) });
  const opened = await (await callState(state, "account:teacher-a", "login", { uid: "teacher-a", email: "t@example.test", password: "correct" })).json();
  const credentials = { family: opened.session.family, sid: opened.session.sid, version: opened.session.version, active: false, rotate: true };
  const write = store.setJSON; let writes = 0;
  store.setJSON = (...args) => { writes++; return write(...args); };
  clock += 10_000;
  assert.equal((await callState(state, "account:teacher-a", "session", credentials)).status, 200);
  assert.equal(writes, 0, "passive validation must not pay for a redundant remote write");
  await callState(state, "account:teacher-a", "session", { ...credentials, active: true });
  assert.equal(writes, 1, "genuine activity must still persist its idle deadline");
  await callState(state, "account:teacher-a", "logout", {});
  assert.equal((await callState(state, "account:teacher-a", "session", credentials)).status, 401);
});

test("Netlify request wrappers share short identity checks while profile revocations remain live", async () => {
  const f = fixture(), store = blobStore();
  const read = key => key === "NETLIFY_BACKUP_ENABLED" ? "true" : undefined;
  const a = netlifyEnvironment(read, { store }).env, b = netlifyEnvironment(read, { store }).env;
  assert.equal(a.staffIdentityCacheKey, b.staffIdentityCacheKey);
  const account = { id: "TEACH1000", uid: "teacher-a", email: "teacher@example.test", role: "teacher" };
  const identity = f.store.identity.bind(f.store); let calls = 0;
  const database = env => ({ env, get: f.store.get.bind(f.store), identity: uid => { calls++; return identity(uid); } });
  await staffProfile(account, database(a));
  await staffProfile(account, database(b));
  assert.equal(calls, 1, "a new runtime env wrapper must not bypass the existing 60-second Auth cache");
  f.store.data.get("users/TEACH1000").active = false;
  await assert.rejects(staffProfile(account, database(b)), /no longer has website access/);
  assert.equal(calls, 1);
});

test("private teacher invitations stay distinct across concurrent Netlify instances", async () => {
  const store = blobStore();
  const responses = await Promise.all(Array.from({ length: 4 }, (_, i) => callState(new NetlifyState(store, {}), "staff-roster", "allocate-teacher", { minimum: 1000, email: "teacher" + i + "@example.test" })));
  const rows = await Promise.all(responses.map(response => response.json()));
  assert.equal(new Set(rows.map(row => row.id)).size, 4);
  assert.ok(rows.every(row => row.nonce));
});

test("dashboard projections return compact rollups with no Firestore or full-state download", async () => {
  const store = blobStore(), state = new NetlifyState(store, {});
  const body = { id: "TEACH1000", uid: "teacher-a", sections: [{ id: "A", name: "A" }] };
  await state.transact("dashboard:teacher-a", async (_actor, storage) => {
    await storage.put("dashboard:config", { ...body, scope: JSON.stringify([["A", "A"]]) });
    await storage.put("dashboard:summary", { scope: JSON.stringify([["A", "A"]]), total: 1000, recent: [], reconciledAt: Date.now() });
    await storage.put("dashboard:student:S1", { private: "full-rollup-marker" });
  });
  const get = store.get; store.get = async key => { assert.ok(!key.startsWith("state/")); return get(key); };
  store.getWithMetadata = () => assert.fail("A warm dashboard must not load the full mutable state");
  const result = await (await callState(new NetlifyState(store, {}), "dashboard:teacher-a", "dashboard-get", body)).json();
  assert.equal(result.summary.total, 1000); assert.ok(!JSON.stringify(result).includes("full-rollup-marker"));
  const wrong = await callState(state, "dashboard:teacher-a", "dashboard-get", { ...body, uid: "teacher-b" }); assert.equal(wrong.status, 400);
});

test("signed background jobs reject forged, modified and expired requests", async () => {
  const env = { URL: "https://imars-backup.netlify.app", NETLIFY_BACKGROUND_SECRET: "s".repeat(48) }; let request;
  await dispatchJob(env, { kind: "quiz", id: "a".repeat(32) }, async (url, options) => { request = new Request(url, options); return new Response(null, { status: 202 }); });
  assert.deepEqual(await verifyJob(request.clone(), env.NETLIFY_BACKGROUND_SECRET), { kind: "quiz", id: "a".repeat(32) });
  await assert.rejects(verifyJob(request.clone(), "wrong".repeat(10)));
  await assert.rejects(verifyJob(request.clone(), env.NETLIFY_BACKGROUND_SECRET, Date.now() + 120_000));
  const tampered = new Request(request, { body: JSON.stringify({ kind: "quiz", id: "b".repeat(32) }) });
  await assert.rejects(verifyJob(tampered, env.NETLIFY_BACKGROUND_SECRET));
});

test("Netlify routes preserve staff protection while student APIs keep their own token authentication", async () => {
  const f = fixture();
  const run = path => netlifyRouter({ env: f.env, store: blobStore(), request: f.request(path, {}), jobs: () => assert.fail("Unauthenticated quiz jobs must not run") });
  assert.equal((await run("/api/web-data")).status, 401);
  assert.equal((await run("/api/quiz-jobs/start")).status, 401);
  assert.equal((await run("/api/student-quizzes/list")).status, 503, "unconfigured student API fails closed, without demanding a website cookie");
});

function quizFixture() {
  const store = blobStore(), database = fixture().store, actor = { id: "TEACH1000", uid: "teacher-a", role: "teacher", email: "teacher@example.test" };
  const env = { WEB_LOGIN_STATE: { idFromName: v => v, get: () => ({ fetch: async () => Response.json({ allowed: true }) }) } };
  const call = (action, body, query = "", identity = actor) => netlifyQuizJobs({ env, store, request: new Request("https://backup.test/api/quiz-jobs/" + action + query, {
    method: "POST", headers: { "Content-Type": body instanceof Blob ? "application/octet-stream" : "application/json" }, body: body instanceof Blob ? body : JSON.stringify(body || {})
  }) }, { database, authenticate: async () => identity, dispatch: async () => {} });
  const settings = { fileName: "Science.pdf", fileMimeType: "application/pdf", fileSize: QUIZ_CHUNK_BYTES + 10, questionCount: 1, questionType: "multiple-choice", difficulty: "Easy" };
  return { store, database, actor, env, call, settings };
}

test("quiz chunks remain bounded, reject foreign teachers and finalize only a complete upload", async () => {
  const f = quizFixture(), started = await (await f.call("start", f.settings)).json(), query = "?id=" + started.id;
  assert.equal(started.chunkBytes, 3_000_000);
  assert.equal((await f.call("run", {}, query)).status, 409);
  assert.equal((await f.call("chunk", new Blob([new Uint8Array(3_000_000)]), query + "&index=0", { ...f.actor, uid: "teacher-b" })).status, 403);
  assert.equal((await f.call("chunk", new Blob([new Uint8Array(3_000_001)]), query + "&index=0")).status, 413);
  assert.equal((await f.call("chunk", new Blob([new Uint8Array(3_000_000)]), query + "&index=0")).status, 200);
  assert.equal((await f.call("chunk", new Blob([new Uint8Array(10)]), query + "&index=1")).status, 200);
  assert.equal((await f.call("run", {}, query)).status, 202);
  assert.equal((await f.call("status", {}, query)).status, 200);
});

test("background quiz generation is claimed once and reuses the existing protected generator", async () => {
  const f = quizFixture(), started = await (await f.call("start", { ...f.settings, fileName: "Science.docx", fileMimeType: "text/plain", sourceText: "A readable science lesson." })).json();
  const query = "?id=" + started.id; await f.call("run", {}, query); let generated = 0;
  const generate = async ({ request }, { authenticate }) => {
    generated++; assert.equal((await authenticate()).uid, f.actor.uid);
    assert.equal((await request.json()).sourceText, "A readable science lesson.");
    return Response.json({ questions: [{ text: "Generated question" }] });
  };
  await Promise.all([runNetlifyQuiz(started.id, f.env, f.store, { database: f.database, generate }), runNetlifyQuiz(started.id, f.env, f.store, { database: f.database, generate })]);
  assert.equal(generated, 1);
  const result = await (await f.call("status", {}, query)).json(); assert.equal(result.status, "complete"); assert.equal(result.questions.length, 1);
});

test("backup configuration remains disabled until secrets are explicitly configured", () => {
  assert.throws(() => netlifyEnvironment(() => undefined, { store: blobStore() }), /incomplete/);
  assert.ok(readFileSync(new URL("../netlify.toml", import.meta.url), "utf8").includes('command = "npm run build:netlify"'));
  assert.ok(!readFileSync(new URL("../scripts/build-site.mjs", import.meta.url), "utf8").includes("imars-quiz-transport"));
});
