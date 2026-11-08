import { test } from "node:test";
import assert from "node:assert/strict";
import { mobileApi } from "../server/mobile-api.js";

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
    get: async path => row(path),
    getAll: async paths => new Map(paths.map(path => [path, row(path)])),
    query: async (_path, { filters }) => [...records.keys()].filter(path => path.startsWith("users/") && records.get(path).uid === filters[0].value).map(row),
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
  return { env, post, records, results, at: time => { clock = Date.parse(time); } };
}

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
