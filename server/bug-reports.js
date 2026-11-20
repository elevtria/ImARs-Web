import { appStore, SupabaseAppStore, supabaseWebData } from "./supabase-app-store.js";
import { FirestoreAdmin } from "./firestore-admin.js";
import { requireStaff, readJson, stateCall } from "./web-auth.js";
import { authenticateStudent, activeProfile } from "./student-quiz-auth.js";

export const reportCategories = ["Sign-in or account", "AR camera or scanning", "Lesson or activity", "Quiz, score, or progress", "Sound or display", "Slow, frozen, or crashed", "Loading or connection", "Other"];
const states = ["new", "in-progress", "resolved"];
const key = value => typeof value === "string" && /^\d{13}_[a-f0-9]{32}$/.test(value);
const text = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

export async function bugReports({ request, env }, { store, identityStore, staffAuth = requireStaff,
  mobileAuth = authenticateStudent, rate = stateCall, now = Date.now } = {}) {
  let transaction = false;
  try {
    if (request.method !== "POST") throw fail("Use POST.", 405);
    if (!request.headers.get("Content-Type")?.startsWith("application/json")) throw fail("Use JSON.", 415);
    const action = new URL(request.url).pathname.split("/").filter(Boolean).at(-1);
    store ??= supabaseWebData(env) ? new SupabaseAppStore(env, fetch, { mirrorToFirestore: false }) : appStore(env);
    if (action === "submit") {
      identityStore ??= new FirestoreAdmin(env);
      const identity = await mobileAuth(request, env, identityStore);
      // Prefer the migrated profile so Firestore quota failures cannot block a
      // report from a student whose records already live in Supabase.
      let profile = await store.findUser(identity.uid);
      let profileStore = store;
      if (!profile) {
        profile = await identityStore.findUser(identity.uid);
        profileStore = identityStore;
      }
      if (!profile || !activeProfile(profile.data) || profile.data.role !== "student") throw fail("An active student account is required.", 403);
      const binding = await profileStore.get("_accountAccess/" + identity.uid);
      if (binding ? binding.data.active !== true || binding.data.role !== "student" || binding.data.profileId !== profile.id ||
          String(binding.data.authEmail || "").toLowerCase() !== identity.email : env.ACCOUNT_ACCESS_ENABLED === "true") {
        throw fail("Please sign in again or contact your teacher.", 403);
      }
      const primaryProfile = await store.get("users/" + profile.id);
      if (primaryProfile && !activeProfile(primaryProfile.data)) throw fail("This account is inactive.", 403);
      const limited = await rate(env, "bug-reports:" + identity.uid, "rate");
      if (!limited.ok) throw fail("Please wait before sending another report.", limited.status === 429 ? 429 : 503);
      const body = await readJson(request, 8192);
      if (!body || Array.isArray(body) || Object.keys(body).some(field => !["requestId", "category", "issue", "description", "appVersion", "platform", "scene"].includes(field)) ||
          !/^[a-f0-9]{32}$/.test(body.requestId || "") || !reportCategories.includes(body.category) || !text(body.issue, 120) ||
          !text(body.description, 1000) || !text(body.appVersion, 40) || !text(body.platform, 40) || !text(body.scene, 120)) throw fail("Enter a valid issue and description.");
      const receiptKey = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity.uid + ":" + body.requestId))), byte => byte.toString(16).padStart(2, "0")).join("");
      const receiptPath = "bugReportSubmissions/" + receiptKey;
      await store.begin(); transaction = true;
      const receipt = await store.get(receiptPath);
      if (receipt) { await store.rollback(); transaction = false; return json({ ok: true, id: receipt.data.reportId }); }
      const createdAt = now();
      const id = String(9999999999999 - createdAt).padStart(13, "0") + "_" + crypto.randomUUID().replaceAll("-", "");
      const report = { reporterId: profile.id, reporterName: String(profile.data.fullName || profile.data.displayName || profile.id).slice(0, 160),
        sectionId: String(profile.data.classCode || "").slice(0, 128), category: body.category, issue: body.issue.trim(), description: body.description.trim(),
        appVersion: body.appVersion.trim(), platform: body.platform.trim(), scene: body.scene.trim(), status: "new", createdAt: new Date(createdAt).toISOString() };
      await store.commit([{ operation: "set", path: "bugReports/" + id, data: report },
        { operation: "set", path: receiptPath, data: { reportId: id } }]); transaction = false;
      return json({ ok: true, id }, 201);
    }
    const actor = await staffAuth(request, env, store);
    if (actor.role !== "admin") throw fail("Administrator access is required.", 403);
    const body = await readJson(request, 4096);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw fail("Invalid request.");
    if (action === "list") {
      if (body.cursor != null && !key(body.cursor)) throw fail("Invalid report cursor.");
      const rows = await store.query("bugReports", { limit: 26, ...(body.cursor ? { after: body.cursor } : {}) });
      return json({ reports: rows.slice(0, 25).map(({ id, data }) => ({ id, ...Object.fromEntries([
        "reporterId", "reporterName", "sectionId", "category", "issue", "description", "appVersion", "platform", "scene", "status", "createdAt", "updatedAt"
      ].map(field => [field, data[field] ?? ""])) })), cursor: rows.length > 25 ? rows[24].id : null });
    }
    if (action !== "status" || !key(body.id) || !states.includes(body.status)) throw fail("Choose a valid report and status.");
    await store.begin(); transaction = true;
    const row = await store.get("bugReports/" + body.id);
    if (!row) throw fail("Report no longer exists.", 404);
    await store.commit([{ operation: "update", path: "bugReports/" + body.id, updateTime: row.updateTime,
      data: { status: body.status, updatedAt: new Date(now()).toISOString(), updatedBy: actor.id } }]); transaction = false;
    return json({ ok: true });
  } catch (error) {
    if (transaction) await store.rollback().catch(() => {});
    const status = [400, 401, 403, 404, 405, 409, 413, 415, 429].includes(error.status) ? error.status : 503;
    return json({ error: status === 503 ? "Bug reports are temporarily unavailable. Please try again." : error.message,
      code: status === 401 ? "unauthenticated" : status === 403 ? "permission-denied" : "unavailable" }, status);
  }
}
