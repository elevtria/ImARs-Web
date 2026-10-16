import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createLoadingTracker, startLoading } from "../js/loading.js";
import { wrapFirestoreReads } from "../js/firebase-loading.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("quick cached or empty reads finish without showing a loader", async () => {
  const states = [];
  let cancelled = false;
  const loading = createLoadingTracker((state) => states.push(state.active), {
    delayMs: 150,
    schedule: () => 1,
    cancel: () => { cancelled = true; }
  });
  const reads = wrapFirestoreReads({ getDocs: async () => ({ empty: true, docs: [] }) }, loading);
  await reads.getDocs("empty collection");
  assert.equal(cancelled, true);
  assert.equal(states.includes(true), false);
  assert.equal(loading.pendingCount, 0);
});

test("a genuinely pending fetch reveals the loader after the short delay", async () => {
  const states = [];
  let reveal;
  const loading = createLoadingTracker((state) => states.push(state.active), {
    delayMs: 150,
    schedule: (callback) => { reveal = callback; return 1; },
    cancel() {}
  });
  const request = deferred();
  const pending = loading.run(() => request.promise);
  assert.equal(states.includes(true), false);
  reveal();
  assert.equal(states.at(-1), true);
  request.resolve("data");
  await pending;
  assert.equal(states.at(-1), false);
});

test("concurrent reads keep loading until the last request finishes", async () => {
  const states = [];
  const loading = createLoadingTracker((state) => states.push(state.active));
  const first = deferred(), second = deferred();
  const reads = wrapFirestoreReads({ getDoc: () => first.promise, getDocs: () => second.promise }, loading);
  const a = reads.getDoc("profile"), b = reads.getDocs("students");
  assert.equal(loading.pendingCount, 2);
  first.resolve("profile data");
  assert.equal(await a, "profile data");
  assert.equal(loading.pendingCount, 1);
  assert.equal(states.at(-1), true);
  second.resolve("student data");
  assert.equal(await b, "student data");
  assert.equal(loading.pendingCount, 0);
  assert.equal(states.at(-1), false);
});

test("failed reads release loading and preserve the original error", async () => {
  const loading = createLoadingTracker(() => {});
  const failure = new Error("permission-denied");
  const reads = wrapFirestoreReads({ getDocs: async () => { throw failure; } }, loading);
  await assert.rejects(reads.getDocs("students"), (error) => error === failure);
  assert.equal(loading.pendingCount, 0);
});

test("synchronous SDK errors also release loading", async () => {
  const loading = createLoadingTracker(() => {});
  const reads = wrapFirestoreReads({ getDoc() { throw new Error("invalid reference"); } }, loading);
  await assert.rejects(reads.getDoc(null), /invalid reference/);
  assert.equal(loading.pendingCount, 0);
});

test("listeners load once, keep receiving updates, and preserve options", () => {
  const loading = createLoadingTracker(() => {});
  let callback, options, unsubscribed = false;
  const reads = wrapFirestoreReads({ onSnapshot(ref, opts, next) {
    assert.equal(ref, "lessons");
    options = opts;
    callback = next;
    return () => { unsubscribed = true; };
  } }, loading);
  const updates = [];
  const unsubscribe = reads.onSnapshot("lessons", { includeMetadataChanges: true }, (data) => updates.push(data));
  assert.equal(loading.pendingCount, 1);
  assert.equal(options.includeMetadataChanges, true);
  callback("initial data");
  assert.equal(loading.pendingCount, 0);
  callback("remote update");
  assert.equal(loading.pendingCount, 0);
  assert.deepEqual(updates, ["initial data", "remote update"]);
  unsubscribe();
  assert.equal(unsubscribed, true);
});

test("listener errors and unsubscribe before a result release loading", () => {
  const loading = createLoadingTracker(() => {});
  let handleError;
  const reads = wrapFirestoreReads({ onSnapshot(ref, next, error) {
    handleError = error;
    return () => {};
  } }, loading);
  let received;
  reads.onSnapshot("lessons", () => {}, (error) => { received = error; });
  const failure = new Error("permission-denied");
  handleError(failure);
  assert.equal(received, failure);
  assert.equal(loading.pendingCount, 0);
  const unsubscribe = reads.onSnapshot("lessons", () => {});
  assert.equal(loading.pendingCount, 1);
  unsubscribe();
  unsubscribe();
  assert.equal(loading.pendingCount, 0);
});

test("observer-style listeners and throwing callbacks release loading", () => {
  const loading = createLoadingTracker(() => {});
  let observer;
  const reads = wrapFirestoreReads({ onSnapshot(ref, value) { observer = value; return () => {}; } }, loading);
  reads.onSnapshot("lessons", { next() { throw new Error("render failed"); } });
  assert.throws(() => observer.next({}), /render failed/);
  assert.equal(loading.pendingCount, 0);
});

test("loader appears as a modal and closes only after all tasks finish", async () => {
  const previousDocument = globalThis.document;
  const previousFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => queueMicrotask(callback);
  const nodes = new Map(["img", "#appLoadingTitle", "#appLoadingDetail"].map((name) => [name, {}]));
  const dialog = {
    open: false, hidden: true, attributes: {}, events: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    querySelector(name) { return nodes.get(name); },
    addEventListener(name, callback) { this.events[name] = callback; },
    showModal() { this.open = true; }, close() { this.open = false; }
  };
  globalThis.document = { createElement: () => dialog, body: { append() {} } };
  try {
    const finishA = startLoading(), finishB = startLoading();
    assert.equal(dialog.open, false);
    await delay(170);
    assert.equal(dialog.open, true);
    assert.equal(dialog.attributes["aria-busy"], "true");
    assert.match(nodes.get("img").src, /imars-loader-transparent\.png$/);
    finishA();
    await Promise.resolve();
    assert.equal(dialog.open, true);
    let cancelled = false;
    dialog.events.cancel({ preventDefault() { cancelled = true; } });
    assert.equal(cancelled, true);
    finishB();
    await Promise.resolve();
    assert.equal(dialog.open, false);
    assert.equal(dialog.hidden, true);
    assert.equal(dialog.attributes["aria-busy"], "false");

    // A new short request during a queued close must not leave the old dialog open.
    const finishC = startLoading();
    await delay(170);
    finishC();
    const finishD = startLoading();
    await Promise.resolve();
    assert.equal(dialog.open, true);
    finishD();
    await Promise.resolve();
    assert.equal(dialog.open, false);
  } finally {
    globalThis.document = previousDocument;
    globalThis.requestAnimationFrame = previousFrame;
  }
});
