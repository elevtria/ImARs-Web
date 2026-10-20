import { ABSOLUTE_AFTER_MS, validSessionId } from "./web-session.js";

const cookieName = "__Host-imars-web";
const sessionSeconds = 12 * 60 * 60;
const encoder = new TextEncoder();
const json = (body, status = 200, headers = {}) => Response.json(body, {
  status, headers: { "Cache-Control": "no-store", ...headers }
});
export const enabled = env => env.WEB_LOGIN_ENABLED === "true";
const cookie = (token, age = sessionSeconds) => `${cookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;
const base64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
const unbase64 = text => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0));
const hmacKey = secret => crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

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

export async function signSession(env, account, session, host) {
  const value = base64(encoder.encode(JSON.stringify({ uid: account.uid, role: account.role, id: account.id,
    version: session.version, family: session.family, sid: session.sid, aud: host,
    iat: Math.floor(session.rotatedAt / 1000), exp: Math.floor(session.absoluteUntil / 1000) })));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(env.WEB_SESSION_SECRET), encoder.encode(value));
  return `${value}.${base64(new Uint8Array(signature))}`;
}

async function inspectSession(request, env, { now = Date.now(), active = false, rotate = false } = {}) {
  const accounts = settings(env);
  const value = request.headers.get("Cookie")?.split(/;\s*/).find(item => item.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  if (!value || value.length > 2048) return null;
  try {
    const parts = value.split(".");
    if (parts.length !== 2 || !await crypto.subtle.verify("HMAC", await hmacKey(env.WEB_SESSION_SECRET), unbase64(parts[1]), encoder.encode(parts[0]))) return null;
    const payload = JSON.parse(new TextDecoder().decode(unbase64(parts[0])));
    const account = accounts.find(item => item.uid === payload.uid && item.id === payload.id && item.role === payload.role);
    const time = Math.floor(now / 1000);
    if (!account || payload.aud !== new URL(request.url).host || !Number.isSafeInteger(payload.exp) ||
        payload.exp <= time || !Number.isSafeInteger(payload.iat) || payload.iat > time + 30 ||
        payload.exp <= payload.iat || payload.exp - payload.iat > ABSOLUTE_AFTER_MS / 1000 ||
        !validSessionId(payload.family) || !validSessionId(payload.sid) || !Number.isSafeInteger(payload.version)) return null;
    let checked;
    try {
      checked = await stateCall(env, `account:${account.uid}`, "session", {
        family: payload.family, sid: payload.sid, version: payload.version, active, rotate
      });
    } catch { throw new Error("Login state unavailable"); }
    if (checked.status === 401) return null;
    if (!checked.ok) throw new Error("Login state unavailable");
    return { account, ...checked.result };
  } catch (error) {
    if (error.message === "Login state unavailable") throw error;
    return null;
  }
}

export async function webSession(request, env, now = Date.now()) {
  return (await inspectSession(request, env, { now }))?.account ?? null;
}

async function renewalHeaders(request, env, checked) {
  if (!checked?.rotated || checked.previous) return {};
  const token = await signSession(env, checked.account, checked.session, new URL(request.url).host);
  const remaining = Math.max(0, Math.floor((checked.session.absoluteUntil - checked.timing.serverNow) / 1000));
  return { "Set-Cookie": cookie(token, remaining) };
}

async function maintenance(request, env) {
  const expected = env.WEB_MAINTENANCE_KEY;
  const provided = request.headers.get("Authorization")?.match(/^Bearer (.{32,256})$/)?.[1];
  if (typeof expected !== "string" || expected.length < 32 || !provided) return false;
  const message = encoder.encode("imars-web-maintenance-unlock");
  const proof = await crypto.subtle.sign("HMAC", await hmacKey(provided), message);
  return crypto.subtle.verify("HMAC", await hmacKey(expected), proof, message);
}

export async function authApi({ request, env }, now = Date.now()) {
  const action = new URL(request.url).pathname.replace(/\/$/, "").split("/").at(-1);
  if (action === "config" && request.method === "GET") {
    if (!enabled(env)) return json({ enabled: false });
    try { settings(env); return json({ enabled: true }); }
    catch { return json({ error: "Login protection setup needs website maintenance." }, 503); }
  }
  if (!enabled(env)) return action === "logout" ? json({ ok: true }, 200, { "Set-Cookie": cookie("", 0) }) : json({ error: "Web login protection is not enabled." }, 409);
  if (request.method !== "POST") return json({ error: "Use POST." }, 405);
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return json({ error: "Use the ImARs website." }, 403);
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) return json({ error: "Use JSON." }, 415);
  try {
    const accounts = settings(env);
    if (Number(request.headers.get("Content-Length") || 0) > 8192) return json({ error: "Request too large." }, 413);
    const text = await request.text();
    if (encoder.encode(text).length > 8192) return json({ error: "Request too large." }, 413);
    let body;
    try { body = JSON.parse(text); } catch { return json({ error: "Invalid request." }, 400); }
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
      const account = accounts.find(item => item.id.toLowerCase() === identifier || (body.portal === "admin" && item.email.toLowerCase() === identifier));
      if (!account || account.role !== body.portal) return json({ error: "Invalid ID or password." }, 401);
      const attempt = await stateCall(env, `account:${account.uid}`, "login", { uid: account.uid, email: account.email, password: body.password });
      if (!attempt.ok) return json(attempt.result, attempt.status, attempt.result.retryAfter ? { "Retry-After": String(attempt.result.retryAfter) } : {});
      const token = await signSession(env, account, attempt.result.session, new URL(request.url).host);
      return json({ email: account.email }, 200, { "Set-Cookie": cookie(token) });
    }
    if (action === "session") {
      if (typeof body.active !== "boolean") return json({ error: "Invalid session request." }, 400);
      const checked = await inspectSession(request, env, { now, active: body.active, rotate: true });
      if (!checked) return json({ error: "Your website session expired. Please sign in again." }, 401);
      return json(checked.timing, 200, await renewalHeaders(request, env, checked));
    }
    if (action === "logout") {
      const account = await webSession(request, env, now);
      if (account) {
        const result = await stateCall(env, `account:${account.uid}`, "logout", {});
        if (!result.ok) throw new Error("Logout failed");
      }
      return json({ ok: true }, 200, { "Set-Cookie": cookie("", 0) });
    }
    if (action === "unlock") {
      const owner = await maintenance(request, env);
      const caller = owner ? null : await webSession(request, env, now);
      if (!owner && caller?.role !== "admin") return json({ error: "Administrator or maintenance access is required." }, 403);
      const target = accounts.find(item => item.id === String(body.identifier || "").trim().toUpperCase());
      if (!target || (!owner && target.role !== "teacher")) return json({ error: "An administrator can unlock teachers. Maintenance must restore an administrator." }, 403);
      const result = await stateCall(env, `account:${target.uid}`, "unlock", {});
      if (!result.ok) throw new Error("Unlock failed");
      return json({ ok: true });
    }
    return json({ error: "Not found." }, 404);
  } catch {
    // Never log or echo passwords, cookies, upstream tokens, or server secrets.
    return json({ error: "Login protection is temporarily unavailable. Contact website maintenance." }, 503);
  }
}

export async function protectWebsite(context, now = Date.now()) {
  const { request, env } = context;
  if (!enabled(env)) return context.next();
  const url = new URL(request.url);
  let path;
  try {
    const decoded = decodeURIComponent(url.pathname);
    if (/[\\%\u0000]/.test(decoded)) return json({ error: "Invalid path." }, 400);
    const canonical = new URL(request.url);
    canonical.pathname = decoded.replace(/\/{2,}/g, "/");
    path = canonical.pathname.replace(/\/$/, "").replace(/\.html$/, "");
  } catch { return json({ error: "Invalid path." }, 400); }
  if (["/assets/", "/css/", "/js/"].some(prefix => path.startsWith(prefix)) || path === "/favicon.ico") return context.next();
  if (path === "/login" || path.startsWith("/api/web-auth/") || path.startsWith("/api/account-access/")) return context.next();
  try {
    const checked = await inspectSession(request, env, { now, active: true, rotate: true });
    const account = checked?.account;
    if (!account) {
      if (path.startsWith("/api/")) return json({ error: "Please sign in to the website." }, 401);
      return new Response(null, { status: 302, headers: { Location: "/login?reason=web-session", "Cache-Control": "no-store", "Set-Cookie": cookie("", 0) } });
    }
    const adminOnly = ["/admin-dashboard", "/admin-profile", "/manage-teachers", "/school-analytics"].includes(path);
    if (account.role !== (adminOnly ? "admin" : "teacher") && path !== "/teacher-manual") return json({ error: "This account cannot access that page." }, 403);
    const response = await context.next();
    const protectedResponse = new Response(response.body, response);
    protectedResponse.headers.set("Cache-Control", "private, no-store");
    for (const [name, value] of Object.entries(await renewalHeaders(request, env, checked))) protectedResponse.headers.set(name, value);
    return protectedResponse;
  } catch {
    return json({ error: "Login protection is temporarily unavailable. Contact website maintenance." }, 503);
  }
}
