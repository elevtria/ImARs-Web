import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

function page({ protection = true, denied = false, outage = false, search = "", configuration, profileExists = true, responses } = {}) {
  const elements = new Map(), calls = [];
  const pendingResponses = responses?.slice();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: "", disabled: false, events: {}, style: {}, attributes: {}, classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(name, callback) { this.events[name] = callback; },
      setAttribute(name, value) { this.attributes[name] = value; },
      querySelector() { return element(`${id}:label`); }, reset() {}, showModal() {}, close() {} });
    return elements.get(id);
  };
  const location = { href: "login.html", search, pathname: "/login" };
  const context = vm.createContext({
    console: { error() {} }, document: { getElementById: element }, window: { location }, URLSearchParams,
    AbortSignal, sessionStorage: { getItem: () => null }, fetch: async () => {
      const { body, status } = pendingResponses.shift();
      return Response.json(body, { status });
    },
    localStorage: { setItem() {} }, initializeApp: () => ({}), getAuth: () => ({}), getFirestore: () => ({}),
    webProtectionEnabled: async () => { if (outage) throw new Error("Unavailable"); await configuration; return protection; },
    protectedWebLogin: async (...args) => {
      calls.push(["protected", ...args]);
      if (denied) { const error = new Error("Web login is locked. Contact your administrator."); error.userMessage = error.message; throw error; }
      return "teacher@example.test";
    },
    closeWebSession: async () => { calls.push(["logout"]); },
    signInWithEmailAndPassword: async (_, identifier, password, role) => {
      if (outage || !protection) throw new Error("Unavailable");
      await configuration;
      calls.push(["server", identifier, password, role]);
      if (pendingResponses) return context.webRequest("/api/web-auth/login", { identifier, password, portal: role });
      if (denied || !profileExists) throw Object.assign(new Error("Web login is locked. Contact your administrator."), { userMessage: "Web login is locked. Contact your administrator." });
      return { user: { uid: "teacher-a" } };
    },
    prepareDashboard: async () => {},
    signOut: async () => {}, doc: () => ({}), collection: () => ({}), where: () => ({}), query: () => ({}),
    getDoc: async () => { calls.push(["legacy-profile"]); return { exists: () => profileExists, data: () => ({ role: "teacher", email: "teacher@example.test" }) }; },
    getDocs: async () => ({ empty: false, docs: [{ data: () => ({ role: "teacher" }) }] })
  });
  if (pendingResponses) {
    const transport = readFileSync(new URL("../js/web-login.js", import.meta.url), "utf8").replace(/^export /gm, "");
    vm.runInContext(transport, context);
  }
  const source = readFileSync(new URL("../js/login.js", import.meta.url), "utf8").replace(/^import\s[\s\S]*?from\s+"[^"]+";\r?\n/gm, "");
  vm.runInContext(source, context);
  element("teacherId").value = "TEACH1000"; element("password").value = "password";
  element("adminIdentifier").value = "ADMIN1000"; element("adminPassword").value = "password";
  return { element, calls, location, submit: id => element(id).events.submit({ preventDefault() {} }) };
}

test("enabled protection sends Teacher ID/password through the server and keeps the dashboard flow", async () => {
  const app = page(); await app.submit("loginForm");
  assert.deepEqual(app.calls, [["server", "TEACH1000", "password", "teacher"]]);
  assert.equal(app.location.href, "index.html");
});
test("a locked teacher never reaches the browser Firebase sign-in step", async () => {
  const app = page({ denied: true }); await app.submit("loginForm");
  assert.equal(app.calls.length, 1);
  assert.match(app.element("error").innerText, /Contact your administrator/);
  assert.equal(app.location.href, "login.html");
});
test("admin login uses the same protected flow and existing dashboard destination", async () => {
  const app = page(); await app.submit("adminLoginForm");
  assert.equal(app.calls[0][3], "admin");
  assert.equal(app.location.href, "admin-dashboard.html");
});
test("a configuration outage cannot silently fall back to the old login", async () => {
  const app = page({ outage: true }); await app.submit("loginForm");
  assert.equal(app.calls.length, 0);
  assert.equal(app.location.href, "login.html");
});
test("unconfigured protection fails closed without any legacy profile lookup", async () => {
  const app = page({ protection: false }); await app.submit("loginForm");
  assert.deepEqual(app.calls, []);
  assert.equal(app.location.href, "login.html");
});

