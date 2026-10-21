import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const VISIT = "imars-web-visit-v1";
const source = readFileSync(new URL("../js/firebase-auth.js", import.meta.url), "utf8")
  .replace(/^export \* from [^\n]+\n/gm, "")
  .replace(/^import\s[\s\S]*?from\s+"[^"]+";\r?\n/gm, "").replace(/^export /gm, "");
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)); };
const storage = entries => {
  const data = new Map(entries);
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key) };
};
const grant = (uid = "teacher-a", role = "teacher", startedAt = Date.now()) => JSON.stringify({ uid, role, startedAt, tabId: "imars-web:fixture-tab" });

function page({ path = "/index", type = "navigate", referrer = "", user = { uid: "teacher-a" }, saved,
    profile = { uid: "teacher-a", role: "teacher", active: true }, profiles, read, passwordFails = false, sessionStorage = storage(), name = "imars-web:fixture-tab" } = {}) {
  if (saved) sessionStorage.setItem(VISIT, saved);
  const events = {}, observers = new Set(), calls = [], deliveries = [];
  const app = {}, auth = { app, currentUser: user, authStateReady: async () => {} };
  const body = { pending: path !== "/login", setAttribute() { this.pending = true; }, removeAttribute() { this.pending = false; } };
  const main = { cleared: false, replaceChildren() { this.cleared = true; } };
  const location = { pathname: path, origin: "https://imars.example.test", replace(url) { this.redirect = url; } };
  const context = vm.createContext({
    window: { name, location, sessionStorage, localStorage: storage(), performance: { getEntriesByType: () => [{ type }] },
      addEventListener: (name, callback) => { (events[name] ||= []).push(callback); } },
    document: { referrer, body, querySelector: () => main }, URL, Date, crypto,
    firebaseGetAuth: () => auth, browserSessionPersistence: "session-only",
    setPersistence: async (_, persistence) => { calls.push(["persistence", persistence]); },
    firebaseAuthChanged: (_, callback) => { observers.add(callback); queueMicrotask(() => callback(auth.currentUser)); return () => observers.delete(callback); },
    firebaseSignIn: async () => {
      calls.push(["password"]);
      if (passwordFails) throw Object.assign(new Error("Invalid credentials"), { code: "auth/invalid-credential" });
      auth.currentUser = { uid: profile.uid };
      for (const callback of observers) callback(auth.currentUser);
      return { user: auth.currentUser };
    },
    firebaseSignOut: async () => {
      calls.push(["sign-out"]); auth.currentUser = null;
      for (const callback of observers) callback(null);
    },
    closeWebSession: async () => { calls.push(["server-sign-out"]); },
    invalidateTeacherViews: () => { calls.push(["clear-views"]); },
    getFirestore: () => ({}), collection: (_, path) => ({ path }), where: (...args) => args, limit: count => ({ count }),
    query: (reference, ...filters) => ({ ...reference, filters }),
    getDocsFromServer: async reference => {
      calls.push(["profile", reference]);
      if (read) return read();
      const rows = profiles || (profile ? [profile] : []);
      return { size: rows.length, docs: rows.map(row => ({ data: () => row })) };
    }
  });
  const api = vm.runInContext(source + "\n({ getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut });", context);
  api.getAuth(app);
  const observe = callback => api.onAuthStateChanged(auth, callback || (user => deliveries.push(user?.uid || null)));
  return { api, auth, app, body, main, location, calls, deliveries, observe, sessionStorage,
    emit: (name, event) => { for (const listener of events[name] || []) listener(event); } };
}

test("new visits discard remembered browser accounts before any portal data callback or profile read", async () => {
  for (const saved of [undefined, grant()]) {
    const app = page({ saved }); app.observe(); await flush();
    assert.equal(app.auth.currentUser, null);
    assert.equal(app.sessionStorage.getItem(VISIT), null);
    assert.deepEqual(app.deliveries, []);
    assert.equal(app.calls.some(call => call[0] === "profile"), false);
    assert.equal(app.calls[0][1], "session-only", "migrate away from Firebase's persistent local login before exposing auth state");
    assert.equal(app.body.pending, true);
    assert.equal(app.main.cleared, true);
    assert.equal(app.location.redirect, "/login?reason=web-session");
  }
});

