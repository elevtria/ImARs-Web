import test from "node:test";
import assert from "node:assert/strict";
import { recordedLearningMinutes, recordedArMinutes, formatLearningMinutes } from "../js/learning-duration.js";

test("learning-time totals include all device counters without double-counting the rollup", () => {
  const result = { arTimeMinutes: 0, lessonTimeMinutes: 1, learningTimeByDevice: {
    phone: { arSeconds: 90, lessonSeconds: 30 }, tablet: { arSeconds: 30, lessonSeconds: 90 }
  } };
  assert.equal(recordedLearningMinutes(result, "arTimeMinutes", "arSeconds"), 2);
  assert.equal(recordedLearningMinutes(result, "lessonTimeMinutes", "lessonSeconds"), 2);
  result.arTimeMinutes = 2;
  assert.equal(recordedLearningMinutes(result, "arTimeMinutes", "arSeconds"), 2, "aggregate and devices describe the same time");
  result.arTimeMinutes = 5;
  assert.equal(recordedLearningMinutes(result, "arTimeMinutes", "arSeconds"), 5, "preserve genuine older aggregate time");
  assert.equal(result.lessonTimeMinutes, 1, "reading cannot change the saved result");
});

test("missing and invalid durations stay distinct from a genuine zero", () => {
  assert.equal(recordedLearningMinutes({}, "arTimeMinutes", "arSeconds"), null);
  assert.equal(recordedLearningMinutes({ arTimeMinutes: 0 }, "arTimeMinutes", "arSeconds"), 0);
  assert.equal(recordedLearningMinutes({ arTimeMinutes: -1, learningTimeByDevice: { a: { arSeconds: NaN }, b: { arSeconds: -10 } } }, "arTimeMinutes", "arSeconds"), null);
  assert.equal(formatLearningMinutes(null), "Not recorded");
  assert.equal(formatLearningMinutes(0), "0 min");
  assert.equal(formatLearningMinutes(0.02), "<0.1 min");
  assert.equal(formatLearningMinutes(1.25), "1.3 min");
});

test("AR navigation is only a fallback, and overlapping counters are not added", () => {
  assert.equal(recordedArMinutes({ arTimeMinutes: 0, arNavigationTimeMinutes: 4 }), 4);
  assert.equal(recordedArMinutes({ arTimeMinutes: 2, arNavigationTimeMinutes: 4 }), 2);
  assert.equal(recordedArMinutes({ learningTimeByDevice: { phone: { arSeconds: 90, arNavigationSeconds: 120 } } }), 1.5);
  assert.equal(recordedArMinutes({}), null);
});
