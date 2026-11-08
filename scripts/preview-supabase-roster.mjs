import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { onRequest } from "../functions/_middleware.js";
import { FirestoreAdmin } from "../server/firestore-admin.js";
import { quizReview } from "../server/quiz-review.js";
import { authApi, settings } from "../server/web-auth.js";
import { webData } from "../server/web-data.js";
import { WebLoginState } from "../workers/web-auth-worker.js";

const origin = "http://localhost:61339";
const snapshot = process.env.IMARS_SUPABASE_SNAPSHOT_ID || "";
const key = process.env.SUPABASE_SECRET_KEY || "";
const project = new URL(process.env.IMARS_SUPABASE_URL || "about:blank");
if (project.protocol !== "https:" || !/^[a-z0-9]+\.supabase\.co$/.test(project.hostname) ||
    project.origin + "/" !== project.href || !/^sb_secret_\S+$/.test(key) ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(snapshot)) {
  throw new Error("Set the Supabase project URL, server secret, and snapshot ID.");
}

const staff = process.env.WEB_STAFF_ACCOUNTS || await readFile(process.env.IMARS_PREVIEW_STAFF_FILE, "utf8");
const credential = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || await readFile(process.env.IMARS_FIREBASE_CREDENTIAL_FILE, "utf8");
const actors = new Map();
const env = {
  WEB_LOGIN_ENABLED: "true",
  WEB_DATA_ENABLED: "true",
  WEB_SESSION_SECRET: randomBytes(32).toString("hex"),
  WEB_STAFF_ACCOUNTS: staff,
  FIREBASE_SERVICE_ACCOUNT_JSON: credential,
  WEB_LOGIN_STATE: {
    idFromName: name => name,
    get(name) {
      if (!actors.has(name)) {
        const values = new Map();
        const storage = {
          get: async field => structuredClone(values.get(field)),
          put: async (field, value) => { values.set(field, structuredClone(value)); }
        };
        actors.set(name, new WebLoginState({ storage }, env));
      }
      return { fetch: (url, options) => actors.get(name).fetch(new Request(url, options)) };
    }
  }
};
settings(env);
const live = new FirestoreAdmin(env);
const fields = ["role", "classCode", "teacherId", "active"];
const drift = () => Object.assign(new Error("The roster has changed since this copy was made. Refresh the snapshot before testing."), { status: 409 });

async function staged(method, collection, { filters = [], limit, after } = {}) {
  const url = new URL("/rest/v1/imars_migration_documents", project);
  url.search = new URLSearchParams({
    snapshot_id: "eq." + snapshot,
    select: "path,data,source_updated_at",
    and: "(path.like." + collection + "/*" + (after ? ",path.gt." + collection + "/" + after : "") + ")",
    order: "path.asc",
    ...(limit ? { limit: String(limit) } : {}),
    ...Object.fromEntries(filters.map(({ field, value }) => ["data->>" + field, "eq." + value]))
  });
  const response = await fetch(url, {
    method, redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { apikey: key, ...(method === "HEAD" ? { Prefer: "count=exact" } : {}) }
  });
  if (!response.ok) throw new Error("The Supabase roster is unavailable.");
  if (method === "HEAD") {
    const count = response.headers.get("Content-Range")?.match(/\/(\d+)$/);
    if (!count) throw new Error("The Supabase roster count is unavailable.");
    return Number(count[1]);
  }
  return (await response.json()).map(row => ({
    id: row.path.split("/").at(-1), data: row.data, updateTime: row.source_updated_at
  }));
}

function previewRoster() {
  const roster = Object.create(live);
  roster.count = (collection, filters) => staged("HEAD", collection, { filters, limit: 1 });
  roster.query = async (collection, options) => {
    const rows = await staged("GET", collection, options);
    if (collection === "classes") {
      // A stale section assignment must never grant access to its roster.
      const current = await live.query(collection, { ...options, fieldPaths: ["teacherId"] });
      if (current.length !== rows.length || current.some((row, i) => row.id !== rows[i].id)) throw drift();
    } else if (rows.length) {
      const paths = rows.map(row => "users/" + row.id);
      const current = await live.getAll(paths, { fieldPaths: fields });
      if (rows.some((row, i) => {
        const profile = current.get(paths[i])?.data;
        return !profile || fields.some(field => profile[field] !== row.data[field]);
      })) throw drift();
    }
    return rows;
  };
  return roster;
}

