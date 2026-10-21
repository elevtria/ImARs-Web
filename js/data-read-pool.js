// Share equivalent pending reads and cap the number sent to Firestore at once.
// Results stay in memory only while a request is pending; every later read is fresh.
export function createReadPool({ concurrency = 8, equal = (_, a, b) => a === b, now = () => performance.now() } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError("Invalid read concurrency");
  const pending = [];
  const waiting = [];
  let active = 0;
  const totals = { requests: 0, reused: 0, failed: 0, documents: 0, peakConcurrent: 0, requestMs: 0 };
  function drain() {
    while (active < concurrency && waiting.length) {
      const task = waiting.shift();
      active++;
      totals.requests++;
      totals.peakConcurrent = Math.max(totals.peakConcurrent, active);
      const started = now();
      const complete = (failed, result) => {
        totals.requestMs += now() - started;
        active--;
        pending.splice(pending.indexOf(task), 1);
        if (failed) totals.failed++;
        else totals.documents += result?.size ?? (result?.exists?.() ? 1 : 0);
        drain();
        if (failed) task.reject(result);
        else task.resolve(result);
      };
      Promise.resolve().then(task.operation).then(result => complete(false, result), error => complete(true, error));
    }
  }
  return {
    read(kind, reference, operation) {
      const existing = pending.find(task => task.kind === kind && equal(kind, task.reference, reference));
      if (existing) { totals.reused++; return existing.promise; }
      const task = { kind, reference, operation };
      task.promise = new Promise((resolve, reject) => { task.resolve = resolve; task.reject = reject; });
      pending.push(task);
      waiting.push(task);
      drain();
      return task.promise;
    },
    metrics: () => ({ ...totals, active, queued: waiting.length })
  };
}
