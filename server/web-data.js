import { FirestoreAdmin } from "./firestore-admin.js";
import { dataEnabled, requireStaff, stateCall, settings, readJson } from "./web-auth.js";
import { QUIZ_TYPES, writtenQuestion, normalizeQuizQuestion } from "../js/quiz-limits.js";

const json = (value, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "private, no-store" } });
const fail = (message = "You cannot access that record.", status = 403) => Object.assign(new Error(message), { status });
const part = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const term = value => /^term_0[1-3]$/.test(value);
const lesson = value => /^lesson_0[1-4]$/.test(value);
const object = value => value && typeof value === "object" && !Array.isArray(value);
const fields = (data, allowed) => Object.keys(data).every(key => allowed.includes(key));
const text = (value, maximum = 200, empty = false) => typeof value === "string" && value.length <= maximum && (empty || value.trim().length > 0);
const email = value => text(value, 254) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const timestamp = value => value?.$type === "serverTimestamp" && Object.keys(value).length === 1;
const date = value => typeof value === "string" && /^\d{4}-\d\d-\d\d$/.test(value) && Number.isFinite(Date.parse(value + "T00:00:00Z")) && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
const profileFields = ["uid", "schoolId", "role", "active", "status", "name", "displayName", "fullName", "firstName", "lastName", "providedEmail", "email",
  "subject", "sections", "section", "classCode", "teacherId", "adviserId", "teacher", "gradeSection", "sectionName", "className", "school", "roleLabel",
  "department", "phone", "adminSince", "createdAt", "updatedAt", "lastUpdated", "lastQrSyncAt", "deletedAt", "archiveReason", "avatarId", "isRegistered", "isClaimed", "joined"];

function reference(value) {
  if (!object(value) || !["document", "query"].includes(value.kind) || typeof value.path !== "string") throw fail("Invalid data request.", 400);
  const parts = value.path.split("/");
  if (!parts.every(part) || parts.length > 6 || (parts.length % 2 === 0) !== (value.kind === "document")) throw fail("Invalid data path.", 400);
  const filters = value.filters || [], order = value.order || [];
  if (!Array.isArray(filters) || filters.length > 3 || !Array.isArray(order) || order.length > 1 ||
      filters.some(filter => !object(filter) || filter.op !== "==" || !["uid", "role", "classCode", "teacherId", "teacherUid"].includes(filter.field) || !text(filter.value, 128)) ||
      new Set(filters.map(filter => filter.field)).size !== filters.length ||
      order.some(item => item.field !== "timestamp" || !["asc", "desc"].includes(item.direction)) ||
      (value.limit !== undefined && (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > 5000)) ||
      (value.kind === "document" && (filters.length || order.length || value.limit !== undefined))) throw fail("Invalid data query.", 400);
  return { kind: value.kind, path: value.path, parts, filters, order, limit: value.limit || 5000 };
}

