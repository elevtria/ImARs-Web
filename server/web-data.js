import { databaseQuotaFailure } from "./firestore-admin.js";
import { appStore, SupabaseAppStore, supabaseWebData } from "./supabase-app-store.js";
import { dataEnabled, requireStaff, stateCall, settings, readJson } from "./web-auth.js";
import { QUIZ_TYPES, writtenQuestion, normalizeQuizQuestion, quizAssignmentScope } from "../js/quiz-limits.js";
import { validateActivityDeadlineUtc } from "../js/topic-availability.js";
import { activityStorageDataset, MobileActivityStore } from "./mobile-activity-store.js";

const json = (value, status = 200, headers = {}) => Response.json(value, { status, headers: { "Cache-Control": "private, no-store", ...headers } });
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
const profileFields = ["uid", "schoolId", "role", "active", "status", "name", "displayName", "fullName", "firstName", "middleName", "middleInitial", "lastName", "providedEmail", "email",
  "subject", "sections", "section", "classCode", "teacherId", "adviserId", "teacher", "gradeSection", "sectionName", "className", "school", "roleLabel",
  "department", "phone", "adminSince", "createdAt", "updatedAt", "lastUpdated", "lastQrSyncAt", "deletedAt", "archiveReason", "avatarId", "isRegistered", "isClaimed", "joined"];
const schoolYears = new WeakMap();
const schoolYearPath = "webSettings/schoolYear";
const schoolYearCacheKey = store => store.env?.staffIdentityCacheKey || store.env || store;

