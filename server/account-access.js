import { FirestoreAdmin, serviceAccount } from "./firestore-admin.js";
import { stateCall } from "./web-auth.js";

const publicFirebaseKey = "AIzaSyBwH8D-mJSpjqu_C7Y7e7ljCjSZiO7FTm0";
const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const fail = (message, status) => Object.assign(new Error(message), { status });
const normalizeId = value => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value.trim())) throw fail("Enter your school ID.", 400);
  const id = value.trim().toUpperCase();
  return /^\d+$/.test(id) ? id.padStart(10, "0") : id;
};
const email = value => typeof value === "string" ? value.trim().toLowerCase() : "";
const approvedEmail = data => email(data.providedEmail || data.email);
const available = data => data && data.active !== false && String(data.status || "").toLowerCase() !== "inactive";
const claimed = data => !!data.uid || data.isClaimed === true || data.isRegistered === true;
const roleOf = data => data.role || (data.classCode ? "student" : "");

async function identity(path, body, fetcher) {
  const response = await fetcher("https://identitytoolkit.googleapis.com/v1/" + path + "?key=" + publicFirebaseKey, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000)
  });
  const result = await response.json();
  if (!response.ok) {
    const code = result.error?.message;
    if (["INVALID_PASSWORD", "INVALID_LOGIN_CREDENTIALS", "EMAIL_NOT_FOUND", "INVALID_ID_TOKEN", "TOKEN_EXPIRED", "USER_DISABLED"].includes(code)) {
      throw fail("Your ID, password or session could not be verified.", 401);
    }
    throw fail("Sign-in is temporarily unavailable. Please retry.", 503);
  }
  return result;
}

