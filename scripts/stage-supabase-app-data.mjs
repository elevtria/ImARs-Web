import { readFile } from "node:fs/promises";
import { FirestoreAdmin } from "../server/firestore-admin.js";
import { sortableTimestamp, SupabaseAppStore, supabaseDocumentPath } from "../server/supabase-app-store.js";

const mode = process.argv[2] || "--plan";
const snapshotToVerify = process.argv[3];
if (!["--plan", "--stage", "--verify"].includes(mode) || process.argv.length > 4 ||
    (mode === "--verify" ? !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(snapshotToVerify || "") : snapshotToVerify !== undefined)) {
  throw new Error("Use --plan, --stage, or --verify <snapshot-id>.");
}

const roots = new Set(["_accountAccess", "classes", "did_you_know", "generatedQuizRevisions", "generatedQuizzes", "terms", "users", "webSettings"]);
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
  if (discovered.some(root => !roots.has(root))) {
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
      const destination = supabaseDocumentPath(path);
      if (documents.has(destination)) throw new Error("The Firestore snapshot contains duplicate paths.");
      if (path === "webSettings/accountAccess" || path.startsWith("webSettings/accountAccess/")) throw new Error("The private Supabase path is already in use.");
      const fields = row.fields || {};
      if (/^users\/[^/]+$/.test(path)) {
        for (const field of Object.keys(fields)) {
          if (field !== "webInvitationNonce" && privateProfileField.test(field)) {
            delete fields[field];
            omittedProfileFields++;
          }
        }
      }
      const collection = path.split("/").at(-2);
      if (collection === "generated_quiz_attempts" && typeof fields.submittedAt?.timestampValue === "string") {
        fields.submittedAt = { timestampValue: sortableTimestamp(fields.submittedAt.timestampValue) };
      }
      counts[collection] = (counts[collection] || 0) + 1;
      documents.set(destination, { path: destination, source_read_time: readTime, source_updated_at: row.updateTime, fields });
    }
    collections = await batches(paths, async path => (await childCollections(path, readTime)).map(id => path + "/" + id));
  }
  if (!counts.classes || !counts.users || !counts.lessons) throw new Error("The Firestore snapshot is missing classes, profiles, or lessons.");
  if (mode !== "--plan") {
    // Cloudflare already saves this setting to Supabase. The Firestore copy may be older.
    const path = "webSettings/schoolYear";
    const [year] = (await new SupabaseAppStore(process.env).rawDocuments([path])).values();
    if (!year) throw new Error("The live school year is missing from Supabase.");
    documents.set(path, { path, source_read_time: readTime, source_updated_at: year.update_time, fields: year.fields });
  }
  return documents;
}

const canonical = value => JSON.stringify(value, (_key, item) => (
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
    : item
));

async function snapshotAccess(documents, existing) {
  const project = new URL(process.env.IMARS_SUPABASE_URL || "about:blank");
  const key = process.env.SUPABASE_SECRET_KEY || "";
  if (project.protocol !== "https:" || !/^[a-z0-9]+\.supabase\.co$/.test(project.host) ||
      project.href !== project.origin + "/" || !/^sb_secret_\S+$/.test(key)) throw new Error("Set the Supabase project URL and server secret.");
  const snapshotId = existing || crypto.randomUUID();
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
  let checked = 0;
  async function verify() {
    const remaining = new Set(documents.keys());
    for (;;) {
      const page = await request("GET", {
        ...filter, select: "path,source_read_time,source_updated_at,fields",
        order: "path.asc", limit: "25", offset: String(checked)
      });
      for (const row of page) {
        const wanted = documents.get(row.path);
        if (!remaining.delete(row.path) || canonical({ ...wanted, source_read_time: row.source_read_time }) !== canonical(row)) {
          throw new Error("A staged Supabase record differs from the current source.");
        }
      }
      checked += page.length;
      if (page.length < 25) break;
    }
    if (remaining.size) throw new Error("The staged Supabase snapshot is incomplete.");
    return snapshotId;
  }
  if (existing) return verify();
  await request("GET", { ...filter, select: "path", limit: "1" });
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
    return await verify();
  } catch (error) {
    await request("DELETE", filter);
    if ((await request("GET", { ...filter, select: "path", limit: "1" })).length) {
      throw new Error("The failed staging snapshot could not be cleaned up.");
    }
    throw error;
  }
}

async function verifySeededDataset(documents, dataset) {
  const store = new SupabaseAppStore({ ...process.env, IMARS_SUPABASE_APP_DATASET_ID: dataset });
  const paths = [...documents.keys()];
  for (let index = 0; index < paths.length; index += 100) {
    const batch = paths.slice(index, index + 100);
    const rows = await store.rawDocuments(batch);
    for (const path of batch) {
      const source = documents.get(path), row = rows.get(path);
      if (!row || row.update_time !== source.source_updated_at || canonical(row.fields) !== canonical(source.fields)) {
        throw new Error("The seeded Supabase dataset does not match the staged source.");
      }
    }
  }
  const response = await store.documents("HEAD", { select: "path", limit: "1" });
  if (Number(response.headers.get("Content-Range")?.split("/").at(-1)) !== paths.length) {
    throw new Error("The seeded Supabase dataset contains unexpected records.");
  }
}

try {
  const documents = await readSnapshot();
  const snapshotId = mode === "--plan" ? undefined : await snapshotAccess(documents, snapshotToVerify);
  const target = process.env.IMARS_SUPABASE_TARGET_DATASET_ID;
  if (mode === "--verify" && target) await verifySeededDataset(documents, target);
  console.log(JSON.stringify({ mode, records: documents.size, counts, omittedProfileFields, snapshotId,
    sourceReadTime: documents.values().next().value.source_read_time, verifiedTarget: mode === "--verify" ? target : undefined }));
} catch (error) {
  console.error(error.upstreamStatus ? "Firestore returned HTTP " + error.upstreamStatus + "." : error.message);
  process.exitCode = 1;
}
