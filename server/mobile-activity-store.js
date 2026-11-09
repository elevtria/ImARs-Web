export const activities = new Map([
  ["states-of-matter", "States of Matter", 1, 1],
  ["physical-chemical-changes", "Physical and Chemical Changes", 1, 2],
  ["separation-techniques", "Separation Techniques", 1, 3],
  ["circulatory-system", "Circulatory System", 1, 4],
  ["food-web", "Food Web", 2, 1],
  ["simple-machines", "Simple Machines", 2, 2],
  ["sound-waves", "Sound Waves", 2, 3],
  ["longitudinal-waves", "Longitudinal Waves", 3, 1],
  ["volcanic-eruptions", "Volcanic Activity", 3, 2],
  ["earth-motion", "Motions of the Earth", 3, 3],
  ["constellation", "Constellations", 3, 4]
].map(([activityId, title, term, lesson]) => [activityId, { activityId, title, termId: "term_0" + term, lessonId: "lesson_0" + lesson }]));

export const legacyActivityFields = ["activityId", "classCode", "uid", "status", "score", "maximum", "completedAtUtc"];

const reportFields = [
  "activityId", "termId", "lessonId", "title", "runId", "studentId", "classCode", "deviceId", "status",
  "startedAtUtc", "completedAtUtc", "updatedAtUtc", "checkpointRevision", "score", "maximum",
  "rawScore", "rawMaximum", "durationSeconds", "timedOut"
].map(field => `${field}:item->${field}`).join(",");

export function activityStorageDataset(env) {
  const staging = env.MOBILE_ACTIVITY_STAGING_ENABLED === "true";
  const production = env.MOBILE_ACTIVITY_PRODUCTION_ENABLED === "true";
  if (staging && !production) return "staging";
  if (production && !staging && env.IMARS_MOBILE_DATASET_EPOCH === "mobile-production-v1") return "production";
  return null;
}

export class MobileActivityStore {
  constructor(env, fetcher) {
    const dataset = activityStorageDataset(env);
    if (!dataset) throw new Error("Mobile activity storage is disabled.");
    this.runs = "imars_mobile_" + dataset + "_runs";
    this.receipts = "imars_mobile_" + dataset + "_receipts";
    this.commitFunction = "rpc/imars_mobile_" + dataset + "_commit";
    const project = new URL(env.IMARS_SUPABASE_URL || "about:blank");
    if (project.protocol !== "https:" || !/^[a-z0-9]+\.supabase\.co$/.test(project.host) ||
        project.href !== project.origin + "/" || !/^sb_secret_\S+$/.test(env.SUPABASE_SECRET_KEY || "")) {
      throw new Error("Mobile activity storage is unavailable.");
    }
    Object.assign(this, { project, key: env.SUPABASE_SECRET_KEY });
    this.fetcher = (...args) => fetcher(...args);
  }

  async request(resource, params, body) {
    const url = new URL("/rest/v1/" + resource, this.project);
    url.search = new URLSearchParams(params);
    const response = await this.fetcher(url, {
      method: body ? "POST" : "GET", redirect: "manual", signal: AbortSignal.timeout(10_000),
      headers: { apikey: this.key, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (!response.ok) {
      if ((await response.json().catch(() => ({}))).code === "40001") return null;
      throw new Error("Mobile activity storage is unavailable.");
    }
    return response.json();
  }

  async run(uid, activityId) {
    const [row] = await this.request(this.runs, { uid: "eq." + uid, activity_id: "eq." + activityId, select: "version,item", limit: "1" });
    return row;
  }

  async receipt(uid, action, requestId) {
    const [row] = await this.request(this.receipts, { uid: "eq." + uid, action: "eq." + action,
      request_id: "eq." + requestId, select: "digest,receipt", limit: "1" });
    return row;
  }

  commit(uid, action, requestId, digest, activityId, version, item, receipt) {
    return this.request(this.commitFunction, {}, { p_uid: uid, p_action: action, p_request_id: requestId,
      p_digest: digest, p_activity_id: activityId, p_version: version ?? null, p_item: item ?? null, p_receipt: receipt });
  }

  async studentResults(scope, { termId, activityId }) {
    const rows = await this.request(this.runs, {
      uid: "eq." + scope.uid, student_id: "eq." + scope.profileId, section_id: "eq." + scope.classCode,
      ...(termId ? { term_id: "eq." + termId } : {}), ...(activityId ? { activity_id: "eq." + activityId } : {}),
      select: "item", order: "activity_id.asc", limit: "11"
    });
    return rows.map(row => row.item);
  }

  async gradesForRoster(sectionId, termIds, studentIds) {
    const part = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
    if (!part(sectionId) || studentIds.length < 1 || studentIds.length > 20 || !studentIds.every(part) ||
        termIds.length < 1 || termIds.length > 3 || !termIds.every(id => /^term_0[1-3]$/.test(id))) {
      throw new Error("Invalid activity grade scope.");
    }
    return this.request(this.runs, {
      section_id: "eq." + sectionId, term_id: "in.(" + termIds.join(",") + ")",
      student_id: "in.(" + studentIds.join(",") + ")", status: "eq.completed",
      select: "studentId:student_id,termId:term_id,lessonId:item->>lessonId,score:item->score,maximum:item->maximum",
      limit: String(studentIds.length * termIds.length * 4)
    });
  }

  async staffResults({ sectionId, studentId, activityId, termId, limit }, after) {
    const rows = await this.request(this.runs, {
      section_id: "eq." + sectionId, status: "eq.completed",
      ...(studentId ? { student_id: "eq." + studentId } : {}), ...(activityId ? { activity_id: "eq." + activityId } : {}),
      ...(termId ? { term_id: "eq." + termId } : {}),
      ...(after ? { or: `(updated_at_utc.lt.${after.updatedAtUtc},and(updated_at_utc.eq.${after.updatedAtUtc},run_id.lt.${after.runId}))` } : {}),
      select: reportFields, order: "updated_at_utc.desc,run_id.desc", limit: String(limit + 1)
    });
    return rows.map(row => ({ ...row, checkpoint: "" }));
  }
}