test("opening login clears an old visit and cannot automatically open a dashboard", async () => {
  const app = page({ path: "/login", saved: grant() }); app.observe(); await flush();
  assert.equal(app.auth.currentUser, null);
  assert.equal(app.sessionStorage.getItem(VISIT), null);
  assert.deepEqual(app.deliveries, [null]);
  assert.equal(app.location.redirect, undefined);
});

test("only successful password and matching live staff-role verification start a website visit", async () => {
  for (const role of ["teacher", "admin"]) {
    const uid = `${role}-a`, app = page({ path: "/login", user: null, profile: { uid, role, active: true } });
    app.observe(); await app.api.signInWithEmailAndPassword(app.auth, "staff@example.test", "password", role);
    const saved = JSON.parse(app.sessionStorage.getItem(VISIT));
    assert.deepEqual(Object.keys(saved).sort(), ["role", "startedAt", "tabId", "uid"]);
    assert.equal(saved.uid, uid); assert.equal(saved.role, role);
    assert.ok(app.calls.findIndex(call => call[0] === "password") < app.calls.findIndex(call => call[0] === "profile"));
    assert.ok(!app.sessionStorage.getItem(VISIT).includes("password"));
    assert.equal(app.location.redirect, undefined);
  }
});

test("failed passwords, missing/duplicate profiles, wrong roles, and disabled profiles never create a visit", async () => {
  for (const options of [
    { passwordFails: true }, { profiles: [] },
    { profiles: [{ uid: "teacher-a", role: "teacher" }, { uid: "teacher-a", role: "teacher" }] },
    { profile: { uid: "teacher-a", role: "student" } }, { profile: { uid: "teacher-a", role: "teacher", active: false } },
    { profile: { uid: "teacher-a", role: "teacher", status: "disabled" } }
  ]) {
    const app = page({ path: "/login", user: null, ...options });
    await assert.rejects(app.api.signInWithEmailAndPassword(app.auth, "staff@example.test", "password", "teacher"));
    assert.equal(app.sessionStorage.getItem(VISIT), null);
    assert.equal(app.auth.currentUser, null);
  }
});

test("internal page navigation and reloads keep the current visit without another password prompt", async () => {
  for (const options of [{ referrer: "https://imars.example.test/index" }, { type: "reload" }]) {
    const app = page({ saved: grant(), ...options }); app.observe(); await flush();
    assert.deepEqual(app.deliveries, ["teacher-a"]);
    assert.equal(app.body.pending, false);
    assert.equal(app.location.redirect, undefined);
    assert.equal(app.calls.some(call => call[0] === "password"), false);
  }
});

test("all page observers wait for one shared live role check before displaying cached or fresh records", async () => {
  let resolve;
  const app = page({ saved: grant(), type: "reload", read: () => new Promise(yes => { resolve = yes; }) });
  app.observe(); app.observe(); await flush();
  assert.equal(app.calls.filter(call => call[0] === "profile").length, 1);
  assert.deepEqual(app.deliveries, []); assert.equal(app.body.pending, true);
  resolve({ size: 1, docs: [{ data: () => ({ uid: "teacher-a", role: "teacher", active: true }) }] });
  await flush();
  assert.deepEqual(app.deliveries, ["teacher-a", "teacher-a"]); assert.equal(app.body.pending, false);
});

test("a new tab cannot reuse session storage copied from its opener, even with a same-site referrer", async () => {
  const app = page({ saved: grant(), name: "", referrer: "https://imars.example.test/index" });
  app.observe(); await flush();
  assert.equal(app.auth.currentUser, null); assert.equal(app.body.pending, true);
  assert.deepEqual(app.deliveries, []); assert.equal(app.location.redirect, "/login?reason=web-session");
});

test("mismatched UIDs, expired visits, restored history and cross-portal navigation require login", async () => {
  for (const options of [
    { saved: grant("other-uid") }, { saved: grant("teacher-a", "teacher", Date.now() - 12 * 60 * 60_000) },
    { type: "back_forward" }, { path: "/admin-dashboard" }
  ]) {
    const app = page({ saved: grant(), referrer: "https://imars.example.test/index", ...options });
    app.observe(); await flush();
    assert.deepEqual(app.deliveries, []); assert.equal(app.body.pending, true);
    assert.equal(app.location.redirect, "/login?reason=web-session");
  }
});

