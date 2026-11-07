import assert from "node:assert/strict";
import test from "node:test";
import { requestQuiz } from "../js/quiz-request.js";
import { normalizeQuizQuestion } from "../js/quiz-limits.js";
import { requestNetlifyQuiz } from "../js/netlify-quiz-request.js";

const questions = [{ text: "Which material freezes into ice?", options: ["Water", "Sand", "Air", "Metal"], correctIndex: 0 }];
const payload = { questionCount: 1, sectionId: "fixture-section", fileName: "science.docx" };

test("question validation rejects disguised duplicate choices and preserves true/false answer meaning", () => {
  assert.equal(normalizeQuizQuestion({ text: "Choose a state.", options: ["Liquid", " liquid! ", "Gas", "Solid"], correctIndex: 0 }, "multiple-choice"), null);
  assert.equal(normalizeQuizQuestion({ text: "A statement", options: ["False", "True"], correctIndex: 0 }, "true-false"), null);
  assert.equal(normalizeQuizQuestion({ text: "A statement", options: ["True", "False"], correctIndex: 1, correction: "" }, "modified-true-false"), null);
  assert.equal(normalizeQuizQuestion({ text: "A true statement", options: ["True", "False"], correctIndex: 0, correction: "" }, "modified-true-false").correctIndex, 0);
});

test("quiz requests preserve teacher authorization, requested options and the review question format", async t => {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "/api/generate-quiz");
    assert.equal(options.method, "POST");
    assert.equal(options.headers["X-Web-User"], "teacher-a");
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.credentials, "same-origin");
    assert.deepEqual(JSON.parse(options.body), payload);
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ questions });
  });
  assert.deepEqual(await requestQuiz(payload, "teacher-a"), questions);
});

test("server errors and an HTML 404 produce useful errors instead of an endless pending state", async t => {
  const mock = t.mock.method(globalThis, "fetch", async () => Response.json({ error: "Please retry with fewer questions." }, { status: 504 }));
  await assert.rejects(requestQuiz(payload, "teacher-a"), /fewer questions/);
  mock.mock.mockImplementation(async () => new Response("<!doctype html>Missing route", { status: 404 }));
  await assert.rejects(requestQuiz(payload, "teacher-a"), /unavailable.*Refresh/);
  mock.mock.mockImplementation(async () => Response.json({ questions: [] }));
  await assert.rejects(requestQuiz(payload, "teacher-a"), /returned no questions/);
});

for (const phase of ["fetch", "response body"]) {
  test(`the browser stops waiting for a stalled ${phase} without automatically sending a duplicate request`, async t => {
    const deadline = new AbortController();
    t.mock.method(AbortSignal, "timeout", milliseconds => {
      assert.equal(milliseconds, 105000);
      return deadline.signal;
    });
    let entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const waitForAbort = () => new Promise((resolve, reject) => {
      entered();
      deadline.signal.addEventListener("abort", () => reject(deadline.signal.reason), { once: true });
    });
    const mock = t.mock.method(globalThis, "fetch", () => phase === "fetch" ? waitForAbort() : ({ ok: true, json: waitForAbort }));
    const pending = requestQuiz(payload, "teacher-a");
    await ready;
    deadline.abort(new DOMException("Timed out", "TimeoutError"));
    await assert.rejects(pending, /took too long.*fewer questions/);
    assert.equal(mock.mock.callCount(), 1);
  });
}

test("Netlify uploads large PDFs in bounded chunks before starting one generation job", async t => {
  const id = "a".repeat(32), file = new Blob([new Uint8Array(10_000_001)]);
  const chunks = new Map(); let active = 0, peak = 0, runs = 0;
  t.mock.method(globalThis, "fetch", async (path, options) => {
    assert.equal(options.credentials, "same-origin");
    assert.equal(options.headers["X-Web-User"], "teacher-a");
    assert.ok(options.signal instanceof AbortSignal);
    const url = new URL(path, "https://backup.test");
    if (url.pathname.endsWith("/start")) {
      assert.equal(JSON.parse(options.body).fileSize, file.size);
      return Response.json({ id, chunkBytes: 3_000_000 });
    }
    assert.equal(url.searchParams.get("id"), id);
    if (url.pathname.endsWith("/chunk")) {
      const index = Number(url.searchParams.get("index"));
      assert.equal(options.headers["Content-Type"], "application/octet-stream");
      assert.ok(options.body instanceof Blob && options.body.size <= 3_000_000);
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setImmediate(resolve));
      chunks.set(index, options.body.size); active--;
      return Response.json({ ok: true });
    }
    if (url.pathname.endsWith("/run")) {
      runs++; assert.equal(chunks.size, 4); assert.equal(active, 0);
      return Response.json({ status: "queued" }, { status: 202 });
    }
    assert.ok(url.pathname.endsWith("/status"));
    return Response.json({ status: "complete", questions });
  });
  assert.deepEqual(await requestNetlifyQuiz({ fileMimeType: "application/pdf" }, file, "teacher-a", new AbortController().signal), questions);
  assert.deepEqual([...chunks].sort(([a], [b]) => a - b), [[0, 3_000_000], [1, 3_000_000], [2, 3_000_000], [3, 1_000_001]]);
  assert.equal(peak, 3); assert.equal(runs, 1);
});

test("Netlify quiz failures stop before review and polling respects cancellation", async t => {
  const id = "b".repeat(32), controller = new AbortController(); let mode = "failed", calls = 0;
  const mock = t.mock.method(globalThis, "fetch", async path => {
    calls++;
    if (path.endsWith("/start")) return Response.json({ id, chunkBytes: 3_000_000 });
    if (path.includes("/run?")) return Response.json({ status: "queued" }, { status: 202 });
    if (mode === "failed") return Response.json({ status: "failed", error: "Provider quota reached." });
    if (mode === "empty") return Response.json({ status: "complete", questions: [] });
    queueMicrotask(() => controller.abort(new DOMException("Cancelled", "AbortError")));
    return Response.json({ status: "running" });
  });
  await assert.rejects(requestNetlifyQuiz({}, null, "teacher-a", controller.signal), /Provider quota/);
  mode = "empty";
  await assert.rejects(requestNetlifyQuiz({}, null, "teacher-a", controller.signal), /no questions/);
  mode = "running"; const before = calls;
  await assert.rejects(requestNetlifyQuiz({}, null, "teacher-a", controller.signal), { name: "AbortError" });
  assert.equal(calls - before, 3, "cancelling must not start another generation request");
  assert.equal(mock.mock.callCount(), calls);
});
