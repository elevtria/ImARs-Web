import assert from "node:assert/strict";
import test from "node:test";
import { createReadPool } from "../js/data-read-pool.js";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

test("many independent result reads overlap while respecting the eight-request limit", async () => {
  const pool = createReadPool();
  const gates = Array.from({ length: 27 }, deferred);
  let started = 0;
  const reads = gates.map((gate, index) => pool.read("query", index, () => { started++; return gate.promise; }));
  await flush();
  assert.equal(started, 8);
  assert.equal(pool.metrics().queued, 19);
  gates[0].resolve({ size: 2 });
  await flush();
  assert.equal(started, 9);
  for (let i = 1; i < gates.length; i++) gates[i].resolve({ size: 2 });
  await Promise.all(reads);
  assert.equal(pool.metrics().requests, 27);
  assert.equal(pool.metrics().documents, 54);
  assert.equal(pool.metrics().peakConcurrent, 8);
  assert.equal(pool.metrics().active, 0);
});

test("equivalent pending profile queries share one read; later reads fetch fresh results", async () => {
  const pool = createReadPool({ equal: (_, a, b) => a.path === b.path });
  const gate = deferred();
  let calls = 0;
  const a = pool.read("query", { path: "profile" }, () => { calls++; return gate.promise; });
  const b = pool.read("query", { path: "profile" }, () => { calls++; });
  assert.equal(a, b);
  gate.resolve({ size: 1 });
  await a;
  const changed = await pool.read("query", { path: "profile" }, () => { calls++; return { size: 2 }; });
  assert.equal(changed.size, 2);
  assert.equal(calls, 2);
  assert.equal(pool.metrics().reused, 1);
});

test("failed and synchronous reads preserve errors, free queued slots, and can be retried", async () => {
  const pool = createReadPool({ concurrency: 1 });
  const failure = new Error("permission-denied");
  const failed = pool.read("document", "a", () => { throw failure; });
  const next = pool.read("document", "b", () => ({ exists: () => true }));
  await assert.rejects(failed, error => error === failure);
  await next;
  const retry = await pool.read("document", "a", () => ({ exists: () => false }));
  assert.equal(retry.exists(), false);
  assert.equal(pool.metrics().failed, 1);
  assert.equal(pool.metrics().documents, 1);
  assert.equal(pool.metrics().active, 0);
});