test("an offline or rejected role check never falls back to saved student data", async () => {
  for (const read of [async () => { throw new Error("Offline"); }, async () => ({ size: 0, docs: [] })]) {
    const app = page({ saved: grant(), type: "reload", read }); app.observe(); await flush();
    assert.deepEqual(app.deliveries, []); assert.equal(app.body.pending, true);
    assert.equal(app.sessionStorage.getItem(VISIT), null);
    assert.match(app.location.redirect, /access-(unavailable|denied)/);
  }
});

test("back-button restoration after logout cannot reveal previously rendered student records", async () => {
  const app = page({ saved: grant(), type: "reload" }); app.observe(); await flush();
  app.emit("pagehide", {});
  assert.equal(app.body.pending, true);
  app.sessionStorage.removeItem(VISIT);
  app.emit("pageshow", { persisted: true }); await flush();
  assert.equal(app.body.pending, true); assert.equal(app.main.cleared, true);
  assert.deepEqual(app.deliveries, ["teacher-a"]);
  assert.equal(app.location.redirect, "/login?reason=web-session");
});

test("returning to a live history page rechecks access before un-hiding it", async () => {
  const app = page({ saved: grant(), type: "reload" }); app.observe(); await flush();
  app.emit("pagehide", {}); app.emit("pageshow", { persisted: true }); await flush();
  assert.equal(app.body.pending, false);
  assert.equal(app.calls.filter(call => call[0] === "profile").length, 2);
});

test("a late role check from a page being left cannot unhide its history snapshot", async () => {
  let resolve;
  const app = page({ saved: grant(), type: "reload", read: () => new Promise(yes => { resolve = yes; }) });
  app.observe(); await flush();
  app.emit("pagehide", {});
  resolve({ size: 1, docs: [{ data: () => ({ uid: "teacher-a", role: "teacher" }) }] }); await flush();
  assert.equal(app.body.pending, true); assert.deepEqual(app.deliveries, []);
});

test("logout clears the visit, hides the portal, and notifies other tabs for the same account", async () => {
  const app = page({ saved: grant(), type: "reload" }); app.observe(); await flush();
  await app.api.signOut(app.auth); await flush();
  assert.equal(app.sessionStorage.getItem(VISIT), null); assert.equal(app.body.pending, true);
  assert.ok(app.calls.some(call => call[0] === "server-sign-out"));
  const other = page({ saved: grant(), type: "reload" }); other.observe(); await flush();
  other.emit("storage", { key: "imars-web-sign-out-v1", newValue: JSON.stringify({ uid: "teacher-a" }) }); await flush();
  assert.equal(other.auth.currentUser, null); assert.equal(other.body.pending, true);
});

test("blocked browser storage cannot leave a partially signed-in account", async () => {
  const sessionStorage = { getItem() { throw new Error("Blocked"); }, removeItem() {}, setItem() { throw new Error("Blocked"); } };
  const app = page({ path: "/login", user: null, sessionStorage });
  await assert.rejects(app.api.signInWithEmailAndPassword(app.auth, "staff@example.test", "password", "teacher"), /Blocked/);
  assert.equal(app.auth.currentUser, null);
});

test("every portal includes the initial privacy guard and uses the shared authentication wrapper", () => {
  const root = new URL("../", import.meta.url);
  for (const file of readdirSync(root).filter(file => file.endsWith(".html") && file !== "login.html")) {
    const html = readFileSync(new URL(file, root), "utf8");
    assert.match(html, /<body data-auth-pending/);
    assert.match(html, /css\/(app|admin-dashboard)\.css/);
    assert.match(html, /js\/(school-year|teacher-nav)\.js/);
  }
  for (const file of readdirSync(new URL("js/", root)).filter(file => file.endsWith(".js") && file !== "firebase-auth.js")) {
    assert.ok(!readFileSync(new URL(`js/${file}`, root), "utf8").includes("https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js"), file);
  }
});