class Scope {
  constructor(store, actor) {
    this.store = store; this.actor = actor; this.reads = new Map();
    if (actor.row) this.reads.set("users/" + actor.id, Promise.resolve(actor.row));
  }
  get(path) {
    if (!this.reads.has(path)) this.reads.set(path, this.store.get(path));
    return this.reads.get(path);
  }
  async ownsClass(id) {
    if (!part(id)) throw fail();
    const row = await this.get("classes/" + id);
    if (!row || (this.actor.role !== "admin" && row.data.teacherId !== this.actor.id)) throw fail();
    return row;
  }
  async student(id, missing = false) {
    const row = await this.get("users/" + id);
    if (!row && missing) return null;
    if (!row || row.data.role !== "student") throw fail();
    if (this.actor.role !== "admin") {
      await this.ownsClass(row.data.classCode);
      if (row.data.teacherId && row.data.teacherId !== this.actor.id) throw fail();
    }
    return row;
  }
  async quiz(id, missing = false) {
    const row = await this.get("generatedQuizzes/" + id);
    if (!row && missing) return null;
    if (!row || this.actor.role !== "teacher" || row.data.teacherUid !== this.actor.uid || row.data.teacherProfileId !== this.actor.id) throw fail();
    await this.ownsClass(row.data.sectionId);
    return row;
  }
  async authorizeRead(ref) {
    const { actor } = this, p = ref.parts;
    const constraints = Object.fromEntries(ref.filters.map(filter => [filter.field, filter.value]));
    if (p[0] === "users" && p.length === 1) {
      if (ref.order.length) throw fail();
      if (Object.keys(constraints).length === 1 && constraints.uid === actor.uid) return;
      if (actor.role === "admin" && Object.keys(constraints).length === 1 && ["student", "teacher"].includes(constraints.role)) return;
      if (actor.role === "teacher" && Object.keys(constraints).length === 2 && constraints.role === "student" && constraints.classCode) {
        await this.ownsClass(constraints.classCode); return;
      }
      throw fail();
    }
    if (ref.filters.length && !["classes", "generatedQuizzes"].includes(p[0])) throw fail();
    if (p[0] === "users" && p.length === 2) {
      if (p[1] === actor.id) return;
      const row = await this.get(ref.path);
      if (!row) return;
      if (actor.role === "admin" && row.data.role === "teacher") return;
      await this.student(p[1]); return;
    }
    if (p[0] === "users" && p[2] === "test_results" && term(p[3]) && p[4] === "lessons" &&
        (p.length === 5 || (p.length === 6 && lesson(p[5]))) && !ref.order.length) {
      await this.student(p[1]); return;
    }
    if (p[0] === "users" && p[1] === actor.id && actor.role === "teacher" &&
        ((p[2] === "recent_scans" && (p.length === 3 || p.length === 4)) || (p[2] === "offlineSync" && p[3] === "markerDownloads" && p.length === 4))) return;
    if (p[0] === "classes" && !ref.order.length) {
      if (p.length === 2 && !ref.filters.length) { await this.ownsClass(p[1]); return; }
      if (p.length === 1 && Object.keys(constraints).length === 1 && constraints.teacherId === actor.id) return;
    }
    if (p[0] === "terms" && term(p[1]) && !ref.order.length &&
        (p.length === 2 || (p[2] === "lessons" && (p.length === 3 || (p.length === 4 && lesson(p[3])))))) return;
    if (ref.path === "webSettings/schoolYear") return;
    if (p[0] === "generatedQuizzes" && !ref.order.length && actor.role === "teacher") {
      if (p.length === 1 && Object.keys(constraints).length === 1 && constraints.teacherUid === actor.uid) return;
      if (p.length === 2 && !ref.filters.length) { await this.quiz(p[1]); return; }
    }
    throw fail();
  }
  async write(input) {
    if (!object(input) || !["set", "update", "delete"].includes(input.operation)) throw fail("Invalid save request.", 400);
    const ref = reference({ kind: "document", path: input.path }), p = ref.parts, actor = this.actor;
    const row = await this.get(ref.path), previous = row?.data, data = input.data;
    if (input.operation === "delete") {
      if (p[0] === "generatedQuizzes" && p.length === 2) await this.quiz(p[1]);
      else if (p[0] === "users" && p.length === 2 && actor.role === "teacher" && previous?.role === "student" && previous.active === false) await this.student(p[1]);
      else if (!(p[0] === "users" && p.length === 2 && actor.role === "admin" && previous?.role === "teacher")) throw fail();
      if (!row) throw fail("This record no longer exists.", 409);
      return { ...input, updateTime: row.updateTime };
    }
    if (row && input.operation === "set" && input.merge !== true && p[0] !== "generatedQuizzes") throw fail("Save edits without replacing the existing record.", 400);
    if (!object(data) || !Object.keys(data).length || Object.keys(data).some(key => !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key))) throw fail("Invalid record fields.", 400);
    if (input.operation === "update" && !row) throw fail("This record no longer exists. Refresh and try again.", 409);
    const names = values => fields(data, values);
    if (p[0] === "users" && p.length === 2) {
      if (actor.role === "admin" && p[1] === actor.id && input.merge === true && names(["uid", "schoolId", "role", "roleLabel", "displayName", "fullName", "providedEmail", "email", "school", "department", "phone", "updatedAt"]) &&
          data.uid === actor.uid && data.schoolId === actor.id && data.role === "admin" &&
          text(data.displayName) && text(data.fullName) && email(data.email) && email(data.providedEmail) && timestamp(data.updatedAt) &&
          ["school", "department", "phone", "roleLabel"].every(key => data[key] === undefined || text(data[key], 200, true))) {
        return { ...input, updateTime: row.updateTime };
      }
      if (actor.role === "admin" && previous?.role === "teacher" && input.operation === "update" &&
          names(["active", "status"]) && typeof data.active === "boolean" && data.status === (data.active ? "active" : "inactive")) {
        return { ...input, updateTime: row.updateTime };
      }
      if (actor.role === "teacher" && p[1] === actor.id && input.operation === "update" && names(["sections"]) &&
          data.sections?.$type === "arrayUnion" && Array.isArray(data.sections.values) && data.sections.values.length <= 10 && data.sections.values.every(item => text(item, 200))) {
        return { ...input, updateTime: row.updateTime };
      }
      if (actor.role !== "teacher" || (row && previous.role !== "student")) throw fail();
      if (row) await this.student(p[1]);
      const allowed = ["schoolId", "firstName", "lastName", "displayName", "fullName", "role", "classCode", "section", "teacherId", "providedEmail", "email", "active", "updatedAt", "deletedAt", "archiveReason", "lastQrSyncAt"];
      if (!row) allowed.push("avatarId", "completedQuizzes", "gamification", "createdAt");
      if (!names(allowed) || (data.role !== undefined && data.role !== "student") || (data.schoolId !== undefined && data.schoolId !== p[1]) ||
          (data.teacherId !== undefined && data.teacherId !== actor.id) || (data.active !== undefined && typeof data.active !== "boolean")) throw fail("These student fields cannot be changed.", 403);
      if (!row && (data.role !== "student" || !data.classCode || !text(data.displayName))) throw fail("A new student needs a name and an assigned class.", 400);
      if (data.classCode !== undefined) await this.ownsClass(data.classCode);
      for (const key of ["firstName", "lastName", "displayName", "fullName", "section", "avatarId"]) if (data[key] !== undefined && !text(data[key], 200)) throw fail("Enter valid student details.", 400);
      for (const key of ["providedEmail", "email"]) if (data[key] !== undefined && !email(data[key])) throw fail("Enter a valid email address.", 400);
      for (const key of ["updatedAt", "lastQrSyncAt", "createdAt"]) if (data[key] !== undefined && !timestamp(data[key])) throw fail("Invalid record timestamp.", 400);
      if (data.archiveReason !== undefined && !(data.archiveReason === null && data.active === true) && (data.active !== false || !["graduated", "dropped-out"].includes(data.archiveReason))) throw fail("Choose a valid archive reason.", 400);
      if (data.deletedAt !== undefined && !(data.deletedAt === null && data.active === true) && !(data.deletedAt?.$type === "timestamp" && Number.isFinite(Date.parse(data.deletedAt.value)))) throw fail("Invalid archive date.", 400);
      if (!row && ((data.completedQuizzes !== undefined && JSON.stringify(data.completedQuizzes) !== "{}") ||
          (data.gamification !== undefined && JSON.stringify(data.gamification) !== JSON.stringify({ badgeCounts: { AccuracyBadgeCount: 0, OnFireBadgeCount: 0 } })))) throw fail("New students must start without earned results.", 400);
      return { ...input, data: { ...data, teacherId: actor.id }, updateTime: row?.updateTime };
    }
    if (p[0] === "classes" && p.length === 2 && actor.role === "teacher" &&
        names(["SectionName", "teacherId", "gradeLevel", "createdAt"]) && data.teacherId === actor.id && text(data.SectionName) &&
        data.gradeLevel === "Grade 6" && timestamp(data.createdAt)) {
      if (row) await this.ownsClass(p[1]);
      return { ...input, updateTime: row?.updateTime };
    }
    if (p[0] === "terms" && term(p[1]) && p[2] === "lessons" && lesson(p[3]) && p.length === 4 && row &&
        input.operation === "update" && names(["sectionId", "isLocked", "scheduledDate"]) &&
        typeof data.isLocked === "boolean" && (data.scheduledDate === "" || date(data.scheduledDate))) {
      await this.ownsClass(data.sectionId);
      // This document was read in the same transaction. Retain every other
      // section and the legacy default used by older mobile builds.
      return { ...input, data: { sectionSchedules: { ...previous.sectionSchedules,
        [data.sectionId]: { isLocked: data.isLocked, scheduledDate: data.scheduledDate }
      } }, updateTime: row.updateTime };
    }
    if (p[0] === "users" && p[2] === "test_results" && term(p[3]) && p[4] === "lessons" && lesson(p[5]) && p.length === 6 && actor.role === "teacher") {
      await this.student(p[1]);
      if (!names(["lessonId", "timestamp", "isPreTestCompleted", "preTestScore", "preTestTotalQuestions", "isPostTestCompleted", "isLessonCompleted", "postTestScore", "postTestTotalQuestions"]) ||
          data.lessonId !== p[5] || !timestamp(data.timestamp)) throw fail("Invalid result fields.", 400);
      for (const key of ["isPreTestCompleted", "isPostTestCompleted", "isLessonCompleted"]) if (data[key] !== undefined && data[key] !== true) throw fail("Invalid completion value.", 400);
      for (const [prefix, maximum] of [["preTest", 5], ["postTest", 10]]) {
        if (data[prefix + "Score"] !== undefined && (!Number.isInteger(data[prefix + "Score"]) || data[prefix + "Score"] < 0 || data[prefix + "Score"] > maximum || data[prefix + "TotalQuestions"] !== maximum)) throw fail("Invalid test score.", 400);
      }
      return { ...input, updateTime: row?.updateTime };
    }
    if (p[0] === "users" && p[1] === actor.id && actor.role === "teacher" && p[2] === "recent_scans" && p.length === 4 && !row &&
        names(["moduleName", "scanType", "timestamp"]) && text(data.moduleName, 4000) && data.scanType === "qr" && timestamp(data.timestamp)) return { ...input };
    if (ref.path === `users/${actor.id}/offlineSync/markerDownloads` && actor.role === "teacher" && input.merge === true &&
        names(["requestedFiles", "updatedAt"]) && timestamp(data.updatedAt) && data.requestedFiles?.$type === "arrayUnion" &&
        Array.isArray(data.requestedFiles.values) && data.requestedFiles.values.length <= 24 &&
        data.requestedFiles.values.every(value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}\.zip$/.test(value))) return { ...input, updateTime: row?.updateTime };
    if (ref.path === "webSettings/schoolYear" && actor.role === "admin" && input.merge === true &&
        names(["startYear", "endYear", "updatedBy", "updatedAt"]) && Number.isInteger(data.startYear) && data.startYear >= 2000 && data.startYear <= 2100 &&
        data.endYear === data.startYear + 1 && data.updatedBy === actor.uid && timestamp(data.updatedAt)) return { ...input, updateTime: row?.updateTime };
    if (p[0] === "generatedQuizzes" && p.length === 2 && actor.role === "teacher") {
      if (row) await this.quiz(p[1]);
      await this.ownsClass(data.sectionId);
      if (!names(["id", "title", "section", "sectionId", "sourceFile", "type", "difficulty", "questions", "availability", "availableAt", "createdAt", "updatedAt", "demo", "teacherUid", "teacherProfileId", "schemaVersion", "gradingMode"]) ||
          data.id !== p[1] || data.teacherUid !== actor.uid || data.teacherProfileId !== actor.id || !text(data.title, 500) || !text(data.section, 200) || !text(data.sourceFile, 240) ||
          !Object.hasOwn(QUIZ_TYPES, data.type) || !["Easy", "Medium", "Hard"].includes(data.difficulty) || !["draft", "now", "scheduled"].includes(data.availability) || data.demo !== false ||
          (data.schemaVersion !== undefined && data.schemaVersion !== 2) ||
          (data.gradingMode !== undefined && data.gradingMode !== (writtenQuestion(data.type) || data.type === "modified-true-false" ? "teacher-review" : "automatic")) ||
          !Array.isArray(data.questions) || data.questions.length < 1 || data.questions.length > 50) throw fail("Invalid quiz details.", 400);
      const answerFields = writtenQuestion(data.type) ? ["answer", "points", data.type === "essay" ? "rubric" : "explanation"] : data.type === "modified-true-false" ? ["correction"] : [];
      if (data.questions.some(question => !object(question) || !fields(question, ["id", "text", "options", "correctIndex", ...answerFields]) || !part(question.id) ||
          (writtenQuestion(data.type) && (!Array.isArray(question.options) || question.options.length !== 0 || question.correctIndex !== -1)) || !normalizeQuizQuestion(question, data.type))) throw fail("Check the quiz questions and answer guides.", 400);
      if (!["multiple-choice", "true-false"].includes(data.type) && (data.schemaVersion !== 2 || data.gradingMode !== "teacher-review")) throw fail("Written-response quizzes need a teacher-review answer guide.", 400);
      if (data.availability === "scheduled" ? !Number.isFinite(Date.parse(data.availableAt)) || Date.parse(data.availableAt) <= Date.now() : data.availableAt !== "") throw fail("Choose a valid quiz release date.", 400);
      return { ...input, data: { ...data, createdAt: previous?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() }, updateTime: row?.updateTime };
    }
    throw fail();
  }
}

