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
const questions = [{ text: "What does water become when it freezes?", options: ["Ice", "Liquid water", "Water vapour", "Water droplets"], correctIndex: 0 }];
function request(body = material, authorized = true) {
  return new Request("https://hosting-test.invalid/api/generate-quiz", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(authorized ? { Authorization: "Bearer hosting-test-token" } : {}) },
    body: JSON.stringify(body)
  });
}
function upstream(t, { role = "teacher", owner = "test-teacher", generate, review } = {}) {
  const geminiCalls = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    if (url.includes("identitytoolkit.googleapis.com")) return Response.json({ users: [{ localId: "test-uid" }] });
    if (url.includes("documents:runQuery")) return Response.json([{ document: {
      name: "projects/test/databases/(default)/documents/users/test-teacher",
      fields: { role: { stringValue: role } }
    } }]);
    if (url.includes("documents/classes/")) return Response.json({ fields: { teacherId: { stringValue: owner } } });
    if (url.includes("generativelanguage.googleapis.com")) {
      const body = JSON.parse(options.body);
      geminiCalls.push(body);
      if (body.response_format.schema.properties.checks) return review ? review(body, options) : Response.json({ output_text: JSON.stringify({ checks: [{ questionIndex: 0, topicRelevant: true, plausibleDistractors: true, singleCorrect: true, supportedAnswer: true }] }) });
      return generate ? generate(geminiCalls.length, options) : Response.json({ output_text: JSON.stringify({ questions }) });
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
  assert.equal(calls[0].model, "gemini-3.5-flash-lite");
  assert.equal(calls[0].generation_config.thinking_level, "minimal");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].store, false);
  assert.match(calls[1].input[0].text, /ALL four options/);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.match(response.headers.get("Server-Timing"), /^verify;dur=\d+, upload;dur=\d+, ai;dur=\d+, total;dur=\d+$/);
});

test("teachers can generate before choosing a section, while malformed optional sections remain invalid", async t => {
  const calls = upstream(t);
  const { sectionId, ...unassigned } = material;
  assert.equal((await onRequestPost({ request: request(unassigned), env })).status, 200);
  assert.equal(calls.length, 2);
  for (const value of ["", "*", null, "../other"]) {
    assert.equal((await onRequestPost({ request: request({ ...unassigned, sectionId: value }), env })).status, 400);
  }
});

test("a busy Flash-Lite model falls back to Flash with low thinking and the same deadline", async (t) => {
  const signals = [];
  const calls = upstream(t, { generate: (count, options) => {
    signals.push(options.signal);
    return count === 1 ? Response.json({ error: { message: "Busy" } }, { status: 503 })
      : Response.json({ steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify({ questions }) }] }] });
  }, review: (_, options) => {
    signals.push(options.signal);
    return Response.json({ output_text: JSON.stringify({ checks: [{ questionIndex: 0, topicRelevant: true, plausibleDistractors: true, singleCorrect: true, supportedAnswer: true }] }) });
  } });
  const response = await onRequestPost({ request: request(), env });
  assert.equal(response.status, 200);
  assert.deepEqual(calls.map((call) => call.model), ["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3.8-flash"]);
  assert.equal(calls[1].generation_config.thinking_level, "low");
  assert.equal(signals[0], signals[1]);
  assert.equal(signals[1], signals[2]);
});

test("a stalled option review uses the generation deadline and never returns unchecked questions", async t => {
  const deadline = new AbortController();
  t.mock.method(AbortSignal, "timeout", milliseconds => {
    assert.equal(milliseconds, 60000);
    return deadline.signal;
  });
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const calls = upstream(t, { review: (_, options) => new Promise((resolve, reject) => {
    assert.equal(options.signal, deadline.signal);
    entered();
    options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
  }) });
  const pending = onRequestPost({ request: request(), env });
  await ready;
  deadline.abort(new DOMException("Timed out", "TimeoutError"));
  const response = await pending;
  assert.equal(response.status, 504);
  const result = await response.json();
  assert.match(result.error, /Checking the answer options took too long/);
  assert.equal(result.questions, undefined);
  assert.equal(calls.length, 2);
});

