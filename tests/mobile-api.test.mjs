import { test } from "node:test";
import assert from "node:assert/strict";
import { mobileApi } from "../server/mobile-api.js";
import { DashboardSummary } from "../server/dashboard-summary.js";

const requestTime = Date.parse("2026-11-07T04:00:00.000Z");
const lessonPath = "terms/term_01/lessons/lesson_01";
const receipt = "a".repeat(64);
const receiptHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(receipt))),
  byte => byte.toString(16).padStart(2, "0")).join("");

function fixture() {
  let clock = requestTime;
  const env = { MOBILE_API_ENABLED: "true", MOBILE_ACTIVITY_STAGING_ENABLED: "true", TEACHER_SESSION_SYNC_ENABLED: "true",
    WEB_SESSION_SECRET: "unit-test-secret-".repeat(3), IMARS_MOBILE_DATASET_EPOCH: "test" };
  const records = new Map(Object.entries({
    "users/S1": { uid: "first", role: "student", classCode: "A", fullName: "Student One", secret: "private",
      gamification: { totalPoints: 5, badgeCounts: { AccuracyBadgeCount: 2 } } },
    "users/S2": { uid: "second", role: "student", classCode: "B" },
    "users/T1": { uid: "teacher", role: "teacher", fullName: "Teacher" },
    "classes/A": { teacherId: "T1", SectionName: "Section A" },
    "classes/B": { teacherId: "T2", SectionName: "Section B" },
    "users/T2": { uid: "other_teacher", role: "teacher" },
    "_accountAccess/teacher/sessions/teacher": { uid: "teacher", profileId: "T1", schemaVersion: 1, platform: "mobile", mobileReceiptHash: receiptHash },
    [lessonPath]: { title: "States of Matter", isLocked: false,
      sectionSchedules: { A: { isLocked: false, scheduledDate: "", activityDeadlineUtc: "2026-11-07T04:05:00Z" }, B: { isLocked: true } } }
  }));
  const row = path => records.has(path) ? { id: path.split("/").at(-1), data: records.get(path) } : null;
  const store = {
    begin: async () => {},
    commit: async writes => {
      for (const { path, data, merge } of writes) records.set(path, { ...(merge ? records.get(path) : {}), ...data });
    },
    get: async path => row(path),
    getAll: async paths => new Map(paths.map(path => [path, row(path)])),
    query: async (collection, { filters = [], limit = 5000, after } = {}) => [...records.keys()]
      .filter(path => path.startsWith(collection + "/") && path.split("/").length === collection.split("/").length + 1 &&
        (!after || path.split("/").at(-1) > after) && filters.every(filter => records.get(path)[filter.field] === filter.value))
      .sort().slice(0, limit).map(row),
    identity: async uid => ({ emailVerified: true, email: uid + "@example.test" })
  };
  const saved = new Map(), results = new Map();
  const receiptKey = (uid, action, requestId) => [uid, action, requestId].join("/");
  const activityStore = {
    receipt: async (...keys) => saved.get(receiptKey(...keys)),
    run: async (uid, activityId) => results.get(uid + "/" + activityId),
    commit: async (uid, action, requestId, digest, activityId, version, item, response) => {
      const key = receiptKey(uid, action, requestId), run = uid + "/" + activityId;
      if (saved.has(key)) return saved.get(key);
      if (version !== results.get(run)?.version) return null;
      if (item) results.set(run, { item, version: crypto.randomUUID() });
      const record = { digest, receipt: response };
      saved.set(key, record);
      return record;
    },
    studentResults: async scope => [...results.values()].map(row => row.item).filter(item => item.studentId === scope.profileId && item.classCode === scope.classCode),
    staffResults: async ({ sectionId }) => [...results.values()].map(row => row.item).filter(item => item.classCode === sectionId && item.status === "completed")
      .map(item => ({ ...item, checkpoint: "" }))
  };
  const fetcher = async (_url, options) => {
    const token = JSON.parse(options.body).idToken;
    const { sub } = JSON.parse(Buffer.from(token.split(".")[1], "base64url"));
    return Response.json({ users: [{ localId: sub, emailVerified: true }] });
  };
  const encode = data => Buffer.from(JSON.stringify(data)).toString("base64url");
  const token = uid => `${encode({ alg: "RS256", kid: "stub" })}.${encode({ aud: "imars-db-a733b",
    iss: "https://securetoken.google.com/imars-db-a733b", sub: uid, exp: requestTime / 1000 + 7200,
    iat: requestTime / 1000 - 10, auth_time: requestTime / 1000 - 10, email_verified: true })}.mock`;
  async function post(action, body = {}, uid = "first", headers = {}) {
    const request = new Request("https://test.example/api/mobile/v1/" + action, { method: "POST", headers: {
      "Content-Type": "application/json", ...(uid ? { Authorization: "Bearer " + token(uid) } : {}),
      ...(body.requestId ? { "Idempotency-Key": body.requestId } : {}), ...headers
    }, body: JSON.stringify(body) });
    const response = await mobileApi({ request, env }, { store, activityStore, fetcher, rate: async () => {}, now: () => new Date(clock) });
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    return { status: response.status, ...(await response.json()) };
  }
  return { env, post, records, results, store, at: time => { clock = Date.parse(time); } };
}

