import assert from "node:assert/strict";
import test from "node:test";
import { topicAvailability, termAvailability, manualAccessUpdate, scheduledAccessUpdate, sectionSchedule, validateActivityDeadlineUtc, activityDeadlineInput, activityDeadlineFromInput } from "../js/topic-availability.js";

const today = "2026-10-14";
const locked = { locked: true, date: "" };
const unlocked = { locked: false, date: "" };
const fromUpdate = (update) => ({ locked: update.isLocked, date: update.scheduledDate });

test("activity deadlines round-trip between Philippine input time and UTC across day boundaries", () => {
  assert.equal(activityDeadlineFromInput("2026-11-03T07:30"), "2026-11-02T23:30:00.000Z");
  assert.equal(activityDeadlineInput("2026-11-02T23:30:00.000Z"), "2026-11-03T07:30");
  assert.equal(activityDeadlineInput(""), ""); assert.equal(activityDeadlineFromInput(""), "");
  assert.equal(validateActivityDeadlineUtc("2026-11-02T23:30:00Z", "2026-11-03"), "2026-11-02T23:30:00Z");
  assert.equal(validateActivityDeadlineUtc("", "2026-11-03"), "");
});

test("deadline validation rejects invalid timestamps and deadlines at or before the release day starts", () => {
  for (const value of [null, 123, "tomorrow", "2026-02-30T12:00:00Z", "2026-11-03T12:00:00", "2026-11-03T12:00:00+08:00", "2026-11-03T24:00:00Z"])
    assert.throws(() => validateActivityDeadlineUtc(value));
  for (const value of ["2026-11-02T15:59:00Z", "2026-11-02T16:00:00Z"])
    assert.throws(() => validateActivityDeadlineUtc(value, "2026-11-03"), /after/);
  assert.doesNotThrow(() => validateActivityDeadlineUtc("2026-11-02T16:00:00.001Z", "2026-11-03"));
  for (const value of ["2026-02-30T12:00", "2026-11-03T24:00", "2026-11-03", "bad"])
    assert.throws(() => activityDeadlineFromInput(value));
});

test("section settings override the shared default and malformed overrides stay locked", () => {
  const lesson = { isLocked: false, scheduledDate: "", sectionSchedules: {
    A: { isLocked: true, scheduledDate: "2026-10-15" }, B: { isLocked: false, scheduledDate: "" }, C: null
  } };
  assert.deepEqual(sectionSchedule(lesson, "A"), { isLocked: true, scheduledDate: "2026-10-15" });
  assert.equal(topicAvailability(fromUpdate(sectionSchedule(lesson, "A")), today).locked, true);
  assert.equal(topicAvailability(fromUpdate(sectionSchedule(lesson, "A")), "2026-10-15").locked, false);
  assert.equal(sectionSchedule(lesson, "B").isLocked, false);
  assert.equal(sectionSchedule(lesson, "unconfigured").isLocked, false);
  assert.deepEqual(sectionSchedule(lesson, "C"), { isLocked: true, scheduledDate: "" });
  assert.deepEqual(sectionSchedule({}, "A"), { isLocked: true, scheduledDate: "" });
  for (const sectionSchedules of [null, [], "invalid"]) assert.equal(sectionSchedule({ isLocked: false, sectionSchedules }, "A").isLocked, true);
});

test("progress counts unlocked topics, including ones with no date", () => {
  for (let count = 0; count <= 4; count++) {
    const topics = Array.from({ length: 4 }, (_, index) => index < count ? unlocked : locked);
    const state = termAvailability({ topics }, today);
    assert.equal(state.unlocked, count);
    assert.equal(state.locked, 4 - count);
    assert.equal(state.percent, count * 25);
    assert.equal(state.label, count === 0 ? "Locked" : count === 4 ? "Unlocked" : "Partly unlocked");
  }
});

test("scheduled release counts only from its release day", () => {
  const topic = { locked: true, date: "2026-10-15" };
  assert.equal(topicAvailability(topic, today).label, "Scheduled");
  assert.equal(termAvailability({ topics: [topic, locked, locked, locked] }, today).percent, 0);
  assert.equal(termAvailability({ topics: [topic, locked, locked, locked] }, "2026-10-15").percent, 25);
  assert.equal(topicAvailability(topic, "2026-10-16").label, "Unlocked");
});

test("a manual lock cancels a due release and stays locked", () => {
  const topic = fromUpdate(manualAccessUpdate(true));
  assert.equal(topic.date, "");
  assert.equal(topicAvailability(topic, "2026-10-16").locked, true);
});

test("manual unlock cancels a future release and counts immediately", () => {
  const topic = fromUpdate(manualAccessUpdate(false));
  assert.equal(topic.date, "");
  assert.equal(termAvailability({ topics: [topic, locked, locked, locked] }, today).percent, 25);
});

test("scheduling a future date locks an already unlocked topic", () => {
  const update = scheduledAccessUpdate("2026-10-15", unlocked, today);
  assert.deepEqual(update, { isLocked: true, scheduledDate: "2026-10-15" });
  assert.equal(topicAvailability(fromUpdate(update), today).locked, true);
});

test("scheduling today unlocks a manually locked topic", () => {
  const update = scheduledAccessUpdate(today, locked, today);
  assert.equal(update.isLocked, false);
  assert.equal(topicAvailability(fromUpdate(update), today).locked, false);
});

test("clearing a date keeps effective availability", () => {
  assert.deepEqual(scheduledAccessUpdate("", { locked: true, date: "2026-10-15" }, today), manualAccessUpdate(true));
  assert.deepEqual(scheduledAccessUpdate("", { locked: true, date: today }, today), manualAccessUpdate(false));
});

test("invalid dates cannot release a locked topic or be saved", () => {
  for (const date of ["2026-02-30", "not-a-date", "2026-1-5"]) {
    assert.equal(topicAvailability({ locked: true, date }, today).locked, true);
    assert.throws(() => scheduledAccessUpdate(date, locked, today));
  }
  assert.throws(() => scheduledAccessUpdate("2026-10-13", unlocked, today));
});

test("an empty term has zero progress", () => {
  assert.equal(termAvailability({ topics: [] }, today).percent, 0);
});