const staticRoot = resolve("dist");
await readFile(resolve(staticRoot, "student-records.html"));
if (await staged("HEAD", "classes", { limit: 1 }) === 0) throw new Error("The Supabase snapshot has no classes.");
if (process.argv[2] === "--check") {
  const teacher = settings(env).find(account => account.role === "teacher");
  assert.ok(teacher, "The preview requires an approved teacher.");
  const roster = previewRoster();
  const classes = await roster.query("classes", { filters: [{ field: "teacherId", value: teacher.id }] });
  let checked = 0;
  for (const section of classes) {
    const filters = [{ field: "role", value: "student" }, { field: "classCode", value: section.id }];
    const archived = [...filters, { field: "active", value: false }];
    assert.equal(await roster.count("users", filters), await live.count("users", filters));
    assert.equal(await roster.count("users", archived), await live.count("users", archived));
    const page = await roster.query("users", { filters, limit: 25 });
    if (page.length < 25) continue;
    const after = page.at(-1).id;
    const next = await roster.query("users", { filters, limit: 25, after });
    assert.ok(next.every(row => row.id > after));
    checked++;
  }
  console.log(JSON.stringify({ assignedSectionsChecked: classes.length, paginationChecks: checked }));
  process.exit(0);
}
const mime = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".zip": "application/zip"
};
const allowedAuth = new Set(["config", "login", "identity", "session", "logout"]);
const allowedData = new Set([
  "student-page", "dashboard-summary", "teacher-report-page", "teacher-topic-overview",
  "get", "query", "reads"
]);
const allowedPages = new Set([
  "/login", "/index", "/student-records", "/topic-scheduler", "/quiz-generator",
  "/analytics", "/batch-upload", "/offline-sync", "/sync-offline-results", "/teacher-manual"
]);
const unavailable = () => Response.json({ error: "This preview is read-only." }, { status: 403 });

async function dispatch(context) {
  const { request } = context;
  const path = decodeURIComponent(new URL(request.url).pathname);
  if (path.startsWith("/api/web-auth/")) {
    return allowedAuth.has(path.split("/").at(-1)) ? authApi(context, Date.now(), { store: live }) : unavailable();
  }
  if (path === "/api/web-data/school-year") return webData(context, { store: live });
  if (["/api/web-data", "/api/quiz-review/action"].includes(path) && request.method === "POST") {
    // Inspect a bounded copy while retaining the original verified request.
    const length = Number(request.headers.get("Content-Length"));
    if (!Number.isSafeInteger(length) || length <= 0 || length > 1_000_000) return unavailable();
    const body = await request.clone().json();
    if (path === "/api/quiz-review/action") {
      return ["list", "open"].includes(body?.action) ? quizReview(context) : unavailable();
    }
    if (!allowedData.has(body?.action)) return unavailable();
    const isRoster = body.action === "student-page";
    const response = await webData(context, { store: isRoster ? previewRoster() : live });
    if (isRoster && response.ok) response.headers.set("X-Imars-Roster-Source", "supabase-staging");
    return response;
  }
  if (request.method !== "GET" || path.startsWith("/api/")) return unavailable();
  const page = path === "/" ? "/index" : path.replace(/\.html$/, "");
  const asset = path.startsWith("/assets/");
  if (!asset && !allowedPages.has(page)) return unavailable();
  const file = resolve(staticRoot, "." + (asset ? path : page + ".html"));
  const allowedRoot = asset ? resolve(staticRoot, "assets") : staticRoot;
  if (!file.startsWith(allowedRoot + sep) || !mime[extname(file)]) return new Response(null, { status: 404 });
  try {
    return new Response(await readFile(file), {
      headers: { "Content-Type": mime[extname(file)], "Cache-Control": "private, no-store" }
    });
  } catch (error) {
    if (error.code === "ENOENT") return new Response(null, { status: 404 });
    throw error;
  }
}

createServer(async (incoming, outgoing) => {
  try {
    if (incoming.headers.host !== new URL(origin).host || !incoming.url?.startsWith("/") || incoming.url.startsWith("//")) {
      outgoing.writeHead(421).end();
      return;
    }
    const method = incoming.method;
    const request = new Request(origin + incoming.url, {
      method, headers: incoming.headers,
      ...(["GET", "HEAD"].includes(method) ? {} : { body: Readable.toWeb(incoming), duplex: "half" })
    });
    const response = await onRequest({ request, env, next: () => dispatch({ request, env }) });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    if (!outgoing.headersSent) outgoing.writeHead(503, { "Cache-Control": "no-store" });
    outgoing.end("The local roster preview could not complete the request.");
  }
}).listen(61339, "127.0.0.1", () => console.log("ImARs roster preview: " + origin + "/login"));
