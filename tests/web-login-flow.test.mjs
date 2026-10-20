import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

function page({ protection = true, denied = false, outage = false, search = "", configuration, profileExists = true } = {}) {
  const elements = new Map(), calls = [];
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
    localStorage: { setItem() {} }, initializeApp: () => ({}), getAuth: () => ({}), getFirestore: () => ({}),
    webProtectionEnabled: async () => { if (outage) throw new Error("Unavailable"); await configuration; return protection; },
    protectedWebLogin: async (...args) => {
      calls.push(["protected", ...args]);
      if (denied) { const error = new Error("Web login is locked. Contact your administrator."); error.userMessage = error.message; throw error; }
      return "teacher@example.test";
    },
    closeWebSession: async () => { calls.push(["logout"]); },
    signInWithEmailAndPassword: async (_, email, password) => { calls.push(["firebase", email, password]); return { user: { uid: "teacher-a" } }; },
    signOut: async () => {}, doc: () => ({}), collection: () => ({}), where: () => ({}), query: () => ({}),
    getDoc: async () => { calls.push(["legacy-profile"]); return { exists: () => profileExists, data: () => ({ role: "teacher", email: "teacher@example.test" }) }; },
    getDocs: async () => ({ empty: false, docs: [{ data: () => ({ role: "teacher" }) }] })
  });
  const source = readFileSync(new URL("../js/login.js", import.meta.url), "utf8").replace(/^import\s[\s\S]*?from\s+"[^"]+";\r?\n/gm, "");
  vm.runInContext(source, context);
  element("teacherId").value = "TEACH1000"; element("password").value = "password";
  element("adminIdentifier").value = "ADMIN1000"; element("adminPassword").value = "password";
  return { element, calls, location, submit: id => element(id).events.submit({ preventDefault() {} }) };
}

test("enabled protection sends Teacher ID/password through the server and keeps the dashboard flow", async () => {
  const app = page(); await app.submit("loginForm");
  assert.deepEqual(app.calls, [["protected", "TEACH1000", "password", "teacher"], ["firebase", "teacher@example.test", "password"]]);
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
test("until protection is activated, the original teacher login stays available", async () => {
  const app = page({ protection: false }); await app.submit("loginForm");
  assert.deepEqual(app.calls, [["legacy-profile"], ["firebase", "teacher@example.test", "password"]]);
  assert.equal(app.location.href, "index.html");
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
    assert.equal(app.calls.filter(call => call[0] === "protected").length, 1);
    assert.equal(app.calls.filter(call => call[0] === "firebase").length, 1);
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
  const app = page({ protection: false, profileExists: false });
  await app.submit("loginForm");
  assert.equal(app.element("teacherSubmitBtn").disabled, false);
  assert.equal(app.element("teacherSubmitBtn:label").textContent, "Log in");
  assert.match(app.element("error").innerText, /Teacher ID not found/);
  assert.deepEqual(app.calls, [["legacy-profile"]]);
});

test("an expired website session shows a sign-in message and preserves the normal teacher login", async () => {
  const app = page({ search: "?reason=web-session" });
  assert.match(app.element("error").innerText, /session ended/);
  assert.equal(app.element("error").style.display, "block");
  assert.deepEqual(app.calls, []);
  await app.submit("loginForm");
  assert.equal(app.location.href, "index.html");
});

test("Firebase sign-out still clears browser authentication if web-session revocation is unavailable", async () => {
  let cleared = false;
  const context = vm.createContext({ window: { location: { pathname: "/login" } }, invalidateTeacherViews() {}, closeWebSession: async () => { throw new Error("Retry sign-out"); },
    firebaseSignOut: async () => { cleared = true; } });
  const source = readFileSync(new URL("../js/firebase-auth.js", import.meta.url), "utf8")
    .replace(/^export \* from [^\n]+\n/gm, "")
    .replace(/^import\s[\s\S]*?from\s+"[^"]+";\r?\n/gm, "")
    .replace(/^export /gm, "");
  const signOut = vm.runInContext(source + "\nsignOut;", context);
  await assert.rejects(signOut({}), /Retry sign-out/);
  assert.equal(cleared, true);
});
