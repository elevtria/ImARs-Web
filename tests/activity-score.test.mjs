import assert from "node:assert/strict";
import test from "node:test";
import { activityPercent } from "../js/activity-score.js";

test("activity score uses the stored score and maximum without inventing missing results", () => {
  assert.equal(activityPercent({ activityScore: 3, activityTotalQuestions: 4 }), 75);
  assert.equal(activityPercent({ activityScore: 0, activityTotalPoints: 10 }), 0);
  assert.equal(activityPercent({ preTestScore: 5, preTestTotalQuestions: 5 }), null);
  assert.equal(activityPercent({ activityScore: 11, activityTotalQuestions: 10 }), null);
  assert.equal(activityPercent({ activityScore: 2, activityTotalQuestions: 0 }), null);
});
