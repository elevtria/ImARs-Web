import { readFile } from "node:fs/promises";
import { FirestoreAdmin } from "../server/firestore-admin.js";

const mode = process.argv[2] || "--plan";
if (!["--plan", "--stage"].includes(mode) || process.argv.length > 3) throw new Error("Use --plan or --stage.");

const roots = new Set(["classes", "did_you_know", "generatedQuizRevisions", "generatedQuizzes", "terms", "users", "webSettings"]);
const privateProfileField = /password|passwd|passcode|token|secret|credential|apikey|session|nonce|salt|authEmail/i;
const credential = process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
  await readFile(process.env.IMARS_FIREBASE_CREDENTIAL_FILE, "utf8");
const source = new FirestoreAdmin({ FIREBASE_SERVICE_ACCOUNT_JSON: credential });
const prefix = source.name("users").slice(0, -"users".length);
const encodePath = path => path.split("/").map(encodeURIComponent).join("/");
const counts = {};
let omittedProfileFields = 0;

async function paginate(request, list) {
  const rows = [];
  let pageToken;
  do {
    const page = await request(pageToken);
    if (!page) throw new Error("Firestore did not return a snapshot page.");
    rows.push(...(page[list] || []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return rows;
}

function childCollections(parent, readTime) {
  return paginate(pageToken => source.request(parent ? "documents/" + encodePath(parent) + ":listCollectionIds" : "documents:listCollectionIds", {
    method: "POST",
    body: JSON.stringify({ pageSize: 100, readTime, ...(pageToken ? { pageToken } : {}) })
  }), "collectionIds");
}

function listDocuments(collection, readTime) {
  return paginate(pageToken => {
    const params = new URLSearchParams({ pageSize: "100", showMissing: "true", readTime, ...(pageToken ? { pageToken } : {}) });
    return source.request("documents/" + encodePath(collection) + "?" + params);
  }, "documents");
}

async function batches(items, operation) {
  const results = [];
  for (let start = 0; start < items.length; start += 8) {
    results.push(...await Promise.all(items.slice(start, start + 8).map(operation)));
  }
  return results.flat();
}

async function readSnapshot() {
  const initial = await source.request("documents:runQuery", { method: "POST", body: JSON.stringify({
    structuredQuery: { from: [{ collectionId: "classes" }], select: { fields: [{ fieldPath: "__name__" }] }, limit: 1 }
  }) });
  const readTime = initial?.find(row => row.readTime)?.readTime;
  if (!readTime) throw new Error("Firestore did not provide a snapshot timestamp.");
  const discovered = await childCollections("", readTime);
  if (discovered.some(root => root !== "_accountAccess" && !roots.has(root))) {
    throw new Error("An unclassified Firestore collection needs review before copying.");
  }
  let collections = discovered.filter(root => roots.has(root));
  const documents = new Map();
  while (collections.length) {
    const rows = await batches(collections, collection => listDocuments(collection, readTime));
    const paths = [];
    for (const row of rows) {
      if (!row.name?.startsWith(prefix)) throw new Error("Firestore returned an unexpected document path.");
      const path = row.name.slice(prefix.length);
      paths.push(path);
      // A deleted or absent parent can still have real subcollection records.
      if (!row.updateTime) continue;
      if (documents.has(path)) throw new Error("The Firestore snapshot contains duplicate paths.");
      const fields = row.fields || {};
      if (/^users\/[^/]+$/.test(path)) {
        for (const field of Object.keys(fields)) {
          if (privateProfileField.test(field)) {
            delete fields[field];
            omittedProfileFields++;
          }
        }
      }
      const collection = path.split("/").at(-2);
      counts[collection] = (counts[collection] || 0) + 1;
      documents.set(path, { path, source_read_time: readTime, source_updated_at: row.updateTime, fields });
    }
    collections = await batches(paths, async path => (await childCollections(path, readTime)).map(id => path + "/" + id));
  }
  if (!documents.size) throw new Error("The Firestore application snapshot is empty.");
  return documents;
}

const canonical = value => JSON.stringify(value, (_key, item) => (
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
    : item
));

async function writeSnapshot(documents) {
  const project = new URL(process.env.IMARS_SUPABASE_URL || "about:blank");
  const key = process.env.SUPABASE_SECRET_KEY || "";
  if (project.protocol !== "https:" || !/^[a-z0-9]+\.supabase\.co$/.test(project.host) ||
      project.href !== project.origin + "/" || !/^sb_secret_\S+$/.test(key)) throw new Error("Set the Supabase project URL and server secret.");
  const snapshotId = crypto.randomUUID();
  const filter = { snapshot_id: "eq." + snapshotId };
  async function request(method, params, body) {
    const url = new URL("/rest/v1/imars_app_snapshots", project);
    url.search = new URLSearchParams(params);
    const response = await fetch(url, {
      method, redirect: "error", headers: { apikey: key, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) throw new Error("Supabase " + method + " failed with HTTP " + response.status + ".");
    if (method === "GET") return response.json();
  }
  await request("GET", { ...filter, select: "path", limit: "1" });
  let checked = 0;
  try {
    let rows = [];
    let bytes = 0;
    for (const document of documents.values()) {
      const row = { ...document, snapshot_id: snapshotId };
      const size = Buffer.byteLength(JSON.stringify(row));
      if (rows.length && (rows.length === 100 || bytes + size > 2_000_000)) {
        await request("POST", {}, rows);
        rows = [];
        bytes = 0;
      }
      rows.push(row);
      bytes += size;
    }
    if (rows.length) await request("POST", {}, rows);
    const remaining = new Set(documents.keys());
    for (;;) {
      const page = await request("GET", {
        ...filter, select: "path,source_read_time,source_updated_at,fields",
        order: "path.asc", limit: "25", offset: String(checked)
      });
      for (const row of page) {
        if (!remaining.delete(row.path) || canonical(documents.get(row.path)) !== canonical(row)) {
          throw new Error("A staged Supabase record did not match the Firestore snapshot.");
        }
      }
      checked += page.length;
      if (page.length < 25) break;
    }
    if (remaining.size) throw new Error("The staged Supabase snapshot is incomplete.");
    return snapshotId;
  } catch (error) {
    await request("DELETE", filter);
    if ((await request("GET", { ...filter, select: "path", limit: "1" })).length) {
      throw new Error("The failed staging snapshot could not be cleaned up.");
    }
    throw error;
  }
}

try {
  const documents = await readSnapshot();
  const snapshotId = mode === "--stage" ? await writeSnapshot(documents) : undefined;
  console.log(JSON.stringify({ mode, records: documents.size, counts, omittedProfileFields, snapshotId }));
} catch (error) {
  console.error(error.upstreamStatus ? "Firestore returned HTTP " + error.upstreamStatus + "." : error.message);
  process.exitCode = 1;
}
