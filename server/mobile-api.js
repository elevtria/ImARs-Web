import { appStore } from "./supabase-app-store.js";
import { activityStorageDataset, MobileActivityStore } from "./mobile-activity-store.js";
import { activeProfile, authenticateStudent, validPart } from "./student-quiz-auth.js";
import { checkTeacherSession } from "./teacher-sessions.js";
import { readJson, requireStaff, stateCall } from "./web-auth.js";
import { schoolTodayISO, sectionSchedule, topicAvailability, validateActivityDeadlineUtc } from "../js/topic-availability.js";

const termIdValid = value => typeof value === "string" && /^term_0[1-3]$/.test(value);
const terms = ["term_01", "term_02", "term_03"];
const lessons = ["lesson_01", "lesson_02", "lesson_03", "lesson_04"];
const failure = (code, status, message) => Object.assign(new Error(message), { code, status });
const invalid = () => failure("INVALID_REQUEST", 400, "Invalid mobile request.");
const forbidden = () => failure("FORBIDDEN", 403, "You do not have access to this record.");
const scopeChanged = () => failure("SCOPE_CHANGED", 403, "Your class or account has changed.");
const unavailable = () => failure("SERVICE_UNAVAILABLE", 503, "The mobile service is temporarily unavailable.");
const conflict = (code, message) => failure(code, 409, message);
const locked = () => conflict("ACTIVITY_LOCKED", "This activity is unavailable.");
const completed = () => conflict("ALREADY_COMPLETED", "You already completed this activity.");
const deadlinePassed = () => failure("DEADLINE_PASSED", 410, "The activity deadline has passed.");
const string = value => typeof value === "string" ? value : "";
const counter = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const json = (data, status = 200, extra = {}) => Response.json(data, { status, headers: { "Cache-Control": "private, no-store", ...extra } });
const lessonPath = (termId, lessonId) => `terms/${termId}/lessons/${lessonId}`;
const scheduleFields = ["title", "name", "sectionSchedules", "isLocked", "scheduledDate", "activityDeadlineUtc"];
const encoder = new TextEncoder();

async function digest(value) {
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

function validateKeys(body, keys) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !keys.includes(key))) throw invalid();
}

async function linkedProfile(identity, env, store) {
  const binding = (await store.get("_accountAccess/" + identity.uid))?.data;
  let row;
  if (binding) {
    if (binding.active !== true) throw failure("ACCOUNT_DISABLED", 403, "This account is inactive.");
    if (!validPart(binding.profileId) || string(binding.authEmail).toLowerCase() !== identity.email) throw scopeChanged();
    row = await store.get("users/" + binding.profileId);
  } else {
    if (env.ACCOUNT_ACCESS_ENABLED === "true") throw scopeChanged();
    const rows = await store.query("users", { filters: [{ field: "uid", value: identity.uid }], limit: 2 });
    if (rows.length === 1) [row] = rows;
  }
  if (!row || !validPart(row.id) || row.data.uid !== identity.uid || (binding && binding.role !== row.data.role)) throw scopeChanged();
  if (!activeProfile(row.data)) throw failure("ACCOUNT_DISABLED", 403, "This account is inactive.");
  return row;
}

async function accountScope(request, env, store, row, uid, verifySession = true) {
  const profile = row.data;
  if (!["student", "teacher", "admin"].includes(profile.role)) throw forbidden();
  if (verifySession && !await checkTeacherSession(env, store, { uid, id: row.id, role: profile.role }, "mobile", request.headers.get("X-Imars-Mobile-Session"))) {
    throw failure("SESSION_REVOKED", 401, "Sign in again to continue.");
  }
  const scope = { uid, profileId: row.id, role: profile.role, classCode: "", teacherProfileId: "", teacherUid: "",
    datasetEpoch: env.IMARS_MOBILE_DATASET_EPOCH || "firestore-v1" };
  if (profile.role === "student" && profile.classCode) {
    if (!validPart(profile.classCode)) throw scopeChanged();
    const section = (await store.get("classes/" + profile.classCode))?.data;
    if (!activeProfile(section) || !validPart(section.teacherId) || (profile.teacherId && profile.teacherId !== section.teacherId)) throw scopeChanged();
    const teacher = (await store.get("users/" + section.teacherId))?.data;
    if (!activeProfile(teacher) || teacher.role !== "teacher" || !validPart(teacher.uid)) throw scopeChanged();
    Object.assign(scope, { classCode: profile.classCode, teacherProfileId: section.teacherId, teacherUid: teacher.uid });
    return { scope, section };
  }
  return { scope };
}

