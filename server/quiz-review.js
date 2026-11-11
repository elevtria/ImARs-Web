import { FirestoreAdmin, decodeFields } from "./firestore-admin.js";
import { appStore, supabaseWebData } from "./supabase-app-store.js";
import { requireStaff, readJson } from "./web-auth.js";
import { quizFailure as fail, validPart, activeProfile } from "./student-quiz-auth.js";
import { QUIZ_TYPES, quizAssignedToSection, quizReviewPoints } from "../js/quiz-limits.js";

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
    const parent = studentId ? `/users/${studentId}` : "";
    const fields = ["quizId", "submittedAt", "status", "receipt.score", "receipt.maximum", "review.score", "review.maximum"];
    const rows = await this.request(`documents${parent}:runQuery`, { method: "POST", body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "generated_quiz_attempts", ...(!studentId ? { allDescendants: true } : {}) }],
        select: { fields: fields.map(fieldPath => ({ fieldPath })) },
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
  if (!q || q.teacherUid !== actor.uid || q.teacherProfileId !== actor.id) throw fail("FORBIDDEN");
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
const rosterFilters = sectionId => [{ field: "role", value: "student" }, { field: "classCode", value: sectionId }];
const rosterMember = (actor, student) => activeProfile(student.data) && (!student.data.teacherId || student.data.teacherId === actor.id);
const studentNameFields = ["displayName", "fullName", "name", "firstName", "lastName"];
function studentName(profile) {
  return [profile?.displayName, profile?.fullName, profile?.name, [profile?.firstName, profile?.lastName].filter(Boolean).join(" ")]
    .find(value => typeof value === "string" && value.trim())?.trim();
}

async function summarizeScores(actor, store, sectionId, students, studentId = null) {
  const latest = new Map(), totals = new Map();
  const limit = 250;
  if (students.size) {
    let after;
    for (;;) {
      const rows = await store.scorePage(actor, studentId, sectionId, { after, limit });
      for (const row of rows) {
        const id = row.path.split("/")[1], { quizId } = row.data;
        if (!students.has(id) || !validPart(quizId)) continue;
        if (!latest.has(quizId)) latest.set(quizId, new Set());
        const submitted = latest.get(quizId);
        if (submitted.has(id)) continue;
        submitted.add(id);
        if (!totals.has(quizId)) totals.set(quizId, { quizId, submitted: 0, graded: 0, percentTotal: 0 });
        const total = totals.get(quizId);
        total.submitted++;
        const { score, maximum } = resultFor(row);
        if (score !== null && maximum > 0) {
          total.graded++;
          total.percentTotal += score / maximum * 100;
        }
      }
      if (rows.length < limit) break;
      const last = rows.at(-1);
      after = [last.data.submittedAt, last.path];
    }
  }
  return [...totals.values()];
}

async function sectionSummary(actor, store, sectionId) {
  await ownedSection(actor, store, sectionId);
  if (store.quizReport) return store.quizReport(actor, sectionId);
  const roster = await store.query("users", { filters: rosterFilters(sectionId), fieldPaths: ["active", "status", "teacherId"] });
  const students = new Set(roster.filter(student => rosterMember(actor, student)).map(student => student.id));
  const totals = await summarizeScores(actor, store, sectionId, students);
  return { learners: students.size, items: [...totals.values()].map(({ quizId, submitted, graded, percentTotal }) =>
    ({ quizId, submitted, average: graded ? Math.round(percentTotal / graded) : null })) };
}

async function studentAverage(actor, store, studentId) {
  if (!validPart(studentId)) throw fail("INVALID_REQUEST", 400);
  const student = (await store.get("users/" + studentId))?.data;
  if (student?.role !== "student" || (student.teacherId && student.teacherId !== actor.id)) throw fail("FORBIDDEN");
  await ownedSection(actor, store, student.classCode);
  const totals = await summarizeScores(actor, store, student.classCode, new Set([studentId]), studentId);
  const count = totals.reduce((sum, quiz) => sum + quiz.graded, 0);
  return { average: count ? Math.round(totals.reduce((sum, quiz) => sum + quiz.percentTotal, 0) / count) : null };
}

