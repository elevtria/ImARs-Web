import { FirestoreAdmin, decodeFields, encodeFields, firebaseIdentity } from "./firestore-admin.js";
import { legacyActivityFields } from "./mobile-activity-store.js";

const id = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const part = /^[A-Za-z0-9_-]{1,128}$/;
const conflict = () => Object.assign(new Error("The records changed. Reload and try again."), { status: 409 });
export const supabaseDocumentPath = path => path.replace(/^_accountAccess\//, "webSettings/accountAccess/accounts/");
export const sortableTimestamp = value => value.replace(/(?:\.(\d{1,9}))?Z$/, (_, fraction = "") => "." + fraction.padEnd(9, "0") + "Z");
const quoted = value => JSON.stringify(value);

export const supabaseWebData = env => env.IMARS_SUPABASE_WEB_DATA === "true";
export function appStore(env, fetcher = fetch) {
  return supabaseWebData(env) ? new SupabaseAppStore(env, fetcher) : new FirestoreAdmin(env, fetcher);
}

function validatePath(path, document) {
  const parts = path.split("/");
  if (!parts.every(segment => part.test(segment)) || (parts.length % 2 === 0) !== document) {
    throw new Error("Invalid application data path.");
  }
}

function asDocument(row) {
  if (!row) return null;
  return {
    id: row.path.split("/").at(-1), data: decodeFields(row.fields),
    wire: decodeFields(row.fields, true), updateTime: row.update_time
  };
}

function updateFields(write, previous, timestamp) {
  const fields = write.merge || write.operation === "update" ? { ...previous } : {};
  for (const [field, value] of Object.entries(write.data)) {
    let encoded;
    if (value?.$type === "serverTimestamp") encoded = { timestampValue: timestamp };
    else if (value?.$type === "timestamp") encoded = encodeFields({ value: new Date(value.value) }).value;
    else if (value?.$type === "arrayUnion") {
      const previousValues = previous?.[field]?.arrayValue?.values || [];
      const combined = [...previousValues];
      for (const item of value.values) {
        const candidate = encodeFields({ value: item }).value;
        if (!combined.some(current => JSON.stringify(current) === JSON.stringify(candidate))) combined.push(candidate);
      }
      encoded = { arrayValue: { values: combined } };
    } else encoded = encodeFields({ value }).value;
    fields[field] = encoded;
  }
  return fields;
}

// Server-side only. Each request or transaction gets its own store instance.
export class SupabaseAppStore {
  constructor(env, fetcher = fetch) {
    const project = new URL(env.IMARS_SUPABASE_URL || "about:blank");
    const key = env.SUPABASE_SECRET_KEY || "";
    const dataset = env.IMARS_SUPABASE_APP_DATASET_ID || "";
    if (project.protocol !== "https:" || !/^[a-z0-9]+\.supabase\.co$/.test(project.host) ||
        project.href !== project.origin + "/" || !/^sb_secret_\S+$/.test(key) || !id.test(dataset)) {
      throw new Error("Supabase application data is not configured.");
    }
    Object.assign(this, { env, project, key, dataset, revision: null });
    this.fetcher = (...args) => fetcher(...args);
  }

  async request(resource, method, params, body) {
    const url = new URL("/rest/v1/" + resource, this.project);
    url.search = new URLSearchParams(params);
    const response = await this.fetcher(url, {
      method, redirect: "manual", signal: AbortSignal.timeout(15_000),
      headers: {
        apikey: this.key, "Content-Type": "application/json",
        ...(method === "HEAD" ? { Prefer: "count=exact" } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      if (error.code === "40001") throw conflict();
      throw new Error("Supabase application data is unavailable.");
    }
    return response;
  }

  async documents(method, params) {
    return this.request("imars_app_documents", method, {
      ...params, dataset_id: "eq." + this.dataset
    });
  }

  async get(path) {
    return (await this.getAll([path])).get(path);
  }

  async getAll(paths, { fieldPaths } = {}) {
    const rows = await this.rawDocuments(paths, fieldPaths);
    return new Map(paths.map(path => {
      const row = rows.get(supabaseDocumentPath(path));
      return [path, row ? this.projected(row, fieldPaths) : null];
    }));
  }

  async adminLessonResults(fieldPaths) {
    const pattern = "^users/[A-Za-z0-9_-]+/test_results/term_0[1-3]/lessons/lesson_0[1-4]$";
    const select = this.selection(fieldPaths);
    const rows = [];
    let after;
    for (;;) {
      const response = await this.documents("GET", {
        path: "match." + pattern, select, order: "path.asc", limit: "500",
        ...(after ? { and: "(path.gt." + after + ")" } : {})
      });
      const page = await response.json();
      rows.push(...page.map(row => ({ path: row.path, ...this.projected(row, fieldPaths) })));
      if (page.length < 500) return rows;
      after = page.at(-1).path;
    }
  }

  async activityResultsForRoster(studentIds) {
    if (!studentIds.length || studentIds.length > 25 || !studentIds.every(id => part.test(id))) {
      throw new Error("Invalid activity roster.");
    }
    const collections = studentIds.map(id => "users/" + id + "/activity_results");
    const fields = legacyActivityFields;
    const select = this.selection(fields);
    const results = [];
    let after;
    for (;;) {
      const response = await this.documents("GET", {
        collection_path: "in.(" + collections.join(",") + ")", select, order: "path.asc", limit: "250",
        ...(after ? { path: "gt." + after } : {})
      });
      const rows = await response.json();
      results.push(...rows.map(row => ({ studentId: row.path.split("/")[1], data: this.projected(row, fields).data })));
      if (rows.length < 250) return results;
      after = rows.at(-1).path;
    }
  }

  async rawDocuments(paths, fieldPaths) {
    if (!paths.length || paths.length > 100 || new Set(paths).size !== paths.length) throw new Error("Load at most 100 distinct documents.");
    for (const path of paths) validatePath(path, true);
    paths = paths.map(supabaseDocumentPath);
    // Most batches fit into a few reads. Leave room in the URL for projections.
    const groups = [];
    let group = [];
    let length = 0;
    for (const path of paths) {
      if (length + path.length + 3 > 3300 && group.length) {
        groups.push(group);
        group = [];
        length = 0;
      }
      group.push(path);
      length += path.length + 3;
    }
    groups.push(group);
    const select = this.selection(fieldPaths);
    const pages = await Promise.all(groups.map(async group => {
      const response = await this.documents("GET", { path: "in.(" + group.join(",") + ")", select });
      return response.json();
    }));
    return new Map(pages.flat().map(row => [row.path, row]));
  }

  filter(path, filters) {
    validatePath(path, false);
    const values = Object.create(null);
    for (const filter of filters) {
      if (!part.test(filter.field) || (filter.op && filter.op !== "==") || Object.hasOwn(values, filter.field)) {
        throw new Error("Unsupported Supabase document filter.");
      }
      values[filter.field] = filter.value;
    }
    return {
      collection_path: "eq." + path,
      ...(filters.length ? { fields: "cs." + JSON.stringify(encodeFields(values)) } : {})
    };
  }

  async query(path, { filters = [], order = [], limit = 5000, after, fieldPaths } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000 || (after && !part.test(after))) {
      throw new Error("Unsupported Supabase document query.");
    }
    if (order.length) {
      if (order.length !== 1 || order[0].field !== "timestamp" || !["asc", "desc"].includes(order[0].direction) ||
          filters.length || after || !/^users\/[A-Za-z0-9_-]{1,128}\/recent_scans$/.test(path)) {
        throw new Error("Unsupported Supabase document query.");
      }
      return this.recentScans(path, order[0].direction, limit, fieldPaths);
    }
    const params = this.filter(path, filters);
    const rows = [];
    let cursor = after;
    while (rows.length < limit + 1) {
      const size = Math.min(250, limit + 1 - rows.length);
      const response = await this.documents("GET", {
        ...params, select: this.selection(fieldPaths), order: "path.asc", limit: String(size),
        ...(cursor ? { path: "gt." + path + "/" + cursor } : {})
      });
      const page = await response.json();
      rows.push(...page);
      if (page.length < size) break;
      cursor = page.at(-1).path.split("/").at(-1);
    }
    if (rows.length > limit && limit === 5000) {
      throw Object.assign(new Error("This report is too large. Contact website maintenance."), { status: 409 });
    }
    return rows.slice(0, limit).map(row => this.projected(row, fieldPaths));
  }

  selection(fields) {
    if (!fields) return "path,fields,update_time";
    if (fields.some(field => !part.test(field))) throw new Error("Invalid field projection.");
    return ["path", "update_time", ...fields.map(field => field + ":fields->" + field)].join(",");
  }

  projected(row, fields) {
    if (!fields) return asDocument(row);
    const projected = Object.fromEntries(fields.filter(field => row[field] != null).map(field => [field, row[field]]));
    return asDocument({ ...row, fields: projected });
  }

  identity(uid) {
    return firebaseIdentity(this.env, uid, this.fetcher);
  }

  async findUser(uid) {
    const rows = await this.query("users", { filters: [{ field: "uid", value: uid }], limit: 2 });
    if (rows.length > 1) throw new Error("Duplicate Firebase UID requires administrator review");
    return rows[0] || null;
  }

  async activate(profileId, profile, uid, updates, role, authEmail) {
    await this.begin();
    try {
      if (await this.findUser(uid)) throw conflict();
      await this.commit([
        { operation: "update", path: "users/" + profileId, updateTime: profile.updateTime, data: updates },
        { operation: "set", path: "_accountAccess/" + uid, data: { profileId, role, authEmail, active: true } }
      ]);
    } finally { await this.rollback(); }
  }

  async quizPage(context, { limit = 21, after, upper, ids } = {}) {
    if (ids && !ids.length) return [];
    const fields = ["id", "title", "sectionId", "assignmentScope", "teacherProfileId", "teacherUid", "type",
      "gradingMode", "availability", "availableAt", "createdAt", "schemaVersion", "questionCount"];
    const createdAt = "fields->createdAt->>stringValue";
    const cursor = after || upper;
    const response = await this.documents("GET", {
      ...this.filter("generatedQuizzes", ["teacherProfileId", "teacherUid"].map(field => ({ field, value: context[field] }))),
      select: this.selection(fields),
      ...(ids ? { path: "in.(" + ids.map(id => "generatedQuizzes/" + id).join(",") + ")", order: "path.desc", limit: String(ids.length) } : {
        "fields->sectionId->>stringValue": "in.(" + quoted(context.sectionId) + ',"")',
        "fields->availability->>stringValue": "in.(now,scheduled)",
        [createdAt]: "not.is.null",
        order: createdAt + ".desc,path.desc", limit: String(limit),
        ...(cursor ? { or: "(" + createdAt + ".lt." + quoted(cursor[0]) + ",and(" + createdAt + ".eq." +
          quoted(cursor[0]) + ",path." + (after ? "lt" : "lte") + ".generatedQuizzes/" + cursor[1] + "))" } : {})
      })
    });
    return (await response.json()).map(row => this.projected(row, fields));
  }

  async quizReport(actor, sectionId, quizId = null, studentIds = null) {
    const response = await this.request("rpc/imars_quiz_report", "POST", {}, {
      p_dataset: this.dataset, p_teacher_uid: actor.uid, p_teacher_id: actor.id,
      p_section: sectionId, p_quiz: quizId, p_students: studentIds
    });
    return response.json();
  }

  async scorePage(actor, studentId, sectionId, { quizId, after, limit = 21 } = {}) {
    const fields = ["quizId", "status", "submittedAt", "receipt", "review"];
    const submittedAt = "fields->submittedAt->>timestampValue";
    const context = { teacherUid: actor.uid, teacherProfileId: actor.id, sectionId };
    const boundary = after && quoted(sortableTimestamp(after[0]));
    const response = await this.documents("GET", {
      collection_path: studentId ? `eq.users/${studentId}/generated_quiz_attempts` : "like.users/*/generated_quiz_attempts",
      select: this.selection(fields),
      fields: "cs." + JSON.stringify(encodeFields({ context, ...(quizId ? { quizId } : {}) })),
      [submittedAt]: "not.is.null", order: submittedAt + ".desc,path.desc", limit: String(limit),
      ...(after ? { or: "(" + submittedAt + ".lt." + boundary + ",and(" + submittedAt +
        ".eq." + boundary + ",path.lt." + after[1] + "))" } : {})
    });
    return (await response.json()).map(row => ({ ...this.projected(row, fields), path: row.path }));
  }

  async reviewPage(actor, quizId, sectionId, after) {
    const fields = ["context", "quizId", "status", "submittedAt"];
    const submittedAt = "fields->submittedAt->>timestampValue";
    const context = { teacherUid: actor.uid, teacherProfileId: actor.id, ...(sectionId ? { sectionId } : {}) };
    const boundary = after && quoted(sortableTimestamp(after[0]));
    const response = await this.documents("GET", {
      collection_path: "like.users/*/generated_quiz_attempts", select: this.selection(fields),
      fields: "cs." + JSON.stringify(encodeFields({ context, quizId, status: "pending-review" })),
      [submittedAt]: "not.is.null", order: submittedAt + ".asc,path.asc", limit: "21",
      ...(after ? { or: "(" + submittedAt + ".gt." + boundary + ",and(" + submittedAt +
        ".eq." + boundary + ",path.gt." + after[1] + "))" } : {})
    });
    return (await response.json()).map(row => ({ ...this.projected(row, fields), path: row.path }));
  }

  async recentScans(path, direction, limit, fieldPaths) {
    const rows = [];
    while (rows.length <= limit) {
      const size = Math.min(250, limit + 1 - rows.length);
      const response = await this.request("rpc/imars_app_scan_page", "POST", {}, {
        p_dataset: this.dataset, p_collection: path, p_desc: direction === "desc", p_limit: size, p_offset: rows.length
      });
      const page = await response.json();
      rows.push(...page);
      if (page.length < size) break;
    }
    if (rows.length > limit && limit === 5000) {
      throw Object.assign(new Error("This report is too large. Contact website maintenance."), { status: 409 });
    }
    return rows.slice(0, limit).map(row => asDocument(row, fieldPaths));
  }

  async count(path, filters = []) {
    const response = await this.documents("HEAD", { ...this.filter(path, filters), select: "path", limit: "1" });
    const count = response.headers.get("Content-Range")?.match(/\/(\d+)$/);
    if (!count) throw new Error("Supabase application totals are unavailable.");
    return Number(count[1]);
  }

  async begin() {
    const response = await this.request("imars_app_datasets", "GET", { id: "eq." + this.dataset, select: "revision" });
    const [row] = await response.json();
    if (!row || !id.test(row.revision)) throw new Error("The application dataset is unavailable.");
    this.revision = row.revision;
  }

  async rollback() {
    this.revision = null;
  }

  async commit(writes) {
    if (!this.revision) await this.begin();
    const revision = this.revision;
    this.revision = null;
    if (writes.some(write => !["set", "update", "delete"].includes(write.operation))) {
      throw new Error("Invalid application write.");
    }
    const existing = await this.rawDocuments(writes.map(write => write.path));
    const timestamp = sortableTimestamp(new Date().toISOString());
    const changes = writes.map(write => {
      const path = supabaseDocumentPath(write.path);
      const row = existing.get(path);
      if (row?.update_time !== write.updateTime || (!row && write.operation !== "set")) throw conflict();
      return {
        path, previous: row?.update_time || null,
        fields: write.operation === "delete" ? null : updateFields(write, row?.fields, timestamp)
      };
    });
    await this.request("rpc/imars_commit_app_documents", "POST", {}, {
      dataset: this.dataset, expected_revision: revision, changes
    });
  }
}