async function permittedSection(store, scope, requested) {
  if (requested !== undefined && !validPart(requested)) throw invalid();
  if (scope.role === "student") {
    if (!scope.classCode || (requested !== undefined && requested !== scope.classCode)) throw forbidden();
    return scope.classCode;
  }
  if (!requested) throw invalid();
  const section = (await store.get("classes/" + requested))?.data;
  if (!activeProfile(section) || (scope.role === "teacher" && section.teacherId !== scope.profileId)) throw forbidden();
  return requested;
}

async function profileResponse(scope, row, section, email) {
  const source = row.data;
  const profile = Object.fromEntries(["firstName", "lastName", "avatarId", "school", "department", "phone"].map(key => [key, string(source[key])]));
  Object.assign(profile, {
    profileId: scope.profileId, schoolId: string(source.schoolId) || scope.profileId, uid: scope.uid, role: scope.role, active: true,
    displayName: string(source.displayName || source.fullName), email, hasPickedAvatar: source.hasPickedAvatar === true,
    hasSeenClassCode: source.hasSeenClassCode === true, classCode: scope.classCode, sectionName: string(section?.SectionName || section?.sectionName),
    teacherProfileId: scope.teacherProfileId, revision: ""
  });
  profile.revision = await digest(profile);
  const gamification = source.gamification;
  const badgeCounts = Object.fromEntries(["Accuracy", "OnFire", "PerfectStreak", "StreakMaster", "QuizChampion"].map(name => {
    const key = name + "BadgeCount";
    return [key, counter(gamification?.badgeCounts?.[key])];
  }));
  return { scope, profile, achievements: { totalPoints: counter(gamification?.totalPoints), badgeCounts } };
}

async function scheduleItem(record, sectionId, termId, lessonId) {
  const lesson = record?.data;
  const own = lesson?.sectionSchedules && Object.hasOwn(lesson.sectionSchedules, sectionId) ? lesson.sectionSchedules[sectionId] : lesson;
  let schedule = sectionSchedule(lesson || {}, sectionId);
  let activityDeadlineUtc = "";
  try { activityDeadlineUtc = validateActivityDeadlineUtc(own && Object.hasOwn(own, "activityDeadlineUtc") ? own.activityDeadlineUtc : "", schedule.scheduledDate); }
  catch { schedule = { isLocked: true, scheduledDate: "" }; }
  const item = { termId, lessonId, title: string(lesson?.title || lesson?.name), ...schedule, activityDeadlineUtc };
  return { ...item, revision: await digest([sectionId, item]) };
}

async function scheduleResponse(store, scope, body, now) {
  validateKeys(body, ["termId", "sectionId"]);
  if (body.termId !== undefined && !termIdValid(body.termId)) throw invalid();
  const sectionId = await permittedSection(store, scope, body.sectionId);
  const pairs = (body.termId ? [body.termId] : terms).flatMap(termId => lessons.map(lessonId => [termId, lessonId]));
  const records = await store.getAll(pairs.map(pair => lessonPath(...pair)), { fieldPaths: scheduleFields });
  const items = await Promise.all(pairs.map(pair => scheduleItem(records.get(lessonPath(...pair)), sectionId, ...pair)));
  return { scope, serverTimeUtc: now.toISOString(), schoolDate: schoolTodayISO(now), revision: await digest(items.map(item => item.revision)), items };
}

