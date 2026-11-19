import test from "node:test";
import assert from "node:assert/strict";
import { SupabaseAppStore } from "../server/supabase-app-store.js";
import { encodeFields } from "../server/firestore-admin.js";
import { fixture } from "./fixtures/web-data.js";

function setup() {
  const app = fixture(), legacy = new Map(), reads = [];
  const store = new SupabaseAppStore({ IMARS_SUPABASE_URL: "https://fixture.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test",
    IMARS_SUPABASE_APP_DATASET_ID: "a176e0fd-0b7e-4840-99c5-413452160b6a", WEB_LEGACY_LESSON_READS_ENABLED: "true" },
    async () => { throw new Error("Unexpected network request"); });
  const profile = "users/0026271000";
  legacy.set(profile, { ...app.data.get(profile) });
  store.rawDocuments = async (paths, fields) => new Map(paths.filter(path => app.data.has(path)).map(path => {
    const values = encodeFields(app.data.get(path));
    return [path, { path, update_time: "2026-11-01T00:00:00Z", ...(fields
      ? Object.fromEntries(fields.filter(field => Object.hasOwn(values, field)).map(field => [field, values[field]])) : { fields: values }) }];
  }));
  store.legacyLessons = { getAll: async (paths, options) => {
    reads.push({ paths, options });
    return new Map(paths.map(path => [path, legacy.has(path) ? {
      id: path.split("/").at(-1), data: structuredClone(legacy.get(path)), wire: structuredClone(legacy.get(path)),
      updateTime: "2026-11-19T00:00:00Z"
    } : null]));
  } };
  const original = app.store.getAll.bind(app.store);
  app.store.getAll = (paths, options) => paths.some(path => path.includes("/test_results/")) ? store.getAll(paths, options) : original(paths, options);
  app.data.get("users/TEACH1000").authEmailVerified = true;
  const query = termId => ({ action: "reads", reads: [{ action: "query", reference: {
    kind: "query", path: `${profile}/test_results/${termId}/lessons`
  } }] });
  return { app, store, legacy, reads, profile, query };
}

for (const termId of ["term_01", "term_02", "term_03"]) test(`${termId}: mobile-only learning records and added minutes reach Student Records and Analytics`, async () => {
  const { app, legacy, reads, profile, query } = setup(), cookie = await app.login();
  const path = `${profile}/test_results/${termId}/lessons/lesson_01`;
  const mobile = { isPreTestCompleted: true, preTestScore: 2, preTestTotalQuestions: 5,
    isPostTestCompleted: true, postTestScore: 8, postTestTotalQuestions: 10, lessonTimeMinutes: 3, arTimeMinutes: 2 };
  legacy.set(path, mobile);
  const first = await app.call(query(termId), cookie);
  assert.equal(first.status, 200);
  const document = (await first.json()).results[0].documents[0];
  assert.equal(document.id, "lesson_01"); assert.deepEqual(document.data, mobile);
  legacy.set(path, { ...mobile, lessonTimeMinutes: 13, arTimeMinutes: 7 });
  const updated = await app.call(query(termId), cookie);
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).results[0].documents[0].data.lessonTimeMinutes, 13);
  const report = await app.call({ action: "teacher-report-page", termId, sectionId: "A", includeCurriculum: false, rawActivityScores: true }, cookie);
  assert.equal(report.status, 200);
  const lesson = (await report.json()).students[0].lessons.find(row => row.id === "lesson_01");
  assert.equal(lesson.data.preTestScore, 2); assert.equal(lesson.data.postTestScore, 8);
  assert.equal(lesson.data.isPreTestCompleted, true); assert.equal(lesson.data.isPostTestCompleted, true);
  assert.ok(reads.flatMap(read => read.paths).every(path => path === profile || path.startsWith(`${profile}/test_results/${termId}/`)));
  assert.ok(reads.every(read => read.paths.length <= 100));
  assert.equal(app.data.has(path), false, "displaying progress does not overwrite either database");
});

test("seeded website zeroes do not hide mobile completions, and teacher corrections stay authoritative", async () => {
  const { app, store, legacy, profile } = setup(), path = `${profile}/test_results/term_01/lessons/lesson_01`;
  app.data.set(path, { isPreTestCompleted: false, preTestScore: 0, preTestTotalQuestions: 5,
    lessonTimeMinutes: 0, teacherScoreOverrides: { post: { score: 0, maximum: 10 } } });
  legacy.set(path, { isPreTestCompleted: true, preTestScore: 3, preTestTotalQuestions: 5,
    isPostTestCompleted: true, postTestScore: 9, postTestTotalQuestions: 10, lessonTimeMinutes: 5, password: "private" });
  const result = (await store.getAll([path])).get(path).data;
  assert.equal(result.preTestScore, 3); assert.equal(result.isPreTestCompleted, true);
  assert.equal(result.postTestScore, 0); assert.equal(result.isPostTestCompleted, true);
  assert.equal(result.lessonTimeMinutes, 5); assert.equal(result.password, undefined);
  const projected = (await store.getAll([path], { fieldPaths: ["preTestScore", "postTestScore", "lessonTimeMinutes"] })).get(path);
  assert.deepEqual(projected.data, { preTestScore: 3, postTestScore: 0, lessonTimeMinutes: 5 });
});

test("different mobile account bindings or sections cannot supply a student's lesson records", async () => {
  for (const changes of [{ uid: "someone-else" }, { classCode: "B" }, { schoolId: "OTHER" }]) {
    const { store, legacy, profile, reads } = setup(), path = `${profile}/test_results/term_01/lessons/lesson_01`;
    Object.assign(legacy.get(profile), changes);
    legacy.set(path, { preTestScore: 5 });
    assert.equal((await store.getAll([path])).get(path), null);
    assert.ok(reads.every(read => read.paths.every(path => !path.includes("/test_results/"))));
  }
});

test("device-recorded learning time is not hidden by an imported zero-minute seed", async () => {
  const { app, store, legacy, profile } = setup(), path = `${profile}/test_results/term_02/lessons/lesson_01`;
  app.data.set(path, { lessonTimeMinutes: 0, arTimeMinutes: 0 });
  legacy.set(path, { learningTimeByDevice: { phone: { lessonSeconds: 180, arSeconds: 120 } } });
  const result = (await store.getAll([path])).get(path).data;
  assert.equal(result.lessonTimeMinutes, 3); assert.equal(result.arTimeMinutes, 2);
});

test("a mobile-record read failure is reported as unavailable instead of a successful empty result", async () => {
  const { app, store, query } = setup(), cookie = await app.login();
  store.legacyLessons.getAll = async () => { throw new Error("Temporary data-source outage"); };
  const result = await app.call(query("term_02"), cookie);
  assert.equal(result.status, 503);
  assert.equal((await result.json()).code, "unavailable");
});