async function sectionResults(actor, store, quiz, body) {
  if (!validPart(body.sectionId) || (body.cursor && !validPart(body.cursor))) throw fail("INVALID_REQUEST", 400);
  const currentlyAssigned = quizAssignedToSection(quiz, body.sectionId);
  const limit = 10;
  const roster = [];
  let after = body.cursor;
  while (roster.length <= limit) {
    const page = await store.query("users", {
      filters: rosterFilters(body.sectionId), after, limit: limit + 1,
      fieldPaths: ["active", "status", "teacherId", ...studentNameFields]
    });
    roster.push(...page.filter(student => rosterMember(actor, student)));
    if (page.length <= limit) break;
    after = page.at(-1).id;
  }
  const page = roster.slice(0, limit);
  const report = store.quizReport && page.length
    ? await store.quizReport(actor, body.sectionId, body.quizId, page.map(student => student.id))
    : null;
  const scores = new Map(report?.items.map(item => [item.studentId, item]));
  const items = await Promise.all(page.map(async ({ id, data }) => {
    let result = scores.get(id);
    if (!store.quizReport) {
      const [latest] = await store.scorePage(actor, id, body.sectionId, { quizId: body.quizId, limit: 1 });
      if (latest) result = resultFor(latest);
    }
    if (!result && !currentlyAssigned) return null;
    return { ...result, studentId: id, name: studentName(data) || id, status: result?.status || "not-submitted" };
  }));
  return { items: items.filter(Boolean), nextCursor: roster.length > limit ? roster[limit - 1].id : "" };
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
    if (!only(body, ["action", "quizId", "sectionId", "cursor", "studentId", "attemptId", "revision", "scores", "feedback"]) || !["list", "open", "grade", "student-average", "section-results", "section-summary"].includes(body.action) ||
        (body.sectionId !== undefined && body.sectionId !== "" && !validPart(body.sectionId))) throw fail("INVALID_REQUEST", 400);
    if (body.action === "grade") { await store.begin(); transaction = true; }
    const actor = transaction ? await authenticate(request, env, store) : initialActor;
    if (actor.role !== "teacher") throw fail("FORBIDDEN");
    if (body.action === "student-average") return respond(await studentAverage(actor, store, body.studentId));
    if (body.action === "section-summary") return respond(await sectionSummary(actor, store, body.sectionId));
    const q = await ownedQuiz(actor, store, body.quizId);
    const sectionId = body.sectionId || "";
    if (sectionId) await ownedSection(actor, store, sectionId);
    if (body.action === "section-results") return respond(await sectionResults(actor, store, q, body));
    if (body.action === "list") {
      const rows = await store.reviewPage(actor, body.quizId, sectionId, await cursor(env, actor, body.quizId, sectionId, body.cursor, now()));
      const sections = new Map(sectionId ? [[sectionId, Promise.resolve(true)]] : []), items = [];
      for (const row of rows.slice(0, 20)) {
        const id = row.data.context.sectionId;
        if (sectionId && id !== sectionId) continue;
        if (!sections.has(id)) sections.set(id, ownedSection(actor, store, id).then(() => true, error => { if (error.status === 403) return false; throw error; }));
        if (await sections.get(id)) items.push({ studentId: row.data.context.studentId, sectionId: id, attemptId: row.path.split("/").at(-1), submittedAtUtc: row.data.submittedAt, revision: row.updateTime });
      }
      const paths = [...new Set(items.map(item => item.studentId).filter(validPart))].map(id => "users/" + id);
      const profiles = paths.length ? await store.getAll(paths, { fieldPaths: ["role", "classCode", "teacherId", ...studentNameFields] }) : new Map();
      for (const item of items) {
        const profile = profiles.get("users/" + item.studentId)?.data;
        if (profile?.role === "student" && profile.classCode === item.sectionId && (!profile.teacherId || profile.teacherId === actor.id)) {
          item.name = studentName(profile);
        }
      }
      return respond({ items, nextCursor: rows.length > 20 ? await sign(env, { uid: actor.uid, id: actor.id, quizId: body.quizId, sectionId, exp: now() + 3600_000, after: [rows[19].data.submittedAt, rows[19].path] }) : "" });
    }
    if (!validPart(body.studentId) || !/^[a-f0-9]{32}$/.test(body.attemptId)) throw fail("INVALID_REQUEST", 400);
    const path = `users/${body.studentId}/generated_quiz_attempts/${body.attemptId}`, attempt = await store.get(path), a = attempt?.data;
    if (!a || a.quizId !== body.quizId || a.context?.teacherUid !== actor.uid || a.context?.teacherProfileId !== actor.id || a.context?.studentId !== body.studentId || (sectionId && a.context.sectionId !== sectionId) || !validPart(a.snapshotId) || !a.receipt) throw fail("FORBIDDEN");
    if (!sectionId) await ownedSection(actor, store, a.context.sectionId);
    const snapshot = (await store.get("generatedQuizRevisions/" + a.snapshotId))?.data;
    if (!snapshot || snapshot.quizId !== body.quizId || snapshot.revision !== a.revision || !Object.hasOwn(QUIZ_TYPES, snapshot.type)) throw fail("FORBIDDEN");
    if (body.action === "open") return respond({ studentId: body.studentId, revision: attempt.updateTime, type: snapshot.type, title: snapshot.title,
      questions: snapshot.questions, answers: a.answers, ...resultFor({ path, data: a }),
      ...(a.automaticScores ? { automaticScores: a.automaticScores } : {}),
      ...(a.status === "reviewed" ? { scores: a.review?.scores, feedback: a.review?.feedback } : {}) });
    if (body.revision !== attempt.updateTime || !["pending-review", "reviewed", "graded"].includes(a.status)) {
      throw fail("REVISION_CHANGED", 409, "This submission changed. Reopen it before saving.");
    }
    if (!Array.isArray(body.scores) || body.scores.length !== snapshot.questions.length || new Set(body.scores.map(item => item?.questionId)).size !== body.scores.length || typeof body.feedback !== "string" || body.feedback.length > 4000) throw fail("INVALID_REVIEW", 400);
    let score = 0, maximum = 0;
    const automatic = new Map(a.automaticScores?.map(item => [item.questionId, item.score]));
    const scores = snapshot.questions.map(question => {
      const item = body.scores.find(item => item.questionId === question.id), points = quizReviewPoints(snapshot.type, question);
      if (!only(item, ["questionId", "score"]) || !Number.isInteger(item.score) || item.score < 0 || item.score > points) throw fail("INVALID_REVIEW", 400);
      if (automatic.has(question.id) && item.score !== automatic.get(question.id)) throw fail("INVALID_REVIEW", 400, "Automatically graded answers already have a score.");
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
