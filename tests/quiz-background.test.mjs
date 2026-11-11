import test from "node:test";
import assert from "node:assert/strict";
import { QuizGenerationJob } from "../workers/quiz-jobs-worker.js";
import { onRequestPost as runJob } from "../functions/api/run-quiz-job.js";
import { signQuizJob, verifyQuizJob } from "../server/quiz-background.js";

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