const activities = new Map([
  ["states-of-matter", "States of Matter", 1, 1],
  ["physical-chemical-changes", "Physical and Chemical Changes", 1, 2],
  ["separation-techniques", "Separation Techniques", 1, 3],
  ["circulatory-system", "Circulatory System", 1, 4],
  ["food-web", "Food Web", 2, 1],
  ["simple-machines", "Simple Machines", 2, 2],
  ["sound-waves", "Sound Waves", 2, 3],
  ["longitudinal-waves", "Longitudinal Waves", 3, 1],
  ["volcanic-eruptions", "Volcanic Activity", 3, 2],
  ["earth-motion", "Motions of the Earth", 3, 3],
  ["constellation", "Constellations", 3, 4]
].map(([activityId, title, term, lesson]) => [activityId, { activityId, title, termId: terms[term - 1], lessonId: lessons[lesson - 1] }]));
const readActions = ["me", "schedules"];
const reportAction = "staff-activity-results";
const writeKeys = {
  "activity-start": ["requestId", "activityId", "deviceId"],
  "activity-checkpoint": ["requestId", "activityId", "deviceId", "runId", "checkpointRevision", "checkpoint"],
  "activity-submit": ["requestId", "activityId", "deviceId", "runId", "checkpointRevision", "checkpoint",
    "rawScore", "rawMaximum", "durationSeconds", "timedOut", "completedAtUtc"]
};
const activityActions = ["activity-results", reportAction, ...Object.keys(writeKeys)];
const clockAllowance = 2 * 60_000;
const maximumOfflineAge = 7 * 24 * 60 * 60_000;
const boundedInt = (value, minimum = 0, maximum = 2_147_483_647) => Number.isInteger(value) && value >= minimum && value <= maximum;

function completionTime(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/.test(value)) throw invalid();
  const time = new Date(value);
  if (!Number.isFinite(time.getTime()) || time.toISOString().slice(0, 19) !== value.slice(0, 19)) throw invalid();
  return time.getTime();
}

function checkActivityFilter(body) {
  if (body.termId !== undefined && !termIdValid(body.termId)) throw invalid();
  if (body.activityId !== undefined && !activities.has(body.activityId)) throw invalid();
}

function readReceipt(previous, scope, payloadDigest) {
  const owner = previous.receipt.scope;
  if (Object.keys(scope).some(key => owner[key] !== scope[key])) throw scopeChanged();
  if (previous.digest !== payloadDigest) throw conflict("IDEMPOTENCY_CONFLICT", "This request ID was already used with different data.");
  return previous.receipt;
}

async function checkRelease(store, scope, activity, now, finished) {
  const record = await store.get(lessonPath(activity.termId, activity.lessonId));
  const schedule = await scheduleItem(record, scope.classCode, activity.termId, activity.lessonId);
  if (topicAvailability({ locked: schedule.isLocked, date: schedule.scheduledDate }, schoolTodayISO(now)).locked) throw locked();
  const deadline = Date.parse(schedule.activityDeadlineUtc);
  // Previously completed offline work can sync after the deadline. A relock
  // still blocks new writes and a completion past the deadline is rejected.
  if (finished === undefined ? now.getTime() >= deadline : finished > deadline) throw deadlinePassed();
}

