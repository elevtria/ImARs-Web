import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mobileApi } from "../server/mobile-api.js";
import { webData } from "../server/web-data.js";
import { fixture } from "./fixtures/web-data.js";
import { activityStorageDataset, MobileActivityStore } from "../server/mobile-activity-store.js";

const project = { IMARS_SUPABASE_URL: "https://test.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test" };
const production = { MOBILE_ACTIVITY_PRODUCTION_ENABLED: "true", IMARS_MOBILE_DATASET_EPOCH: "mobile-production-v1" };
const staging = { MOBILE_ACTIVITY_STAGING_ENABLED: "true" };

test("production activity routes reject ambiguous or missing deployment settings", async () => {
  const url = "https://example.test/api/mobile/v1/activity-results";
  for (const env of [{}, { MOBILE_ACTIVITY_PRODUCTION_ENABLED: "true" }, { ...production, ...staging }]) {
    assert.equal(activityStorageDataset(env), null);
    const request = new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const response = await mobileApi({ request, env: { ...env, MOBILE_API_ENABLED: "true" } });
    assert.equal(response.status, 404);
  }
});

for (const [mode, settings] of [["staging", staging], ["production", production]]) {
  test(`${mode} activity reads and writes use the isolated dataset`, async () => {
    const resources = [];
    const store = new MobileActivityStore({ ...project, ...settings }, async (url, options) => {
      resources.push(url.pathname);
      return Response.json(options.method === "GET" ? [] : null);
    });
    await store.run("uid", "states-of-matter");
    await store.receipt("uid", "activity-start", "request");
    await store.studentResults({ uid: "uid", profileId: "student", classCode: "class" }, {});
    await store.staffResults({ sectionId: "class", limit: 1 });
    assert.equal(await store.commit("uid", "activity-start", "request", "digest", "states-of-matter", null, null, {}), null);
    assert.deepEqual(resources, [
      `/rest/v1/imars_mobile_${mode}_runs`, `/rest/v1/imars_mobile_${mode}_receipts`,
      `/rest/v1/imars_mobile_${mode}_runs`, `/rest/v1/imars_mobile_${mode}_runs`, `/rest/v1/rpc/imars_mobile_${mode}_commit`
    ]);
  });
}

test("production web report projects only the selected roster's activity grades alongside lesson scores", async () => {
  const app = fixture();
  const cookie = await app.login();
  const profile = [...app.data.entries()].find(([, row]) => row.role === "student" && row.classCode === "A");
  assert.ok(profile);
  const studentId = profile[0].split("/").at(-1);
  const path = profile[0] + "/test_results/term_01/lessons/lesson_01";
  app.data.set(path, { preTestScore: 4, isPreTestCompleted: true, activityTotalQuestions: 5 });
  let reads = 0;
  const activityFetcher = async url => {
    reads++;
    assert.equal(url.pathname, "/rest/v1/imars_mobile_production_runs");
    assert.equal(url.searchParams.get("section_id"), "eq.A");
    assert.equal(url.searchParams.get("term_id"), "in.(term_01)");
    assert.ok(url.searchParams.get("student_id").slice(4, -1).split(",").includes(studentId));
    return Response.json([{ studentId, termId: "term_01", lessonId: "lesson_01", score: 80, maximum: 100, rawScore: 4, rawMaximum: 5 }]);
  };
  const env = { ...app.env, ...project, ...production, MOBILE_API_ENABLED: "true" };
  const request = app.request("/api/web-data", { action: "teacher-report-page", termId: "term_01",
    sectionId: "A", includeCurriculum: false, rawActivityScores: true }, cookie);
  const response = await webData({ request, env }, { store: app.store, activityFetcher });
  assert.equal(response.status, 200);
  const report = await response.json();
  const fields = report.students.find(row => row.document.id === studentId).lessons.find(row => row.id === "lesson_01").data;
  assert.equal(fields.preTestScore, 4);
  assert.equal(fields.activityScore, 80);
  assert.equal(fields.activityTotalQuestions, 100);
  assert.equal(fields.activityRawScore, 4);
  assert.equal(fields.activityRawMaximum, 5);
  assert.equal(app.data.get(path).activityTotalQuestions, 5);
  assert.equal(reads, 1);
});

