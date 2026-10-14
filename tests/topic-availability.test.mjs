import assert from "node:assert/strict";
import test from "node:test";
import { topicAvailability, termAvailability, manualAccessUpdate, scheduledAccessUpdate } from "../js/topic-availability.js";

const today = "2026-10-14";
const locked = { locked: true, date: "" };
const unlocked = { locked: false, date: "" };
const fromUpdate = (update) => ({ locked: update.isLocked, date: update.scheduledDate });

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
