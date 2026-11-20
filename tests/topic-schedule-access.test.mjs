import assert from "node:assert/strict";
import test from "node:test";
import { mobileApi } from "../server/mobile-api.js";
import { fixture } from "./fixtures/web-data.js";

test("teacher schedule changes reach the assigned student while another section cannot open the activity", async () => {
  const app = fixture();
  app.data.get("users/TEACH1000").authEmailVerified = true;
  const cookie = await app.login();
  Object.assign(app.env, { MOBILE_API_ENABLED: "true", MOBILE_ACTIVITY_STAGING_ENABLED: "true" });
  // Both sections belong to this teacher; releasing one must not release the other.
  app.data.set("classes/C", { teacherId: "TEACH1000", SectionName: "C" });
  app.data.set("users/0026271002", { uid: "student-c", role: "student", classCode: "C", teacherId: "TEACH1000" });
  const path = "terms/term_01/lessons/lesson_01";
  const otherSchedule = { isLocked: true, scheduledDate: "" };
  app.data.set(path, { title: "States of Matter", isLocked: false, scheduledDate: "",
    sectionSchedules: { A: { isLocked: true, scheduledDate: "" }, C: { ...otherSchedule } } });
  app.store.identity = async uid => ({ localId: uid, email: uid + "@example.test", emailVerified: true });
  const now = new Date("2026-11-11T02:00:00Z"), seconds = now.getTime() / 1000;
  const part = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  let activityWrites = 0;
  const activityStore = {
    receipt: async () => null,
    run: async () => null,
    commit: async (_uid, _action, _requestId, digest, _activityId, _version, _item, receipt) => {
      activityWrites++;
      return { digest, receipt };
    }
  };
  async function mobile(action, uid, body = {}) {
    const token = part({ alg: "RS256", kid: "fixture" }) + "." + part({ aud: "imars-db-a733b",
      iss: "https://securetoken.google.com/imars-db-a733b", sub: uid, exp: seconds + 600,
      iat: seconds - 60, auth_time: seconds - 60, email_verified: true }) + ".fixture";
    const request = app.request("/api/mobile/v1/" + action, body, null, {
      Authorization: "Bearer " + token,
      ...(body.requestId ? { "Idempotency-Key": body.requestId } : {})
    });
    const response = await mobileApi({ request, env: app.env }, { store: app.store, activityStore,
      rate: async () => {}, now: () => now,
      fetcher: async () => Response.json({ users: [{ localId: uid, emailVerified: true }] }) });
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    return { status: response.status, ...(await response.json()) };
  }
  async function save(isLocked, scheduledDate = "") {
    const response = await app.call({ action: "commit", writes: [{ operation: "update", path,
      data: { sectionId: "A", isLocked, scheduledDate } }] }, cookie);
    assert.equal(response.status, 200, await response.text());
    assert.deepEqual(app.data.get(path).sectionSchedules.C, otherSchedule);
  }
  const schedule = uid => mobile("schedules", uid, { termId: "term_01" });
  const start = (uid, requestId) => mobile("activity-start", uid,
    { requestId, activityId: "states-of-matter", deviceId: "test-device" });

  const before = await schedule("student-a");
  assert.equal(before.items[0].isLocked, true);
  await save(true, "2026-11-12");
  const scheduled = await schedule("student-a");
  assert.equal(scheduled.status, 200);
  assert.equal(scheduled.items[0].scheduledDate, "2026-11-12");
  assert.notEqual(scheduled.revision, before.revision);
  assert.equal((await start("student-a", "before-release")).code, "ACTIVITY_LOCKED");

  await save(false);
  const released = await schedule("student-a");
  assert.equal(released.status, 200);
  assert.equal(released.scope.classCode, "A");
  assert.equal(released.items[0].isLocked, false);
  assert.equal(released.items[0].scheduledDate, "");
  assert.notEqual(released.revision, scheduled.revision);
  assert.equal((await start("student-a", "assigned-section")).status, 200);
  assert.equal(activityWrites, 1);

  const other = await schedule("student-c");
  assert.equal(other.status, 200);
  assert.equal(other.scope.classCode, "C");
  assert.equal(other.items[0].isLocked, true);
  assert.equal((await mobile("schedules", "student-c", { termId: "term_01", sectionId: "A" })).status, 403);
  const blocked = await start("student-c", "other-section");
  assert.equal(blocked.status, 409);
  assert.equal(blocked.code, "ACTIVITY_LOCKED");
  assert.equal(activityWrites, 1, "blocked students must not create an activity run");

  await save(true);
  assert.equal((await schedule("student-a")).items[0].isLocked, true);
  assert.equal((await start("student-a", "after-relock")).code, "ACTIVITY_LOCKED");
  assert.equal(activityWrites, 1);
});
