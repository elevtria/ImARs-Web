import { FirestoreAdmin } from "./firestore-admin.js";
import { requireStaff, readJson, staffProfile, stateCall } from "./web-auth.js";
import { onRequestPost as generateQuiz } from "../functions/api/generate-quiz.js";
import { MAX_QUIZ_FILE_BYTES, MAX_QUIZ_TEXT_CHARACTERS } from "../js/quiz-limits.js";
import { limitedStream } from "./quiz-material.js";
import { dispatchJob } from "./netlify-runtime.js";

export const QUIZ_CHUNK_BYTES = 3_000_000;
const lifetime = 20 * 60_000;
const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const validId = id => typeof id === "string" && /^[a-f0-9]{32}$/.test(id);
const chunkKey = (id, index) => `quiz-chunks/${id}/${String(index).padStart(2, "0")}`;
const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");

export async function netlifyQuizJobs({ request, env, store }, { database = new FirestoreAdmin(env), authenticate = requireStaff, now = () => Date.now(), dispatch = dispatchJob } = {}) {
  try {
    const actor = await authenticate(request, env, database);
    if (actor.role !== "teacher") throw fail("Only a teacher can generate quizzes.", 403);
    const url = new URL(request.url), action = url.pathname.split("/").filter(Boolean).at(-1);
    if (request.method !== "POST") throw fail("Use POST.", 405);
    if (action === "start") {
      const settings = await readJson(request, 500_000);
      if (!settings || typeof settings !== "object" || Array.isArray(settings) || !["application/pdf", "text/plain"].includes(settings.fileMimeType) ||
          typeof settings.fileName !== "string" || settings.fileName.length > 200 || !Number.isSafeInteger(settings.questionCount) || settings.questionCount < 1 || settings.questionCount > 50 ||
          !["multiple-choice", "true-false", "essay", "identification-explanation", "modified-true-false"].includes(settings.questionType) ||
          !["Easy", "Medium", "Hard"].includes(settings.difficulty)) throw fail("Choose valid quiz settings.");
      const pdf = settings.fileMimeType === "application/pdf";
      if (pdf ? !Number.isSafeInteger(settings.fileSize) || settings.fileSize < 1 || settings.fileSize > MAX_QUIZ_FILE_BYTES
        : typeof settings.sourceText !== "string" || !settings.sourceText.trim() || settings.sourceText.length > MAX_QUIZ_TEXT_CHARACTERS) throw fail("Choose a learning file of 50 MB or less.");
      if (settings.sectionId) {
        if (typeof settings.sectionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(settings.sectionId) || (await database.get("classes/" + settings.sectionId))?.data.teacherId !== actor.id) throw fail("Choose one of your own sections.", 403);
      }
      const rate = await stateCall(env, "quiz-generation:" + actor.uid, "generation-rate");
      if (!rate.ok) throw fail("Please wait before generating another quiz.", rate.status === 429 ? 429 : 503);
      const id = crypto.randomUUID().replaceAll("-", "");
      // Retain only approved settings. File URIs, tokens, answers and provider
      // options supplied by a client cannot enter the background generation.
      const clean = Object.fromEntries(["fileName", "fileMimeType", "fileSize", "sourceText", "questionCount", "questionType", "difficulty", "sectionId"].filter(key => settings[key] !== undefined).map(key => [key, settings[key]]));
      const job = { id, actor: { id: actor.id, uid: actor.uid, role: actor.role, email: actor.email }, origin: url.origin, settings: clean,
        chunks: pdf ? Math.ceil(settings.fileSize / QUIZ_CHUNK_BYTES) : 0, status: "uploading", expiresAt: now() + lifetime };
      await store.setJSON("quiz-jobs/" + id, job, { onlyIfNew: true });
      return json({ id, chunkBytes: QUIZ_CHUNK_BYTES });
    }
    const id = url.searchParams.get("id");
    if (!validId(id)) throw fail("Invalid quiz upload.");
    const key = "quiz-jobs/" + id, saved = await store.getWithMetadata(key, { type: "json", consistency: "strong" }), job = saved?.data;
    if (!job || job.actor.uid !== actor.uid || job.actor.id !== actor.id || job.origin !== url.origin) throw fail("This quiz upload is not available.", 403);
    if (job.expiresAt <= now()) throw fail("This quiz upload expired. Please generate it again.", 410);
    if (action === "status") return json(job.status === "complete" ? { status: "complete", ...job.result }
      : job.status === "failed" ? { status: "failed", error: job.error } : { status: job.status });
    if (action === "chunk") {
      const raw = url.searchParams.get("index");
      if (!/^\d{1,2}$/.test(raw || "") || job.status !== "uploading" || !job.chunks || Number(raw) >= job.chunks) throw fail("Invalid upload chunk.");
      const index = Number(raw), expected = Math.min(QUIZ_CHUNK_BYTES, job.settings.fileSize - index * QUIZ_CHUNK_BYTES);
      const bytes = await new Response(limitedStream(request.body, QUIZ_CHUNK_BYTES, expected)).arrayBuffer();
      const hash = await digest(bytes), chunk = chunkKey(id, index);
      const previous = await store.getWithMetadata(chunk, { type: "arrayBuffer", consistency: "strong" });
      if (previous) {
        if (previous.metadata.sha256 !== hash) throw fail("This upload chunk changed. Choose the file again.", 409);
      } else if (!(await store.set(chunk, bytes, { onlyIfNew: true, metadata: { sha256: hash } })).modified) {
        const current = await store.getWithMetadata(chunk, { type: "arrayBuffer", consistency: "strong" });
        if (current?.metadata.sha256 !== hash) throw fail("This upload chunk changed. Choose the file again.", 409);
      }
      return json({ ok: true });
    }
    if (action === "run") {
      if (job.status === "running" || job.status === "complete") return json({ status: job.status }, 202);
      if (!["uploading", "queued"].includes(job.status)) throw fail("Generate this quiz again.", 409);
      for (let index = 0; index < job.chunks; index++) if (!await store.getMetadata(chunkKey(id, index))) throw fail("The file upload is incomplete. Please try again.", 409);
      if (job.status === "uploading" && !(await store.setJSON(key, { ...job, status: "queued" }, { onlyIfMatch: saved.etag })).modified) throw fail("The quiz upload changed. Please retry.", 409);
      await dispatch(env, { kind: "quiz", id });
      return json({ status: "queued" }, 202);
    }
    throw fail("Not found.", 404);
  } catch (error) { return json({ error: [400, 401, 403, 409, 410, 413, 429].includes(error.status) ? error.message : "The quiz upload could not be completed. Please retry." }, error.status || 503); }
}

