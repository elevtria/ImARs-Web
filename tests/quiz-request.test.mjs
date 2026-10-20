import assert from "node:assert/strict";
import test from "node:test";
import { requestQuiz } from "../js/quiz-request.js";

const questions = [{ text: "Which material freezes into ice?", options: ["Water", "Sand", "Air", "Metal"], correctIndex: 0 }];
const payload = { questionCount: 1, sectionId: "fixture-section", fileName: "science.docx" };

test("quiz requests preserve teacher authorization, requested options and the review question format", async t => {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "/api/generate-quiz");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, "Bearer test-token");
    assert.deepEqual(JSON.parse(options.body), payload);
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ questions });
  });
  assert.deepEqual(await requestQuiz("test-token", payload), questions);
});

test("server errors and an HTML 404 produce useful errors instead of an endless pending state", async t => {
  const mock = t.mock.method(globalThis, "fetch", async () => Response.json({ error: "Please retry with fewer questions." }, { status: 504 }));
  await assert.rejects(requestQuiz("test-token", payload), /fewer questions/);
  mock.mock.mockImplementation(async () => new Response("<!doctype html>Missing route", { status: 404 }));
  await assert.rejects(requestQuiz("test-token", payload), /unavailable.*Refresh/);
  mock.mock.mockImplementation(async () => Response.json({ questions: [] }));
  await assert.rejects(requestQuiz("test-token", payload), /returned no questions/);
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
    const pending = requestQuiz("test-token", payload);
    await ready;
    deadline.abort(new DOMException("Timed out", "TimeoutError"));
    await assert.rejects(pending, /took too long.*fewer questions/);
    assert.equal(mock.mock.callCount(), 1);
  });
}