async function activityWrite(request, action, body, scope, store, activityStore, now) {
  const keys = writeKeys[action];
  validateKeys(body, keys);
  if (scope.role !== "student" || !scope.classCode) throw forbidden();
  const { requestId, activityId, deviceId, runId, checkpointRevision, checkpoint } = body;
  const activity = activities.get(activityId);
  if (!activity || !validPart(requestId) || !validPart(deviceId) || request.headers.get("Idempotency-Key") !== requestId) throw invalid();
  const start = action === "activity-start", submit = action === "activity-submit";
  if (!start && (!validPart(runId) || !boundedInt(checkpointRevision) || typeof checkpoint !== "string" || checkpoint.length > 100_000)) throw invalid();
  let finished;
  if (submit) {
    finished = completionTime(body.completedAtUtc);
    if (!boundedInt(body.rawMaximum, 1) || !boundedInt(body.rawScore, 0, body.rawMaximum) || typeof body.timedOut !== "boolean" ||
        !Number.isFinite(body.durationSeconds) || body.durationSeconds < 0 || body.durationSeconds * 1000 > maximumOfflineAge) throw invalid();
  }
  const payloadDigest = await digest(keys.map(key => body[key]));
  const ack = { scope, persisted: true, requestId };
  for (let retry = 0; retry < 4; retry++) {
    const previous = await activityStore.receipt(scope.uid, action, requestId);
    if (previous) return readReceipt(previous, scope, payloadDigest);
    const row = await activityStore.run(scope.uid, activityId);
    const item = row?.item;
    if (item && (item.studentId !== scope.profileId || item.classCode !== scope.classCode)) throw scopeChanged();
    if (item && item.deviceId !== deviceId) throw conflict("ATTEMPT_OWNED", "This activity was started on another device.");
    if (!start && (!item || item.runId !== runId)) throw forbidden();
    if (item?.status === "completed") throw completed();
    const updatedAtUtc = new Date(Math.max(now.getTime(), item ? Date.parse(item.updatedAtUtc) + 1 : 0)).toISOString();
    let next, receipt;
    if (start) {
      await checkRelease(store, scope, activity, now);
      next = item ? null : { ...activity, runId: crypto.randomUUID(), studentId: scope.profileId, classCode: scope.classCode,
        deviceId, status: "in_progress", startedAtUtc: updatedAtUtc, completedAtUtc: "", updatedAtUtc,
        checkpointRevision: 0, checkpoint: "", score: 0, maximum: 100, rawScore: 0, rawMaximum: 0, durationSeconds: 0, timedOut: false };
      receipt = { ...ack, item: item || next };
    } else {
      if ((checkpointRevision === item.checkpointRevision && checkpoint !== item.checkpoint) ||
          (submit && checkpointRevision < item.checkpointRevision)) throw conflict("REVISION_CHANGED", "The activity has newer saved progress.");
      if (submit) {
        const started = Date.parse(item.startedAtUtc);
        if (finished < started - clockAllowance || finished > now.getTime() + clockAllowance ||
            now.getTime() - finished > maximumOfflineAge || body.durationSeconds * 1000 > finished - started + clockAllowance) throw invalid();
        await checkRelease(store, scope, activity, now, finished);
        const { rawScore, rawMaximum, durationSeconds, timedOut } = body;
        next = { ...item, status: "completed", completedAtUtc: new Date(finished).toISOString(), updatedAtUtc, checkpointRevision, checkpoint,
          rawScore, rawMaximum, score: Math.round(rawScore * 100 / rawMaximum), durationSeconds, timedOut };
        receipt = { ...ack, ...next };
      } else {
        next = checkpointRevision > item.checkpointRevision ? { ...item, checkpointRevision, checkpoint, updatedAtUtc } : null;
        receipt = { ...ack, activityId, runId, acceptedRevision: (next || item).checkpointRevision };
      }
    }
    const result = await activityStore.commit(scope.uid, action, requestId, payloadDigest, activityId, row?.version, next, receipt);
    if (result) return readReceipt(result, scope, payloadDigest);
  }
  throw unavailable();
}