export async function runNetlifyQuiz(id, env, store, { database = new FirestoreAdmin(env), generate = generateQuiz, now = () => Date.now() } = {}) {
  if (!validId(id)) throw new Error("Invalid quiz job");
  const key = "quiz-jobs/" + id, previous = await store.getWithMetadata(key, { type: "json", consistency: "strong" }), job = previous?.data;
  if (!job || job.status !== "queued" || job.expiresAt <= now()) return;
  const claimed = await store.setJSON(key, { ...job, status: "running" }, { onlyIfMatch: previous.etag });
  if (!claimed.modified) return;
  let result;
  try {
    const actor = await staffProfile(job.actor, database);
    if (actor.role !== "teacher") throw new Error("Teacher access changed");
    const pdf = job.chunks > 0;
    let body = JSON.stringify(job.settings);
    if (pdf) {
      let index = 0;
      body = new ReadableStream({ async pull(controller) {
        if (index >= job.chunks) { controller.close(); return; }
        const bytes = await store.get(chunkKey(id, index++), { type: "arrayBuffer", consistency: "strong" });
        if (!bytes) { controller.error(new Error("Missing upload chunk")); return; }
        controller.enqueue(new Uint8Array(bytes));
      } });
    }
    const request = new Request(job.origin + "/api/generate-quiz", { method: "POST", headers: { "Content-Type": pdf ? "application/pdf" : "application/json",
      ...(pdf ? { "X-Quiz-Options": encodeURIComponent(JSON.stringify(job.settings)), "Content-Length": String(job.settings.fileSize) } : {}) }, body, duplex: "half" });
    const cleanup = [];
    let response;
    try { response = await generate({ request, env, waitUntil: promise => cleanup.push(promise) }, { store: database, authenticate: async () => actor, limitGeneration: false }); }
    finally { await Promise.allSettled(cleanup); }
    result = await response.json();
    result = response.ok && Array.isArray(result.questions) && result.questions.length ? { status: "complete", result } : { status: "failed", error: result.error || "Quiz generation failed. Please retry." };
  } catch { result = { status: "failed", error: "Quiz generation could not finish. Please try again." }; }
  // A repeated background invocation cannot replace an already completed job.
  await store.setJSON(key, { ...job, ...result }, { onlyIfMatch: claimed.etag });
  for (let index = 0; index < job.chunks; index++) await store.delete(chunkKey(id, index));
}
