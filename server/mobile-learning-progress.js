const terms = ["term_01", "term_02", "term_03"];
const lessons = ["lesson_01", "lesson_02", "lesson_03", "lesson_04"];
const counters = { lessonSeconds: "lessonTimeMinutes", arSeconds: "arTimeMinutes", arNavigationSeconds: "arNavigationTimeMinutes" };
const flags = { lessonDone: "isLessonCompleted", lessonOpened: "isLessonOpened", arDone: "isARCompleted" };
const prefixes = ["preTest", "postTest"];
const badges = ["AccuracyBadgeCount", "OnFireBadgeCount", "PerfectStreakBadgeCount", "QuizChampionBadgeCount", "StreakMasterBadgeCount"];
const problem = (code, status, message) => Object.assign(new Error(message), { code, status });
const invalid = () => problem("INVALID_REQUEST", 400, "Invalid learning progress request.");
const number = value => Number.isFinite(value) && value >= 0 ? value : 0;
const keysAllowed = (body, keys) => body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).every(key => keys.includes(key));
const resultPath = (scope, termId, lessonId) => `users/${scope.profileId}/test_results/${termId}/lessons/${lessonId}`;

function timeTotal(data, secondsField, minutesField) {
  const trackedSeconds = Object.values(data.learningTimeByDevice || {})
    .reduce((total, device) => total + number(device?.[secondsField]), 0);
  return Math.max(number(data[minutesField]), trackedSeconds / 60);
}

async function digest(value) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

function projectResult(data, revision, termId, lessonId) {
  const item = { termId, lessonId, revision, updatedAtUtc: data.lastUpdated || data.timestamp || "" };
  for (const prefix of prefixes) {
    const completed = prefix === "preTest" ? "isPreTestCompleted" : "isPostTestCompleted";
    item[completed] = Object.hasOwn(data, completed) ? data[completed] === true : Object.hasOwn(data, prefix + "Score");
    item[prefix + "Score"] = number(data[prefix + "Score"]);
    item[prefix + "TotalQuestions"] = number(data[prefix + "TotalQuestions"] ?? data.totalQuestions);
    const heatmap = data[prefix + "Heatmap"];
    item[prefix + "Heatmap"] = Array.isArray(heatmap) && heatmap.every(value => typeof value === "boolean") ? heatmap : [];
  }
  const legacyCompleted = item.isPreTestCompleted && item.isPostTestCompleted && !Object.hasOwn(data, "postTestPointsRuleVersion");
  item.isLessonCompleted = Object.hasOwn(data, "isLessonCompleted") ? data.isLessonCompleted === true : legacyCompleted;
  item.isLessonOpened = data.isLessonOpened === true || item.isLessonCompleted || legacyCompleted;
  item.isARCompleted = data.isARCompleted === true;
  for (const [secondsField, minutesField] of Object.entries(counters)) item[minutesField] = timeTotal(data, secondsField, minutesField);
  return item;
}

function achievements(data) {
  return { totalPoints: number(data?.totalPoints), badgeCounts: Object.fromEntries(
    badges.map(key => [key, number(data?.badgeCounts?.[key])])) };
}

export async function readLearningProgress(body, scope, profile, store) {
  const { termId, lessonId } = body || {};
  if (!keysAllowed(body, ["termId", "lessonId"]) || (termId !== undefined && !terms.includes(termId)) ||
      (lessonId !== undefined && (!termId || !lessons.includes(lessonId)))) throw invalid();
  const pairs = (termId ? [termId] : terms).flatMap(term => (lessonId ? [lessonId] : lessons).map(lesson => [term, lesson]));
  const records = await store.getAll(pairs.map(pair => resultPath(scope, ...pair)));
  const items = pairs.flatMap(pair => {
    const row = records.get(resultPath(scope, ...pair));
    return row ? [projectResult(row.data, row.updateTime, ...pair)] : [];
  });
  const totals = achievements(profile.data.gamification);
  return { scope, items, revision: await digest([items, totals]), achievements: totals };
}

export async function saveLearningProgress(request, body, scope, profile, store, now, onSaved) {
  const { termId, lessonId, requestId, deviceId, revision, expectedClassCode, expectedTeacherProfileId } = body || {};
  if (!keysAllowed(body, ["termId", "lessonId", "requestId", "deviceId", "revision", "expectedClassCode", "expectedTeacherProfileId",
      ...Object.keys(counters), ...Object.keys(flags)]) || !terms.includes(termId) || !lessons.includes(lessonId) ||
      typeof deviceId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(deviceId) ||
      !Number.isSafeInteger(revision) || revision < 1 || requestId !== [deviceId, termId, lessonId, revision].join("-") ||
      request.headers.get("Idempotency-Key") !== requestId ||
      Object.keys(counters).some(key => !Number.isFinite(body[key]) || body[key] < 0 || body[key] > 1e9) ||
      Object.keys(flags).some(key => typeof body[key] !== "boolean")) throw invalid();
  if (scope.classCode !== expectedClassCode || scope.teacherProfileId !== expectedTeacherProfileId) {
    throw problem("SCOPE_CHANGED", 403, "Your class or account has changed.");
  }

  const path = resultPath(scope, termId, lessonId);
  const record = await store.get(path);
  const data = record?.data || {};
  const devices = data.learningTimeByDevice || {};
  const previous = Object.hasOwn(devices, deviceId) ? devices[deviceId] : null;
  const accepted = number(previous?.acceptedRevision);
  const payloadDigest = await digest([...Object.keys(counters), ...Object.keys(flags)].map(key => body[key]));
  const ack = { scope, requestId, persisted: true, achievements: achievements(profile.data.gamification) };
  if (revision <= accepted) {
    if (revision === accepted && previous.payloadDigest !== payloadDigest) {
      throw problem("IDEMPOTENCY_CONFLICT", 409, "This lesson progress version already has different data.");
    }
    return { ...ack, acceptedRevision: accepted, item: projectResult(data, record.updateTime, termId, lessonId) };
  }
  const device = { acceptedRevision: revision, payloadDigest };
  const updates = { lastUpdated: now.toISOString() };
  for (const [key, totalKey] of Object.entries(counters)) {
    const before = number(previous?.[key]);
    device[key] = Math.max(before, body[key]);
    updates[totalKey] = timeTotal(data, key, totalKey) + (device[key] - before) / 60;
  }
  for (const [key, field] of Object.entries(flags)) if (body[key]) updates[field] = true;
  updates.learningTimeByDevice = { ...devices, [deviceId]: device };
  await store.commit([{ path, operation: "set", merge: true, updateTime: record?.updateTime, data: updates }]);
  await onSaved(termId, lessonId);
  return { ...ack, acceptedRevision: revision, item: projectResult({ ...data, ...updates }, payloadDigest, termId, lessonId) };
}
