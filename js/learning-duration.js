const valid = value => typeof value === "number" && Number.isFinite(value) && value >= 0;

export function recordedLearningMinutes(result, minutesField, secondsField) {
  if (valid(result?.[minutesField])) return result[minutesField];
  const devices = result?.learningTimeByDevice;
  if (!devices || typeof devices !== "object") return null;
  const seconds = Object.values(devices).map(device => device?.[secondsField]).filter(valid);
  return seconds.length ? seconds.reduce((sum, value) => sum + value, 0) / 60 : null;
}
