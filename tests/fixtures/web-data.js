import assert from "node:assert/strict";
import { WebLoginState } from "../../workers/web-auth-worker.js";
import { authApi } from "../../server/web-auth.js";
import { webData } from "../../server/web-data.js";
const accounts = [
  { id: "TEACH1000", uid: "teacher-a", email: "teacher@example.test", role: "teacher" },
  { id: "TEACH1001", uid: "teacher-b", email: "other@example.test", role: "teacher" },
  { id: "ADMIN1000", uid: "admin-a", email: "admin@example.test", role: "admin" }
];
const stamp = { $type: "serverTimestamp" };
const union = (...values) => ({ $type: "arrayUnion", values });
export function fixture() {
  const data = new Map([
    ...accounts.map(account => ["users/" + account.id, { ...account, active: true, password: "must-never-leave-server", webInvitationNonce: "private-marker" }]),
    ["users/0026271000", { uid: "student-a", role: "student", classCode: "A", teacherId: "TEACH1000", displayName: "Student A" }],
    ["users/0026271001", { uid: "student-b", role: "student", classCode: "B", teacherId: "TEACH1001" }],
    ["classes/A", { teacherId: "TEACH1000", SectionName: "A" }], ["classes/B", { teacherId: "TEACH1001", SectionName: "B" }],
    ["terms/term_01", { title: "Term 1" }], ["terms/term_01/lessons/lesson_01", { isLocked: false, scheduledDate: "" }],
    ["webSettings/schoolYear", { startYear: 2027, endYear: 2028, updatedBy: "private-uid" }]
  ]);
  const actors = new Map();
  let revision = 1;
  const env = { WEB_DATA_ENABLED: "true", WEB_LOGIN_ENABLED: "true", WEB_STAFF_ACCOUNTS: JSON.stringify(accounts), WEB_SESSION_SECRET: "fixture-only-not-a-real-signing-secret" };
  const store = { env, data, began: 0, committed: 0, rolledBack: 0,
    async get(path) { return data.has(path) ? { data: structuredClone(data.get(path)), updateTime: String(revision) } : null; },
    async getAll(paths) { return new Map(paths.map(path => [path, data.has(path) ? { data: structuredClone(data.get(path)), updateTime: String(revision) } : null])); },
    async identity(uid) { const row = [...data.values()].find(row => row.uid === uid); return row ? { localId: uid, email: row.email, disabled: row.authDisabled, emailVerified: row.authEmailVerified } : null; },
    async count(path, filters) {
      return [...data].filter(([name, row]) => name.startsWith(path + "/") && name.split("/").length === path.split("/").length + 1 && filters.every(filter => row[filter.field] === filter.value)).length;
    },
    async query(path, { filters = [], limit = 5000, after } = {}) {
      return [...data].filter(([name, row]) => name.startsWith(path + "/") && name.split("/").length === path.split("/").length + 1 && (!after || name.split("/").at(-1) > after) && filters.every(filter => row[filter.field] === filter.value))
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).slice(0, limit).map(([name, row]) => ({ id: name.split("/").at(-1), data: structuredClone(row), updateTime: String(revision) }));
    },
    async begin() { this.began++; this.transaction = true; this.onBegin?.(); },
    async rollback() { this.rolledBack++; this.transaction = false; },
    async commit(writes) {
      if (this.conflict) throw Object.assign(new Error("Data changed"), { status: 409 });
      for (const write of writes) {
        if (write.operation === "delete") data.delete(write.path);
        else {
          const values = structuredClone(write.data);
          for (const [key, value] of Object.entries(values)) {
            if (value?.$type === "serverTimestamp") values[key] = new Date().toISOString();
            if (value?.$type === "arrayUnion") values[key] = [...new Set([...(data.get(write.path)?.[key] || []), ...value.values])];
          }
          data.set(write.path, { ...((write.merge || write.operation === "update") ? data.get(write.path) : {}), ...values });
        }
      }
      this.committed++; revision++; this.transaction = false;
    }
  };
  env.WEB_LOGIN_STATE = { idFromName: name => name, get(name) {
    if (!actors.has(name)) {
      const values = new Map();
      actors.set(name, new WebLoginState({ storage: { get: async key => structuredClone(values.get(key)), put: async (key, value) => values.set(key, structuredClone(value)) } }, {}, {
        fetch: async (_url, options) => {
          const body = JSON.parse(options.body);
          const record = [...data.values()].find(row => row.email === body.email && row.uid);
          return body.password === "correct" && record ? Response.json({ localId: record.uid, idToken: "private-token" }) : Response.json({ error: { message: "INVALID_PASSWORD" } }, { status: 400 });
        }
      }));
    }
    return { fetch: (url, options) => actors.get(name).fetch(new Request(url, options)) };
  } };
  const request = (path, body, cookie, headers = {}) => new Request("https://imars.example.test" + path, { method: "POST", headers: {
    "Content-Type": "application/json", Origin: "https://imars.example.test", ...(cookie ? { Cookie: cookie } : {}), ...headers
  }, body: JSON.stringify(body) });
  const auth = (action, body = {}, cookie, headers) => authApi({ env, request: request("/api/web-auth/" + action, body, cookie, headers) }, Date.now(), { store });
  const login = async (id = "TEACH1000", role = "teacher") => {
    const response = await auth("login", { identifier: id, password: "correct", portal: role });
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    const body = await response.json();
    assert.ok(body.user && !body.email && !body.idToken);
    return response.headers.get("Set-Cookie").split(";")[0];
  };
  const call = (body, cookie, headers) => webData({ env, request: request("/api/web-data", body, cookie, headers) }, { store });
  return { env, store, data, request, auth, login, call };
}
export { accounts };