for (const [role, form, button, idleLabel] of [
  ["teacher", "loginForm", "teacherSubmitBtn", "Log in"],
  ["admin", "adminLoginForm", "adminSubmitBtn", "Sign in as Admin"]
]) {
  test(`${role} sign-in shows button progress and ignores duplicate submissions through redirect`, async () => {
    let resolve;
    const configuration = new Promise(yes => { resolve = yes; });
    const app = page({ configuration });
    const pending = app.submit(form);
    assert.equal(app.element(button).disabled, true);
    assert.equal(app.element(button).attributes["aria-busy"], "true");
    assert.equal(app.element(`${button}:label`).textContent, "Signing in…");
    await app.submit(form);
    resolve();
    await pending;
    assert.equal(app.calls.filter(call => call[0] === "server").length, 1);
    assert.equal(app.calls.filter(call => call[0] === "legacy-profile").length, 0);
    assert.equal(app.element(button).disabled, true, "keep progress visible until the new page opens");
  });

  test(`${role} sign-in restores the button after failure so credentials can be retried`, async () => {
    const app = page({ denied: true });
    await app.submit(form);
    assert.equal(app.element(button).disabled, false);
    assert.equal(app.element(button).attributes["aria-busy"], "false");
    assert.equal(app.element(`${button}:label`).textContent, idleLabel);
    await app.submit(form);
    assert.equal(app.calls.length, 2);
    assert.equal(app.location.href, "login.html");
  });
}

test("an unknown Teacher ID restores the button after the profile check", async () => {
  const app = page({ profileExists: false });
  await app.submit("loginForm");
  assert.equal(app.element("teacherSubmitBtn").disabled, false);
  assert.equal(app.element("teacherSubmitBtn:label").textContent, "Log in");
  assert.match(app.element("error").innerText, /Contact your administrator/);
  assert.deepEqual(app.calls, [["server", "TEACH1000", "password", "teacher"]]);
});

test("an expired website session opens the normal login without an automatic error", async () => {
  const app = page({ search: "?reason=web-session" });
  assert.equal(app.element("error").innerText, undefined);
  assert.equal(app.element("error").textContent, undefined);
  assert.notEqual(app.element("error").style.display, "block");
  assert.deepEqual(app.calls, []);
  await app.submit("loginForm");
  assert.equal(app.location.href, "index.html");
});

for (const [role, form, errorId] of [["teacher", "loginForm", "error"], ["admin", "adminLoginForm", "adminError"]]) {
  test(`${role} login shows server attempts and lock durations without inventing a browser counter`, async () => {
    const responses = [
      { status: 401, body: { error: "Invalid ID or password. Please try again. (2/3 attempts)" } },
      { status: 429, body: { error: "Too many incorrect attempts.", retryAfter: 300 } },
      { status: 429, body: { error: "Too many incorrect attempts.", retryAfter: 18000 } },
      { status: 429, body: { error: "Web login is locked. Contact your administrator or website maintenance to restore access.", manual: true, retryAfter: 0 } }
    ];
    const app = page({ responses });
    for (const expected of [
      "Invalid ID or password. Please try again. (2/3 attempts)",
      "Too many incorrect attempts. Please try again in 5 minutes.",
      "Too many incorrect attempts. Please try again in 5 hours.",
      "Web login is locked. Contact your administrator or website maintenance to restore access."
    ]) {
      await app.submit(form);
      assert.equal(app.element(errorId)[role === "teacher" ? "innerText" : "textContent"], expected);
      assert.equal(app.location.href, "login.html");
    }
  });
}