export async function accountAccess({ request, env }, { store, fetcher = fetch, rate } = {}) {
  const enabled = env.ACCOUNT_ACCESS_ENABLED === "true";
  const url = new URL(request.url), action = url.pathname.replace(/\/$/, "").split("/").at(-1);
  if (action === "config" && request.method === "GET") {
    if (!enabled) return json({ enabled: false });
    try { serviceAccount(env); if (!env.WEB_LOGIN_STATE) throw new Error(); return json({ enabled: true }); }
    catch { return json({ error: "Account access setup needs website maintenance." }, 503); }
  }
  if (!enabled) return json({ error: "Account access is not enabled." }, 409);
  if (request.method !== "POST") return json({ error: "Use POST." }, 405);
  if (request.headers.has("Origin") && request.headers.get("Origin") !== url.origin) return json({ error: "Invalid request origin." }, 403);
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) return json({ error: "Use JSON." }, 415);
  try {
    if (!store) { serviceAccount(env); if (!env.WEB_LOGIN_STATE) throw new Error(); store = new FirestoreAdmin(env, fetcher); }
    if (Number(request.headers.get("Content-Length") || 0) > 8192) return json({ error: "Request too large." }, 413);
    const text = await request.text();
    if (new TextEncoder().encode(text).length > 8192) return json({ error: "Request too large." }, 413);
    let body;
    try { body = JSON.parse(text); } catch { throw fail("Invalid request.", 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw fail("Invalid request.", 400);
    const ip = request.headers.get("CF-Connecting-IP");
    if (rate) await rate();
    else if (ip) {
      const limited = await stateCall(env, "account-access-ip:" + ip, "rate");
      if (!limited.ok) return json({ error: "Too many requests. Please wait a minute." }, limited.status === 429 ? 429 : 503);
    }

    if (action === "login") {
      const id = normalizeId(body.identifier);
      if (typeof body.password !== "string" || !body.password || body.password.length > 4096) throw fail("Enter your password.", 400);
      const profile = await store.get("users/" + id);
      const candidate = profile?.data;
      const access = candidate?.uid ? await store.get("_accountAccess/" + candidate.uid) : null;
      const loginEmail = candidate?.uid ? email(access?.data.authEmail) : approvedEmail(candidate || {});
      if (!available(candidate) || !loginEmail || (candidate.uid && (!access || access.data.active !== true || access.data.profileId !== id || access.data.role !== roleOf(candidate)))) {
        throw fail("Your ID or password could not be verified.", 401);
      }
      const result = await identity("accounts:signInWithPassword", { email: loginEmail, password: body.password, returnSecureToken: true }, fetcher);
      if (!result.localId || !result.idToken || result.mfaPendingCredential ||
          email(result.email) !== loginEmail || (candidate.uid && candidate.uid !== result.localId)) {
        throw fail("Your ID or password could not be verified.", 401);
      }
      // Password proof is required before revealing the login address. Firebase
      // SDK sign-in and verification continue in the mobile client as before.
      return json({ email: loginEmail });
    }
    if (action === "invitation") {
      const id = normalizeId(body.identifier);
      if (!["student", "teacher"].includes(body.role) || !email(body.email)) throw fail("Enter your assigned email and school ID.", 400);
      const profile = await store.get("users/" + id);
      const data = profile?.data;
      if (!available(data) || claimed(data) || roleOf(data) !== body.role || approvedEmail(data) !== email(body.email)) {
        throw fail("This ID and assigned email are not available for registration. Please contact your teacher or administrator.", 403);
      }
      // No profile, assigned email, class, UID or results are returned publicly.
      return json({ approved: true });
    }
    if (action === "claim") {
      const idToken = request.headers.get("Authorization")?.match(/^Bearer (\S{1,8192})$/)?.[1];
      if (!idToken) throw fail("Please sign in first.", 401);
      const result = await identity("accounts:lookup", { idToken }, fetcher);
      const user = result.users?.[0];
      if (!user?.localId || user.disabled || !user.emailVerified || !email(user.email)) throw fail("Verify your assigned email, then sign in again.", 403);
      const uid = user.localId;
      const existing = await store.get("_accountAccess/" + uid);
      let id = body.identifier ? normalizeId(body.identifier) : existing?.data.profileId;
      if (!id) id = (await store.findUser(uid))?.id;
      if (!id) throw fail("Your school profile could not be linked. Contact your teacher or administrator.", 403);
      id = normalizeId(id);
      const profile = await store.get("users/" + id), data = profile?.data;
      const expectedEmail = existing ? email(existing.data.authEmail) : approvedEmail(data || {});
      if (!available(data) || expectedEmail !== email(user.email) || (data.uid && data.uid !== uid)) {
        throw fail("Your school profile could not be linked. Contact your teacher or administrator.", 403);
      }
      const role = roleOf(data);
      if (existing) {
        if (existing.data.active !== true || existing.data.profileId !== id || existing.data.role !== role || data.uid !== uid) throw fail("Account access needs administrator review.", 403);
        return json({ ok: true, profileId: id });
      }
      // Existing accounts, especially staff, must be independently approved in
      // the migration manifest. Registration may claim only an unused invitation.
      if (claimed(data) || !["student", "teacher"].includes(role)) throw fail("Account access needs administrator setup.", 403);
      const linked = await store.findUser(uid);
      if (linked) throw fail(linked.id === id ? "Account state changed. Please retry signing in."
        : "This sign-in is already linked to a school profile. Contact your administrator.", linked.id === id ? 409 : 403);
      const name = String(user.displayName || data.displayName || data.fullName || "").trim().slice(0, 200);
      const updates = { uid, role, isRegistered: true, displayName: name, fullName: name };
      if (role === "student") Object.assign(updates, { isClaimed: true, hasSeenClassCode: false,
        gamification: data.gamification || { badgeCounts: {} } });
      if (role === "teacher") updates.status = "active";
      await store.activate(id, profile, uid, updates, role, email(user.email));
      return json({ ok: true, profileId: id });
    }
    return json({ error: "Not found." }, 404);
  } catch (error) {
    const status = [400, 401, 403, 409, 429].includes(error.status) ? error.status : 503;
    return json({ error: status === 503 ? "Account access is temporarily unavailable. Please retry or contact maintenance." : error.message }, status);
  }
}
