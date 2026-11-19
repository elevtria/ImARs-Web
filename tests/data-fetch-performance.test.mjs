import test from "node:test";
import assert from "node:assert/strict";
import { queueClassDirectorySync, webData } from "../server/web-data.js";
import { fixture } from "./fixtures/web-data.js";
import { SupabaseAppStore } from "../server/supabase-app-store.js";
import { encodeFields } from "../server/firestore-admin.js";

test("directory maintenance is shared during a burst and throttled for five minutes", async () => {
  const env = { IMARS_SUPABASE_WEB_DATA: "true", IMARS_SUPABASE_URL: "https://performance.fixture", IMARS_SUPABASE_APP_DATASET_ID: "burst" };
  let finish, runs = 0, now = 0;
  const jobs = [], options = { now: () => now, run: () => { runs++; return new Promise(resolve => { finish = resolve; }); } };
  const first = queueClassDirectorySync(env, null, job => jobs.push(job), options);
  const second = queueClassDirectorySync(env, null, job => jobs.push(job), options);
  assert.equal(first, second);
  await Promise.resolve(); assert.equal(runs, 1);
  finish(); await first;
  now = 299_999;
  assert.equal(queueClassDirectorySync(env, null, job => jobs.push(job), options), undefined);
  now = 300_000;
  const next = queueClassDirectorySync(env, null, job => jobs.push(job), options);
  await Promise.resolve(); assert.equal(runs, 2); finish(); await next;
});

test("authorized roster reads finish while maintenance is pending; denied reads never schedule it", async () => {
  const f = fixture(), jobs = [];
  let finish, scheduled = 0;
  const work = new Promise(resolve => { finish = resolve; });
  const request = () => new Request("https://test.example/api/web-data", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "student-page", sectionId: "A", status: "active", search: "", limit: 25, includeCounts: false }) });
  const dependencies = { store: f.store, authenticate: async () => ({ id: "TEACH1000", uid: "teacher-a", role: "teacher" }),
    directorySync: (_env, _fetcher, waitUntil) => { scheduled++; waitUntil(work); return work; } };
  let timeout;
  try {
    const response = await Promise.race([webData({ request: request(), env: f.env, waitUntil: job => jobs.push(job) }, dependencies),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(Error("Roster response waited for maintenance")), 1000); })]);
    assert.equal(response.status, 200); assert.equal(scheduled, 1); assert.equal(jobs[0], work);
    assert.equal((await response.json()).students.length, 1);
    const denied = await webData({ request: request(), env: f.env, waitUntil: job => jobs.push(job) },
      { ...dependencies, authenticate: async () => { throw Object.assign(Error("Denied"), { status: 403 }); } });
    assert.equal(denied.status, 403); assert.equal(scheduled, 1);
  } finally { clearTimeout(timeout); finish(); }
});

test("reading an unchanged Supabase roster never mirrors profile writes to Firestore", async () => {
  const store = new SupabaseAppStore({ IMARS_SUPABASE_URL: "https://performance.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test",
    IMARS_SUPABASE_APP_DATASET_ID: "a176e0fd-0b7e-4840-99c5-413452160b6a" }, fetch, { mirrorToFirestore: false });
  let mirrored = 0, reads = 0;
  store.mirrorDocsToFirestore = async () => { mirrored++; };
  store.documents = async () => { reads++; return Response.json([{ path: "users/S1", fields: encodeFields({ role: "student", classCode: "A" }), update_time: "2026-11-19T00:00:00Z" }]); };
  const rows = await store.query("users");
  assert.equal(rows[0].data.classCode, "A"); assert.equal(reads, 1); assert.equal(mirrored, 0);
});