test("hard quizzes retain low thinking and PDF material stays in the server request", async t => {
  const calls = upstream(t);
  const fileBase64 = Buffer.from("PDF fixture with science content").toString("base64");
  const response = await onRequestPost({ request: request({ ...material, difficulty: "Hard", fileName: "science.pdf", fileMimeType: "application/pdf", fileBase64 }), env });
  assert.equal(response.status, 200);
  assert.equal(calls[0].generation_config.thinking_level, "low");
  assert.deepEqual(calls[0].input[1], { type: "document", data: fileBase64, mime_type: "application/pdf" });
});

test("a stalled Gemini call aborts and returns a retry message without another paid generation", async t => {
  const deadline = new AbortController();
  t.mock.method(AbortSignal, "timeout", milliseconds => {
    assert.equal(milliseconds, 60000);
    return deadline.signal;
  });
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const calls = upstream(t, { generate: (_, options) => new Promise((resolve, reject) => {
    entered();
    options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
  }) });
  const pending = onRequestPost({ request: request(), env });
  await ready;
  deadline.abort(new DOMException("Timed out", "TimeoutError"));
  const response = await pending;
  assert.equal(response.status, 504);
  assert.match((await response.json()).error, /fewer questions/);
  assert.equal(calls.length, 1);
});

test("quota exhaustion returns 429 without exposing the key or retrying generation", async (t) => {
  const calls = upstream(t, { generate: () => Response.json({ error: { message: env.GEMINI_API_KEY } }, { status: 429 }) });
  const response = await onRequestPost({ request: request(), env });
  assert.equal(response.status, 429);
  assert.equal((await response.text()).includes(env.GEMINI_API_KEY), false);
  assert.equal(calls.length, 1);
});

test("invalid generated answers are rejected", async (t) => {
  upstream(t, { generate: () => Response.json({ output_text: JSON.stringify({ questions: [{ ...questions[0], correctIndex: 8 }] }) }) });
  const response = await onRequestPost({ request: request(), env });
  assert.equal(response.status, 502);
});

for (const field of ["topicRelevant", "plausibleDistractors", "singleCorrect", "supportedAnswer"]) {
  test(`a multiple-choice quiz is withheld when independent review rejects ${field}`, async t => {
    upstream(t, { review: () => Response.json({ output_text: JSON.stringify({ checks: [{ questionIndex: 0, topicRelevant: true, plausibleDistractors: true, singleCorrect: true, supportedAnswer: true, [field]: false }] }) }) });
    const response = await onRequestPost({ request: request(), env });
    assert.equal(response.status, 422);
    const result = await response.json();
    assert.match(result.error, /relevance or answer-quality/);
    assert.equal(result.questions, undefined);
  });
}

test("an unavailable or malformed relevance check never silently approves the quiz", async t => {
  upstream(t, { review: () => Response.json({ output_text: "{}" }) });
  assert.equal((await onRequestPost({ request: request(), env })).status, 422);
});

for (const [type, question] of [
  ["essay", { text: "Explain how cooling changes water.", answer: "Water loses heat and freezes into ice.", rubric: "Award credit for cooling, freezing and the solid state.", points: 5 }],
  ["identification-explanation", { text: "Identify frozen water and explain how it forms.", answer: "Ice", explanation: "Liquid water freezes when cooled.", points: 2 }],
  ["modified-true-false", { text: "Water becomes steam when it freezes.", options: ["True", "False"], correctIndex: 1, correction: "Water becomes ice when it freezes." }]
]) {
  test(`${type} generation returns an editable answer guide in its own schema`, async t => {
    const calls = upstream(t, { generate: () => Response.json({ output_text: JSON.stringify({ questions: [question] }) }) });
    const response = await onRequestPost({ request: request({ ...material, questionType: type }), env });
    assert.equal(response.status, 200);
    const generated = (await response.json()).questions[0];
    for (const [field, value] of Object.entries(question)) assert.deepEqual(generated[field], value);
    if (type !== "modified-true-false") { assert.deepEqual(generated.options, []); assert.equal(generated.correctIndex, -1); }
    assert.equal(calls.length, 1);
    assert.ok(calls[0].response_format.schema.properties.questions.items.required.includes(type === "modified-true-false" ? "correction" : "answer"));
  });
}
