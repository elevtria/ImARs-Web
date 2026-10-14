export function todayISO(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00`);
  return !Number.isNaN(date.getTime()) && todayISO(date) === value;
}

export function topicAvailability(topic, today = todayISO()) {
  const scheduledDate = validDate(topic.date) ? topic.date : "";
  const locked = topic.locked === true && (!scheduledDate || scheduledDate > today);
  return {
    locked,
    label: locked ? (scheduledDate ? "Scheduled" : "Locked") : "Unlocked",
    cls: locked ? "pill-pending" : "pill-done"
  };
}

export function termAvailability(term, today = todayISO()) {
  const states = term.topics.map((topic) => topicAvailability(topic, today));
  const unlocked = states.filter((state) => !state.locked).length;
  const total = states.length;
  const label = unlocked === total && total > 0 ? "Unlocked"
    : unlocked > 0 ? "Partly unlocked"
    : states.some((state) => state.label === "Scheduled") ? "Scheduled" : "Locked";
  return {
    unlocked,
    locked: total - unlocked,
    total,
    percent: total ? Math.round(unlocked / total * 100) : 0,
    label,
    cls: unlocked === total && total > 0 ? "st-completed" : unlocked > 0 ? "st-active" : "st-upcoming"
  };
}

export function manualAccessUpdate(locked) {
  // A manual choice replaces any scheduled release.
  return { isLocked: locked, scheduledDate: "" };
}

export function scheduledAccessUpdate(date, topic, today = todayISO()) {
  if (!date) return manualAccessUpdate(topicAvailability(topic, today).locked);
  if (!validDate(date) || date < today) throw new Error("Choose today or a future date.");
  return { isLocked: date > today, scheduledDate: date };
}
