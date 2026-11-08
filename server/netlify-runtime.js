import { getStore } from "@netlify/blobs";
import { NetlifyState } from "./netlify-state.js";

const keys = ["FIREBASE_SERVICE_ACCOUNT_JSON", "GEMINI_API_KEY", "WEB_SESSION_SECRET", "WEB_MAINTENANCE_KEY", "WEB_STAFF_ACCOUNTS",
  "STUDENT_QUIZ_CURSOR_SECRET", "STUDENT_SCHEDULE_ENABLED", "NETLIFY_BACKGROUND_SECRET", "URL", "NETLIFY_BACKUP_ENABLED",
  "IMARS_SUPABASE_WEB_SETTINGS", "IMARS_SUPABASE_URL", "IMARS_SUPABASE_APP_DATASET_ID", "SUPABASE_SECRET_KEY"];
// A deployment's identity-status cache must survive per-request env wrappers.
// Profile roles, active status and section ownership are still checked live.
const staffIdentityCacheKey = {};
export function netlifyEnvironment(read, { store = getStore({ name: "imars-private-backup", consistency: "strong" }), fetcher = fetch } = {}) {
  const env = Object.fromEntries(keys.map(key => [key, read(key)]));
  if (env.NETLIFY_BACKUP_ENABLED !== "true") throw new Error("Backup setup is incomplete");
  Object.assign(env, { staffIdentityCacheKey, WEB_LOGIN_ENABLED: "true", WEB_DATA_ENABLED: "true", STUDENT_QUIZZES_ENABLED: "true", TEACHER_MOBILE_SESSIONS_ENABLED: "true", DASHBOARD_SUMMARIES_ENABLED: "true", TEACHER_SESSION_SYNC_ENABLED: "true" });
  env.WEB_LOGIN_STATE = new NetlifyState(store, env, { fetcher, kick: job => dispatchJob(env, job, fetcher) });
  return { env, store };
}
const encoder = new TextEncoder();
async function proof(secret, message) {
  if (typeof secret !== "string" || secret.length < 32) throw new Error("Background setup is incomplete");
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return { key, bytes: await crypto.subtle.sign("HMAC", key, encoder.encode(message)) };
}
export async function dispatchJob(env, job, fetcher = fetch) {
  const origin = new URL(env.URL);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("Invalid backup origin");
  const text = JSON.stringify(job), timestamp = String(Date.now());
  const { bytes } = await proof(env.NETLIFY_BACKGROUND_SECRET, timestamp + "\n" + text);
  const signature = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
  const response = await fetcher(new URL("/.netlify/functions/jobs-background", origin), { method: "POST",
    headers: { "Content-Type": "application/json", "X-Imars-Job-Time": timestamp, "X-Imars-Job-Proof": signature }, body: text, signal: AbortSignal.timeout(5000) });
  if (response.status !== 202) throw new Error("Background job could not be queued");
}
export async function verifyJob(request, secret, now = Date.now()) {
  const text = await request.text();
  if (text.length > 4096) throw new Error("Invalid job");
  const timestamp = request.headers.get("X-Imars-Job-Time"), signature = request.headers.get("X-Imars-Job-Proof");
  if (!/^\d{13}$/.test(timestamp || "") || Math.abs(now - Number(timestamp)) > 60_000 || !/^[a-f0-9]{64}$/.test(signature || "")) throw new Error("Invalid job proof");
  const { key } = await proof(secret, "");
  if (!await crypto.subtle.verify("HMAC", key, Uint8Array.from(signature.match(/../g), byte => parseInt(byte, 16)), encoder.encode(timestamp + "\n" + text))) throw new Error("Invalid job proof");
  const job = JSON.parse(text);
  if (job.kind === "dashboard" && /^dashboard:[A-Za-z0-9_-]{1,128}$/.test(job.name)) return job;
  if (job.kind === "quiz" && /^[a-f0-9]{32}$/.test(job.id)) return job;
  throw new Error("Invalid job");
}
