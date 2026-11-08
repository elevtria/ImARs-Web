import { FirestoreAdmin, serviceAccount } from "./firestore-admin.js";
import { stateCall, resolveStaff, settings } from "./web-auth.js";
import { authenticateStudent, studentContext, quizRate } from "./student-quiz-auth.js";
import { openTeacherSession, checkTeacherSession } from "./teacher-sessions.js";

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
  const teacherSessions = env.TEACHER_MOBILE_SESSIONS_ENABLED === "true" || enabled;
  const mobileAction = ["teacher-session-login", "mobile-session"].includes(action);
  const progressAction = action === "progress-synced" && env.DASHBOARD_SUMMARIES_ENABLED === "true";
  if (action === "config" && request.method === "GET") {
    if (!enabled) return json({ enabled: false, ...(teacherSessions ? { teacherSessions: true } : {}), ...(teacherSessions && env.TEACHER_SESSION_SYNC_ENABLED === "true" ? { teacherSessionSync: true } : {}) });
    try { serviceAccount(env); if (!env.WEB_LOGIN_STATE) throw new Error(); return json({ enabled: true }); }
    catch { return json({ error: "Account access setup needs website maintenance." }, 503); }
  }
  if (!enabled && !(teacherSessions && mobileAction) && !progressAction) return json({ error: "Account access is not enabled." }, 409);
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
    else if (ip && action !== "mobile-session" && !progressAction) {
      const limited = await stateCall(env, "account-access-ip:" + ip, "rate");
      if (!limited.ok) return json({ error: "Too many requests. Please wait a minute." }, limited.status === 429 ? 429 : 503);
    }

    if (progressAction) {
      // This accepts no scores, profile IDs or teacher IDs from the device.
      // The token and current class determine the only rollup it can invalidate.
      if (Object.keys(body).some(key => !["termId", "lessonId"].includes(key)) || !/^term_0[1-3]$/.test(body.termId) || !/^lesson_0[1-4]$/.test(body.lessonId)) throw fail("Invalid progress notification.", 400);
      const identity = await authenticateStudent(request, env, store, { fetcher });
      await quizRate(env, identity.uid);
      const { context } = await studentContext(identity, env, store);
      const classes = await store.query("classes", { filters: [{ field: "teacherId", value: context.teacherProfileId }] });
      const prepared = await stateCall(env, "dashboard:" + context.teacherUid, "dashboard-get", {
        id: context.teacherProfileId, uid: context.teacherUid, warmOnly: true,
        sections: classes.map(row => ({ id: row.id, name: String(row.data.SectionName || row.id).slice(0, 300) }))
      });
      if (!prepared.ok) throw new Error("Dashboard preparation unavailable");
      const updated = await stateCall(env, "dashboard:" + context.teacherUid, "dashboard-dirty", { ids: [context.studentId], lesson: body.termId + "/lessons/" + body.lessonId });
      if (!updated.ok) throw new Error("Dashboard update unavailable");
      return json({ ok: true });
    }

    if (mobileAction) {
      const idToken = request.headers.get("Authorization")?.match(/^Bearer (\S{1,8192})$/)?.[1];
      if (!idToken) throw fail("Please sign in first.", 401);
      const proof = await identity("accounts:lookup", { idToken }, fetcher), user = proof.users?.[0];
      if (!user?.localId || user.disabled || !user.emailVerified || !email(user.email)) throw fail("Please sign in again.", 403);
      const linked = await store.findUser(user.localId);
      const account = linked ? await resolveStaff(env, linked.id, settings(env), store) : null;
      const data = linked?.data || (linked ? (await store.get("users/" + linked.id))?.data : null);
      if (!account || account.role !== "teacher" || account.uid !== user.localId || email(account.email) !== email(user.email) ||
          !available(data) || data.status === "disabled" || data.uid !== user.localId || data.role !== "teacher") throw fail("This teacher account could not be verified.", 403);
      if (action === "teacher-session-login") {
        if (typeof body.password !== "string" || !body.password || body.password.length > 4096) throw fail("Enter your password.", 400);
        const signedIn = await identity("accounts:signInWithPassword", { email: account.email, password: body.password, returnSecureToken: true }, fetcher);
        if (signedIn.localId !== account.uid || !signedIn.idToken || signedIn.mfaPendingCredential) throw fail("Please sign in again.", 401);
        const opened = await stateCall(env, `account:${account.uid}`, "mobile-login", {});
        if (!opened.ok) throw new Error("Mobile sign-in unavailable");
        await openTeacherSession(env, store, account, "mobile", opened.result.mobileSession);
        return json({ ok: true, profileId: account.id, role: "teacher", uid: account.uid, mobileSession: opened.result.mobileSession });
      }
      if (typeof body.mobileSession !== "string" || !/^[a-f0-9]{64}$/.test(body.mobileSession)) throw fail("Please sign in again.", 401);
      const limited = await stateCall(env, `mobile-session-rate:${account.uid}`, "rate");
      if (!limited.ok) throw fail("Please wait before checking your session again.", limited.status === 429 ? 429 : 503);
      const checked = await stateCall(env, `account:${account.uid}`, "mobile-session", { mobileSession: body.mobileSession });
      if (!checked.ok) throw fail("Please sign in again.", checked.status === 401 ? 401 : 503);
      if (!await checkTeacherSession(env, store, account, "mobile", body.mobileSession)) throw fail("Please sign in again.", 401);
      return json({ ok: true, profileId: account.id, role: "teacher" });
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
      if (roleOf(candidate) === "teacher" && candidate.uid) {
        const opened = await stateCall(env, `account:${candidate.uid}`, "mobile-login", {});
        if (!opened.ok) throw new Error("Mobile sign-in unavailable");
        await openTeacherSession(env, store, { id, uid: candidate.uid, role: "teacher" }, "mobile", opened.result.mobileSession);
        return json({ email: loginEmail, uid: candidate.uid, mobileSession: opened.result.mobileSession });
      }
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
        return json({ ok: true, profileId: id, role });
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
      return json({ ok: true, profileId: id, role });
    }
    return json({ error: "Not found." }, 404);
  } catch (error) {
    const status = [400, 401, 403, 409, 429].includes(error.status) ? error.status : 503;
    return json({ error: status === 503 ? "Account access is temporarily unavailable. Please retry or contact maintenance." : error.message }, status);
  }
}
