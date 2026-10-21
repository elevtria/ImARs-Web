import assert from "node:assert/strict";
import test from "node:test";
import { deflateRawSync } from "node:zlib";
import { onRequestPost } from "../functions/api/generate-quiz.js";
import { limitedStream } from "../server/quiz-material.js";
import { requestQuiz } from "../js/quiz-request.js";
import { MAX_QUIZ_FILE_BYTES, PDF_REQUEST_TIMEOUT_MS, quizFileSizeError } from "../js/quiz-limits.js";
import { readOfficeZipEntries } from "../js/quiz-office.js";

const env = { GEMINI_API_KEY: "quiz-upload-test-key-only" };
const settings = { firebaseApiKey: "public-firebase-test-key-only", fileName: "Water cycle.pdf", sectionId: "fixture-section",
  questionCount: 1, questionType: "multiple-choice", difficulty: "Easy", fileMimeType: "application/pdf" };
const questions = [{ text: "What does water form when it freezes?", options: ["Ice", "Sand", "Air", "Metal"], correctIndex: 0 }];
const file = { name: "files/fixture-pdf", uri: "https://generativelanguage.googleapis.com/v1beta/files/fixture-pdf", mimeType: "application/pdf", state: "ACTIVE" };

function bytes(size) {
  let remaining = size;
  return new ReadableStream({ pull(controller) {
    if (!remaining) { controller.close(); return; }
    const length = Math.min(65536, remaining); remaining -= length;
    controller.enqueue(new Uint8Array(length));
  } });
}
function pdfRequest(size = 16000, options = {}) {
  return new Request("https://quiz-fixture.invalid/api/generate-quiz", { method: "POST", duplex: "half",
    headers: { "Content-Type": "application/pdf", Authorization: "Bearer fixture-token",
      "X-Quiz-Options": encodeURIComponent(JSON.stringify({ ...settings, fileSize: size, ...options.settings })), ...options.headers },
    body: bytes(options.actualSize ?? size)
  });
}
function provider(t, overrides = {}) {
  const calls = [], generations = [];
  let uploadedBytes = 0, largestChunk = 0;
  t.mock.method(console, "error", () => {}); t.mock.method(console, "warn", () => {});
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET" });
    if (url.includes("identitytoolkit.googleapis.com")) return Response.json({ users: [{ localId: "fixture-uid" }] });
    if (url.includes("documents:runQuery")) return Response.json([{ document: { name: "projects/fixture/documents/users/fixture-teacher", fields: { role: { stringValue: overrides.role || "teacher" } } } }]);
    if (url.includes("documents/classes/")) return Response.json({ fields: { teacherId: { stringValue: overrides.owner || "fixture-teacher" } } });
    if (options.method === "DELETE") return new Response(null, { status: overrides.deleteStatus || 200 });
    if (url.includes("upload_id=fixture")) {
      assert.ok(options.body instanceof ReadableStream);
      const reader = options.body.getReader();
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        uploadedBytes += value.byteLength; largestChunk = Math.max(largestChunk, value.byteLength);
      }
      return Response.json({ file: { ...file, state: overrides.state || "ACTIVE" } });
    }
    if (url.endsWith("/upload/v1beta/files")) {
      assert.equal(options.headers["x-goog-api-key"], env.GEMINI_API_KEY);
      return new Response(null, { headers: { "X-Goog-Upload-URL": overrides.uploadUrl || "https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=fixture" } });
    }
    if (url.endsWith("/v1beta/files/fixture-pdf")) return Response.json(file);
    if (url.endsWith("/interactions")) {
      const body = JSON.parse(options.body); generations.push(body);
      return overrides.generate ? overrides.generate(body) : Response.json({ output_text: JSON.stringify({ questions }) });
    }
    throw Error("Unexpected fixture request");
  });
  return { calls, generations, get uploadedBytes() { return uploadedBytes; }, get largestChunk() { return largestChunk; } };
}

