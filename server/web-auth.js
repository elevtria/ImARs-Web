import { ABSOLUTE_AFTER_MS, validSessionId } from "./web-session.js";
import { serviceAccount, databaseQuotaFailure } from "./firestore-admin.js";
import { appStore } from "./supabase-app-store.js";
import { openTeacherSession, checkTeacherSession } from "./teacher-sessions.js";

const cookieName = "__Host-imars-web";
const encoder = new TextEncoder();
const json = (body, status = 200, headers = {}) => Response.json(body, {
  status, headers: { "Cache-Control": "no-store", ...headers }
});
export const enabled = env => env.WEB_LOGIN_ENABLED === "true";
export const dataEnabled = env => env.WEB_DATA_ENABLED === "true";
const reusableShells = new WeakSet();
export const isReusablePortalShell = response => reusableShells.has(response);
const staticPortalShells = new Set(["", "/index", "/topic-scheduler", "/quiz-generator", "/analytics", "/student-records", "/batch-upload",
  "/offline-sync", "/sync-offline-results", "/teacher-manual", "/admin-dashboard", "/admin-profile", "/manage-teachers", "/school-analytics"]);
const cookie = (token, age) => `${cookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict${age === 0 ? "; Max-Age=0" : ""}`;
const base64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
const unbase64 = text => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0));
const hmacKey = secret => crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
function logAuthFailure(phase, error) {
  const reasons = ["Web login protection is not configured", "Invalid staff roster", "An administrator is required", "Login state unavailable", "Account access unavailable", "Account access setup is incomplete"];
  console.warn(JSON.stringify({ event: "auth-unavailable", phase, reason: reasons.includes(error?.message) ? error.message : "unexpected", type: error?.name,
    causeType: error?.cause?.name, upstreamStatus: error?.cause?.upstreamStatus || error?.upstreamStatus }));
}

export function settings(env) {
  if (typeof env.WEB_SESSION_SECRET !== "string" || env.WEB_SESSION_SECRET.length < 32 || !env.WEB_LOGIN_STATE) {
    throw new Error("Web login protection is not configured");
  }
  const accounts = JSON.parse(env.WEB_STAFF_ACCOUNTS || "null");
  if (!Array.isArray(accounts) || !accounts.length || accounts.length > 500) throw new Error("Invalid staff roster");
  const ids = new Set(), uids = new Set(), emails = new Set();
  for (const account of accounts) {
    if (!account || typeof account.id !== "string" || !/^[A-Z0-9_-]{1,64}$/.test(account.id) ||
        typeof account.uid !== "string" || !account.uid || account.uid.length > 128 ||
        typeof account.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.email) ||
        !["teacher", "admin"].includes(account.role) || ids.has(account.id) || uids.has(account.uid) || emails.has(account.email.toLowerCase())) {
      throw new Error("Invalid or duplicate staff account");
    }
    ids.add(account.id); uids.add(account.uid); emails.add(account.email.toLowerCase());
  }
  if (!accounts.some(account => account.role === "admin")) throw new Error("An administrator is required");
  return accounts;
}

export async function stateCall(env, name, action, body) {
  const stub = env.WEB_LOGIN_STATE.get(env.WEB_LOGIN_STATE.idFromName(name));
  const response = await stub.fetch(`https://web-auth.internal/${action}`, body === undefined ? undefined : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  const result = await response.json();
  return { result, status: response.status, ok: response.ok };
}

export async function signSession(env, account, session, host, teacherSession) {
  const value = base64(encoder.encode(JSON.stringify({ uid: account.uid, role: account.role, id: account.id,
    version: session.version, family: session.family, sid: session.sid, aud: host,
    ...(account.role === "teacher" && teacherSession ? { teacherSession } : {}),
    iat: Math.floor(session.rotatedAt / 1000), exp: Math.floor(session.absoluteUntil / 1000) })));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(env.WEB_SESSION_SECRET), encoder.encode(value));
  return `${value}.${base64(new Uint8Array(signature))}`;
}