function output(path, row, id = path.split("/").at(-1)) {
  const source = row?.wire || row?.data;
  const data = !source ? null : path.startsWith("users/") && path.split("/").length === 2
    ? Object.fromEntries(Object.entries(source).filter(([key]) => profileFields.includes(key))) : source;
  return { id, path, data };
}

async function studentPage(scope, body) {
  if (scope.actor.role !== "teacher") throw fail();
  const sectionId = body.sectionId || "", search = String(body.search || "").trim().toLowerCase();
  const status = body.status || "active", maximum = body.limit ?? 25, cursor = body.cursor;
  if ((sectionId && !part(sectionId)) || (body.search !== undefined && typeof body.search !== "string") ||
      !["active", "archived"].includes(status) || search.length > 100 ||
      !Number.isInteger(maximum) || maximum < 1 || maximum > 25 ||
      (cursor != null && (!object(cursor) || !fields(cursor, ["classId", "id"]) || !part(cursor.classId) || (cursor.id !== null && !part(cursor.id))))) {
    throw fail("Invalid student page.", 400);
  }
  const classes = await scope.store.query("classes", { filters: [{ field: "teacherId", op: "==", value: scope.actor.id }] });
  classes.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (sectionId) await scope.ownsClass(sectionId);
  const selected = classes.filter(row => !sectionId || row.id === sectionId);
  let index = cursor ? selected.findIndex(row => row.id === cursor.classId) : 0;
  if (index < 0) throw fail();
  let after = cursor?.id, scanned = 0;
  const students = [];
  const filters = classId => [{ field: "role", op: "==", value: "student" }, { field: "classCode", op: "==", value: classId }];
  const countPromise = body.includeCounts === false ? null : (async () => {
    const counts = [];
    for (let offset = 0; offset < selected.length; offset += 4) counts.push(...await Promise.all(selected.slice(offset, offset + 4).map(async row => {
      const [total, archived] = await Promise.all([
        scope.store.count("users", filters(row.id)),
        scope.store.count("users", [...filters(row.id), { field: "active", op: "==", value: false }])
      ]);
      return { classId: row.id, active: Math.max(0, total - archived), archived };
    })));
    return counts;
  })().catch(error => ({ error }));
  while (body.includeStudents !== false && index < selected.length && students.length < maximum && scanned < 100) {
    const classId = selected[index].id, size = Math.min(maximum - students.length + 1, 100 - scanned);
    const rows = await scope.store.query("users", { filters: filters(classId), limit: size, after });
    let consumed = 0;
    for (const row of rows) {
      if (students.length === maximum) break;
      after = row.id; consumed++; scanned++;
      if (row.data.teacherId && row.data.teacherId !== scope.actor.id) continue;
      const archived = row.data.active === false;
      const matches = !search || [row.id, row.data.displayName, row.data.fullName, row.data.firstName, row.data.lastName]
        .filter(Boolean).join(" ").toLowerCase().includes(search);
      if (archived === (status === "archived") && matches) students.push({ classId, document: output("users/" + row.id, row) });
    }
    if (consumed === rows.length && rows.length < size) { index++; after = null; }
    else if (students.length === maximum || scanned >= 100) break;
  }
  const counts = countPromise ? await countPromise : null;
  if (counts?.error) throw counts.error;
  return { classes: classes.map(row => output("classes/" + row.id, row)), students,
    counts, scanned,
    cursor: body.includeStudents !== false && index < selected.length ? { classId: selected[index].id, id: after || null } : null };
}