test("the advertised 50 MB boundary accepts the exact maximum and rejects empty, invalid and oversized files", () => {
  assert.equal(quizFileSizeError(MAX_QUIZ_FILE_BYTES), "");
  assert.match(quizFileSizeError(MAX_QUIZ_FILE_BYTES + 1), /50 MB/);
  for (const size of [0, -1, NaN, 1.5]) assert.ok(quizFileSizeError(size));
});

test("a full 50 MB PDF streams in bounded chunks, uses a private provider URI and is deleted after generation", async t => {
  const mock = provider(t);
  const response = await onRequestPost({ request: pdfRequest(MAX_QUIZ_FILE_BYTES), env });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { questions });
  assert.equal(mock.uploadedBytes, MAX_QUIZ_FILE_BYTES); assert.ok(mock.largestChunk <= 65536);
  assert.deepEqual(mock.generations[0].input[1], { type: "document", uri: file.uri, mime_type: "application/pdf" });
  assert.equal(mock.calls.at(-1).method, "DELETE");
  assert.ok(mock.calls.findIndex(call => call.url.includes("documents/classes/")) < mock.calls.findIndex(call => call.url.includes("/upload/")));
});

test("raw PDF requests preserve the original Blob and Unicode filename without base64 or an API key in the browser", async t => {
  const blob = new File(["%PDF fixture"], "Aral—tubig.pdf", { type: "application/pdf" });
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", milliseconds => { assert.equal(milliseconds, PDF_REQUEST_TIMEOUT_MS); return originalTimeout(milliseconds); });
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "/api/generate-quiz"); assert.equal(options.body, blob);
    assert.equal(options.headers["Content-Type"], "application/pdf");
    const metadata = JSON.parse(decodeURIComponent(options.headers["X-Quiz-Options"]));
    assert.equal(metadata.fileName, blob.name); assert.equal(metadata.fileSize, blob.size);
    assert.equal("pdfFile" in metadata, false); assert.equal("fileBase64" in metadata, false);
    assert.equal(JSON.stringify(options.headers).includes(env.GEMINI_API_KEY), false);
    return Response.json({ questions });
  });
  assert.deepEqual(await requestQuiz({ ...settings, fileName: blob.name, pdfFile: blob }, "teacher-a"), questions);
});

test("oversized declarations, truncated streams and mismatched actual lengths cannot bypass server validation", async t => {
  const mock = provider(t);
  for (const [request, status] of [
    [pdfRequest(2, { settings: { fileSize: MAX_QUIZ_FILE_BYTES + 1 } }), 413],
    [pdfRequest(200, { actualSize: 199 }), 400],
    [pdfRequest(200, { actualSize: 201 }), 400],
    [pdfRequest(200, { headers: { "Content-Length": "199" } }), 400],
    [pdfRequest(2, { headers: { "X-Quiz-Options": "invalid-json" } }), 400]
  ]) assert.equal((await onRequestPost({ request, env })).status, status);
  assert.equal(mock.generations.length, 0);
});

test("students and teachers outside their assigned section cannot start paid PDF uploads", async t => {
  for (const overrides of [{ role: "student" }, { owner: "another-teacher" }]) {
    const mock = provider(t, overrides);
    const response = await onRequestPost({ request: pdfRequest(), env });
    assert.equal(response.status, 403);
    assert.equal(mock.calls.some(call => call.url.includes("/upload/")), false);
  }
});

test("an untrusted upload redirect is rejected without sending file bytes or credentials to another host", async t => {
  const mock = provider(t, { uploadUrl: "https://attacker.invalid/upload" });
  assert.equal((await onRequestPost({ request: pdfRequest(), env })).status, 502);
  assert.equal(mock.uploadedBytes, 0); assert.equal(mock.generations.length, 0);
  assert.ok(mock.calls.every(call => !call.url.includes("attacker")));
});

test("failed PDF processing and rejected generation both schedule deletion of the temporary file", async t => {
  for (const overrides of [{ state: "FAILED" }, { generate: () => Response.json({ error: { message: "Quota" } }, { status: 429 }) }]) {
    const mock = provider(t, overrides);
    const cleanups = [];
    const response = await onRequestPost({ request: pdfRequest(), env, waitUntil: promise => { cleanups.push(promise); } });
    assert.ok([422, 429].includes(response.status)); await Promise.all(cleanups);
    assert.equal(mock.calls.at(-1).method, "DELETE");
  }
});