export async function resolveStaff(env, identifier, accounts = settings(env), store = appStore(env)) {
  const clean = identifier.trim().toLowerCase();
  const initial = accounts.find(item => item.id.toLowerCase() === clean || (item.role === "admin" && item.email.toLowerCase() === clean));
  if (!initial && dataEnabled(env) && (clean === "admin" || clean === "admin1")) {
    const administrators = accounts.filter(item => item.role === "admin");
    if (administrators.length === 1) return administrators[0];
  }
  const id = clean.toUpperCase();
  if (!dataEnabled(env) || !/^TEACH\d{4,10}$/.test(id)) return initial;
  const privateRecord = await stateCall(env, "staff-roster", "roster-get", { id });
  if (!privateRecord.ok) throw new Error("Staff invitations unavailable");
  const invitation = privateRecord.result.account;
  if (!invitation) return initial;
  if (!invitation.active) return null;
  const profile = await store.get("users/" + id);
  if (!profile?.data.uid || profile.data.webInvitationNonce !== invitation.nonce || profile.data.role !== "teacher") return null;
  return { id, uid: profile.data.uid, role: "teacher", email: invitation.email, requiresVerifiedEmail: true };
}

async function sessionClaims(request, env, now) {
  const value = request.headers.get("Cookie")?.split(/;\s*/).find(item => item.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  if (!value || value.length > 2048) return null;
  try {
    const parts = value.split(".");
    if (parts.length !== 2 || !await crypto.subtle.verify("HMAC", await hmacKey(env.WEB_SESSION_SECRET), unbase64(parts[1]), encoder.encode(parts[0]))) return null;
    const payload = JSON.parse(new TextDecoder().decode(unbase64(parts[0])));
    const time = Math.floor(now / 1000);
    if (typeof payload.uid !== "string" || !payload.uid || payload.uid.length > 128 || typeof payload.id !== "string" ||
        (request.headers.has("X-Web-User") && request.headers.get("X-Web-User") !== payload.uid) ||
        payload.aud !== new URL(request.url).host || !Number.isSafeInteger(payload.exp) ||
        payload.exp <= time || !Number.isSafeInteger(payload.iat) || payload.iat > time + 30 ||
        payload.exp <= payload.iat || payload.exp - payload.iat > ABSOLUTE_AFTER_MS / 1000 ||
        !validSessionId(payload.family) || !validSessionId(payload.sid) || !Number.isSafeInteger(payload.version)) return null;
    return payload;
  } catch { return null; }
}

async function inspectSession(request, env, { now = Date.now(), active = false, store } = {}) {
  const accounts = settings(env);
  const payload = await sessionClaims(request, env, now);
  if (!payload) return null;
  const credentials = { family: payload.family, sid: payload.sid, version: payload.version };
  try {
    const checked = await stateCall(env, `account:${payload.uid}`, "session", { ...credentials, active });
    if (checked.status === 401) return null;
    if (!checked.ok) throw new Error("Login state unavailable");
    const account = await resolveStaff(env, payload.id, accounts, store);
    if (!account || account.uid !== payload.uid || account.role !== payload.role) return null;
    if (!await checkTeacherSession(env, store || appStore(env), account, "web", payload.teacherSession)) return null;
    return { account, ...checked.result, credentials, teacherSession: payload.teacherSession };
  } catch (error) { throw new Error("Login state unavailable", { cause: error }); }
}

export async function webSession(request, env, now = Date.now(), store) {
  return (await inspectSession(request, env, { now, store }))?.account ?? null;
}

const identities = new WeakMap();
// Share the middleware's verified session only inside this exact Request.
// Roles and active status are still checked from the current staff profile.
const requestSessions = new WeakMap();
export async function staffProfile(account, store, now = Date.now()) {
  // The approved account supplies both IDs. Its live profile and Auth status
  // can be read independently; neither result grants access on its own.
  const pendingProfile = store.get("users/" + account.id).then(row => ({ row }), error => ({ error }));
  // Cache only Auth account status briefly; database role/active checks remain live.
  const key = store.env?.staffIdentityCacheKey || store.env || store;
  let cache = identities.get(key);
  if (!cache) { cache = new Map(); identities.set(key, cache); }
  let identity = cache.get(account.uid);
  if (!identity || identity.until <= now || (account.requiresVerifiedEmail && identity.user?.emailVerified !== true)) {
    const user = await store.identity(account.uid);
    identity = { user, until: now + 60_000 };
    if (cache.size >= 1000) cache.delete(cache.keys().next().value);
    cache.set(account.uid, identity);
  }
  const result = await pendingProfile;
  if (result.error) throw result.error;
  const row = result.row, profile = row?.data;
  if (!profile || profile.uid !== account.uid || String(profile.role || "").toLowerCase() !== account.role ||
      profile.active === false || ["inactive", "disabled"].includes(String(profile.status || "").toLowerCase())) {
    throw Object.assign(new Error("This account no longer has website access."), { status: 403 });
  }
  const user = identity.user;
  if (!user || user.disabled || user.email?.toLowerCase() !== account.email.toLowerCase()) {
    throw Object.assign(new Error("Your sign-in could not be verified. Please sign in again."), { status: 401 });
  }
  if (account.requiresVerifiedEmail && user.emailVerified !== true) {
    throw Object.assign(new Error("Verify your assigned email before signing in to the website."), { status: 403 });
  }
  return { ...account, profile, row };
}

export async function requireStaff(request, env, store = appStore(env)) {
  if (!dataEnabled(env) || !enabled(env)) throw Object.assign(new Error("Website account setup is incomplete."), { status: 503 });
  const origin = request.headers.get("Origin");
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get("Sec-Fetch-Site") === "cross-site") {
    throw Object.assign(new Error("Use the ImARs website."), { status: 403 });
  }
  const verified = requestSessions.get(request);
  const account = verified?.env === env ? verified.account : await webSession(request, env, Date.now(), store);
  if (!account || (request.headers.has("X-Web-User") && request.headers.get("X-Web-User") !== account.uid)) {
    throw Object.assign(new Error("Please sign in to the website."), { status: 401 });
  }
  return staffProfile(account, store);
}

