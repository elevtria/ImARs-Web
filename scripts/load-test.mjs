import assert from "node:assert/strict";
import http from "node:http";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { fixture } from "../tests/fixtures/web-data.js";
import { protectWebsite } from "../server/web-auth.js";
import { webData } from "../server/web-data.js";

// Local fixture-only HTTP test. No production URL or credentials are accepted.
const args = process.argv.slice(2);
const allowed = ["--vus", "--iterations", "--students", "--delay-ms", "--out"];
if (args.length % 2 || args.some((value, i) => i % 2 === 0 && !allowed.includes(value))) {
  throw new Error("Use --vus N --iterations N --students N --delay-ms N --out path.json");
}
const value = flag => args[args.indexOf(flag) + 1];
const number = (flag, fallback, minimum, maximum) => {
  const result = args.includes(flag) ? Number(value(flag)) : fallback;
  if (!Number.isInteger(result) || result < minimum || result > maximum) throw new Error(`Invalid ${flag}`);
  return result;
};
const vus = number("--vus", 10, 1, 200), iterations = number("--iterations", 5, 1, 1000);
const students = number("--students", 1000, 25, 50000), delayMs = number("--delay-ms", 0, 0, 2000);
const app = fixture();
for (let i = 0; i < students; i++) {
  const id = "LOAD" + String(i).padStart(6, "0");
  app.data.set("users/" + id, { role: "student", classCode: "A", teacherId: "TEACH1000", active: true, displayName: "Sample " + i });
  for (let lesson = 1; lesson <= 4; lesson++) app.data.set(`users/${id}/test_results/term_01/lessons/lesson_0${lesson}`, {
    isPreTestCompleted: true, preTestScore: 3, preTestTotalQuestions: 5,
    isPostTestCompleted: true, postTestScore: 8, postTestTotalQuestions: 10
  });
}
const metrics = { databaseCalls: 0, resultBatches: 0, maximumResultDocuments: 0 };
for (const name of ["get", "query", "count", "identity", "getAll"]) {
  const original = app.store[name].bind(app.store);
  app.store[name] = async (...values) => {
    metrics.databaseCalls++;
    if (name === "getAll") {
      metrics.resultBatches++;
      metrics.maximumResultDocuments = Math.max(metrics.maximumResultDocuments, values[0].length);
      assert.ok(values[0].every(path => path.includes("/test_results/term_01/")));
    }
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    return original(...values);
  };
}
const cookie = await app.login();
const server = http.createServer(async (incoming, outgoing) => {
  try {
    if (incoming.url !== "/api/web-data" || incoming.method !== "POST") { outgoing.writeHead(404).end(); return; }
    let raw = "";
    for await (const chunk of incoming) raw += chunk;
    const request = app.request("/api/web-data", JSON.parse(raw), incoming.headers.cookie, { "X-Web-User": incoming.headers["x-web-user"] || "" });
    const response = await protectWebsite({ request, env: app.env, next: () => webData({ request, env: app.env }, { store: app.store }) });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(await response.text());
  } catch { outgoing.writeHead(500).end('{"error":"Local load test failed"}'); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/api/web-data`;
const latencies = [], errors = [];
let bytes = 0, maximumStudents = 0;
const started = performance.now();
try {
  await Promise.all(Array.from({ length: vus }, async () => {
    let cursor = null;
    for (let i = 0; i < iterations; i++) {
      const action = i % 2 ? "teacher-report-page" : "student-page";
      const before = performance.now();
      try {
        const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, "X-Web-User": "teacher-a" },
          body: JSON.stringify({ action, sectionId: "A", termId: "term_01", cursor, includeCurriculum: i === 1 }), signal: AbortSignal.timeout(30000) });
        const text = await response.text(), result = JSON.parse(text);
        assert.equal(response.status, 200);
        assert.ok(result.students.length <= 25);
        assert.ok(result.students.every(row => row.classId === "A"));
        if (action === "teacher-report-page") assert.equal(result.termId, "term_01");
        assert.ok(!text.includes("must-never-leave-server"));
        maximumStudents = Math.max(maximumStudents, result.students.length);
        cursor = result.cursor; bytes += Buffer.byteLength(text);
      } catch (error) { errors.push(error.message); }
      latencies.push(performance.now() - before);
    }
  }));
} finally {
  server.closeIdleConnections();
  await new Promise(resolve => server.close(resolve));
}
latencies.sort((a, b) => a - b);
const percentile = n => Math.round(latencies[Math.max(0, Math.ceil(latencies.length * n) - 1)]);
const seconds = (performance.now() - started) / 1000;
const report = { scope: "local HTTP + in-memory fixtures; not production capacity", vus, iterationsPerVu: iterations, sampleStudents: students + 1,
  artificialDatabaseDelayMs: delayMs, requests: latencies.length, failures: errors.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99),
  requestsPerSecond: Math.round(latencies.length / seconds), responseBytes: bytes, maximumStudentsPerResponse: maximumStudents, ...metrics };
console.log(JSON.stringify(report, null, 2));
if (args.includes("--out")) await writeFile(value("--out"), JSON.stringify(report, null, 2) + "\n");
assert.equal(app.store.committed, 0, "load tests must not write student records");
assert.equal(errors.length, 0, errors[0]);