test("processing is checked before generation and the temporary PDF is cleaned afterward", async t => {
  const mock = provider(t, { state: "PROCESSING" });
  assert.equal((await onRequestPost({ request: pdfRequest(), env })).status, 200);
  assert.ok(mock.calls.some(call => call.url.endsWith("/v1beta/files/fixture-pdf") && call.method === "GET"));
  assert.equal(mock.calls.at(-1).method, "DELETE");
});

test("a processing timeout returns a clear error and still deletes the uploaded PDF", async t => {
  const deadline = new AbortController(), timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", milliseconds => milliseconds === 180000 ? deadline.signal : timeout(milliseconds));
  const mock = provider(t, { state: "PROCESSING" });
  const pending = onRequestPost({ request: pdfRequest(), env });
  setImmediate(() => deadline.abort(new DOMException("Timed out", "TimeoutError")));
  const response = await pending;
  assert.equal(response.status, 504); assert.match((await response.json()).error, /smaller file/);
  assert.equal(mock.generations.length, 0); assert.equal(mock.calls.at(-1).method, "DELETE");
});

test("a client-provided file URI cannot replace an upload or reference another teacher's file", async t => {
  const mock = provider(t);
  const request = new Request("https://quiz-fixture.invalid/api/generate-quiz", { method: "POST",
    headers: { Authorization: "Bearer fixture-token", "Content-Type": "application/json" },
    body: JSON.stringify({ ...settings, binaryPdf: true, fileUri: file.uri, fileSize: 100 }) });
  assert.equal((await onRequestPost({ request, env })).status, 400);
  assert.equal(mock.calls.length, 0);
});

test("byte limits also reject streams with no Content-Length and stop reading excess data", async () => {
  const stream = limitedStream(bytes(65537), 65536);
  await assert.rejects(new Response(stream).arrayBuffer(), error => error.status === 413);
});

function officeZip(parts) {
  const locals = [], central = [];
  let offset = 0;
  for (const part of parts) {
    const name = Buffer.from(part.name), data = part.compressed || Buffer.from(part.data);
    const local = Buffer.alloc(30), directory = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(part.compressed ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(part.expandedSize ?? data.length, 22); local.writeUInt16LE(name.length, 26);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(part.compressed ? 8 : 0, 10);
    directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(part.expandedSize ?? data.length, 24);
    directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    locals.push(local, name, data); central.push(directory, name); offset += local.length + name.length + data.length;
  }
  const directorySize = central.reduce((size, data) => size + data.length, 0), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(parts.length, 8); end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(directorySize, 12); end.writeUInt32LE(offset, 16);
  return new Blob([...locals, ...central, end]);
}

test("a nearly 50 MB presentation reads its small XML parts without reading the full file or embedded picture", async () => {
  const blob = officeZip([{ name: "ppt/slides/slide1.xml", data: "<p>Water freezes into ice.</p>" },
    { name: "ppt/media/picture.png", data: Buffer.alloc(49_000_000) }]);
  const slices = [];
  const tracked = { size: blob.size, slice(start, end = blob.size) { slices.push(end - start); return blob.slice(start, end); },
    arrayBuffer() { throw Error("Full-file buffering is forbidden"); } };
  const entries = await readOfficeZipEntries(tracked, name => /^ppt\/slides\//.test(name));
  assert.equal(entries.length, 1); assert.match(entries[0].text, /Water freezes/);
  assert.ok(slices.reduce((sum, size) => sum + size, 0) < 140000);
});

test("forged compressed XML sizes cannot bypass the actual decompression limit", async () => {
  const compressed = deflateRawSync(Buffer.alloc(12 * 1024 * 1024 + 1));
  const blob = officeZip([{ name: "word/document.xml", compressed, expandedSize: 1 }]);
  await assert.rejects(readOfficeZipEntries(blob, () => true), /too much readable content/);
});
