import { decodeFields, encodeFields } from "./firestore-admin.js";

const id = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const part = /^[A-Za-z0-9_-]{1,128}$/;
const conflict = () => Object.assign(new Error("The records changed. Reload and try again."), { status: 409 });

function validatePath(path, document) {
  const parts = path.split("/");
  if (!parts.every(segment => part.test(segment)) || (parts.length % 2 === 0) !== document) {
    throw new Error("Invalid application data path.");
  }
}

function asDocument(row, fieldPaths) {
  if (!row) return null;
  const fields = fieldPaths ? Object.fromEntries(fieldPaths.filter(field => Object.hasOwn(row.fields, field))
    .map(field => [field, row.fields[field]])) : row.fields;
  return {
    id: row.path.split("/").at(-1), data: decodeFields(fields),
    wire: decodeFields(fields, true), updateTime: row.update_time
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
    const rows = await this.rawDocuments(paths);
    return new Map(paths.map(path => [path, asDocument(rows.get(path), fieldPaths)]));
  }

  async rawDocuments(paths) {
    if (!paths.length || paths.length > 100 || new Set(paths).size !== paths.length) throw new Error("Load at most 100 distinct documents.");
    for (const path of paths) validatePath(path, true);
    // Keep URLs bounded even for batches of long document IDs.
    const rows = new Map();
    for (let index = 0; index < paths.length; index += 16) {
      const response = await this.documents("GET", {
        path: "in.(" + paths.slice(index, index + 16).join(",") + ")", select: "path,fields,update_time"
      });
      for (const row of await response.json()) rows.set(row.path, row);
    }
    return rows;
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
        ...params, select: "path,fields,update_time", order: "path.asc", limit: String(size),
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
    return rows.slice(0, limit).map(row => asDocument(row, fieldPaths));
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
    if (!this.revision) throw new Error("Begin an application transaction before saving.");
    if (writes.some(write => !["set", "update", "delete"].includes(write.operation))) {
      throw new Error("Invalid application write.");
    }
    const existing = await this.rawDocuments(writes.map(write => write.path));
    const timestamp = new Date().toISOString();
    const changes = writes.map(write => {
      const row = existing.get(write.path);
      if (row?.update_time !== write.updateTime || (!row && write.operation !== "set")) throw conflict();
      return {
        path: write.path, previous: row?.update_time || null,
        fields: write.operation === "delete" ? null : updateFields(write, row?.fields, timestamp)
      };
    });
    await this.request("rpc/imars_commit_app_documents", "POST", {}, {
      dataset: this.dataset, expected_revision: this.revision, changes
    });
    this.revision = null;
  }
}
