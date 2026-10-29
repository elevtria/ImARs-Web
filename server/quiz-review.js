import { FirestoreAdmin, decodeFields } from "./firestore-admin.js";
import { requireStaff, readJson } from "./web-auth.js";
import { quizFailure as fail, validPart, activeProfile } from "./student-quiz-auth.js";
import { quizAssignmentScope, quizAssignedToSection } from "../js/quiz-limits.js";

const bytes = value => new TextEncoder().encode(value);
const b64 = value => btoa(String.fromCharCode(...value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
const from64 = value => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
const key = env => crypto.subtle.importKey("raw", bytes("quiz-review:v1:" + env.WEB_SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
const only = (body, keys) => body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).every(name => keys.includes(name));
export class QuizReviewStore extends FirestoreAdmin {
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
async function cursor(env, actor, quizId, value, now) {
  if (!value) return null;
  try {
    if (typeof value !== "string" || value.length > 4096) throw 0;
    const [body, signature, extra] = value.split(".");
    if (extra || !await crypto.subtle.verify("HMAC", await key(env), from64(signature), bytes(body))) throw 0;
    const parsed = JSON.parse(new TextDecoder().decode(from64(body)));
    if (parsed.uid !== actor.uid || parsed.id !== actor.id || parsed.quizId !== quizId || parsed.exp <= now || !Array.isArray(parsed.after) || parsed.after.length !== 2 || !Number.isFinite(Date.parse(parsed.after[0])) || !/^users\/[A-Za-z0-9_-]+\/generated_quiz_attempts\/[a-f0-9]{32}$/.test(parsed.after[1])) throw 0;
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
export async function quizReview({ request, env }, { store = new QuizReviewStore(env), authenticate = requireStaff, now = Date.now } = {}) {
  const respond = (value, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "private, no-store" } });
  let transaction = false;
  try {
    if (env.STUDENT_QUIZZES_ENABLED !== "true") throw fail("BACKEND_NOT_CONFIGURED", 503);
    if (request.method !== "POST") return respond({ error: "Use POST." }, 405);
    if (!request.headers.get("Content-Type")?.startsWith("application/json")) return respond({ error: "Use JSON." }, 415);
    const body = await readJson(request, 65536);
    const initialActor = await authenticate(request, env, store);
    if (!only(body, ["action", "quizId", "cursor", "studentId", "attemptId", "revision", "scores", "feedback"]) || !["list", "open", "grade"].includes(body.action)) throw fail("INVALID_REQUEST", 400);
    if (body.action === "grade") { await store.begin(); transaction = true; }
    const actor = transaction ? await authenticate(request, env, store) : initialActor;
    const q = await ownedQuiz(actor, store, body.quizId);
    if (body.action === "list") {
      const rows = await store.reviewPage(actor, body.quizId, q.sectionId, await cursor(env, actor, body.quizId, body.cursor, now()));
      const sections = new Map(), items = [];
      for (const row of rows.slice(0, 20)) {
        const id = row.data.context.sectionId;
        if (!sections.has(id)) sections.set(id, ownedSection(actor, store, id).then(() => true, error => { if (error.status === 403) return false; throw error; }));
        if (await sections.get(id)) items.push({ studentId: row.data.context.studentId, attemptId: row.path.split("/").at(-1), submittedAtUtc: row.data.submittedAt, revision: row.updateTime });
      }
      return respond({ items, nextCursor: rows.length > 20 ? await sign(env, { uid: actor.uid, id: actor.id, quizId: body.quizId, exp: now() + 3600_000, after: [rows[19].data.submittedAt, rows[19].path] }) : "" });
    }
    if (!validPart(body.studentId) || !/^[a-f0-9]{32}$/.test(body.attemptId)) throw fail("INVALID_REQUEST", 400);
    const path = `users/${body.studentId}/generated_quiz_attempts/${body.attemptId}`, attempt = await store.get(path), a = attempt?.data;
    if (!a || a.quizId !== body.quizId || a.context?.teacherUid !== actor.uid || a.context?.teacherProfileId !== actor.id || !quizAssignedToSection(q, a.context?.sectionId) || !validPart(a.snapshotId) || !a.receipt) throw fail("FORBIDDEN");
    await ownedSection(actor, store, a.context.sectionId);
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
