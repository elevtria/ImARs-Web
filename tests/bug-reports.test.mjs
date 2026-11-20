import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixtures/web-data.js";
import { bugReports } from "../server/bug-reports.js";
import { protectWebsite } from "../server/web-auth.js";
import { readFileSync } from "node:fs";

const report = { requestId: "a".repeat(32), category: "AR camera or scanning", issue: "Marker does not scan",
  description: "The camera stays black after opening the lesson.", appVersion: "1.2", platform: "Android", scene: "Student_Dashboard" };
async function harness() {
  const app = fixture();
  for (const id of ["ADMIN1000", "TEACH1000"]) app.data.get("users/" + id).authEmailVerified = true;
  const admin = await app.login("ADMIN1000", "admin"), teacher = await app.login();
  const options = { store: app.store, identityStore: app.store,
    mobileAuth: async () => ({ uid: "student-a" }), rate: async () => ({ ok: true }), now: () => Date.parse("2026-11-20T06:00:00Z") };
  const call = (action, body = {}, cookie = admin, extra = {}) => bugReports({ env: app.env,
    request: app.request("/api/bug-reports/" + action, body, cookie) }, { ...options, ...extra });
  return { ...app, call, admin, teacher };
}
test("mobile submissions use verified profile data and retry without duplicate reports", async () => {
  const app = await harness();
  const first = await app.call("submit", report);
  assert.equal(first.status, 201);
  const { id } = await first.json();
  const saved = app.data.get("bugReports/" + id);
  assert.equal(saved.reporterId, "0026271000");
  assert.equal(saved.reporterName, "Student A");
  assert.equal(saved.status, "new");
  assert.equal(saved.description, report.description);
  assert.equal((await (await app.call("submit", report)).json()).id, id);
  assert.equal([...app.data.keys()].filter(key => key.startsWith("bugReports/")).length, 1);
  assert.equal((await app.call("submit", { ...report, reporterId: "someone-else" })).status, 400);
});
test("only admins can list reports and change status; anonymous mobile requests fail authentication", async () => {
  const app = await harness();
  const { id } = await (await app.call("submit", report)).json();
  assert.equal((await app.call("list", {}, app.teacher)).status, 403);
  assert.equal((await app.call("status", { id, status: "resolved" }, app.teacher)).status, 403);
  assert.equal((await app.call("list", {}, "")).status, 401);
  assert.equal((await app.call("submit", report, "", { mobileAuth: undefined })).status, 401);
  assert.equal((await app.call("status", { id, status: "resolved" })).status, 200);
  assert.equal(app.data.get("bugReports/" + id).updatedBy, "ADMIN1000");
  assert.equal((await app.call("status", { id, status: "delete" })).status, 400);
  const records = await (await app.call("list")).json();
  assert.equal(records.reports[0].status, "resolved");
  assert.equal(records.reports[0].updatedBy, undefined);
});
test("inactive accounts, rate limits, oversized text, and conflicts cannot create a report", async () => {
  const app = await harness();
  assert.equal((await app.call("submit", report, "", { rate: async () => ({ ok: false, status: 429 }) })).status, 429);
  assert.equal((await app.call("submit", { ...report, description: "x".repeat(1001) })).status, 400);
  app.data.get("users/0026271000").active = false;
  assert.equal((await app.call("submit", report)).status, 403);
  app.data.get("users/0026271000").active = true;
  app.store.conflict = true;
  assert.equal((await app.call("submit", report)).status, 409);
  assert.equal([...app.data.keys()].some(key => key.startsWith("bugReports/")), false);
  assert.ok(app.store.rolledBack > 0);
});
test("list uses bounded pages in newest-first order and excludes private fields", async () => {
  const app = await harness();
  for (let i = 0; i < 28; i++) app.data.set("bugReports/" + String(8000000000000 + i) + "_" + "b".repeat(32), {
    status: "new", issue: "Sample " + i, privateToken: "must-not-leave-server" });
  const first = await (await app.call("list")).json();
  assert.equal(first.reports.length, 25);
  assert.equal(first.reports[0].issue, "Sample 0");
  assert.equal(first.reports[0].privateToken, undefined);
  const second = await (await app.call("list", { cursor: first.cursor })).json();
  assert.equal(second.reports.length, 3);
  assert.equal(second.cursor, null);
  assert.equal((await app.call("list", { cursor: "../users" })).status, 400);
});

test("mobile submission reaches token authentication while admin navigation stays protected", async () => {
  const app = await harness();
  const context = path => ({ env: app.env, request: new Request("https://example.test" + path), next: async () => Response.json({ reached: true }) });
  assert.equal((await protectWebsite(context("/api/bug-reports/submit"))).status, 200);
  assert.equal((await protectWebsite(context("/api/bug-reports/list"))).status, 401);
  const login = await protectWebsite(context("/admin-bug-reports"));
  assert.equal(login.status, 302);
  assert.match(login.headers.get("Location"), /admin-login/);
  assert.match(readFileSync(new URL("../js/firebase-auth.js", import.meta.url), "utf8"), /portalRole[^\n]*admin-bug-reports/);
  for (const page of ["admin-dashboard", "admin-security", "admin-manual", "school-analytics", "manage-teachers", "admin-bug-reports"]) {
    assert.match(readFileSync(new URL("../" + page + ".html", import.meta.url), "utf8"), /href="admin-bug-reports.html"/);
  }
});

test("revoked mobile bindings and primary database tombstones block submissions", async () => {
  const app = await harness();
  const active = structuredClone(app.data.get("users/0026271000"));
  const identityStore = { ...app.store, findUser: async () => ({ id: "0026271000", data: active }) };
  app.data.get("users/0026271000").status = "deleted";
  assert.equal((await app.call("submit", report, "", { identityStore })).status, 403);
  app.data.get("users/0026271000").status = "active";
  app.data.set("_accountAccess/student-a", { active: false, role: "student", profileId: "0026271000" });
  assert.equal((await app.call("submit", report)).status, 403);
  const crossSite = await bugReports({ env: app.env,
    request: app.request("/api/bug-reports/list", {}, app.admin, { Origin: "https://other.test" }) }, { store: app.store });
  assert.equal(crossSite.status, 403);
});
