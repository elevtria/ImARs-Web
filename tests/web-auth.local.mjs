import assert from "node:assert/strict";
const origin = "http://127.0.0.1:8798";
// Requires the LOCAL fixture Worker in tests/fixtures/web-auth-worker.js,
// a synthetic roster and test secrets. Never point this at real accounts.
const cookieFor = async (identifier, portal) => {
 const response = await fetch(origin + "/api/web-auth/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
  body: JSON.stringify({ identifier, portal, password: "local-fixture-password" }) });
 assert.equal(response.status, 200);
 return response.headers.get("Set-Cookie").split(";")[0];
};
const teacherCookie = await cookieFor("TEACH1000", "teacher"), adminCookie = await cookieFor("ADMIN1000", "admin");
let checks = 0;
async function check(path, status, cookie, options = {}) {
 const response = await fetch(origin + path, { redirect: "manual", ...options, headers: { ...(cookie ? { Cookie: cookie } : {}), ...options.headers } });
 assert.equal(response.status, status, `${path}: expected ${status}, got ${response.status}`);
 checks++; return response;
}
assert.deepEqual(await (await check("/api/web-auth/config", 200)).json(), { enabled: true });
await check("/", 302);
await check("/assets/imars-logo.png", 200);
await check("/", 200, teacherCookie);
await check("/manage-teachers", 403, teacherCookie);
await check("/manage%2Dteachers", 403, teacherCookie);
await check("/assets/%2e%2e%2fmanage-teachers", 403, teacherCookie);
await check("/manage-teachers", 200, adminCookie);
const session = await check("/api/web-auth/session", 200, teacherCookie, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: '{"active":false}' });
assert.deepEqual(Object.keys(await session.json()).sort(), ["absoluteUntil", "idleUntil", "renewAt", "serverNow"]);
await check("/api/generate-quiz", 401, undefined, { method: "POST", headers: { Authorization: "Bearer fake-firebase-token" } });
const unlock = { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ identifier: "TEACH1000" }) };
await check("/api/web-auth/unlock", 403, teacherCookie, unlock);
await check("/api/web-auth/unlock", 200, adminCookie, unlock);
await check("/", 302, teacherCookie);
console.log(`${checks} Cloudflare local runtime checks passed; no Firebase requests made.`);
