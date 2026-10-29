import { readJson } from "./web-auth.js";
import { QUIZ_TYPES, normalizeQuizQuestion, writtenQuestion, quizAssignedToSection } from "../js/quiz-limits.js";
import { StudentQuizStore } from "./student-quiz-store.js";
import { authenticateStudent, studentContext, quizRate, quizFailure as fail, validPart } from "./student-quiz-auth.js";

const object = value => value && typeof value === "object" && !Array.isArray(value);
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const text = (value, max, empty = false) => typeof value === "string" && value.length <= max && (empty || !!value.trim());
const date = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
const review = type => writtenQuestion(type) || type === "modified-true-false";
const sameScope = (a, b) => ["uid", "studentId", "sectionId", "teacherProfileId", "teacherUid"].every(key => a?.[key] === b?.[key]);
const attemptPath = (context, id) => "users/" + context.studentId + "/generated_quiz_attempts/" + id;
const bytes = value => new TextEncoder().encode(value);
const base64 = value => btoa(String.fromCharCode(...value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
const unbase64 = value => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
const cursorKey = env => crypto.subtle.importKey("raw", bytes("student-quizzes:v1:" + (env.STUDENT_QUIZ_CURSOR_SECRET || env.WEB_SESSION_SECRET)), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
async function signCursor(env, payload) {
  const body = base64(bytes(JSON.stringify(payload)));
  return body + "." + base64(new Uint8Array(await crypto.subtle.sign("HMAC", await cursorKey(env), bytes(body))));
}
async function readCursor(env, value, context, now) {
  try {
    if (!text(value, 8192)) throw 0;
    const [body, signature, extra] = value.split(".");
    if (!body || !signature || extra || !await crypto.subtle.verify("HMAC", await cursorKey(env), unbase64(signature), bytes(body))) throw 0;
    const payload = JSON.parse(new TextDecoder().decode(unbase64(body)));
    if (payload.v !== 1 || !sameScope(payload.context, context) || !Number.isSafeInteger(payload.exp) || payload.exp <= now ||
        !["page", "next"].includes(payload.kind)) throw 0;
    if (payload.kind === "page" ? !Array.isArray(payload.ids) || payload.ids.length > 20 || payload.ids.some(id => !validPart(id)) || new Set(payload.ids).size !== payload.ids.length || typeof payload.next !== "string"
      : ![payload.after, payload.upper].every(tuple => Array.isArray(tuple) && tuple.length === 2 && date(tuple[0]) && validPart(tuple[1]))) throw 0;
    return payload;
  } catch { throw fail("CURSOR_INVALID", 400, "Reopen teacher quizzes to refresh the list."); }
}
function summary(row, scope) {
  const q = row.data, context = scope.context;
  if (q.id !== row.id || !validPart(row.id) || !text(q.title, 500) || !text(row.updateTime, 128) ||
      !quizAssignedToSection(q, context.sectionId) || !["teacherProfileId", "teacherUid"].every(key => q[key] === context[key]) || !Object.hasOwn(QUIZ_TYPES, q.type) ||
      !["now", "scheduled"].includes(q.availability) || (q.availability === "scheduled" && !date(q.availableAt)) || !date(q.createdAt) ||
      !Number.isInteger(q.questionCount) || q.questionCount < 1 || q.questionCount > 50 ||
      (review(q.type) && (q.schemaVersion !== 2 || q.gradingMode !== "teacher-review"))) throw fail("QUIZ_METADATA_INVALID", 503, "This quiz needs teacher maintenance.");
  return { id: row.id, title: q.title, sectionId: context.sectionId, teacherProfileId: q.teacherProfileId, teacherUid: q.teacherUid,
    type: q.type, gradingMode: review(q.type) ? "teacher-review" : "automatic", availability: q.availability, availableAt: q.availableAt || "",
    createdAt: q.createdAt, schemaVersion: q.schemaVersion || 1, questionCount: q.questionCount, teacherName: scope.teacherName, revision: row.updateTime };
}
async function list(body, scope, store, env, now) {
  if (!only(body, ["limit", "cursor"]) || !Number.isInteger(body.limit) || body.limit < 1 || body.limit > 20 || !text(body.cursor, 8192, true)) throw fail("INVALID_REQUEST", 400);
  const context = scope.context, cursor = body.cursor ? await readCursor(env, body.cursor, context, now) : null;
  const common = { v: 1, context, exp: cursor?.exp || now + 12 * 60 * 60_000 };
  if (cursor?.kind === "page") {
    const rows = await store.quizPage(context, { ids: cursor.ids });
    const byId = new Map(rows.map(row => [row.id, row]));
    return { items: cursor.ids.flatMap(id => { const row = byId.get(id); return row && quizAssignedToSection(row.data, context.sectionId) && ["now", "scheduled"].includes(row.data.availability) ? [summary(row, scope)] : []; }), pageCursor: body.cursor, nextCursor: cursor.next };
  }
  const rows = await store.quizPage(context, { limit: body.limit + 1, after: cursor?.after, upper: cursor?.upper });
  const items = rows.slice(0, body.limit).map(row => summary(row, scope));
  const tuple = item => [item.createdAt, item.id];
  const nextCursor = rows.length > body.limit ? await signCursor(env, { ...common, kind: "next", after: tuple(items.at(-1)), upper: cursor?.upper || tuple(items[0]) }) : "";
  const pageCursor = await signCursor(env, { ...common, kind: "page", ids: items.map(item => item.id), next: nextCursor });
  return { items, pageCursor, nextCursor };
}
function validateAttempt(body, submit) {
  if (!only(body, submit ? ["assignmentId", "revision", "attemptId", "startedAtUtc", "completedAtUtc", "answers"] : ["quizId", "revision", "attemptId"]) ||
      !validPart(submit ? body.assignmentId : body.quizId) || !text(body.revision, 128) || !/^[a-f0-9]{32}$/.test(body.attemptId)) throw fail("INVALID_REQUEST", 400);
}
async function quizFor(body, scope, store, now, submit = false) {
  const id = submit ? body.assignmentId : body.quizId, row = await store.get("generatedQuizzes/" + id), q = row?.data;
  if (!q || !quizAssignedToSection(q, scope.context.sectionId) || !["teacherProfileId", "teacherUid"].every(key => q[key] === scope.context[key]) || q.availability === "draft") throw fail("QUIZ_UNAVAILABLE");
  if (!["now", "scheduled"].includes(q.availability) || (q.availability === "scheduled" && (!date(q.availableAt) || Date.parse(q.availableAt) > now))) throw fail("NOT_RELEASED");
  if (row.updateTime !== body.revision) throw fail("REVISION_CHANGED", 409, "Your teacher updated this quiz. Reopen it to continue.");
  const safe = summary({ ...row, id }, scope);
  if (!Array.isArray(q.questions) || q.questions.length !== safe.questionCount || new Set(q.questions.map(item => item?.id)).size !== q.questions.length ||
      q.questions.some(item => !validPart(item?.id) || !normalizeQuizQuestion(item, q.type))) throw fail("QUIZ_METADATA_INVALID", 503);
  return { q, safe };
}
function answers(body, q) {
  if (!date(body.startedAtUtc) || !date(body.completedAtUtc) || !Array.isArray(body.answers) || body.answers.length !== q.questions.length) throw fail("INVALID_ANSWERS", 400);
  const byId = new Map();
  for (const answer of body.answers) {
    if (!only(answer, ["questionId", "optionIndex", "value", "explanation", "correction"]) || !validPart(answer.questionId) || byId.has(answer.questionId) ||
        !Number.isInteger(answer.optionIndex) || !text(answer.value, 8000, true) || !text(answer.explanation, 4000, true) || !text(answer.correction, 4000, true)) throw fail("INVALID_ANSWERS", 400);
    if (writtenQuestion(q.type)) {
      if (answer.optionIndex !== -1 || !text(answer.value, q.type === "essay" ? 8000 : 1000) || answer.correction !== "" ||
          (q.type === "essay" ? answer.explanation !== "" : !text(answer.explanation, 4000))) throw fail("INVALID_ANSWERS", 400);
    } else if (answer.optionIndex < 0 || answer.optionIndex >= (q.type === "multiple-choice" ? 4 : 2) || answer.value !== "" || answer.explanation !== "" ||
        (q.type === "modified-true-false" && answer.optionIndex === 1 ? !text(answer.correction, 4000) : answer.correction !== "")) throw fail("INVALID_ANSWERS", 400);
    byId.set(answer.questionId, { questionId: answer.questionId, optionIndex: answer.optionIndex, value: answer.value, explanation: answer.explanation, correction: answer.correction });
  }
  return q.questions.map(question => { if (!byId.has(question.id)) throw fail("INVALID_ANSWERS", 400); return byId.get(question.id); });
}
const hash = async value => base64(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(JSON.stringify(value)))));
function canonical(body) {
  return { assignmentId: body.assignmentId, revision: body.revision, attemptId: body.attemptId, startedAtUtc: body.startedAtUtc, completedAtUtc: body.completedAtUtc,
    answers: Array.isArray(body.answers) ? body.answers.map(a => ({ questionId: a?.questionId, optionIndex: a?.optionIndex, value: a?.value, explanation: a?.explanation, correction: a?.correction })).sort((a, b) => String(a.questionId).localeCompare(String(b.questionId))) : null };
}

export async function studentQuizzes({ request, env }, { store = new StudentQuizStore(env), authenticate = authenticateStudent, rate = quizRate, now = Date.now, fetcher = fetch } = {}) {
  const started = performance.now();
  const respond = (value, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "private, no-store", "Server-Timing": `student-quiz;dur=${(performance.now() - started).toFixed(1)}`, ...(status === 405 ? { Allow: "POST" } : {}), ...(status === 429 ? { "Retry-After": "60" } : {}) } });
  if (env.STUDENT_QUIZZES_ENABLED !== "true") return respond({ code: "BACKEND_NOT_CONFIGURED", error: "Teacher quizzes are temporarily unavailable." }, 503);
  if (request.method !== "POST") return respond({ code: "METHOD_NOT_ALLOWED", error: "Use POST." }, 405);
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) return respond({ code: "INVALID_REQUEST", error: "Use JSON." }, 415);
  let transaction = false;
  try {
    if ((env.STUDENT_QUIZ_CURSOR_SECRET || env.WEB_SESSION_SECRET || "").length < 32) throw fail("BACKEND_NOT_CONFIGURED", 503);
    const action = new URL(request.url).pathname.split("/").filter(Boolean).at(-1);
    if (!["list", "start", "access", "submit"].includes(action)) throw fail("NOT_FOUND", 404);
    const identity = await authenticate(request, env, store, { fetcher, now: now() });
    await rate(env, identity.uid);
    const body = await readJson(request, 1_000_000);
    if (!object(body)) throw fail("INVALID_REQUEST", 400);
    if (action !== "list") validateAttempt(body, action === "submit");
    if (["start", "submit"].includes(action)) { await store.begin(); transaction = true; }
    const scope = await studentContext(identity, env, store), context = scope.context, time = now();
    if (action === "list") return respond({ context, serverTimeUtc: new Date(time).toISOString(), ...await list(body, scope, store, env, time) });
    const path = attemptPath(context, body.attemptId), reservation = await store.get(path);
    if (reservation && (reservation.data.uid !== context.uid || reservation.data.quizId !== (body.quizId || body.assignmentId) || reservation.data.revision !== body.revision || !sameScope(reservation.data.context, context))) throw fail("ATTEMPT_CONFLICT", 409);
    // A committed response may be replayed after relocking, never written again.
    if (action === "submit" && reservation?.data.receipt) {
      if (await hash(canonical(body)) !== reservation.data.payloadHash) throw fail("ATTEMPT_CONFLICT", 409);
      await store.rollback(); transaction = false;
      return respond(reservation.data.receipt);
    }
    const { q, safe } = await quizFor(body, scope, store, time, action === "submit");
    if (action === "access") {
      if (!reservation || reservation.data.receipt) throw fail("QUIZ_UNAVAILABLE");
      return respond({ context, allowed: true, quizId: safe.id, revision: safe.revision, attemptId: body.attemptId, serverTimeUtc: new Date(time).toISOString() });
    }
    if (action === "start") {
      if (reservation?.data.receipt) throw fail("ATTEMPT_CONFLICT", 409);
      // Preserve the original teacher guide privately, once per revision. It
      // lives outside the answer document so long essays don't duplicate it.
      const snapshotId = await hash([safe.id, safe.revision]), snapshotPath = "generatedQuizRevisions/" + snapshotId;
      const snapshot = await store.get(snapshotPath);
      if (!reservation) await store.commit([
        ...(!snapshot ? [{ operation: "set", path: snapshotPath, data: { quizId: safe.id, revision: safe.revision, type: q.type, title: q.title, questions: q.questions } }] : []),
        { operation: "set", path, data: { uid: context.uid, quizId: safe.id, revision: safe.revision, context, snapshotId,
          status: "started", startedAtUtc: new Date(time).toISOString(), questionIds: q.questions.map(item => item.id) } }
      ]);
      else await store.rollback();
      transaction = false;
      return respond({ context, serverTimeUtc: new Date(time).toISOString(), attemptId: body.attemptId, quiz: safe,
        questions: q.questions.map(item => ({ id: item.id, text: item.text, options: writtenQuestion(q.type) ? [] : item.options, points: item.points || 1 })) });
    }
    if (!reservation) throw fail("ATTEMPT_CONFLICT", 409);
    const submitted = answers(body, q), teacherReview = review(q.type);
    const receipt = { context, persisted: true, quizId: safe.id, revision: safe.revision, attemptId: body.attemptId,
      status: teacherReview ? "pending-review" : "graded", submittedAtUtc: new Date(time).toISOString(),
      score: teacherReview ? 0 : q.questions.reduce((total, question, i) => total + (submitted[i].optionIndex === question.correctIndex ? 1 : 0), 0), maximum: teacherReview ? 0 : q.questions.length };
    await store.commit([{ operation: "update", path, updateTime: reservation.updateTime, data: { status: receipt.status, answers: submitted,
      payloadHash: await hash(canonical(body)), receipt, submittedAt: { $type: "serverTimestamp" }, startedAtClientUtc: body.startedAtUtc, completedAtClientUtc: body.completedAtUtc } }]);
    transaction = false;
    return respond(receipt);
  } catch (error) {
    if (transaction) await store.rollback().catch(() => {});
    // A transaction conflict is retryable with the same attempt ID. Explicit
    // revision/payload conflicts remain permanent 409 errors.
    const status = error.status === 409 && !error.code ? 503 : [400, 401, 403, 404, 409, 413, 429].includes(error.status) ? error.status : 503;
    return respond({ code: error.code || (status === 409 ? "STATE_CHANGED" : status === 413 ? "INVALID_REQUEST" : "SERVICE_UNAVAILABLE"),
      error: error.code && status < 500 ? error.message : "Teacher quizzes are temporarily unavailable. Please retry." }, status);
  }
}