async function recentActivity(app) {
  const values = new Map();
  const storage = {
    get: async key => structuredClone(values.get(key)),
    put: async (key, value) => { values.set(key, structuredClone(value)); },
    delete: async key => values.delete(key),
    getAlarm: async () => null,
    setAlarm: async () => {},
    list: async ({ prefix, limit, startAfter }) => new Map([...values]
      .filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter))
      .sort(([a], [b]) => a.localeCompare(b)).slice(0, limit))
  };
  const dashboard = new DashboardSummary(storage, {}, { store: app.store });
  const scope = { id: "T1", uid: "teacher", sections: [{ id: "A", name: "Section A" }] };
  await dashboard.configure(scope);
  for (let step = 0; step < 30 && await storage.get("dashboard:job"); step++) await dashboard.step();
  assert.equal(await storage.get("dashboard:job"), undefined, "summary preparation must finish");
  return (await dashboard.read(scope)).summary;
}

function loginOnlyPeer(app) {
  Object.assign(app.records.get("users/S2"), { classCode: "A", lastLogin: "2026-11-07T04:00:00Z" });
}

test("BFF recent activity includes synced learning and excludes a login-only classmate", async () => {
  const app = fixture(); loginOnlyPeer(app);
  assert.equal((await app.post("me", {}, "second")).status, 200);
  assert.deepEqual((await recentActivity(app)).recent, []);
  Object.assign(app.env, { IMARS_SUPABASE_WEB_DATA: "true", MOBILE_ACTIVITY_STAGING_ENABLED: "false",
    MOBILE_ACTIVITY_PRODUCTION_ENABLED: "true", IMARS_MOBILE_DATASET_EPOCH: "mobile-production-v1" });
  const body = { requestId: "phone-term_01-lesson_01-1", deviceId: "phone", revision: 1,
    termId: "term_01", lessonId: "lesson_01", expectedClassCode: "A", expectedTeacherProfileId: "T1",
    lessonSeconds: 60, arSeconds: 120, arNavigationSeconds: 0, lessonDone: true, lessonOpened: true, arDone: true };
  const saved = await app.post("lesson-progress", body);
  assert.equal(saved.status, 200); assert.equal(saved.persisted, true);
  assert.equal((await app.post("lesson-progress", body)).persisted, true);
  const summary = await recentActivity(app);
  assert.equal(summary.total, 2);
  assert.deepEqual(summary.recent.map(row => row.id), ["S1"]);
  assert.equal(summary.arMinutes, 2, "sync retry must not double-count learning time");
});

