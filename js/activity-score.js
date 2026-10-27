// Activity scores are optional on lesson results. Older results have only tests.
export function activityPercent(result) {
  const score = Number(result?.activityScore);
  const total = Number(result?.activityTotalQuestions ?? result?.activityTotalPoints);
  if (result?.activityScore == null || !Number.isFinite(score) || !Number.isFinite(total) || total <= 0 || score < 0 || score > total) return null;
  return (score / total) * 100;
}

export function assessmentPercent(result, kind) {
  if (result?.[`is${kind === "pre" ? "Pre" : "Post"}TestCompleted`] !== true) return null;
  const total = result[`${kind}TestTotalQuestions`];
  const score = result[`${kind}TestScore`] ?? (kind === "post" && Array.isArray(result.postTestHeatmap) ? result.postTestHeatmap.filter(Boolean).length : null);
  return typeof score === "number" && typeof total === "number" && Number.isFinite(score) && Number.isFinite(total) && total > 0 && score >= 0 && score <= total
    ? score / total * 100 : null;
}

// Each completed assessment has equal weight. Gain uses matched lesson pairs.
export function summarizeAssessments(results) {
  let prePctSum = 0, preCount = 0, postPctSum = 0, postCount = 0, pairDifference = 0, pairCount = 0;
  for (const result of results) {
    const pre = assessmentPercent(result, "pre"), post = assessmentPercent(result, "post");
    if (pre !== null) { prePctSum += pre; preCount++; }
    if (post !== null) { postPctSum += post; postCount++; }
    if (pre !== null && post !== null) { pairDifference += post - pre; pairCount++; }
  }
  return { prePctSum, preCount, postPctSum, postCount, pairDifference, pairCount,
    pre: preCount ? Math.round(prePctSum / preCount) : null,
    post: postCount ? Math.round(postPctSum / postCount) : null,
    gain: pairCount ? Math.round(pairDifference / pairCount) : null };
}

export const percentLabel = value => value === null || value === undefined ? "—" : `${value}%`;
export const gainLabel = value => value === null || value === undefined ? "—" : `${value > 0 ? "+" : ""}${value} pp`;
