// Older mobile builds write lesson progress directly to Firestore. Website
// reports must reconcile those records with the newer application dataset.
export const lessonResultPath = path => /^users\/[A-Za-z0-9_-]{1,128}\/test_results\/term_0[1-3]\/lessons\/lesson_0[1-4]$/.test(path);
export const lessonResultFields = ["lessonId", "termId", "timestamp", "lastUpdated", "completedAt", "activityCompletedAt",
  "isPreTestCompleted", "preTestScore", "preTestTotalQuestions", "preTestHeatmap", "preTestCompletedAt",
  "isPostTestCompleted", "postTestScore", "postTestTotalQuestions", "postTestHeatmap", "postTestQuestionOrder", "postTestCompletedAt",
  "isLessonOpened", "isLessonCompleted", "isARCompleted", "completed", "lessonTimeMinutes", "arTimeMinutes", "arNavigationTimeMinutes",
  "learningTimeByDevice", "activityScore", "activityTotalQuestions", "activityTotalPoints", "activityRawScore", "activityRawMaximum"];
export const lessonMergeFields = [...lessonResultFields, "teacherScoreOverrides"];
const validMinutes = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const at = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const updated = row => Math.max(at(row?.updateTime), ...["timestamp", "lastUpdated", "completedAt"].map(field => at(row?.data[field])));

export function mergeLegacyLesson(current, legacy, fields) {
  if (!legacy) return current;
  const data = { ...current?.data }, wire = { ...(current?.wire || current?.data) };
  const newer = updated(legacy) > updated(current);
  for (const field of lessonResultFields) {
    if (!Object.hasOwn(legacy.data, field)) continue;
    if (newer || !Object.hasOwn(data, field)) {
      data[field] = legacy.data[field]; wire[field] = (legacy.wire || legacy.data)[field];
    }
  }
  // Completion and elapsed learning time are cumulative. An imported seed or a
  // partial update must not erase a confirmed completion or recorded duration.
  for (const field of ["isPreTestCompleted", "isPostTestCompleted", "isLessonCompleted", "isARCompleted", "completed"]) {
    if (current?.data[field] === true || legacy.data[field] === true) {
      data[field] = true; wire[field] = true;
      const prefix = field === "isPreTestCompleted" ? "preTest" : field === "isPostTestCompleted" ? "postTest" : null;
      if (prefix) {
        const source = current?.data[field] === true && legacy.data[field] !== true ? current
          : legacy.data[field] === true && current?.data[field] !== true ? legacy : null;
        if (source) for (const key of lessonResultFields.filter(key => key.startsWith(prefix))) {
          if (Object.hasOwn(source.data, key)) { data[key] = source.data[key]; wire[key] = (source.wire || source.data)[key]; }
        }
      }
    }
  }
  for (const [field, secondsField] of [["lessonTimeMinutes", "lessonSeconds"], ["arTimeMinutes", "arSeconds"], ["arNavigationTimeMinutes", "arNavigationSeconds"]]) {
    const values = [current?.data[field], legacy.data[field]].filter(validMinutes);
    for (const row of [current, legacy]) {
      const seconds = Object.values(row?.data.learningTimeByDevice || {}).map(device => device?.[secondsField]).filter(validMinutes);
      if (seconds.length) values.push(seconds.reduce((sum, value) => sum + value, 0) / 60);
    }
    if (values.length) data[field] = wire[field] = Math.max(...values);
  }
  // Website score corrections remain authoritative over mobile result copies.
  for (const [kind, edit] of Object.entries(current?.data.teacherScoreOverrides || {})) {
    if (!edit || !validMinutes(edit.score) || !validMinutes(edit.maximum) || edit.maximum <= 0 || edit.score > edit.maximum) continue;
    const prefix = kind === "pre" ? "preTest" : kind === "post" ? "postTest" : kind === "activity" ? "activity" : null;
    if (!prefix) continue;
    for (const [field, value] of Object.entries({ [prefix + "Score"]: edit.score, [prefix + "TotalQuestions"]: edit.maximum,
      ...(kind === "activity" ? { activityTotalPoints: edit.maximum, activityRawScore: edit.score, activityRawMaximum: edit.maximum }
        : { [kind === "pre" ? "isPreTestCompleted" : "isPostTestCompleted"]: true }) })) data[field] = wire[field] = value;
  }
  const pick = values => fields ? Object.fromEntries(fields.filter(field => Object.hasOwn(values, field)).map(field => [field, values[field]])) : values;
  return { id: current?.id || legacy.id, data: pick(data), wire: pick(wire), updateTime: current?.updateTime };
}
