import test from "node:test";
import assert from "node:assert/strict";
import { QuizGenerationJob } from "../workers/quiz-jobs-worker.js";
import { onRequestPost as runJob } from "../functions/api/run-quiz-job.js";
import { quizExecutionObject, quizJobObject, signQuizJob, verifyQuizJob } from "../server/quiz-background.js";

test("a queued job survives its initiating request and keeps its result for review", async context => {
  const storage = {
    data: new Map(),
    async get(key) { return this.data.get(key); },
    async put(key, value) { this.data.set(key, value); },
    async delete(key) { this.data.delete(key); },
    async transaction(callback) { return callback(this); },
    async setAlarm(time) { this.alarm = time; },
    async deleteAlarm() { this.alarm = null; }
  };
  const env = { QUIZ_JOB_CALLBACK_ORIGIN: "https://imars.test" };
  const queued = new QuizGenerationJob({ storage }, env);
  const id = crypto.randomUUID(), secret = "test-session-secret-with-sufficient-length";
  const callback = await signQuizJob(secret, { id, executeBy: Date.now() + 120_000 });
  const send = (object, path, method = "GET", body) => object.fetch(new Request("https://quiz-job.internal" + path, {
    method, ...(body ? { body: JSON.stringify(body) } : {})
  }));
  assert.equal((await send(queued, "/", "POST", { id, details: { title: "Cells" }, callback })).status, 202);
  assert.equal((await send(queued, "/", "POST", { id: crypto.randomUUID(), details: {}, callback })).status, 409);
  assert.ok(storage.alarm);
  assert.deepEqual(await (await send(queued, "/")).json(), { id, status: "queued", details: { title: "Cells" } });

  const recovered = new QuizGenerationJob({ storage }, env);
  const fetch = context.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://imars.test/api/run-quiz-job");
    assert.equal((await verifyQuizJob(secret, options.headers["X-Imars-Quiz-Signature"], options.body)).id, id);
    assert.equal((await send(recovered, "/claim", "POST", { id })).status, 200);
    assert.equal((await send(recovered, "/claim", "POST", { id })).status, 409);
    assert.equal((await (await send(recovered, "/")).json()).status, "running");
    return Response.json({ questions: [{ text: "What is a cell?" }] });
  });
  await recovered.alarm();
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(await (await send(recovered, "/")).json(), {
    id, status: "complete", details: { title: "Cells" }, questions: [{ text: "What is a cell?" }]
  });
  assert.equal((await storage.get("job")).callback, undefined);
  await send(recovered, "/?id=" + id, "DELETE");
  assert.deepEqual(await (await send(recovered, "/")).json(), { status: "none" });
});

test("the private callback rejects altered and expired job signatures", async () => {
  const secret = "test-session-secret-with-sufficient-length";
  const { body, signature } = await signQuizJob(secret, { executeBy: 10_000, actor: { role: "teacher" } });
  assert.ok(await verifyQuizJob(secret, signature, body, 9000));
  assert.equal(await verifyQuizJob(secret, signature, body, 10_001), null);
  const response = await runJob({
    request: new Request("https://imars.test/api/run-quiz-job", {
      method: "POST", body: body + " ", headers: { "X-Imars-Quiz-Signature": signature }
    }),
    env: { WEB_SESSION_SECRET: secret, QUIZ_GENERATION_JOBS: {} }
  });
  assert.equal(response.status, 401);
});

function backgroundFixture() {
  const objects = new Map();
  const env = { WEB_SESSION_SECRET: "test-session-secret-with-sufficient-length", QUIZ_JOB_CALLBACK_ORIGIN: "https://imars.test" };
  env.QUIZ_GENERATION_JOBS = {
    idFromName: value => value,
    get(name) {
      if (!objects.has(name)) {
        const values = new Map();
        const storage = { get: async key => values.get(key), put: async (key, value) => values.set(key, structuredClone(value)),
          delete: async key => values.delete(key), setAlarm: async () => {}, deleteAlarm: async () => {},
          transaction: async callback => callback(storage) };
        objects.set(name, new QuizGenerationJob({ storage }, env));
      }
      return { fetch: (url, options) => objects.get(name).fetch(new Request(url, options)) };
    }
  };
  return { env, objects };
}

for (const loseResponse of [false, true]) {
  test(`background generation completes without browser polling, lost callback response=${loseResponse}`, async context => {
    const { env, objects } = backgroundFixture();
    const actor = { uid: "teacher-a", id: "TEACH1000", role: "teacher" };
    const id = crypto.randomUUID();
    const callback = await signQuizJob(env.WEB_SESSION_SECRET, { id, actor, executeBy: Date.now() + 120_000 });
    let generated = 0;
    const generate = async () => { generated++; return Response.json({ questions: [{ text: "What is a food web?" }] }); };
    const request = options => new Request("https://imars.test/api/run-quiz-job", options);
    context.mock.method(globalThis, "fetch", async (_url, options) => {
      const response = await runJob({ env, request: request(options) }, { generate });
      if (loseResponse) throw new TypeError("Connection interrupted after result storage");
      return response;
    });
    const job = quizJobObject(env, actor);
    await job.fetch("https://quiz-job.internal/", { method: "POST", body: JSON.stringify({ id, details: { title: "Food Webs" }, callback }) });
    const worker = objects.get(JSON.stringify([actor.uid, actor.id]));
    const originalFetch = worker.fetch.bind(worker);
    worker.fetch = request => {
      assert.notEqual(new URL(request.url).pathname, "/claim", "callback must not reenter the waiting job object");
      return originalFetch(request);
    };
    await worker.alarm();
    assert.equal(generated, 1);
    assert.equal((await (await job.fetch("https://quiz-job.internal/")).json()).status, "complete");
    const duplicate = await runJob({ env, request: request({ method: "POST", body: callback.body,
      headers: { "X-Imars-Quiz-Signature": callback.signature } }) }, { generate });
    assert.equal(duplicate.status, 409);
    assert.equal(generated, 1);
  });
}