const publicUser = account => ({ uid: account.uid, id: account.id, role: account.role,
  displayName: String(account.profile?.displayName || account.profile?.fullName || "") });
const publicTiming = ({ serverNow, idleUntil, absoluteUntil, renewAt }) => ({
  remainingMs: Math.max(0, Math.min(idleUntil, absoluteUntil) - serverNow),
  checkInMs: Math.max(0, renewAt - serverNow),
  expiresBy: absoluteUntil <= idleUntil ? "absolute" : "idle"
});

export async function readJson(request, maximum = 8192) {
  if (Number(request.headers.get("Content-Length") || 0) > maximum) throw Object.assign(new Error("Request too large."), { status: 413 });
  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let text = "", size = 0;
  try {
    if (reader) while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum) { await reader.cancel(); throw Object.assign(new Error("Request too large."), { status: 413 }); }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch (error) {
    if (error.status) throw error;
    throw Object.assign(new Error("Invalid request."), { status: 400 });
  } finally { reader?.releaseLock(); }
}

async function renewSession(env, checked) {
  if (checked.previous || checked.timing.serverNow < checked.timing.renewAt) return checked;
  // Rotate only after upstream checks succeed. An outage must not consume a
  // valid cookie before the browser can receive its replacement.
  const renewed = await stateCall(env, `account:${checked.account.uid}`, "session", { ...checked.credentials, rotate: true });
  if (renewed.status === 401) return null;
  if (!renewed.ok) throw new Error("Login state unavailable");
  return { ...checked, ...renewed.result };
}

async function renewalHeaders(request, env, checked) {
  if (!checked?.rotated || checked.previous) return {};
  const token = await signSession(env, checked.account, checked.session, new URL(request.url).host, checked.teacherSession);
  return { "Set-Cookie": cookie(token) };
}

async function maintenance(request, env) {
  const expected = env.WEB_MAINTENANCE_KEY;
  const provided = request.headers.get("Authorization")?.match(/^Bearer (.{32,256})$/)?.[1];
  if (typeof expected !== "string" || expected.length < 32 || !provided) return false;
  const message = encoder.encode("imars-web-maintenance-unlock");
  const proof = await crypto.subtle.sign("HMAC", await hmacKey(provided), message);
  return crypto.subtle.verify("HMAC", await hmacKey(expected), proof, message);
}

