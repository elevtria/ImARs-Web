import assert from "node:assert/strict";
import test from "node:test";
import { onRequestPost } from "../functions/api/generate-quiz.js";

const env = { GEMINI_API_KEY: "hosting-test-key-not-a-real-key" };
const material = {
  firebaseApiKey: "hosting-test-public-firebase-key",
  sectionId: "test-section",
  fileName: "science.docx",
  questionCount: 1,
  difficulty: "Easy",
  questionType: "multiple-choice",
  fileMimeType: "text/plain",
  sourceText: "Water freezes into ice when cooled sufficiently."
};
const questions = [{ text: "What does water become when it freezes?", options: ["Ice", "Steam", "Sand", "Air"], correctIndex: 0 }];
function request(body = material, authorized = true) {
  return new Request("https://hosting-test.invalid/api/generate-quiz", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(authorized ? { Authorization: "Bearer hosting-test-token" } : {}) },
    body: JSON.stringify(body)
  });
}
function upstream(t, { role = "teacher", owner = "test-teacher", generate } = {}) {
  const geminiCalls = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    if (url.includes("identitytoolkit.googleapis.com")) return Response.json({ users: [{ localId: "test-uid" }] });
    if (url.includes("documents:runQuery")) return Response.json([{ document: {
      name: "projects/test/databases/(default)/documents/users/test-teacher",
      fields: { role: { stringValue: role } }
    } }]);
    if (url.includes("documents/classes/")) return Response.json({ fields: { teacherId: { stringValue: owner } } });
    if (url.includes("generativelanguage.googleapis.com")) {
      geminiCalls.push(JSON.parse(options.body));
      return generate ? generate(geminiCalls.length) : Response.json({ output_text: JSON.stringify({ questions }) });
    }
    throw new Error("Unexpected upstream request in test");
  });
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  return geminiCalls;
}

test("missing production secret returns a clear configuration error", async (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("No network call expected"); });
  const response = await onRequestPost({ request: request(), env: {} });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /not configured/);
});

test("unauthenticated requests cannot reach Gemini", async (t) => {
  const calls = upstream(t);
  const response = await onRequestPost({ request: request(material, false), env });
  assert.equal(response.status, 401);
  assert.equal(calls.length, 0);
});

test("malformed requests are rejected before generation", async (t) => {
  const calls = upstream(t);
  const response = await onRequestPost({ request: request({ ...material, questionCount: 51 }), env });
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});

test("student accounts cannot generate quizzes", async (t) => {
  const calls = upstream(t, { role: "student" });
  const response = await onRequestPost({ request: request(), env });
  assert.equal(response.status, 403);
  assert.equal(calls.length, 0);
});

test("teachers cannot generate for another teacher's section", async (t) => {
  const calls = upstream(t, { owner: "another-teacher" });
  const response = await onRequestPost({ request: request(), env });
  assert.equal(response.status, 403);
  assert.equal(calls.length, 0);
});

test("authorized teachers receive the frontend's question format without stored interactions", async (t) => {
  const calls = upstream(t);
  const response = await onRequestPost({ request: request(), env });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { questions });
  assert.equal(calls[0].store, false);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("a busy primary model falls back to Flash-Lite", async (t) => {
  const calls = upstream(t, { generate: (count) => count === 1
    ? Response.json({ error: { message: "Busy" } }, { status: 503 })
    : Response.json({ steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify({ questions }) }] }] }) });
  const response = await onRequestPost({ request: request(), env });
  assert.equal(response.status, 200);
  assert.deepEqual(calls.map((call) => call.model), ["gemini-3.8-flash", "gemini-3.5-flash-lite"]);
});

test("quota exhaustion returns 429 without exposing the key", async (t) => {
  upstream(t, { generate: () => Response.json({ error: { message: env.GEMINI_API_KEY } }, { status: 429 }) });
  const response = await onRequestPost({ request: request(), env });
  assert.equal(response.status, 429);
  assert.equal((await response.text()).includes(env.GEMINI_API_KEY), false);
});

test("invalid generated answers are rejected", async (t) => {
  upstream(t, { generate: () => Response.json({ output_text: JSON.stringify({ questions: [{ ...questions[0], correctIndex: 8 }] }) }) });
  const response = await onRequestPost({ request: request(), env });
  assert.equal(response.status, 502);
});