test("BFF recent activity includes a newly submitted activity without lesson-progress sync", async () => {
  const app = fixture(); loginOnlyPeer(app);
  Object.assign(app.env, { IMARS_SUPABASE_WEB_DATA: "true", MOBILE_ACTIVITY_STAGING_ENABLED: "false",
    MOBILE_ACTIVITY_PRODUCTION_ENABLED: "true", IMARS_MOBILE_DATASET_EPOCH: "mobile-production-v1" });
  assert.equal((await app.post("me", {}, "second")).status, 200);
  const activityId = "states-of-matter", deviceId = "phone";
  const start = await app.post("activity-start", { requestId: "recent-start", activityId, deviceId });
  assert.equal(start.status, 200);
  app.at("2026-11-07T04:02:00Z");
  const result = await app.post("activity-submit", { requestId: "recent-submit", activityId, deviceId,
    runId: start.item.runId, checkpointRevision: 1, checkpoint: "", rawScore: 4, rawMaximum: 5,
    durationSeconds: 90, timedOut: false, completedAtUtc: "2026-11-07T04:01:30Z" });
  assert.equal(result.persisted, true); assert.equal(result.score, 80);
  assert.equal((await app.post("activity-results")).items.length, 1);
  assert.deepEqual((await recentActivity(app)).recent.map(row => row.id), ["S1"]);
});

test("a submission retry repairs a failed completion marker without changing lesson scores", async () => {
  const app = fixture();
  Object.assign(app.env, { IMARS_SUPABASE_WEB_DATA: "true", MOBILE_ACTIVITY_STAGING_ENABLED: "false",
    MOBILE_ACTIVITY_PRODUCTION_ENABLED: "true", IMARS_MOBILE_DATASET_EPOCH: "mobile-production-v1",
    DASHBOARD_SUMMARIES_ENABLED: "true" });
  const dirty = [];
  app.env.WEB_LOGIN_STATE = { idFromName: name => name, get: name => ({ fetch: async (url, options) => {
    dirty.push({ name, action: new URL(url).pathname, body: JSON.parse(options.body) });
    return Response.json({ ok: true });
  } }) };
  const activityId = "states-of-matter", deviceId = "phone";
  const start = await app.post("activity-start", { requestId: "retry-start", activityId, deviceId });
  assert.equal(start.status, 200);
  const path = "users/S1/test_results/term_01/lessons/lesson_01";
  const original = { preTestScore: 2, activityScore: 95, arTimeMinutes: 3 };
  app.records.set(path, original);
  app.at("2026-11-07T04:02:00Z");
  const body = { requestId: "retry-submit", activityId, deviceId, runId: start.item.runId,
    checkpointRevision: 1, checkpoint: "", rawScore: 4, rawMaximum: 5,
    durationSeconds: 90, timedOut: false, completedAtUtc: "2026-11-07T04:01:30Z" };
  const commit = app.store.commit;
  app.store.commit = async () => { throw new Error("Temporary outage"); };
  assert.equal((await app.post("activity-submit", body)).status, 503);
  assert.equal(app.results.size, 1);
  app.store.commit = commit;
  const saved = await app.post("activity-submit", body);
  assert.equal(saved.persisted, true);
  assert.deepEqual(app.records.get(path), { ...original, activityCompletedAt: saved.completedAtUtc });
  assert.deepEqual(await app.post("activity-submit", body), saved);
  assert.deepEqual(dirty[0], { name: "dashboard:teacher", action: "/dashboard-dirty",
    body: { ids: ["S1"], lesson: "term_01/lessons/lesson_01" } });
});

