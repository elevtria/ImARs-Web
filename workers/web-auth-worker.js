import { decision, emptyState, passwordFailed, resetAfterApproval, verifiedSuccess } from "../server/web-lockout.js";
import { checkSession, createSession, pruneSessions, sessionTiming, validSessionId } from "../server/web-session.js";
import { DashboardSummary } from "../server/dashboard-summary.js";
import { FirestoreAdmin, databaseQuotaFailure } from "../server/firestore-admin.js";

const apiKey = "AIzaSyBwH8D-mJSpjqu_C7Y7e7ljCjSZiO7FTm0";
const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export class WebLoginState {
  constructor(state, env, { fetch: fetcher = (...args) => fetch(...args), now = () => Date.now() } = {}) {
    this.storage = state.storage;
    this.state = state;
    this.dashboard = new DashboardSummary(state.storage, env, { now, report: stats => console.info(JSON.stringify({ event: "dashboard-summary-ready", ...stats })) });
    this.fetcher = fetcher;
    this.now = now;
    this.pending = Promise.resolve();
  }

  fetch(request) {
    if (new URL(request.url).pathname === "/dashboard-get" && request.method === "POST") {
      return this.dashboardRead(request).catch(() => json({ error: "Dashboard is temporarily unavailable." }, 503));
    }
    // Serialize across the password verification as well as storage writes. Parallel
    // browser requests cannot all pass a stale attempt-count check.
    const result = this.pending.then(() => this.handle(request));
    this.pending = result.catch(() => {});
    return result.catch(() => json({ error: "Login protection is temporarily unavailable." }, 503));
  }

  async dashboardRead(request) {
    const body = await request.json();
    const cached = await this.dashboard.read(body);
    const update = this.pending.then(() => this.dashboard.configure(body));
    this.pending = update.catch(() => {});
    // A warm read does not wait behind a background Firestore batch.
    if (cached?.ready) { this.state.waitUntil(update); return json(cached); }
    return json(await update);
  }

  alarm() {
    const result = this.pending.then(() => this.dashboard.step());
    this.pending = result.catch(() => {});
    return result.catch(async error => { await this.dashboard.schedule(databaseQuotaFailure(error) ? 900_000 : 30_000); throw error; });
  }

  async handle(request) {
    const action = new URL(request.url).pathname;
    if (action === "/dashboard-dirty" && request.method === "POST") {
      const body = await request.json();
      await this.dashboard.invalidate(body.ids, body.lesson);
      return json({ ok: true });
    }
    if (["/mobile-login", "/mobile-session", "/mobile-revoke"].includes(action) && request.method === "POST") {
      // Only the private binding can reach these actions. Pages verifies the
      // teacher's password or Firebase identity before selecting this object.
      if (action === "/mobile-revoke") {
        await this.storage.put("mobileSessions", []);
        return json({ ok: true });
      }
      const sessions = (await this.storage.get("mobileSessions")) || [];
      if (action === "/mobile-login") {
        const mobileSession = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
        await this.storage.put("mobileSessions", [...sessions, mobileSession].slice(-20));
        return json({ mobileSession });
      }
      const body = await request.json();
      return validSessionId(body.mobileSession) && sessions.includes(body.mobileSession)
        ? json({ ok: true }) : json({ error: "Please sign in again." }, 401);
    }
    if (["/allocate-teacher", "/roster-get", "/roster-disable"].includes(action) && request.method === "POST") {
      const body = await request.json();
      if (action === "/allocate-teacher") {
        if (!Number.isSafeInteger(body.minimum) || body.minimum < 1000 || body.minimum > 999999999 ||
            typeof body.email !== "string" || body.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) return json({ error: "Invalid invitation." }, 400);
        const next = Math.max((await this.storage.get("lastTeacherId")) || 999, body.minimum - 1) + 1;
        const invitation = { id: `TEACH${next}`, email: body.email.toLowerCase(), role: "teacher", active: true, nonce: crypto.randomUUID() };
        // Reservation survives deleted profiles and failed writes. Never reuse
        // an old ID, which might still own classes or have an old mobile login.
        await this.storage.put("lastTeacherId", next);
        await this.storage.put("roster:" + invitation.id, invitation);
        return json(invitation);
      }
      if (typeof body.id !== "string" || !/^TEACH\d{4,10}$/.test(body.id)) return json({ error: "Invalid teacher." }, 400);
      const previous = await this.storage.get("roster:" + body.id);
      if (action === "/roster-get") return json({ account: previous || null });
      await this.storage.put("roster:" + body.id, { ...previous, id: body.id, active: false });
      return json({ ok: true });
    }
    if (action === "/rate" || action === "/generation-rate") {
      const now = this.now();
      let bucket = await this.storage.get("rate");
      if (!bucket || now >= bucket.until) bucket = { count: 0, until: now + 60_000 };
      const maximum = action === "/generation-rate" ? 6 : 60;
      if (bucket.count >= maximum) return json({ error: "Too many requests. Please wait a minute." }, 429);
      await this.storage.put("rate", { ...bucket, count: bucket.count + 1 });
      return json({ allowed: true });
    }
    const state = (await this.storage.get("account")) ?? emptyState();
    const access = decision(state, this.now());
    if (action === "/status") return json({ ...access, version: state.version, stage: state.stage });
    if (action === "/session-logout" && request.method === "POST") {
      const session = checkSession(await this.storage.get("sessions") || {}, await request.json(), state.version, this.now());
      if (!session) return json({ error: "Please sign in to the website again." }, 401);
    }
    if (action === "/unlock" || action === "/logout" || (action === "/session-logout" && request.method === "POST")) {
      await this.storage.put("account", action === "/unlock" ? resetAfterApproval(state) : { ...state, version: state.version + 1 });
      await this.storage.put("sessions", {});
      return json({ ok: true });
    }
    if (action === "/session" && request.method === "POST") {
      const now = this.now();
      const body = await request.json();
      const saved = await this.storage.get("sessions");
      const sessions = pruneSessions(saved, state.version, now);
      const lastActiveAt = sessions[body.family]?.lastActiveAt;
      const checked = access.allowed && checkSession(sessions, body, state.version, now,
        { active: body.active === true, rotate: body.rotate === true });
      if (Object.keys(sessions).length !== Object.keys(saved || {}).length ||
          (checked && (checked.rotated || checked.session.lastActiveAt !== lastActiveAt))) {
        await this.storage.put("sessions", sessions);
      }
      if (!checked) return json({ error: "Please sign in to the website again." }, 401);
      // Only the private Pages binding sees this state, never browser JSON.
      return json({ ...checked, timing: sessionTiming(checked.session, now) });
    }
    if (!["/login", "/invalid-login"].includes(action) || request.method !== "POST") return json({ error: "Not found." }, 404);
    if (!access.allowed) return json({ ...access, error: access.manual
      ? "Web login is locked. Contact your administrator or website maintenance to restore access."
      : "Too many incorrect attempts." }, 429);
    if (action === "/invalid-login") return this.rejectPassword(state);

    const { uid, email, password } = await request.json();
    if (typeof uid !== "string" || typeof email !== "string" || typeof password !== "string" || !password || password.length > 4096) {
      return json({ error: "Invalid sign-in request." }, 400);
    }
    let response, account;
    try {
      response = await this.fetcher(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, returnSecureToken: true }), signal: AbortSignal.timeout(10_000)
      });
      account = await response.json();
    } catch { return json({ error: "Sign-in is temporarily unavailable. Your attempt was not counted." }, 503); }

    if (response.ok && account.localId === uid && typeof account.idToken === "string" && !account.mfaPendingCredential) {
      const next = verifiedSuccess(state, this.now());
      await this.storage.put("account", next);
      const now = this.now();
      const sessions = pruneSessions(await this.storage.get("sessions"), next.version, now);
      const session = createSession(sessions, next.version, now);
      await this.storage.put("sessions", sessions);
      // The private binding returns session state; upstream tokens stay here.
      return json({ email, version: next.version, session });
    }
    const error = String(account.error?.message || "").split(" : ")[0];
    if (["INVALID_PASSWORD", "INVALID_LOGIN_CREDENTIALS", "EMAIL_NOT_FOUND"].includes(error)) {
      return this.rejectPassword(state);
    }
    return json({ error: error === "USER_DISABLED" ? "This Firebase account is disabled. Contact website maintenance."
      : "Sign-in could not be verified. Your attempt was not counted." }, error === "USER_DISABLED" ? 403 : 503);
  }

  async rejectPassword(state) {
    const now = this.now();
    const next = passwordFailed(state, now);
    await this.storage.put("account", next);
    const access = decision(next, now);
    return json({ ...access, error: access.allowed
      ? `Invalid ID or password. Please try again. (${next.failures}/3 attempts)`
      : access.manual ? "Web login is locked. Contact your administrator or website maintenance to restore access."
        : "Too many incorrect attempts." }, access.allowed ? 401 : 429);
  }
}

