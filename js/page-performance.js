import { getReadMetrics } from "./firebase-data.js";

// These measurements contain counts and timings only, never student data or IDs.
export function createPagePerformance(page) {
  const started = performance.now();
  const before = getReadMetrics();
  let dataMs = 0, renderMs = 0;
  return {
    async data(operation) {
      const start = performance.now();
      try { return await operation(); }
      finally {
        const end = performance.now();
        dataMs += end - start;
        performance.measure(`ImARs: ${page} data`, { start, end });
      }
    },
    render(operation) {
      const start = performance.now();
      try { return operation(); }
      finally {
        const end = performance.now();
        renderMs += end - start;
        performance.measure(`ImARs: ${page} render`, { start, end });
      }
    },
    finish(outcome = "loaded", details = {}) {
      requestAnimationFrame(() => {
        const after = getReadMetrics();
        window.imarsPerformance = {
          page, outcome, ...details,
          dataMs: Math.round(dataMs),
          renderMs: Math.round(renderMs),
          startupMs: Math.round(started),
          readyMs: Math.round(performance.now()),
          queries: after.requests - before.requests,
          duplicateReadsAvoided: after.reused - before.reused,
          documentsReceived: after.documents - before.documents,
          failedReads: after.failed - before.failed,
          maxConcurrentReads: after.peakConcurrent
        };
      });
    }
  };
}