test("syncing an unchanged learning revision preserves the last meaningful activity time", async () => {
  const app = fixture();
  Object.assign(app.env, { IMARS_SUPABASE_WEB_DATA: "true", MOBILE_ACTIVITY_STAGING_ENABLED: "false",
    MOBILE_ACTIVITY_PRODUCTION_ENABLED: "true", IMARS_MOBILE_DATASET_EPOCH: "mobile-production-v1" });
  const payload = revision => ({ requestId: `phone-term_01-lesson_01-${revision}`, deviceId: "phone", revision,
    termId: "term_01", lessonId: "lesson_01", expectedClassCode: "A", expectedTeacherProfileId: "T1",
    lessonSeconds: 60, arSeconds: 0, arNavigationSeconds: 0, lessonDone: false, lessonOpened: true, arDone: false });
  const first = await app.post("lesson-progress", payload(1));
  assert.equal(first.status, 200);
  app.at("2026-11-07T04:04:00Z");
  const second = await app.post("lesson-progress", payload(2));
  assert.equal(second.status, 200);
  assert.equal(second.item.updatedAtUtc, first.item.updatedAtUtc);
});

test("learning-time sync saves and updates Terms 1, 2 and 3 independently", async () => {
  const app = fixture();
  Object.assign(app.env, { IMARS_SUPABASE_WEB_DATA: "true", MOBILE_ACTIVITY_STAGING_ENABLED: "false",
    MOBILE_ACTIVITY_PRODUCTION_ENABLED: "true", IMARS_MOBILE_DATASET_EPOCH: "mobile-production-v1" });
  for (const revision of [1, 2]) for (const [index, termId] of ["term_01", "term_02", "term_03"].entries()) {
    const seconds = 60 * (index + 1) * revision;
    const saved = await app.post("lesson-progress", { requestId: `phone-${termId}-lesson_01-${revision}`, deviceId: "phone", revision,
      termId, lessonId: "lesson_01", expectedClassCode: "A", expectedTeacherProfileId: "T1",
      lessonSeconds: seconds, arSeconds: 0, arNavigationSeconds: 0, lessonDone: false, lessonOpened: true, arDone: false });
    assert.equal(saved.persisted, true, termId);
    assert.equal(saved.item.termId, termId);
    assert.equal(saved.item.lessonTimeMinutes, (index + 1) * revision);
  }
  const result = await app.post("progress");
  assert.deepEqual(result.items.map(item => [item.termId, item.lessonTimeMinutes]), [["term_01", 2], ["term_02", 4], ["term_03", 6]]);
});

test("BFF recent activity excludes an empty progress sync with no learning", async () => {
  const app = fixture(); loginOnlyPeer(app);
  Object.assign(app.env, { IMARS_SUPABASE_WEB_DATA: "true", MOBILE_ACTIVITY_STAGING_ENABLED: "false",
    MOBILE_ACTIVITY_PRODUCTION_ENABLED: "true", IMARS_MOBILE_DATASET_EPOCH: "mobile-production-v1" });
  const saved = await app.post("lesson-progress", { requestId: "phone-term_01-lesson_01-1", deviceId: "phone", revision: 1,
    termId: "term_01", lessonId: "lesson_01", expectedClassCode: "A", expectedTeacherProfileId: "T1",
    lessonSeconds: 0, arSeconds: 0, arNavigationSeconds: 0, lessonDone: false, lessonOpened: false, arDone: false });
  assert.equal(saved.status, 200); assert.equal(saved.persisted, true);
  assert.deepEqual((await recentActivity(app)).recent, []);
});

