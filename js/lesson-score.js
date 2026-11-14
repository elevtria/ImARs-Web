export function validLessonScore(kind, score, maximum) {
  if (!["activity", "pre", "post"].includes(kind) || typeof score !== "number" || !Number.isFinite(score) ||
      typeof maximum !== "number" || !Number.isFinite(maximum) || maximum <= 0 || maximum > 1000 || score < 0 || score > maximum) return false;
  return kind === "activity" || (Number.isInteger(score) && maximum === (kind === "pre" ? 5 : 10));
}

export function scoreOverride(result, kind) {
  const value = result?.teacherScoreOverrides?.[kind];
  return value && validLessonScore(kind, value.score, value.maximum) ? value : null;
}
