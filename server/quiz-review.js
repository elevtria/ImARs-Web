import { FirestoreAdmin, decodeFields } from "./firestore-admin.js";
import { appStore, supabaseWebData } from "./supabase-app-store.js";
import { requireStaff, readJson } from "./web-auth.js";
import { quizFailure as fail, validPart, activeProfile } from "./student-quiz-auth.js";
import { quizAssignmentScope, quizAssignedToSection } from "../js/quiz-limits.js";

const bytes = value => new TextEncoder().encode(value);
const b64 = value => btoa(String.fromCharCode(...value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
const from64 = value => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
const key = env => crypto.subtle.importKey("raw", bytes("quiz-review:v1:" + env.WEB_SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
const only = (body, keys) => body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).every(name => keys.includes(name));
export class QuizReviewStore extends FirestoreAdmin {
  async scorePage(actor, studentId, sectionId, { quizId, after, limit = 21 } = {}) {
    const filters = [["context.teacherUid", actor.uid], ["context.teacherProfileId", actor.id],
      ["context.sectionId", sectionId], ...(quizId ? [["quizId", quizId]] : [])]
      .map(([fieldPath, stringValue]) => ({ fieldFilter: { field: { fieldPath }, op: "EQUAL", value: { stringValue } } }));
    const rows = await this.request(`documents/users/${studentId}:runQuery`, { method: "POST", body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "generated_quiz_attempts" }],
        select: { fields: ["quizId", "snapshotId", "status", "submittedAt", "receipt.score", "receipt.maximum", "review.score", "review.maximum"].map(fieldPath => ({ fieldPath })) },
        where: { compositeFilter: { op: "AND", filters } },
        orderBy: ["submittedAt", "__name__"].map(fieldPath => ({ field: { fieldPath }, direction: "DESCENDING" })),
        ...(after ? { startAt: { before: false, values: [{ timestampValue: after[0] }, { referenceValue: this.name(after[1]) }] } } : {}),
        limit
      }
    }) });
    return rows.filter(row => row.document).map(({ document }) => ({
      path: document.name.split("/documents/")[1], data: decodeFields(document.fields)
    }));
  }
  async reviewPage(actor, quizId, sectionId, after) {
    const conditions = [["context.teacherUid", actor.uid], ["context.teacherProfileId", actor.id], ...(sectionId ? [["context.sectionId", sectionId]] : []), ["quizId", quizId], ["status", "pending-review"]].map(([fieldPath, stringValue]) => ({ fieldFilter: { field: { fieldPath }, op: "EQUAL", value: { stringValue } } }));
    const rows = await this.request("documents:runQuery", { method: "POST", body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: "generated_quiz_attempts", allDescendants: true }], select: { fields: ["context", "quizId", "status", "submittedAt"].map(fieldPath => ({ fieldPath })) },
      where: { compositeFilter: { op: "AND", filters: conditions } }, orderBy: ["submittedAt", "__name__"].map(fieldPath => ({ field: { fieldPath }, direction: "ASCENDING" })), limit: 21,
      ...(after ? { startAt: { before: false, values: [{ timestampValue: after[0] }, { referenceValue: this.name(after[1]) }] } } : {})
    } }) });
    return rows.filter(row => row.document).map(({ document }) => ({ path: document.name.split("/documents/")[1], data: decodeFields(document.fields), updateTime: document.updateTime }));
  }
}
async function cursor(env, actor, quizId, sectionId, value, now) {
  if (!value) return null;
  try {
    if (typeof value !== "string" || value.length > 4096) throw 0;
    const [body, signature, extra] = value.split(".");
    if (extra || !await crypto.subtle.verify("HMAC", await key(env), from64(signature), bytes(body))) throw 0;
    const parsed = JSON.parse(new TextDecoder().decode(from64(body)));
    if (parsed.uid !== actor.uid || parsed.id !== actor.id || parsed.quizId !== quizId || parsed.sectionId !== sectionId || parsed.exp <= now || !Array.isArray(parsed.after) || parsed.after.length !== 2 || !Number.isFinite(Date.parse(parsed.after[0])) || !/^users\/[A-Za-z0-9_-]+\/generated_quiz_attempts\/[a-f0-9]{32}$/.test(parsed.after[1])) throw 0;
    return parsed.after;
  } catch { throw fail("CURSOR_INVALID", 400); }
}
async function sign(env, payload) {
  const body = b64(bytes(JSON.stringify(payload))); return body + "." + b64(new Uint8Array(await crypto.subtle.sign("HMAC", await key(env), bytes(body))));
}
async function ownedQuiz(actor, store, id) {
  if (actor.role !== "teacher" || !validPart(id)) throw fail("FORBIDDEN");
  const q = (await store.get("generatedQuizzes/" + id))?.data;
  if (!q || q.teacherUid !== actor.uid || q.teacherProfileId !== actor.id || !["all", "section"].includes(quizAssignmentScope(q))) throw fail("FORBIDDEN");
  if (quizAssignmentScope(q) === "section") await ownedSection(actor, store, q.sectionId);
  return q;
}
async function ownedSection(actor, store, id) {
  if (!validPart(id)) throw fail("FORBIDDEN");
  const section = (await store.get("classes/" + id))?.data;
  if (!activeProfile(section) || section.teacherId !== actor.id) throw fail("FORBIDDEN");
}
function resultFor(row) {
  const { status, submittedAt, receipt, review } = row.data;
  const grade = status === "reviewed" ? review : status === "graded" ? receipt : null;
  return { attemptId: row.path.split("/").at(-1), status, submittedAtUtc: submittedAt,
    score: grade?.score ?? null, maximum: grade?.maximum ?? null };
}
async function studentScores(actor, store, body, env, now) {
  if (!validPart(body.studentId)) throw fail("INVALID_REQUEST", 400);
  const student = (await store.get("users/" + body.studentId))?.data;
  if (student?.role !== "student" || (student.teacherId && student.teacherId !== actor.id)) throw fail("FORBIDDEN");
  await ownedSection(actor, store, student.classCode);
  const scope = "student:" + body.studentId;
  const after = await cursor(env, actor, scope, student.classCode, body.cursor, now);
  const rows = await store.scorePage(actor, body.studentId, student.classCode, { after });
  const page = rows.slice(0, 20);
  const paths = [...new Set(page.map(row => row.data.snapshotId).filter(validPart))]
    .map(id => "generatedQuizRevisions/" + id);
  const snapshots = paths.length ? await store.getAll(paths, { fieldPaths: ["title", "type"] }) : new Map();
  const last = page.at(-1);
  return {
    items: page.map(row => {
      const snapshot = snapshots.get("generatedQuizRevisions/" + row.data.snapshotId)?.data;
      return { ...resultFor(row), quizId: row.data.quizId, title: snapshot?.title || "Teacher quiz", type: snapshot?.type };
    }),
    nextCursor: rows.length > 20 ? await sign(env, { uid: actor.uid, id: actor.id, quizId: scope,
      sectionId: student.classCode, exp: now + 3600_000, after: [last.data.submittedAt, last.path] }) : ""
  };
}
async function sectionResults(actor, store, quiz, body, now) {
  if (!validPart(body.sectionId) || (body.cursor && !validPart(body.cursor))) throw fail("INVALID_REQUEST", 400);
  const available = quiz.availability === "now" || (quiz.availability === "scheduled" && Date.parse(quiz.availableAt) <= now);
  if (!available) throw fail("FORBIDDEN");
  const limit = 10;
  const roster = await store.query("users", {
    filters: [{ field: "role", value: "student" }, { field: "classCode", value: body.sectionId }],
    after: body.cursor, limit: limit + 1, fieldPaths: ["active", "status", "teacherId", "displayName", "fullName"]
  });
  const items = await Promise.all(roster.slice(0, limit)
    .filter(student => activeProfile(student.data) && (!student.data.teacherId || student.data.teacherId === actor.id))
    .map(async ({ id, data }) => {
      const [latest] = await store.scorePage(actor, id, body.sectionId, { quizId: body.quizId, limit: 1 });
      return { studentId: id, name: data.displayName || data.fullName || id,
        ...(latest ? resultFor(latest) : { status: "not-submitted" }) };
    }));
  return { items, nextCursor: roster.length > limit ? roster[limit - 1].id : "" };
}
export async function quizReview({ request, env }, { store, authenticate = requireStaff, now = Date.now } = {}) {
  const respond = (value, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "private, no-store" } });
  let transaction = false;
  try {
    if (env.STUDENT_QUIZZES_ENABLED !== "true") throw fail("BACKEND_NOT_CONFIGURED", 503);
    if (request.method !== "POST") return respond({ error: "Use POST." }, 405);
    if (!request.headers.get("Content-Type")?.startsWith("application/json")) return respond({ error: "Use JSON." }, 415);
    store ??= supabaseWebData(env) ? appStore(env) : new QuizReviewStore(env);
    const initialActor = await authenticate(request, env, store);
    const body = await readJson(request, 65536);
    if (!only(body, ["action", "quizId", "sectionId", "cursor", "studentId", "attemptId", "revision", "scores", "feedback"]) || !["list", "open", "grade", "student-scores", "section-results"].includes(body.action) ||
        (body.sectionId !== undefined && body.sectionId !== "" && !validPart(body.sectionId))) throw fail("INVALID_REQUEST", 400);
    if (body.action === "grade") { await store.begin(); transaction = true; }
    const actor = transaction ? await authenticate(request, env, store) : initialActor;
    if (actor.role !== "teacher") throw fail("FORBIDDEN");
    if (body.action === "student-scores") return respond(await studentScores(actor, store, body, env, now()));
    const q = await ownedQuiz(actor, store, body.quizId);
    const sectionId = body.sectionId || q.sectionId || "";
    if (body.sectionId && body.sectionId !== q.sectionId) {
      if (!quizAssignedToSection(q, body.sectionId)) throw fail("FORBIDDEN");
      await ownedSection(actor, store, body.sectionId);
    }
    if (body.action === "section-results") return respond(await sectionResults(actor, store, q, body, now()));
    if (body.action === "list") {
      const rows = await store.reviewPage(actor, body.quizId, sectionId, await cursor(env, actor, body.quizId, sectionId, body.cursor, now()));
      const sections = new Map(sectionId ? [[sectionId, Promise.resolve(true)]] : []), items = [];
      for (const row of rows.slice(0, 20)) {
        const id = row.data.context.sectionId;
        if (sectionId && id !== sectionId) continue;
        if (!sections.has(id)) sections.set(id, ownedSection(actor, store, id).then(() => true, error => { if (error.status === 403) return false; throw error; }));
        if (await sections.get(id)) items.push({ studentId: row.data.context.studentId, sectionId: id, attemptId: row.path.split("/").at(-1), submittedAtUtc: row.data.submittedAt, revision: row.updateTime });
      }
      return respond({ items, nextCursor: rows.length > 20 ? await sign(env, { uid: actor.uid, id: actor.id, quizId: body.quizId, sectionId, exp: now() + 3600_000, after: [rows[19].data.submittedAt, rows[19].path] }) : "" });
    }
    if (!validPart(body.studentId) || !/^[a-f0-9]{32}$/.test(body.attemptId)) throw fail("INVALID_REQUEST", 400);
    const path = `users/${body.studentId}/generated_quiz_attempts/${body.attemptId}`, attempt = await store.get(path), a = attempt?.data;
    if (!a || a.quizId !== body.quizId || a.context?.teacherUid !== actor.uid || a.context?.teacherProfileId !== actor.id || !quizAssignedToSection(q, a.context?.sectionId) || (sectionId && a.context.sectionId !== sectionId) || !validPart(a.snapshotId) || !a.receipt) throw fail("FORBIDDEN");
    if (!sectionId) await ownedSection(actor, store, a.context.sectionId);
    const snapshot = (await store.get("generatedQuizRevisions/" + a.snapshotId))?.data;
    if (!snapshot || snapshot.quizId !== body.quizId || snapshot.revision !== a.revision || !["essay", "identification-explanation", "modified-true-false"].includes(snapshot.type)) throw fail("FORBIDDEN");
    if (body.action === "open") return respond({ studentId: body.studentId, attemptId: body.attemptId, revision: attempt.updateTime, type: snapshot.type, title: snapshot.title, questions: snapshot.questions, answers: a.answers, status: a.status });
    if (body.revision !== attempt.updateTime || a.status !== "pending-review") throw fail("REVISION_CHANGED", 409, "This submission was already reviewed or changed. Reopen it.");
    if (!Array.isArray(body.scores) || body.scores.length !== snapshot.questions.length || new Set(body.scores.map(item => item?.questionId)).size !== body.scores.length || typeof body.feedback !== "string" || body.feedback.length > 4000) throw fail("INVALID_REVIEW", 400);
    let score = 0, maximum = 0;
    const scores = snapshot.questions.map(question => {
      const item = body.scores.find(item => item.questionId === question.id), points = question.points || 1;
      if (!only(item, ["questionId", "score"]) || !Number.isInteger(item.score) || item.score < 0 || item.score > points) throw fail("INVALID_REVIEW", 400);
      score += item.score; maximum += points; return { questionId: question.id, score: item.score };
    });
    await store.commit([{ operation: "update", path, updateTime: attempt.updateTime, data: { status: "reviewed", review: { score, maximum, scores, feedback: body.feedback, reviewerUid: actor.uid, reviewerProfileId: actor.id, reviewedAtUtc: new Date(now()).toISOString() }, reviewedAt: { $type: "serverTimestamp" } } }]);
    transaction = false;
    // Preserve the original submission receipt, answers and private snapshot.
    return respond({ persisted: true, score, maximum });
  } catch (error) {
    if (transaction) await store.rollback().catch(() => {});
    const status = [400, 401, 403, 409, 413].includes(error.status) ? error.status : 503;
    return respond({ code: error.code || "SERVICE_UNAVAILABLE", error: error.code && status < 500 ? error.message : "Quiz reviews are temporarily unavailable." }, status);
  }
}