// There is no public Worker API. Pages accesses objects through a private binding.
export default {
  fetch: () => new Response("Not found", { status: 404 }),
  async scheduled(_event, env) {
    // Prepare new teachers before their first website visit. Existing summaries
    // are left intact; mobile notifications and authenticated visits refresh them.
    const store = new FirestoreAdmin(env);
    const teachers = await store.query("users", { filters: [{ field: "role", value: "teacher" }], limit: 5000 });
    for (const teacher of teachers) {
      if (!teacher.data.uid || teacher.data.active === false || ["inactive", "disabled", "deleted", "archived"].includes(String(teacher.data.status || "").toLowerCase())) continue;
      const classes = await store.query("classes", { filters: [{ field: "teacherId", value: teacher.id }] });
      const response = await env.WEB_LOGIN_STATE.get(env.WEB_LOGIN_STATE.idFromName("dashboard:" + teacher.data.uid)).fetch("https://private/dashboard-get", {
        method: "POST", body: JSON.stringify({ id: teacher.id, uid: teacher.data.uid, warmOnly: true,
          sections: classes.map(row => ({ id: row.id, name: String(row.data.SectionName || row.id).slice(0, 300) })) })
      });
      if (!response.ok) throw new Error("Dashboard preparation unavailable");
    }
  }
};