async function readSchoolYear(store) {
  const key = schoolYearCacheKey(store);
  let entry = schoolYears.get(key);
  if (entry?.pending) return entry.pending;
  if (entry?.until > Date.now()) return entry.value;
  entry = {};
  schoolYears.set(key, entry);
  entry.pending = store.get(schoolYearPath).then(row => {
    const year = row?.data.startYear;
    entry.value = { startYear: Number.isInteger(year) && year >= 2000 && year <= 2100 ? year : 2026 };
    entry.until = Date.now() + 60_000;
    return entry.value;
  }).finally(() => { entry.pending = null; });
  return entry.pending;
}

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
  assignedClasses() {
    this.classes ||= this.store.query("classes", { filters: [{ field: "teacherId", op: "==", value: this.actor.id }] });
    return this.classes;
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
    const assignment = quizAssignmentScope(row.data);
    if (!assignment) throw fail();
    if (assignment === "section") await this.ownsClass(row.data.sectionId);
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
    const row = await this.get(ref.path), previous = row?.data;
    let data = input.data;
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
      const allowed = ["schoolId", "firstName", "middleName", "middleInitial", "lastName", "displayName", "fullName", "role", "classCode", "section", "teacherId", "providedEmail", "email", "active", "updatedAt", "deletedAt", "archiveReason", "lastQrSyncAt"];
      if (!row) allowed.push("avatarId", "isClaimed", "completedQuizzes", "gamification", "createdAt");
      if (!names(allowed) || (data.role !== undefined && data.role !== "student") || (data.schoolId !== undefined && data.schoolId !== p[1]) ||
          (data.teacherId !== undefined && data.teacherId !== actor.id) || (data.active !== undefined && typeof data.active !== "boolean") ||
          (data.isClaimed !== undefined && data.isClaimed !== false)) throw fail("These student fields cannot be changed.", 403);
      if (!row && (data.role !== "student" || !data.classCode || !text(data.displayName))) throw fail("A new student needs a name and an assigned class.", 400);
      if (data.classCode !== undefined) await this.ownsClass(data.classCode);
      for (const key of ["firstName", "lastName", "displayName", "fullName", "section", "avatarId"]) if (data[key] !== undefined && !text(data[key], 200)) throw fail("Enter valid student details.", 400);
      if (data.middleInitial !== undefined && (!text(data.middleInitial, 10, true) || (data.middleInitial && !/^\p{L}\.$/u.test(data.middleInitial)))) throw fail("Invalid middle initial.", 400);
      if (data.middleName !== undefined && (!text(data.middleName, 200, true) || (data.middleName && data.middleName !== "-" &&
          ((data.middleName.match(/\p{L}/gu) || []).length < 2 || !/^[\p{L}\p{M}'’ -]+$/u.test(data.middleName) || /(^|\s)\p{L}(?=\s|$)/u.test(data.middleName))))) throw fail("Enter the full middle name, not a middle initial.", 400);
      for (const key of ["providedEmail", "email"]) if (data[key] !== undefined && !email(data[key])) throw fail("Enter a valid email address.", 400);
      for (const key of ["updatedAt", "lastQrSyncAt", "createdAt"]) if (data[key] !== undefined && !timestamp(data[key])) throw fail("Invalid record timestamp.", 400);
      if (data.archiveReason !== undefined && !(data.archiveReason === null && data.active === true) && (data.active !== false || !["graduated", "dropped-out"].includes(data.archiveReason))) throw fail("Choose a valid archive reason.", 400);
      if (data.deletedAt !== undefined && !(data.deletedAt === null && data.active === true) && !(data.deletedAt?.$type === "timestamp" && Number.isFinite(Date.parse(data.deletedAt.value)))) throw fail("Invalid archive date.", 400);
      if (!row && ((data.completedQuizzes !== undefined && JSON.stringify(data.completedQuizzes) !== "{}") ||
          (data.gamification !== undefined && ![
            { badgeCounts: { AccuracyBadgeCount: 0, OnFireBadgeCount: 0 } },
            { badgeCounts: { AccuracyBadgeCount: 0, OnFireBadgeCount: 0, PerfectStreakBadgeCount: 0, QuizChampionBadgeCount: 0, StreakMasterBadgeCount: 0 } }
          ].some(initial => JSON.stringify(data.gamification) === JSON.stringify(initial))))) throw fail("New students must start without earned results.", 400);
      return { ...input, data: { ...data, teacherId: actor.id }, updateTime: row?.updateTime };
    }
    if (p[0] === "classes" && p.length === 2 && actor.role === "teacher" &&
        names(["SectionName", "teacherId", "gradeLevel", "createdAt"]) && data.teacherId === actor.id && text(data.SectionName) &&
        data.gradeLevel === "Grade 6" && timestamp(data.createdAt)) {
      if (row) await this.ownsClass(p[1]);
      return { ...input, updateTime: row?.updateTime };
    }
    if (p[0] === "terms" && term(p[1]) && p[2] === "lessons" && lesson(p[3]) && p.length === 4 && row &&
        input.operation === "update" && names(["sectionId", "isLocked", "scheduledDate", "activityDeadlineUtc"]) &&
        typeof data.isLocked === "boolean" && (data.scheduledDate === "" || date(data.scheduledDate))) {
      await this.ownsClass(data.sectionId);
      const existing = object(previous.sectionSchedules?.[data.sectionId]) ? previous.sectionSchedules[data.sectionId] : {};
      const activityDeadlineUtc = Object.hasOwn(data, "activityDeadlineUtc") ? data.activityDeadlineUtc : existing.activityDeadlineUtc ?? "";
      try { validateActivityDeadlineUtc(activityDeadlineUtc, data.scheduledDate); }
      catch (error) { throw fail(error.message, 400); }
      // This document was read in the same transaction. Retain every other
      // section and the legacy default used by older mobile builds.
      return { ...input, data: { sectionSchedules: { ...previous.sectionSchedules,
        [data.sectionId]: { ...existing, isLocked: data.isLocked, scheduledDate: data.scheduledDate, activityDeadlineUtc }
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
      const releaseOnly = input.operation === "update" && names(["section", "sectionId", "assignmentScope", "availability", "availableAt"]);
      const release = releaseOnly ? data : null;
      if (releaseOnly) data = { ...previous, ...release };
      const assignment = quizAssignmentScope(data);
      if (!assignment || (assignment === "unassigned" && data.availability !== "draft")) throw fail("Choose a section in the quiz schedule before releasing it.", 400);
      if (assignment === "section") await this.ownsClass(data.sectionId);
      if (!names(["id", "title", "section", "sectionId", "assignmentScope", "sourceFile", "type", "difficulty", "questions", "availability", "availableAt", "createdAt", "updatedAt", "demo", "teacherUid", "teacherProfileId", "schemaVersion", "gradingMode", "questionCount"]) ||
          data.id !== p[1] || data.teacherUid !== actor.uid || data.teacherProfileId !== actor.id || !text(data.title, 500) || !text(data.section, 200) || !text(data.sourceFile, 240) ||
          !Object.hasOwn(QUIZ_TYPES, data.type) || !["Easy", "Medium", "Hard"].includes(data.difficulty) || !["draft", "now", "scheduled"].includes(data.availability) || data.demo !== false ||
          (data.schemaVersion !== undefined && data.schemaVersion !== 2) ||
          (data.gradingMode !== undefined && data.gradingMode !== (writtenQuestion(data.type) || data.type === "modified-true-false" ? "teacher-review" : "automatic")) ||
          !Array.isArray(data.questions) || data.questions.length < 1 || data.questions.length > 50 || new Set(data.questions.map(q => q?.id)).size !== data.questions.length) throw fail("Invalid quiz details.", 400);
      const answerFields = writtenQuestion(data.type) ? ["answer", "points", data.type === "essay" ? "rubric" : "explanation"] : data.type === "modified-true-false" ? ["correction"] : [];
      if (data.questions.some(question => !object(question) || !fields(question, ["id", "text", "options", "correctIndex", ...answerFields]) || !part(question.id) ||
          (writtenQuestion(data.type) && (!Array.isArray(question.options) || question.options.length !== 0 || question.correctIndex !== -1)) || !normalizeQuizQuestion(question, data.type))) throw fail("Check the quiz questions and answer guides.", 400);
      if (!["multiple-choice", "true-false"].includes(data.type) && (data.schemaVersion !== 2 || data.gradingMode !== "teacher-review")) throw fail("Written-response quizzes need a teacher-review answer guide.", 400);
      if (data.availability === "scheduled" ? !Number.isFinite(Date.parse(data.availableAt)) || Date.parse(data.availableAt) <= Date.now() : data.availableAt !== "") throw fail("Choose a valid quiz release date.", 400);
      return { ...input, data: { ...(release || data), questionCount: data.questions.length, createdAt: previous?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() }, updateTime: row?.updateTime };
    }
    throw fail();
  }
}

const pick = (source, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(source, key)).map(key => [key, source[key]]));

function output(path, row, id = path.split("/").at(-1), sectionIds = []) {
  const source = row?.wire || row?.data;
  let data = source ?? null;
  if (source && /^users\/[^/]+$/.test(path)) data = pick(source, profileFields);
  if (source && /^classes\/[^/]+$/.test(path)) data = pick(source, ["SectionName", "sectionName", "name", "gradeLevel", "GradeLevel", "grade", "Grade"]);
  if (source && /^generatedQuizzes\/[^/]+$/.test(path)) {
    data = pick(source, ["title", "section", "sectionId", "assignmentScope", "sourceFile", "type", "difficulty", "availability", "availableAt", "createdAt", "demo", "teacherUid"]);
    data.questions = Array.isArray(source.questions) ? source.questions.filter(object).map(question =>
      pick(question, ["id", "text", "options", "correctIndex", "answer", "points", "rubric", "explanation", "correction"])) : [];
  }
  if (source && /^terms\/[^/]+(?:\/lessons\/[^/]+)?$/.test(path)) {
    data = pick(source, ["title", "name", "topicTitle", "lessonOrder", "isLocked", "scheduledDate"]);
    if (Array.isArray(source.postTest)) data.postTest = source.postTest.map(item => ({ question: typeof item?.question === "string" ? item.question : "" }));
    if (object(source.sectionSchedules)) {
      data.sectionSchedules = Object.fromEntries(sectionIds.filter(id => object(source.sectionSchedules[id])).map(id => [id,
        pick(source.sectionSchedules[id], ["isLocked", "scheduledDate", "activityDeadlineUtc"])]));
    }
  }
  return { id, path, data };
}

function quizListEntry(row) {
  const data = pick(row.data, ["title", "section", "sectionId", "assignmentScope", "type", "availability", "availableAt"]);
  return { id: row.id, path: "generatedQuizzes/" + row.id, data: { ...data, questionCount: Array.isArray(row.data.questions) ? row.data.questions.length : 0 } };
}

async function studentPage(scope, body, { deferCounts = false, maximumLimit = 25 } = {}) {
  if (scope.actor.role !== "teacher") throw fail();
  let sectionId = body.sectionId || "";
  const search = String(body.search || "").trim().toLowerCase();
  const status = body.status || "active", maximum = body.limit ?? 25, cursor = body.cursor;
  if ((sectionId && !part(sectionId)) || (body.search !== undefined && typeof body.search !== "string") ||
      !["active", "archived"].includes(status) || search.length > 100 ||
      !Number.isInteger(maximum) || maximum < 1 || maximum > maximumLimit ||
      (cursor != null && (!object(cursor) || !fields(cursor, ["classId", "id"]) || !part(cursor.classId) || (cursor.id !== null && !part(cursor.id))))) {
    throw fail("Invalid student page.", 400);
  }
  if (body.includeResults !== undefined && (!object(body.includeResults) || !fields(body.includeResults, ["termId", "limit"]) ||
      !term(body.includeResults.termId) || !Number.isInteger(body.includeResults.limit) || body.includeResults.limit < 1 || body.includeResults.limit > 8)) {
    throw fail("Invalid student performance page.", 400);
  }
  if (body.includeTeacher !== undefined && typeof body.includeTeacher !== "boolean") throw fail("Invalid teacher details request.", 400);
  const classes = await scope.assignedClasses();
  for (const row of classes) scope.reads.set("classes/" + row.id, Promise.resolve(row));
  classes.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (body.firstSection === true && !sectionId) sectionId = classes[0]?.id || "";
  if (sectionId) await scope.ownsClass(sectionId);
  const selected = classes.filter(row => !sectionId || row.id === sectionId);
  let index = cursor ? selected.findIndex(row => row.id === cursor.classId) : 0;
  if (index < 0) throw fail();
  let after = cursor?.id, scanned = 0;
  const students = [];
  const filters = classId => [{ field: "role", op: "==", value: "student" }, { field: "classCode", op: "==", value: classId }];
  const queued = new Map();
  const queueClass = (position, size) => {
    const queryFilters = [...filters(selected[position].id), ...(status === "archived" ? [{ field: "active", op: "==", value: false }] : [])];
    queued.set(position, { size, pending: scope.store.query("users", { filters: queryFilters, limit: size, after: position === index ? after : undefined })
      .then(rows => ({ rows }), error => ({ error })) });
  };
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
    // Empty sections must not add one network round trip each. Probe at most
    // three following sections with eight rows; the visible page stays bounded.
    for (let position = index; position < Math.min(index + 4, selected.length); position++) {
      if (!queued.has(position)) queueClass(position, position === index ? size : Math.min(8, size));
    }
    const queuedClass = queued.get(index), result = await queuedClass.pending;
    queued.delete(index);
    if (result.error) throw result.error;
    const rows = result.rows;
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
    if (consumed === rows.length && rows.length < queuedClass.size) { index++; after = null; }
    else if (students.length === maximum || scanned >= 100) break;
  }
  const page = { classes: classes.map(row => output("classes/" + row.id, row)), students, scanned,
    cursor: body.includeStudents !== false && index < selected.length ? { classId: selected[index].id, id: after || null } : null };
  if (body.includeTeacher === true) page.teacher = output("users/" + scope.actor.id, await scope.get("users/" + scope.actor.id));
  // Reports can start their lesson batches as soon as roster ownership is
  // verified, while independent section totals are still being calculated.
  if (deferCounts) return { ...page, pendingCounts: countPromise };
  if (body.includeResults && students.length) {
    const visible = students.slice(0, body.includeResults.limit), termId = body.includeResults.termId;
    const paths = visible.flatMap(row => [1, 2, 3, 4].map(index => `users/${row.document.id}/test_results/${termId}/lessons/lesson_0${index}`));
    try {
      const results = await scope.store.getAll(paths);
      for (const row of visible) {
        row.termId = termId;
        row.lessons = paths.filter(path => path.startsWith(`users/${row.document.id}/`)).flatMap(path => results.get(path) ? [output(path, results.get(path))] : []);
      }
    } catch {
      // Optional performance reads must not hide a successfully authorized roster.
      // Omitted results retain each card's existing lazy-load/retry behavior.
      page.performanceUnavailable = true;
    }
  }
  const counts = countPromise ? await countPromise : null;
  if (counts?.error) throw counts.error;
  return { ...page, counts };
}

async function reportActivityGrades(env, students, termIds, fetcher) {
  const store = new MobileActivityStore(env, fetcher);
  const bySection = new Map();
  for (const row of students) {
    if (!bySection.has(row.classId)) bySection.set(row.classId, []);
    bySection.get(row.classId).push(row.document.id);
  }
  const requests = [];
  for (const [sectionId, studentIds] of bySection) {
    for (let offset = 0; offset < studentIds.length; offset += 20)
      requests.push([sectionId, studentIds.slice(offset, offset + 20)]);
  }
  const grades = new Map();
  for (let offset = 0; offset < requests.length; offset += 4) {
    await Promise.all(requests.slice(offset, offset + 4).map(async ([sectionId, studentIds]) => {
      for (const row of await store.gradesForRoster(sectionId, termIds, studentIds)) {
        if (!studentIds.includes(row.studentId) || !termIds.includes(row.termId) || !lesson(row.lessonId) ||
            row.maximum !== 100 || !Number.isInteger(row.score) || row.score < 0 || row.score > row.maximum) {
          throw new Error("Unexpected activity grade in teacher report.");
        }
        grades.set([sectionId, row.studentId, row.termId, row.lessonId].join("/"), row);
      }
    }));
  }
  return grades;
}

async function teacherReportPage(scope, body, env, fetcher) {
  if (scope.actor.role !== "teacher") throw fail();
  if (!term(body.termId)) throw fail("Choose one term.", 400);
  if (body.allTerms !== undefined && typeof body.allTerms !== "boolean") throw fail("Invalid report scope.", 400);
  const batchSize = body.batchSize ?? 25;
  if (![25, 100].includes(batchSize)) throw fail("Invalid report batch size.", 400);
  const heatmap = body.heatmapLesson !== undefined;
  if (heatmap && (typeof body.heatmapLesson !== "string" || !lesson(body.heatmapLesson) || !body.sectionId || body.allTerms === true || batchSize !== 25)) throw fail("Choose one section and topic.", 400);
  const termIds = body.allTerms === true ? ["term_01", "term_02", "term_03"] : [body.termId];
  const curriculumPromise = heatmap || body.includeCurriculum === false ? null : (async () => {
    const path = "terms/" + body.termId;
    const [row, lessons, classes] = await Promise.all([scope.get(path), scope.store.query(path + "/lessons", { limit: 4 }), scope.assignedClasses()]);
    const sectionIds = classes.map(section => section.id);
    return { term: output(path, row), lessons: lessons.map(lesson => output(path + "/lessons/" + lesson.id, lesson, lesson.id, sectionIds)) };
  })().then(value => ({ value }), error => ({ error }));
  const { pendingCounts, ...page } = await studentPage(scope, { ...body, ...(heatmap ? { includeCounts: false } : {}), status: "active", search: "", limit: batchSize }, { deferCounts: true, maximumLimit: 100 });
  // Lesson IDs are the four fixed IDs already enforced by this gateway. Fetch
  // their documents in batches of at most 100, only for verified roster rows.
  const lessonIds = heatmap ? [body.heatmapLesson] : ["lesson_01", "lesson_02", "lesson_03", "lesson_04"];
  const heatmapFields = ["isPostTestCompleted", "postTestTotalQuestions", "postTestScore", "postTestHeatmap", "postTestQuestionOrder"];
  const paths = page.students.flatMap(row => termIds.flatMap(termId => lessonIds.map(id => `users/${row.document.id}/test_results/${termId}/lessons/${id}`)));
  const records = new Map();
  for (let offset = 0; offset < paths.length; offset += 400) {
    const batches = [];
    for (let index = offset; index < Math.min(offset + 400, paths.length); index += 100) batches.push(scope.store.getAll(paths.slice(index, index + 100), heatmap ? { fieldPaths: heatmapFields } : undefined));
    for (const rows of await Promise.all(batches)) for (const [path, record] of rows) records.set(path, record);
  }
  const activityGrades = !heatmap && page.students.length && env.MOBILE_API_ENABLED === "true" &&
    activityStorageDataset(env) === "production"
    ? await reportActivityGrades(env, page.students, termIds, fetcher) : null;
  const students = page.students.map(row => {
    const results = termIds.map(termId => ({ termId, lessons: lessonIds.flatMap(id => {
      const path = `users/${row.document.id}/test_results/${termId}/lessons/${id}`, record = records.get(path);
      const grade = activityGrades?.get([row.classId, row.document.id, termId, id].join("/"));
      if (grade) return [output(path, { data: { ...(record?.wire || record?.data),
        activityScore: grade.score, activityTotalQuestions: grade.maximum, activityTotalPoints: grade.maximum } })];
      return record ? [output(path, heatmap ? { data: pick(record.wire || record.data, heatmapFields) } : record)] : [];
    }) }));
    return { ...row, ...(heatmap ? { document: { ...row.document, data: {} } } : {}), ...(body.allTerms === true ? { termResults: results } : { lessons: results[0].lessons }) };
  });
  const curriculumResult = await curriculumPromise;
  if (curriculumResult?.error) throw curriculumResult.error;
  const curriculum = curriculumResult?.value;
  const counts = pendingCounts ? await pendingCounts : null;
  if (counts?.error) throw counts.error;
  return { ...page, counts, students, cursor: counts?.every(row => row.active === 0) ? null : page.cursor, curriculum, termId: body.termId };
}

async function teacherTopicOverview(scope) {
  if (scope.actor.role !== "teacher") throw fail();
  const classes = await scope.store.query("classes", { filters: [{ field: "teacherId", op: "==", value: scope.actor.id }] });
  const sectionIds = classes.map(row => row.id);
  const termIds = ["term_01", "term_02", "term_03"];
  const paths = termIds.flatMap(termId => [1, 2, 3, 4].map(index => `terms/${termId}/lessons/lesson_0${index}`));
  const records = classes.length ? await scope.store.getAll(paths, { fieldPaths: ["title", "name", "isLocked", "scheduledDate", "sectionSchedules"] }) : new Map();
  return { sectionIds, terms: termIds.map(id => ({ id, lessons: paths.filter(path => path.startsWith(`terms/${id}/`)).flatMap(path => {
    const data = records.get(path)?.data;
    if (!data) return [];
    const schedules = object(data.sectionSchedules) ? data.sectionSchedules : {};
    return [{ id: path.split("/").at(-1), title: data.title || data.name || "Lesson " + Number(path.slice(-2)),
      isLocked: data.isLocked, scheduledDate: data.scheduledDate || "",
      sectionSchedules: Object.fromEntries(sectionIds.filter(sectionId => Object.hasOwn(schedules, sectionId)).map(sectionId => [sectionId,
        { isLocked: schedules[sectionId]?.isLocked, scheduledDate: schedules[sectionId]?.scheduledDate || "" }])) }];
  }) })) };
}

export async function webData({ request, env, waitUntil }, { store, authenticate = requireStaff,
  settingsFetcher = fetch, activityFetcher = fetch } = {}) {
  const requestStarted = Date.now(); let authenticationMs = 0;
  const respond = (value, status = 200) => json(value, status, { "Server-Timing": `auth;dur=${authenticationMs}, data;dur=${Math.max(0, Date.now() - requestStarted - authenticationMs)}` });
  if (!dataEnabled(env)) return respond({ error: "Website data setup is incomplete." }, 503);
  const supabaseSettings = !supabaseWebData(env) && env.IMARS_SUPABASE_WEB_SETTINGS === "true";
  let transaction;
  const settingsStore = () => supabaseSettings ? new SupabaseAppStore(env, settingsFetcher) : store;
  try {
    store ??= appStore(env, settingsFetcher);
    if (request.method === "GET" && new URL(request.url).pathname.endsWith("/school-year")) {
      return respond(await readSchoolYear(settingsStore()));
    }
    if (request.method !== "POST") return respond({ error: "Use POST." }, 405);
    if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) return respond({ error: "Use JSON." }, 415);
    const actorBefore = await authenticate(request, env, store);
    const body = await readJson(request, 1_000_000);
    if (!object(body)) throw fail("Invalid data request.", 400);
    if (["commit", "create-teacher"].includes(body.action)) {
      const changesSchoolYear = body.action === "commit" && Array.isArray(body.writes) && body.writes.some(write => write?.path === schoolYearPath);
      if (supabaseSettings && changesSchoolYear) {
        if (actorBefore.role !== "admin") throw fail();
        if (body.writes.length !== 1) throw fail("Save the school year separately.", 400);
        transaction = settingsStore();
      } else transaction = store;
      await transaction.begin();
    }
    // Re-read the actor inside the transaction so disabling the actor or
    // reassigning a class races safely with the write rather than granting it.
    const actor = transaction ? await authenticate(request, env, store) : actorBefore;
    authenticationMs = Date.now() - requestStarted;
    const scope = new Scope(transaction || store, actor);
    if (body.action === "dashboard-summary") {
      if (actor.role !== "teacher") throw fail();
      if (env.DASHBOARD_SUMMARIES_ENABLED !== "true") return respond({ enabled: false });
      const classes = await store.query("classes", { filters: [{ field: "teacherId", value: actor.id }] });
      const sections = classes.map(row => ({ id: row.id, name: String(row.data.SectionName || row.id).slice(0, 300) }));
      const cached = await stateCall(env, "dashboard:" + actor.uid, "dashboard-get", { id: actor.id, uid: actor.uid, sections });
      if (!cached.ok) throw new Error("Dashboard unavailable");
      return respond({ enabled: true, ...cached.result, teacherName: actor.profile?.displayName || actor.profile?.fullName || "Teacher" });
    }
    if (body.action === "student-page") return respond(await studentPage(scope, body));
    if (body.action === "teacher-report-page") return respond(await teacherReportPage(scope, body, env, activityFetcher));
    if (body.action === "teacher-topic-overview") return respond(await teacherTopicOverview(scope));
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
      await transaction.commit([{ operation: "set", path: "users/" + invitation.id, data: teacher }]); transaction = null;
      return respond({ id: invitation.id });
    }
    if (body.action === "check-student-ids") {
      if (actor.role !== "teacher" || !Array.isArray(body.ids) || body.ids.length > 500 || body.ids.some(id => !part(id))) throw fail("Check fewer student IDs at a time.", 400);
      const existing = [];
      for (let index = 0; index < body.ids.length; index += 8) {
        await Promise.all(body.ids.slice(index, index + 8).map(async id => { if (await scope.get("users/" + id)) existing.push(id); }));
      }
      return respond({ existing });
    }
    if (["get", "query", "reads"].includes(body.action)) {
      const requests = body.action === "reads" ? body.reads : [body];
      if (!Array.isArray(requests) || !requests.length || requests.length > 30) throw fail("Load fewer records at a time.", 400);
      const refs = requests.map(item => {
        const ref = reference(item.reference);
        if (!["get", "query"].includes(item.action) || (item.action === "get") !== (ref.kind === "document")) throw fail("Invalid data request.", 400);
        return ref;
      });
      const resultQueries = refs.filter(ref => ref.kind === "query" && /^users\/[A-Za-z0-9_-]+\/test_results\/term_0[1-3]\/lessons$/.test(ref.path) &&
        !ref.filters.length && !ref.order.length && ref.limit >= 4);
      // A visible group shares two batch reads: current student profiles for
      // ownership, then their fixed lesson documents. Never return any results
      // until every reference in the request has passed authorization.
      if (resultQueries.length > 1) {
        const paths = [...new Set(resultQueries.map(ref => "users/" + ref.parts[1]))];
        const profiles = await store.getAll(paths);
        for (const path of paths) scope.reads.set(path, Promise.resolve(profiles.get(path)));
      }
      // Authorize the whole group before returning any records; memoized class
      // checks are shared across a page's concurrent report requests.
      await Promise.all(refs.map(ref => scope.authorizeRead(ref)));
      const sectionIds = actor.role === "teacher" && refs.some(ref => ref.parts[0] === "terms" && ref.parts[2] === "lessons")
        ? (await scope.assignedClasses()).map(section => section.id) : [];
      const batchedResults = new Map();
      for (let index = 0; index < resultQueries.length; index += 25) {
        const group = resultQueries.slice(index, index + 25);
        const paths = [...new Set(group.flatMap(ref => [1, 2, 3, 4].map(number => ref.path + "/lesson_0" + number)))];
        const rows = await store.getAll(paths);
        for (const ref of group) batchedResults.set(ref.path, [1, 2, 3, 4].flatMap(number => {
          const path = ref.path + "/lesson_0" + number, row = rows.get(path);
          return row ? [output(path, row)] : [];
        }));
      }
      const results = [];
      for (let index = 0; index < refs.length; index += 8) results.push(...await Promise.all(refs.slice(index, index + 8).map(async ref => {
        if (ref.kind === "document") {
          const row = ref.path === schoolYearPath && supabaseSettings ? await settingsStore().get(ref.path) : await scope.get(ref.path);
          return { document: output(ref.path, row, undefined, sectionIds) };
        }
        if (batchedResults.has(ref.path)) return { documents: batchedResults.get(ref.path) };
        if (ref.path === "users" && ref.filters.some(filter => filter.field === "uid")) {
          return { documents: [output("users/" + actor.id, await scope.get("users/" + actor.id), actor.id)] };
        }
        let records = ref.path === "classes" ? (await scope.assignedClasses()).slice(0, ref.limit) : await store.query(ref.path, ref);
        if (ref.path === "generatedQuizzes") {
          // Old or forged UID matches never grant access to another profile's
          // quizzes or sections after a teacher account has been replaced.
          records = (await Promise.all(records.map(async row => {
            if (row.data.teacherProfileId !== actor.id) return null;
            try {
              const assignment = quizAssignmentScope(row.data);
              if (!assignment) return null;
              if (assignment === "section") await scope.ownsClass(row.data.sectionId);
              return row;
            } catch (error) { if (error.status === 403) return null; throw error; }
          }))).filter(Boolean);
        }
        return { documents: records.map(row => ref.path === "generatedQuizzes" ? quizListEntry(row) : output(ref.path + "/" + row.id, row, row.id, sectionIds)) };
      })));
      return respond(body.action === "reads" ? { results } : results[0]);
    }
    if (body.action === "commit") {
      if (!Array.isArray(body.writes) || !body.writes.length || body.writes.length > 100 || new Set(body.writes.map(write => write?.path)).size !== body.writes.length) throw fail("Save between 1 and 100 distinct records at a time.", 400);
      const writes = [];
      for (const write of body.writes) writes.push(await scope.write(write));
      await transaction.commit(writes);
      if (writes.some(write => write.path === schoolYearPath)) schoolYears.delete(schoolYearCacheKey(transaction));
      transaction = null;
      if (env.DASHBOARD_SUMMARIES_ENABLED === "true" && actor.role === "teacher") {
        const ids = [...new Set(writes.filter(write => /^users\/[A-Za-z0-9_-]+(?:\/test_results\/|$)/.test(write.path)).map(write => write.path.split("/")[1]))];
        if (ids.length) {
          const update = stateCall(env, "dashboard:" + actor.uid, "dashboard-dirty", { ids }).then(result => { if (!result.ok) throw new Error("Dashboard update unavailable"); });
          if (waitUntil) waitUntil(update.catch(() => console.warn("Dashboard refresh will retry.")));
          else await update.catch(() => {});
        }
      }
      for (const write of writes) if (/^users\/TEACH\d+$/.test(write.path) && actor.role === "admin") {
        const id = write.path.split("/")[1];
        if (write.operation === "delete") {
          const disabled = await stateCall(env, "staff-roster", "roster-disable", { id });
          if (!disabled.ok) throw new Error("Invitation update failed");
        }
      }
      return respond({ ok: true });
    }
    throw fail("Unknown data operation.", 400);
  } catch (error) {
    if (transaction) await transaction.rollback().catch(() => {});
    if (databaseQuotaFailure(error)) return respond({ error: error.message, code: "DATABASE_QUOTA_EXCEEDED" }, 503);
    const status = [400, 401, 403, 409, 413].includes(error.status) ? error.status : 503;
    return respond({ error: status === 503 ? "Your data could not be loaded or saved. Please retry or contact website maintenance." : error.message,
      code: status === 401 ? "unauthenticated" : status === 403 ? "permission-denied" : status === 409 ? "aborted" : "unavailable" }, status);
  }
}