async function cursorSignature(env, scope, filter, cursor) {
  if (typeof env.WEB_SESSION_SECRET !== "string" || env.WEB_SESSION_SECRET.length < 32) throw unavailable();
  const key = await crypto.subtle.importKey("raw", encoder.encode(env.WEB_SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const data = encoder.encode(JSON.stringify([scope.uid, scope.datasetEpoch, filter.sectionId, filter.studentId, filter.termId, filter.activityId, cursor]));
  return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, data)), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function teacherActivityResults(env, scope, store, activityStore, body) {
  if (!["teacher", "admin"].includes(scope.role)) throw forbidden();
  validateKeys(body, ["sectionId", "studentId", "activityId", "termId", "limit", "cursor"]);
  checkActivityFilter(body);
  const sectionId = await permittedSection(store, scope, body.sectionId);
  if (body.studentId !== undefined) {
    if (!validPart(body.studentId)) throw invalid();
    const student = (await store.get("users/" + body.studentId))?.data;
    if (student?.role !== "student" || student.classCode !== sectionId) throw forbidden();
  }
  if (!boundedInt(body.limit, 1, 100) || typeof body.cursor !== "string" || body.cursor.length > 160) throw invalid();
  let after;
  if (body.cursor) {
    const [updatedAtUtc, runId, signature, extra] = body.cursor.split("~");
    if (extra !== undefined || !validPart(runId) || !signature) throw invalid();
    completionTime(updatedAtUtc);
    if (signature !== await cursorSignature(env, scope, body, updatedAtUtc + "~" + runId)) throw invalid();
    after = { updatedAtUtc, runId };
  }
  const rows = await activityStore.staffResults(body, after);
  const items = rows.slice(0, body.limit);
  let nextCursor = "";
  if (rows.length > items.length) {
    const { updatedAtUtc, runId } = items.at(-1);
    const cursor = updatedAtUtc + "~" + runId;
    nextCursor = cursor + "~" + await cursorSignature(env, scope, body, cursor);
  }
  return { scope, items, nextCursor };
}

export async function mobileApi({ request, env }, dependencies = {}) {
  const url = new URL(request.url);
  const action = url.pathname.match(/^\/api\/mobile\/v1\/([a-z-]+)\/?$/)?.[1];
  const activityEnabled = activityActions.includes(action) && activityStorageDataset(env) !== null;
  if (env.MOBILE_API_ENABLED !== "true" || (!readActions.includes(action) && !activityEnabled)) return json({ code: "NOT_FOUND", error: "Mobile route not found." }, 404);
  if (request.method !== "POST") return json({ code: "INVALID_REQUEST", error: "Use POST." }, 405, { Allow: "POST" });
  if (request.headers.has("Origin") && request.headers.get("Origin") !== url.origin) return json({ code: "FORBIDDEN", error: "Invalid request origin." }, 403);
  if (!request.headers.get("Content-Type")?.toLowerCase().match(/^application\/json(?:\s*;|$)/)) return json({ code: "INVALID_REQUEST", error: "Use JSON." }, 415);
  try {
    const fetcher = dependencies.fetcher || fetch;
    const store = dependencies.store || appStore(env, fetcher);
    const now = dependencies.now?.() || new Date();
    const body = await readJson(request, action === "activity-checkpoint" || action === "activity-submit" ? 610_000 : 8_192);
    const browserStaff = action === reportAction && !request.headers.has("Authorization") && request.headers.has("Cookie");
    const staff = browserStaff ? await requireStaff(request, env, store) : null;
    const identity = staff || await authenticateStudent(request, env, store, { fetcher, now: now.getTime() });
    if (dependencies.rate) await dependencies.rate(identity.uid);
    else {
      if (!env.WEB_LOGIN_STATE) throw unavailable();
      const limit = await stateCall(env, "mobile-api:" + identity.uid, "rate");
      if (limit.status === 429) throw failure("RATE_LIMITED", 429, "Too many requests. Please try again.");
      if (!limit.ok) throw unavailable();
    }
    const row = staff?.row || await linkedProfile(identity, env, store);
    const { scope, section } = await accountScope(request, env, store, row, identity.uid, !browserStaff);
    if (action === "me") {
      validateKeys(body, []);
      return json(await profileResponse(scope, row, section, identity.email));
    }
    if (action === "schedules") return json(await scheduleResponse(store, scope, body, now));
    const activityStore = dependencies.activityStore || new MobileActivityStore(env, fetcher);
    if (action === reportAction) return json(await teacherActivityResults(env, scope, store, activityStore, body));
    if (action === "activity-results") {
      validateKeys(body, ["termId", "activityId"]);
      checkActivityFilter(body);
      if (scope.role !== "student" || !scope.classCode) throw forbidden();
      const items = await activityStore.studentResults(scope, body);
      return json({ scope, items, revision: await digest(items.map(item => [item.runId, item.updatedAtUtc, item.checkpointRevision, item.status])) });
    }
    return json(await activityWrite(request, action, body, scope, store, activityStore, now));
  } catch (error) {
    const problem = error.code && error.status && error.status < 500 ? error :
      error.status === 400 || error.status === 413 ? invalid() :
      error.status === 401 ? failure("UNAUTHENTICATED", 401, "Sign in again to continue.") :
      error.status === 403 ? forbidden() : unavailable();
    const extra = problem.status === 429 ? { "Retry-After": "60" } : {};
    return json({ code: problem.code, error: problem.message, ...(problem.status === 429 ? { retryAfterSeconds: 60 } : {}) }, problem.status, extra);
  }
}