test("mobile profile and schedule are scoped to the verified Firebase account", async () => {
  const { post, records } = fixture();
  assert.equal((await post("me", {}, "")).code, "UNAUTHENTICATED");
  const me = await post("me");
  assert.equal(me.scope.classCode, "A");
  assert.equal(me.profile.displayName, "Student One");
  assert.equal(me.profile.sectionName, "Section A");
  assert.equal(me.achievements.badgeCounts.AccuracyBadgeCount, 2);
  assert.equal(me.profile.secret, undefined);
  const before = await post("schedules", { termId: "term_01" });
  assert.equal(before.items.length, 4);
  assert.equal(before.items[0].activityDeadlineUtc, "2026-11-07T04:05:00Z");
  assert.equal(before.items[1].isLocked, true);
  assert.equal((await post("schedules", { sectionId: "B" })).status, 403);
  assert.equal((await post("schedules", { termId: "term_01" }, "second")).items[0].isLocked, true);
  records.get(lessonPath).sectionSchedules.A.activityDeadlineUtc = "bad";
  const after = await post("schedules", { termId: "term_01" });
  assert.notEqual(before.revision, after.revision);
  assert.equal(after.items[0].isLocked, true);
  assert.equal((await post("schedules", { sectionId: "A" }, "teacher")).code, "SESSION_REVOKED");
});

test("learning time adds revisits without changing scores or counting a retry twice", async () => {
  const { env, post, records } = fixture();
  const path = "users/S1/test_results/term_01/lessons/lesson_01";
  records.set(path, { preTestScore: 2, postTestScore: 8, arTimeMinutes: 3,
    learningTimeByDevice: { oldDevice: { lessonSeconds: 120 } } });
  records.set(path.replace("S1", "S2"), { postTestScore: 9 });
  const payload = (revision, lessonSeconds, arSeconds, deviceId = "phone") => ({
    requestId: `${deviceId}-term_01-lesson_01-${revision}`, termId: "term_01", lessonId: "lesson_01", deviceId, revision,
    expectedClassCode: "A", expectedTeacherProfileId: "T1", lessonSeconds, arSeconds, arNavigationSeconds: 0,
    lessonDone: true, lessonOpened: true, arDone: true
  });
  assert.equal((await post("lesson-progress", payload(1, 60, 120))).status, 404);
  Object.assign(env, { IMARS_SUPABASE_WEB_DATA: "true", MOBILE_ACTIVITY_STAGING_ENABLED: "false",
    MOBILE_ACTIVITY_PRODUCTION_ENABLED: "true", IMARS_MOBILE_DATASET_EPOCH: "mobile-production-v1" });
  assert.equal((await post("lesson-progress", payload(1, 60, 120), "")).status, 401);
  const first = await post("lesson-progress", payload(1, 60, 120));
  assert.equal(first.status, 200);
  assert.equal(first.item.lessonTimeMinutes, 3);
  assert.equal(first.item.arTimeMinutes, 5);
  assert.equal((await post("lesson-progress", payload(1, 60, 120))).item.arTimeMinutes, 5);
  assert.equal((await post("lesson-progress", payload(1, 60, 121))).code, "IDEMPOTENCY_CONFLICT");
  assert.equal((await post("lesson-progress", payload(2, 180, 180))).item.lessonTimeMinutes, 5);
  assert.equal((await post("lesson-progress", payload(1, 60, 120))).acceptedRevision, 2);
  assert.equal((await post("lesson-progress", payload(1, 60, 60, "tablet"))).item.arTimeMinutes, 7);
  assert.equal((await post("lesson-progress", { ...payload(3, 200, 200), postTestScore: 10 })).status, 400);
  assert.equal((await post("lesson-progress", payload(3, 200, 200), "second")).code, "SCOPE_CHANGED");
  const { items } = await post("progress");
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].lessonTimeMinutes, items[0].arTimeMinutes, items[0].preTestScore, items[0].postTestScore], [6, 7, 2, 8]);
  assert.equal(items[0].learningTimeByDevice, undefined);
});