export async function webData({ request, env }, { store = new FirestoreAdmin(env), authenticate = requireStaff } = {}) {
  if (!dataEnabled(env)) return json({ error: "Website data setup is incomplete." }, 503);
  let started = false;
  try {
    if (request.method === "GET" && new URL(request.url).pathname.endsWith("/school-year")) {
      const row = await store.get("webSettings/schoolYear");
      const startYear = row?.data.startYear;
      return json({ startYear: Number.isInteger(startYear) && startYear >= 2000 && startYear <= 2100 ? startYear : 2026 });
    }
    if (request.method !== "POST") return json({ error: "Use POST." }, 405);
    if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) return json({ error: "Use JSON." }, 415);
    const actorBefore = await authenticate(request, env, store);
    const body = await readJson(request, 1_000_000);
    if (!object(body)) throw fail("Invalid data request.", 400);
    if (["commit", "create-teacher"].includes(body.action)) { await store.begin(); started = true; }
    // Re-read the actor inside the transaction so disabling the actor or
    // reassigning a class races safely with the write rather than granting it.
    const actor = started ? await authenticate(request, env, store) : actorBefore;
    const scope = new Scope(store, actor);
    if (body.action === "student-page") return json(await studentPage(scope, body));
    if (body.action === "create-teacher") {
      const profile = body.profile;
      if (actor.role !== "admin") throw fail();
      if (!object(profile) || !fields(profile, ["name", "email", "subject", "sections"]) || !text(profile.name) || !email(profile.email) || !text(profile.subject) ||
          !Array.isArray(profile.sections) || profile.sections.length > 50 || profile.sections.some(section => !text(section))) throw fail("Enter valid teacher details.", 400);
      const existing = await store.query("users", { filters: [{ field: "role", op: "==", value: "teacher" }] });
      const normalizedEmail = profile.email.toLowerCase();
      if (existing.some(row => [row.data.email, row.data.providedEmail].some(value => typeof value === "string" && value.toLowerCase() === normalizedEmail)) ||
          settings(env).some(account => account.email.toLowerCase() === normalizedEmail)) throw fail("That email already belongs to a staff account. Restore or update that account instead.", 409);
      const ids = [...existing.map(row => row.id), ...settings(env).map(account => account.id)];
      const maximum = Math.max(999, ...ids.filter(id => /^TEACH\d{4,10}$/.test(id)).map(id => Number(id.slice(5))));
      const reserved = await stateCall(env, "staff-roster", "allocate-teacher", { minimum: maximum + 1, email: profile.email });
      if (!reserved.ok) throw new Error("Invitation allocation failed");
      const invitation = reserved.result;
      const teacher = { schoolId: invitation.id, displayName: profile.name, fullName: profile.name, providedEmail: invitation.email, email: invitation.email,
        subject: profile.subject, sections: profile.sections, role: "teacher", active: true, status: "invited", isRegistered: false,
        webInvitationNonce: invitation.nonce, createdAt: { $type: "serverTimestamp" } };
      // The private reservation's nonce is committed only by this action.
      // Mobile registration merges UID fields into the existing invitation.
      await scope.get("users/" + invitation.id);
      await store.commit([{ operation: "set", path: "users/" + invitation.id, data: teacher }]); started = false;
      return json({ id: invitation.id });
    }
    if (body.action === "check-student-ids") {
      if (actor.role !== "teacher" || !Array.isArray(body.ids) || body.ids.length > 500 || body.ids.some(id => !part(id))) throw fail("Check fewer student IDs at a time.", 400);
      const existing = [];
      for (let index = 0; index < body.ids.length; index += 8) {
        await Promise.all(body.ids.slice(index, index + 8).map(async id => { if (await scope.get("users/" + id)) existing.push(id); }));
      }
      return json({ existing });
    }
    if (["get", "query", "reads"].includes(body.action)) {
      const requests = body.action === "reads" ? body.reads : [body];
      if (!Array.isArray(requests) || !requests.length || requests.length > 30) throw fail("Load fewer records at a time.", 400);
      const refs = requests.map(item => {
        const ref = reference(item.reference);
        if (!["get", "query"].includes(item.action) || (item.action === "get") !== (ref.kind === "document")) throw fail("Invalid data request.", 400);
        return ref;
      });
      // Authorize the whole group before returning any records; memoized class
      // checks are shared across a page's concurrent report requests.
      await Promise.all(refs.map(ref => scope.authorizeRead(ref)));
      const results = [];
      for (let index = 0; index < refs.length; index += 8) results.push(...await Promise.all(refs.slice(index, index + 8).map(async ref => {
        if (ref.kind === "document") return { document: output(ref.path, await scope.get(ref.path)) };
        if (ref.path === "users" && ref.filters.some(filter => filter.field === "uid")) {
          return { documents: [output("users/" + actor.id, await scope.get("users/" + actor.id), actor.id)] };
        }
        let records = await store.query(ref.path, ref);
        if (ref.path === "generatedQuizzes") {
          // Old or forged UID matches never grant access to another profile's
          // quizzes or sections after a teacher account has been replaced.
          records = (await Promise.all(records.map(async row => {
            if (row.data.teacherProfileId !== actor.id) return null;
            try { await scope.ownsClass(row.data.sectionId); return row; } catch (error) { if (error.status === 403) return null; throw error; }
          }))).filter(Boolean);
        }
        return { documents: records.map(row => output(ref.path + "/" + row.id, row, row.id)) };
      })));
      return json(body.action === "reads" ? { results } : results[0]);
    }
    if (body.action === "commit") {
      if (!Array.isArray(body.writes) || !body.writes.length || body.writes.length > 100 || new Set(body.writes.map(write => write?.path)).size !== body.writes.length) throw fail("Save between 1 and 100 distinct records at a time.", 400);
      const writes = [];
      for (const write of body.writes) writes.push(await scope.write(write));
      await store.commit(writes); started = false;
      for (const write of writes) if (/^users\/TEACH\d+$/.test(write.path) && actor.role === "admin") {
        const id = write.path.split("/")[1];
        if (write.operation === "delete") {
          const disabled = await stateCall(env, "staff-roster", "roster-disable", { id });
          if (!disabled.ok) throw new Error("Invitation update failed");
        }
      }
      return json({ ok: true });
    }
    throw fail("Unknown data operation.", 400);
  } catch (error) {
    if (started) await store.rollback().catch(() => {});
    const status = [400, 401, 403, 409, 413].includes(error.status) ? error.status : 503;
    return json({ error: status === 503 ? "Your data could not be loaded or saved. Please retry or contact website maintenance." : error.message,
      code: status === 401 ? "unauthenticated" : status === 403 ? "permission-denied" : status === 409 ? "aborted" : "unavailable" }, status);
  }
}
