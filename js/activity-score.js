import { scoreOverride } from "./lesson-score.js";

// Activity scores are optional on lesson results. Older results have only tests.
export function activityPercent(result) {
  const edited = scoreOverride(result, "activity");
  if (edited) return edited.score / edited.maximum * 100;
  const score = Number(result?.activityScore);
  const total = Number(result?.activityTotalQuestions ?? result?.activityTotalPoints);
  if (result?.activityScore == null || !Number.isFinite(score) || !Number.isFinite(total) || total <= 0 || score < 0 || score > total) return null;
  return (score / total) * 100;
}