test("activity retry, monotonic checkpoints, offline submission and teacher report share one run", async () => {
  const { post, at, records, results } = fixture();
  const activityId = "states-of-matter", deviceId = "device-1";
  const start = { requestId: "reserve", activityId, deviceId };
  assert.equal((await post("activity-start", start, "first", { "Idempotency-Key": "wrong" })).code, "INVALID_REQUEST");
  const [first, replay] = await Promise.all([post("activity-start", start), post("activity-start", start)]);
  assert.equal(first.status, 200);
  assert.deepEqual(first, replay);
  const { runId } = first.item;
  assert.equal((await post("activity-start", { ...start, requestId: "reserve2", deviceId: "device-2" })).code, "ATTEMPT_OWNED");
  const checkpoint = { requestId: "cp2", activityId, deviceId, runId, checkpointRevision: 2, checkpoint: "private progress" };
  assert.equal((await post("activity-checkpoint", checkpoint, "second")).code, "FORBIDDEN");
  assert.equal((await post("activity-checkpoint", checkpoint)).acceptedRevision, 2);
  assert.equal((await post("activity-checkpoint", { ...checkpoint, requestId: "cp1", checkpointRevision: 1 })).acceptedRevision, 2);
  const submit = { ...checkpoint, requestId: "submit", rawScore: 4, rawMaximum: 5, durationSeconds: 90, timedOut: false,
    completedAtUtc: "2026-11-07T04:02:30.0000000Z" };
  at("2026-11-07T04:07:00Z");
  assert.equal((await post("activity-submit", { ...submit, completedAtUtc: "2026-11-07T04:06:00Z" })).code, "DEADLINE_PASSED");
  const result = await post("activity-submit", submit);
  assert.equal(result.status, "completed");
  assert.equal(result.score, 80);
  assert.equal(result.persisted, true);
  assert.deepEqual(await post("activity-submit", submit), result);
  assert.equal(records.get("users/S1/test_results/term_01/lessons/lesson_01"), undefined,
    "staging submissions must not project completion into the application dataset");
  assert.equal((await post("activity-submit", { ...submit, rawScore: 3 })).code, "IDEMPOTENCY_CONFLICT");
  assert.equal((await post("activity-submit", { ...submit, requestId: "submit2" })).code, "ALREADY_COMPLETED");
  assert.equal((await post("activity-results")).items.length, 1);
  const page = await post("staff-activity-results", { sectionId: "A", limit: 20, cursor: "" }, "teacher", { "X-Imars-Mobile-Session": receipt });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].runId, runId);
  assert.equal(page.items[0].checkpoint, "");
  assert.equal((await post("staff-activity-results", { sectionId: "B", limit: 20, cursor: "" }, "teacher", { "X-Imars-Mobile-Session": receipt })).status, 403);
  records.get("users/S1").classCode = "B";
  assert.equal((await post("activity-submit", submit)).code, "SCOPE_CHANGED");
  assert.equal(results.size, 1);
});

test("the activity deadline closes unfinished attempts and keeps an earlier completed result", async () => {
  const { post, at, records } = fixture();
  records.set("users/S3", { uid: "third", role: "student", classCode: "A" });
  const activityId = "states-of-matter", deviceId = "device-1";
  at("2026-11-07T04:04:58Z");
  const first = await post("activity-start", { requestId: "first-run", activityId, deviceId });
  const unfinished = await post("activity-start", { requestId: "third-run", activityId, deviceId }, "third");
  assert.equal(first.status, 200);
  assert.equal(unfinished.status, 200);
  const result = await post("activity-submit", { requestId: "first-submit", activityId, deviceId, runId: first.item.runId,
    checkpointRevision: 1, checkpoint: "", rawScore: 4, rawMaximum: 5, durationSeconds: 1, timedOut: false,
    completedAtUtc: "2026-11-07T04:04:59.000Z" });
  assert.equal(result.persisted, true);
  at("2026-11-07T04:05:00Z");
  assert.equal((await post("activity-start", { requestId: "third-resume", activityId, deviceId }, "third")).code, "DEADLINE_PASSED");
  assert.equal((await post("activity-results")).items[0].status, "completed");
  assert.equal((await post("activity-results")).items[0].score, 80);
});