export async function authApi({ request, env }, now = Date.now(), { store } = {}) {
  const action = new URL(request.url).pathname.replace(/\/$/, "").split("/").at(-1);
  if (action === "config" && request.method === "GET") {
    if (!enabled(env)) return dataEnabled(env) ? json({ error: "Website account setup is incomplete." }, 503) : json({ enabled: false });
    try { settings(env); if (dataEnabled(env) && !store) serviceAccount(env); return json({ enabled: true, ...(dataEnabled(env) ? { backend: true } : {}), ...(env.TEACHER_SESSION_SYNC_ENABLED === "true" ? { teacherSessionSync: true } : {}) }); }
    catch { return json({ error: "Login protection setup needs website maintenance." }, 503); }
  }
  if (!enabled(env)) return action === "logout" ? json({ ok: true }, 200, { "Set-Cookie": cookie("", 0) }) : json({ error: "Web login protection is not enabled." }, 409);
  if (request.method !== "POST") return json({ error: "Use POST." }, 405);
  const origin = request.headers.get("Origin");
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get("Sec-Fetch-Site") === "cross-site") return json({ error: "Use the ImARs website." }, 403);
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) return json({ error: "Use JSON." }, 415);
  try {
    const accounts = settings(env);
    const body = await readJson(request);
    if (!body || typeof body !== "object") return json({ error: "Invalid request." }, 400);

    if (action === "login") {
      if (typeof body.identifier !== "string" || body.identifier.length > 254 || typeof body.password !== "string" ||
          !body.password || body.password.length > 4096 || !["teacher", "admin"].includes(body.portal)) return json({ error: "Enter your ID and password." }, 400);
      const ip = request.headers.get("CF-Connecting-IP");
      if (ip) {
        const rate = await stateCall(env, `ip:${ip}`, "rate");
        if (!rate.ok) return json(rate.result, rate.status, { "Retry-After": "60" });
      }
      const identifier = body.identifier.trim().toLowerCase();
      const account = await resolveStaff(env, identifier, accounts, store);
      let attempt;
      if (!account || account.role !== body.portal) {
        // Keep unknown IDs and wrong-portal submissions on the same error sequence,
        // without changing a real account's counter or storing the submitted ID.
        const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${body.portal}:${identifier}`));
        attempt = await stateCall(env, `invalid-login:${base64(new Uint8Array(digest))}`, "invalid-login", {});
        if (attempt.ok) throw new Error("An invalid login cannot authenticate");
      } else {
        attempt = await stateCall(env, `account:${account.uid}`, "login", { uid: account.uid, email: account.email, password: body.password });
      }
      if (!attempt.ok) return json(attempt.result, attempt.status, attempt.result.retryAfter ? { "Retry-After": String(attempt.result.retryAfter) } : {});
      const approved = dataEnabled(env) ? await staffProfile(account, store || appStore(env), now) : null;
      if (approved?.role === "teacher" && env.TEACHER_SESSION_SYNC_ENABLED !== "true") {
        const revoked = await stateCall(env, `account:${approved.uid}`, "mobile-revoke", {});
        if (!revoked.ok) throw new Error("Mobile session update failed");
      }
      const teacherSession = approved?.role === "teacher" ? await openTeacherSession(env, store || appStore(env), approved, "web") : undefined;
      const token = await signSession(env, account, attempt.result.session, new URL(request.url).host, teacherSession);
      return json(approved ? { user: publicUser(approved) } : { email: account.email }, 200, { "Set-Cookie": cookie(token) });
    }
    if (action === "identity") {
      if (!dataEnabled(env)) return json({ error: "Website account setup is incomplete." }, 503);
      const database = store || appStore(env);
      const checked = await inspectSession(request, env, { now, store: database });
      if (!checked) return json({ error: "Please sign in to the website." }, 401);
      const user = await staffProfile(checked.account, database, now);
      return json({ user: publicUser(user), session: publicTiming(checked.timing) });
    }
    if (action === "session") {
      if (typeof body.active !== "boolean") return json({ error: "Invalid session request." }, 400);
      const checked = await inspectSession(request, env, { now, active: body.active, store });
      if (!checked) return json({ error: "Your website session expired. Please sign in again." }, 401);
      if (request.headers.has("X-Web-User") && request.headers.get("X-Web-User") !== checked.account.uid) return json({ error: "Your sign-in changed. Please sign in again." }, 401);
      if (dataEnabled(env)) await staffProfile(checked.account, store || appStore(env), now);
      const renewed = await renewSession(env, checked);
      if (!renewed) return json({ error: "Your website session expired. Please sign in again." }, 401);
      return json(body.timing === "relative" ? publicTiming(renewed.timing) : renewed.timing, 200, await renewalHeaders(request, env, renewed));
    }
    if (action === "logout") {
      const payload = await sessionClaims(request, env, now);
      if (!payload && request.headers.has("X-Web-User")) return json({ error: "Your sign-in changed." }, 401);
      if (payload) {
        const result = await stateCall(env, `account:${payload.uid}`, "session-logout", {
          family: payload.family, sid: payload.sid, version: payload.version
        });
        if (!result.ok && result.status !== 401) throw new Error("Logout failed");
        if (result.status === 401 && request.headers.has("X-Web-User")) return json({ error: "Your sign-in changed." }, 401);
      }
      return json({ ok: true }, 200, { "Set-Cookie": cookie("", 0) });
    }
    if (action === "unlock") {
      const owner = await maintenance(request, env);
      const caller = owner ? null : dataEnabled(env) ? await requireStaff(request, env, store || appStore(env)) : await webSession(request, env, now);
      if (!owner && caller?.role !== "admin") return json({ error: "Administrator or maintenance access is required." }, 403);
      const target = await resolveStaff(env, String(body.identifier || "").trim(), accounts, store);
      if (!target || (!owner && target.role !== "teacher")) return json({ error: "An administrator can unlock teachers. Maintenance must restore an administrator." }, 403);
      const result = await stateCall(env, `account:${target.uid}`, "unlock", {});
      if (!result.ok) throw new Error("Unlock failed");
      return json({ ok: true });
    }
    return json({ error: "Not found." }, 404);
  } catch (error) {
    // Never log or echo passwords, cookies, upstream tokens, or server secrets.
    if (databaseQuotaFailure(error)) return json({ error: "Sign-in is temporarily unavailable because the data service usage limit was reached. Please try again later.", code: "DATABASE_QUOTA_EXCEEDED" }, 503, { "Retry-After": "60" });
    if (![400, 401, 403, 413].includes(error.status)) logAuthFailure("api:" + action, error);
    return [400, 401, 403, 413].includes(error.status) ? json({ error: error.message }, error.status)
      : json({ error: "Login protection is temporarily unavailable. Contact website maintenance." }, 503);
  }
}

export async function protectWebsite(context, now = Date.now()) {
  const { request, env } = context;
  if (!enabled(env) && !dataEnabled(env)) return context.next();
  const url = new URL(request.url);
  let path;
  try {
    const decoded = decodeURIComponent(url.pathname);
    if (/[\\%\u0000]/.test(decoded)) return json({ error: "Invalid path." }, 400);
    const canonical = new URL(request.url);
    canonical.pathname = decoded.replace(/\/{2,}/g, "/");
    path = canonical.pathname.replace(/\/$/, "").replace(/\.html$/, "");
  } catch { return json({ error: "Invalid path." }, 400); }
  if (["/assets/", "/css/", "/js/"].some(prefix => path.startsWith(prefix)) || ["/favicon.ico", "/sw.js"].includes(path)) return context.next();
  if (path === "/login" || path === "/admin-login" || path === "/api/web-data/school-year" || path.startsWith("/api/web-auth/") || path.startsWith("/api/account-access/") || path.startsWith("/api/student-quizzes/") || path.startsWith("/api/mobile/v1/")) return context.next();
  try {
    const checked = await inspectSession(request, env, { now, active: !path.startsWith("/api/") });
    const account = checked?.account;
    if (!account) {
      if (path.startsWith("/api/")) return json({ error: "Please sign in to the website." }, 401);
      return new Response(null, { status: 302, headers: { Location: "/login?reason=web-session", "Cache-Control": "no-store", "Set-Cookie": cookie("", 0) } });
    }
    const adminOnly = ["/admin-dashboard", "/admin-profile", "/manage-teachers", "/school-analytics"].includes(path);
    if (!path.startsWith("/api/") && account.role !== (adminOnly ? "admin" : "teacher") && path !== "/teacher-manual") return json({ error: "This account cannot access that page." }, 403);
    requestSessions.set(request, { env, account });
    const response = await context.next();
    const protectedResponse = new Response(response.body, response);
    protectedResponse.headers.set("Cache-Control", "private, no-store");
    if (response.ok) {
      try {
        const renewed = await renewSession(env, checked);
        for (const [name, value] of Object.entries(await renewalHeaders(request, env, renewed))) protectedResponse.headers.set(name, value);
      } catch (error) { logAuthFailure("portal-renewal", error); }
    }
    // These HTML files are static shells. The browser hides private content
    // on page exit and verifies the visit again before revealing a restored view.
    // Leave API responses and responses carrying a replacement cookie no-store.
    const staticHtml = response.status === 200 && protectedResponse.headers.get("Content-Type")?.includes("text/html");
    if (request.method === "GET" && staticPortalShells.has(path) && (staticHtml || response.status === 304) && !protectedResponse.headers.has("Set-Cookie")) {
      protectedResponse.headers.set("Cache-Control", "private, no-cache");
      reusableShells.add(protectedResponse);
    }
    return protectedResponse;
  } catch (error) {
    logAuthFailure("portal", error);
    if (databaseQuotaFailure(error)) {
      const message = "The data service usage limit has been reached. Please try again later.";
      if (!path.startsWith("/api/")) return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ImARs · Temporarily unavailable</title><body><main><h1>Temporarily unavailable</h1><p>${message}</p><a href="/login">Return to login</a></main></body></html>`, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "60" } });
      return json({ error: message, code: "DATABASE_QUOTA_EXCEEDED" }, 503, { "Retry-After": "60" });
    }
    return json({ error: "Login protection is temporarily unavailable. Contact website maintenance." }, 503);
  }
}
