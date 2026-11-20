const valid = value => typeof value === "number" && Number.isFinite(value) && value >= 0;

export function recordedLearningMinutes(result, minutesField, secondsField) {
  const total = valid(result?.[minutesField]) ? result[minutesField] : null;
  const devices = result?.learningTimeByDevice;
  if (!devices || typeof devices !== "object") return total;
  const seconds = Object.values(devices).map(device => device?.[secondsField]).filter(valid);
  // Rollups and device counters describe the same cumulative time. Do not add
  // them together, or a synced session would count twice.
  const tracked = seconds.length ? seconds.reduce((sum, value) => sum + value, 0) / 60 : null;
  return total === null ? tracked : tracked === null ? total : Math.max(total, tracked);
}

export function formatLearningMinutes(value) {
  if (!valid(value)) return "Not recorded";
  if (value > 0 && value < 0.1) return "<0.1 min";
  return Number(value.toFixed(1)) + " min";
}

export function recordedArMinutes(result) {
  const tracked = recordedLearningMinutes(result, "arTimeMinutes", "arSeconds");
  // Navigation time is a fallback for older AR-screen tracking. It overlaps
  // marker-visible time, so the two counters must never be added together.
  return tracked > 0 ? tracked : recordedLearningMinutes(result, "arNavigationTimeMinutes", "arNavigationSeconds") ?? tracked;
}
