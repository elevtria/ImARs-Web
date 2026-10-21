import { MAX_QUIZ_FILE_BYTES, quizFileSizeError } from "../js/quiz-limits.js";

const API = "https://generativelanguage.googleapis.com";
const MAX_JSON_BYTES = 15_000_000; // Older open tabs can still submit small inline PDFs.
const UPLOAD_TIMEOUT_MS = 180_000;
const fileNamePattern = /^files\/[a-z0-9-]{1,64}$/;

export class QuizRequestError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// Count actual bytes even when Content-Length is absent or untrusted.
export function limitedStream(source, maximum, expected) {
  if (!source) throw new QuizRequestError("This file is empty or could not be read.", 400);
  const reader = source.getReader();
  let total = 0;
  return new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          if (expected !== undefined && total !== expected) throw new QuizRequestError("The upload was incomplete. Please choose the file again.", 400);
          controller.close(); return;
        }
        total += value.byteLength;
        if (total > maximum) throw new QuizRequestError("Please choose a file of 50 MB or less.", 413);
        if (expected !== undefined && total > expected) throw new QuizRequestError("The uploaded file size did not match. Please choose the file again.", 400);
        controller.enqueue(value);
      } catch (error) {
        await reader.cancel(error).catch(() => {});
        controller.error(error);
      }
    },
    cancel(reason) { return reader.cancel(reason); }
  });
}

export async function readQuizMaterial(request) {
  const contentType = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (contentType === "application/pdf") {
    let body;
    try {
      const header = request.headers.get("X-Quiz-Options") || "";
      if (header.length > 8000) throw Error("Metadata too large");
      body = JSON.parse(decodeURIComponent(header));
      if (!body || typeof body !== "object" || Array.isArray(body)) throw Error("Invalid metadata");
    } catch { throw new QuizRequestError("The quiz settings could not be read. Please refresh and try again.", 400); }
    const error = quizFileSizeError(body.fileSize);
    if (error) throw new QuizRequestError(error, body.fileSize > MAX_QUIZ_FILE_BYTES ? 413 : 400);
    const declared = request.headers.get("Content-Length");
    if (declared !== null && Number(declared) !== body.fileSize) throw new QuizRequestError("The uploaded file size did not match. Please choose the file again.", 400);
    // The request determines this mode; JSON fields can never select a file URI.
    return { body: { ...body, fileMimeType: "application/pdf" }, binaryPdf: true };
  }
  if (contentType !== "application/json") throw new QuizRequestError("Choose a PDF, DOCX, or PPTX learning file.", 415);
  if (Number(request.headers.get("Content-Length") || 0) > MAX_JSON_BYTES) {
    throw new QuizRequestError("Please refresh the page to use the large-file upload, then choose a file of 50 MB or less.", 413);
  }
  try {
    return { body: await new Response(limitedStream(request.body, MAX_JSON_BYTES)).json(), binaryPdf: false };
  } catch (error) {
    if (error instanceof QuizRequestError) throw error;
    throw new QuizRequestError("The quiz request could not be read.", 400);
  }
}

function resourceName(file) {
  if (typeof file?.name !== "string" || !fileNamePattern.test(file.name)) throw new QuizRequestError("The PDF upload could not be confirmed. Please retry.", 502);
  return file.name;
}

function checkedUploadUrl(value) {
  try {
    const url = new URL(value);
    if (url.origin === API && url.pathname === "/upload/v1beta/files" && !url.username && !url.password && !url.hash) return url.href;
  } catch {}
  throw new QuizRequestError("The PDF upload could not be started. Please retry.", 502);
}

async function readProviderJson(response, stage) {
  if (!response.ok) {
    // Never include provider responses, upload URLs, source material or keys.
    console.error("[Quiz Generator] PDF service error", { stage, status: response.status });
    if (response.status === 429) throw new QuizRequestError("The question-generation service is busy or its usage limit has been reached. Please try again later.", 429);
    throw new QuizRequestError("The AI service could not process this PDF. Please retry or use a smaller file with no more than 1,000 pages.", 502);
  }
  try { return await response.json(); }
  catch { throw new QuizRequestError("The PDF upload could not be confirmed. Please retry.", 502); }
}

const pause = (milliseconds, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
  signal.addEventListener("abort", abort, { once: true });
});

export async function uploadPdf(source, size, apiKey, created) {
  const deadline = AbortSignal.timeout(UPLOAD_TIMEOUT_MS);
  const cancellation = new AbortController();
  const signal = AbortSignal.any([deadline, cancellation.signal]);
  let streamError;
  let transfer;
  try {
    const start = await fetch(API + "/upload/v1beta/files", {
      method: "POST", redirect: "manual", signal,
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json",
        "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(size), "X-Goog-Upload-Header-Content-Type": "application/pdf" },
      body: JSON.stringify({ file: { display_name: "ImARs quiz material" } })
    });
    if (!start.ok) await readProviderJson(start, "start");
    const uploadUrl = checkedUploadUrl(start.headers.get("X-Goog-Upload-URL"));
    let stream = limitedStream(source, MAX_QUIZ_FILE_BYTES, size);
    // Workers determine Content-Length from FixedLengthStream, not a manual
    // header on a generic stream. No PDF buffers or base64 strings are created.
    if (typeof FixedLengthStream !== "undefined") {
      const fixed = new FixedLengthStream(size);
      transfer = stream.pipeTo(fixed.writable, { signal }).catch(error => { streamError = error; });
      stream = fixed.readable;
    }
    const uploaded = await fetch(uploadUrl, {
      method: "POST", redirect: "manual", signal, duplex: "half",
      headers: { "Content-Type": "application/pdf", "Content-Length": String(size),
        "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" },
      body: stream
    });
    let file = (await readProviderJson(uploaded, "upload")).file;
    const name = resourceName(file);
    created(name); // Cleanup applies even if processing or later generation fails.
    await transfer;
    if (streamError) throw streamError;
    while (file.state === "PROCESSING") {
      // Five-second polling keeps even the full deadline below the free
      // runtime's subrequest limit, including auth, generation and cleanup.
      await pause(5000, signal);
      file = await readProviderJson(await fetch(API + "/v1beta/" + name, {
        headers: { "x-goog-api-key": apiKey }, redirect: "manual", signal
      }), "processing");
      if (resourceName(file) !== name) throw new QuizRequestError("The PDF upload could not be confirmed. Please retry.", 502);
    }
    if (file.state !== "ACTIVE" || file.mimeType !== "application/pdf" || file.uri !== API + "/v1beta/" + name) {
      throw new QuizRequestError("This PDF could not be read. Use a readable PDF with no more than 1,000 pages.", 422);
    }
    return file.uri;
  } catch (error) {
    cancellation.abort(error);
    await transfer;
    if (streamError instanceof QuizRequestError) throw streamError;
    if (error instanceof QuizRequestError) throw error;
    if (deadline.aborted) throw new QuizRequestError("Uploading or reading this PDF took too long. Please retry with a smaller file.", 504);
    throw new QuizRequestError("The PDF upload was interrupted. Please choose the file again and retry.", 502);
  } finally {
    cancellation.abort();
    await transfer;
  }
}

export async function deletePdf(name, apiKey) {
  if (!fileNamePattern.test(name)) return;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(API + "/v1beta/" + name, {
        method: "DELETE", headers: { "x-goog-api-key": apiKey }, redirect: "manual", signal: AbortSignal.timeout(5000)
      });
      if (response.ok || response.status === 404) return;
    } catch {}
  }
  console.warn("[Quiz Generator] Temporary PDF cleanup failed; provider expiration still applies.");
}