test("a callback that has not started receives one server-side retry", async context => {
  const { env, objects } = backgroundFixture();
  const actor = { uid: "teacher-a", id: "TEACH1000", role: "teacher" };
  const id = crypto.randomUUID();
  const callback = await signQuizJob(env.WEB_SESSION_SECRET, { id, actor, executeBy: Date.now() + 120_000 });
  let calls = 0, generated = 0;
  context.mock.method(globalThis, "fetch", async (_url, options) => {
    if (++calls === 1) throw new TypeError("Connection failed before acceptance");
    return runJob({ env, request: new Request("https://imars.test/api/run-quiz-job", options) }, {
      generate: async () => { generated++; return Response.json({ questions: [{ text: "What is a cell?" }] }); }
    });
  });
  const job = quizJobObject(env, actor);
  await job.fetch("https://quiz-job.internal/", { method: "POST", body: JSON.stringify({ id, details: {}, callback }) });
  const worker = objects.get(JSON.stringify([actor.uid, actor.id]));
  await worker.alarm();
  assert.equal((await (await job.fetch("https://quiz-job.internal/")).json()).status, "queued");
  await worker.alarm();
  assert.equal((await (await job.fetch("https://quiz-job.internal/")).json()).status, "complete");
  assert.equal(calls, 2);
  assert.equal(generated, 1);
});

test("the server watchdog recovers a later completed result without starting generation again", async context => {
  const { env, objects } = backgroundFixture();
  const actor = { uid: "teacher-a", id: "TEACH1000", role: "teacher" };
  const id = crypto.randomUUID(), executeBy = Date.now() + 120_000;
  const callback = await signQuizJob(env.WEB_SESSION_SECRET, { id, actor, executeBy });
  let calls = 0;
  const execution = quizExecutionObject(env, id);
  context.mock.method(globalThis, "fetch", async () => {
    calls++;
    await execution.fetch("https://quiz-job.internal/claim-execution", { method: "POST", body: JSON.stringify({ id, executeBy }) });
    throw new TypeError("Response disconnected while execution continues");
  });
  const job = quizJobObject(env, actor);
  await job.fetch("https://quiz-job.internal/", { method: "POST", body: JSON.stringify({ id, details: {}, callback }) });
  const worker = objects.get(JSON.stringify([actor.uid, actor.id]));
  await worker.alarm();
  assert.equal((await (await job.fetch("https://quiz-job.internal/")).json()).status, "running");
  await execution.fetch("https://quiz-job.internal/finish-execution", { method: "POST", body: JSON.stringify({ id,
    result: { status: 200, body: { questions: [{ text: "What is an ecosystem?" }] } } }) });
  await worker.alarm();
  assert.equal((await (await job.fetch("https://quiz-job.internal/")).json()).status, "complete");
  assert.equal(calls, 1);
});

test("the background callback revalidates the current teacher profile before generation", async () => {
  const { env } = backgroundFixture();
  const actor = { uid: "teacher-a", id: "TEACH1000", email: "teacher@example.test", role: "teacher" };
  Object.assign(env, { WEB_DATA_ENABLED: "true", WEB_STAFF_ACCOUNTS: JSON.stringify([actor,
    { uid: "admin-a", id: "ADMIN1000", email: "admin@example.test", role: "admin" }]),
    WEB_LOGIN_STATE: { idFromName: name => name, get: () => ({ fetch: async () => Response.json({ account: null }) }) } });
  const profile = { ...actor, active: true };
  const store = { get: async () => ({ data: profile }), identity: async () => ({ email: actor.email, emailVerified: true }) };
  const callback = await signQuizJob(env.WEB_SESSION_SECRET, { id: crypto.randomUUID(), actor, executeBy: Date.now() + 120_000 });
  let checked = false;
  const response = await runJob({ env, request: new Request("https://imars.test/api/run-quiz-job", { method: "POST", body: callback.body,
    headers: { "X-Imars-Quiz-Signature": callback.signature } }) }, {
    generate: async (context, options) => {
      const current = await options.authenticate(context.request, env, store);
      assert.equal(current.uid, actor.uid);
      assert.equal(current.requiresVerifiedEmail, true);
      checked = true;
      return Response.json({ questions: [{ text: "What is a cell?" }] });
    }
  });
  assert.equal(response.status, 200);
  assert.equal(checked, true);
});