test("teacher report reads copied mobile grades without enabling mobile writes", async () => {
  const app = fixture(), cookie = await app.login();
  const studentId = "0026271000";
  const result = { activityId: "food-web", score: 50, maximum: 100, completedAtUtc: "2026-11-01T12:00:00Z" };
  let reads = 0;
  app.store.activityResultsForRoster = async ids => {
    reads++;
    assert.deepEqual(ids, [studentId]);
    return [
      { studentId, data: result },
      { studentId, data: { ...result, score: 0, completedAtUtc: "2026-11-02T12:00:00Z" } },
      { studentId, data: { ...result, score: 100, status: "in_progress", completedAtUtc: "2026-11-03T12:00:00Z" } },
      { studentId, data: { ...result, score: 100, classCode: "B", completedAtUtc: "2026-11-03T12:00:00Z" } },
      { studentId, data: { ...result, score: 100, uid: "other-user", completedAtUtc: "2026-11-03T12:00:00Z" } },
      { studentId: "0026271001", data: result }
    ];
  };
  const body = { action: "teacher-report-page", termId: "term_02", sectionId: "A", includeCurriculum: false };
  const response = await app.call(body, cookie);
  assert.equal(response.status, 200);
  const { students } = await response.json();
  assert.equal(students.length, 1);
  assert.equal(students[0].lessons[0].id, "lesson_01");
  assert.deepEqual(students[0].lessons[0].data, { activityScore: 0, activityTotalQuestions: 100, activityTotalPoints: 100 });
  assert.equal((await app.call({ ...body, heatmapLesson: "lesson_01" }, cookie)).status, 200);
  assert.equal(reads, 1, "the post-test heatmap does not query activity scores");
});

test("newer legacy submissions are scoped to the roster and saved grades survive an outage", async () => {
  const app = fixture(), cookie = await app.login();
  const studentId = "0026271000";
  const data = { activityId: "food-web", score: 40, maximum: 100, completedAtUtc: "2026-11-01T12:00:00Z" };
  app.store.activityResultsForRoster = async ids => {
    assert.deepEqual(ids, [studentId]);
    return [{ studentId, data }];
  };
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" } });
  const env = { ...app.env, IMARS_SUPABASE_WEB_DATA: "true", WEB_LEGACY_ACTIVITY_READS_ENABLED: "true",
    FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({ project_id: "imars-db-a733b", client_email: "test@imars-db-a733b.iam.gserviceaccount.com", private_key: privateKey }) };
  let outage = false;
  const fetcher = async (input, options) => {
    const url = new URL(input);
    if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "test-token", expires_in: 3600 });
    assert.equal(url.hostname, "firestore.googleapis.com");
    const query = JSON.parse(options.body).structuredQuery;
    assert.deepEqual(query.from, [{ collectionId: "activity_results", allDescendants: true }]);
    const bounds = query.where.compositeFilter.filters.map(item => item.fieldFilter.value.referenceValue);
    assert.ok(bounds.every(bound => bound.includes("/users/" + studentId + "/activity_results/")));
    if (outage) return Response.json({}, { status: 503 });
    return Response.json([{ document: { name: bounds[0].replace(/-$/, "food-web"), fields: {
      activityId: { stringValue: "food-web" }, score: { integerValue: "85" }, maximum: { integerValue: "100" },
      completedAtUtc: { stringValue: "2026-11-02T12:00:00Z" }
    } } }]);
  };
  const getReport = async () => {
    const request = app.request("/api/web-data", { action: "teacher-report-page", termId: "term_02", sectionId: "A", includeCurriculum: false }, cookie);
    const response = await webData({ request, env }, { store: app.store, legacyActivityFetcher: fetcher });
    assert.equal(response.status, 200);
    const report = await response.json();
    return { score: report.students[0].lessons[0].data.activityScore, pending: report.activitySyncPending };
  };
  assert.deepEqual(await getReport(), { score: 85, pending: undefined });
  outage = true;
  assert.deepEqual(await getReport(), { score: 40, pending: true });
});
