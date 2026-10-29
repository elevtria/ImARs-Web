import assert from "node:assert/strict";
import { studentQuizzes } from "../../server/student-quizzes.js";
import { StudentQuizStore } from "../../server/student-quiz-store.js";
import { encodeFields } from "../../server/firestore-admin.js";

export const NOW = Date.parse("2026-10-29T01:00:00.000Z");
export function quiz(id = "quiz1", type = "multiple-choice", extra = {}) {
  let question = { id: "q-original", text: "Choose the correct response", options: type === "multiple-choice" ? ["One", "Two", "Three", "Four"] : ["True", "False"], correctIndex: 0 };
  if (type === "essay") question = { ...question, options: [], correctIndex: -1, answer: "PRIVATE KEY", rubric: "PRIVATE GUIDE", points: 4 };
  if (type === "identification-explanation") question = { ...question, options: [], correctIndex: -1, answer: "PRIVATE KEY", explanation: "PRIVATE GUIDE", points: 3 };
  if (type === "modified-true-false") question = { ...question, correctIndex: 1, correction: "PRIVATE GUIDE" };
  return { id, title: "Class quiz " + id, sectionId: "A", teacherProfileId: "TEACH1", teacherUid: "teacher-a", type,
    schemaVersion: 2, gradingMode: ["multiple-choice", "true-false"].includes(type) ? "automatic" : "teacher-review",
    availability: "now", availableAt: "", createdAt: "2026-10-28T00:00:00.000Z", questionCount: 1, questions: [question], ...extra };
}
export function token(uid = "student-a", changes = {}) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  return encode({ alg: "RS256", kid: "test-key" }) + "." + encode({ aud: "imars-db-a733b", iss: "https://securetoken.google.com/imars-db-a733b", sub: uid,
    iat: NOW / 1000 - 10, auth_time: NOW / 1000 - 20, exp: NOW / 1000 + 3600, email_verified: true, ...changes }) + ".signature";
}
export function fixture() {
  const env = { STUDENT_QUIZZES_ENABLED: "true", ACCOUNT_ACCESS_ENABLED: "true", WEB_SESSION_SECRET: "test-only-signing-secret-with-32-characters" };
  const data = new Map(), versions = new Map(), identities = new Map();
  let revision = 0, clock = NOW;
  const put = (path, value) => { data.set(path, structuredClone(value)); versions.set(path, "revision-" + ++revision); };
  for (const [id, uid, role, section, teacher] of [["S1", "student-a", "student", "A", "TEACH1"], ["S2", "student-b", "student", "B", "TEACH2"], ["TEACH1", "teacher-a", "teacher"], ["TEACH2", "teacher-b", "teacher"]]) {
    put("users/" + id, { uid, role, active: true, displayName: id, ...(section ? { classCode: section, teacherId: teacher } : {}) });
    put("_accountAccess/" + uid, { profileId: id, role, active: true, authEmail: uid + "@example.test" });
    identities.set(uid, { localId: uid, email: uid + "@example.test", emailVerified: true, validSince: "0" });
  }
  put("classes/A", { teacherId: "TEACH1" }); put("classes/B", { teacherId: "TEACH2" }); put("generatedQuizzes/quiz1", quiz());
  class Store extends StudentQuizStore {
    constructor() { super(env); this.reads = []; this.queries = []; this.commits = 0; this.tracked = new Map(); }
    async get(path) { this.reads.push(path); if (this.transaction) this.tracked.set(path, versions.get(path)); return data.has(path) ? { data: structuredClone(data.get(path)), updateTime: versions.get(path) } : null; }
    async query(path, options = {}) {
      return [...data].filter(([name, q]) => name.startsWith(path + "/") && name.split("/").length === path.split("/").length + 1 && (!options.after || name.split("/").at(-1) > options.after) && (options.filters || []).every(f => q[f.field] === f.value))
        .sort(([a], [b]) => a.localeCompare(b)).slice(0, options.limit).map(([name, q]) => ({ id: name.split("/").at(-1), data: structuredClone(q), updateTime: versions.get(name) }));
    }
    async identity(uid) { return structuredClone(identities.get(uid)); }
    async request(path, options) {
      assert.equal(path, "documents:runQuery");
      const q = JSON.parse(options.body).structuredQuery; this.queries.push(q);
      const value = item => item.referenceValue ? item.referenceValue.split("/").at(-1) : item.stringValue;
      let records = [...data].filter(([name]) => name.startsWith("generatedQuizzes/"));
      for (const { fieldFilter: f } of q.where.compositeFilter.filters) records = records.filter(([name, row]) => {
        const actual = f.field.fieldPath === "__name__" ? name.split("/").at(-1) : row[f.field.fieldPath];
        return f.op === "IN" ? f.value.arrayValue.values.some(item => value(item) === actual) : actual === value(f.value);
      });
      const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
      const tuple = ([name, row]) => q.orderBy.length === 1 ? [name.split("/").at(-1)] : [row.createdAt, name.split("/").at(-1)];
      const cmp = (a, b) => { for (let i = 0; i < a.length; i++) { const n = compare(a[i], b[i]); if (n) return n; } return 0; };
      records.sort((a, b) => -cmp(tuple(a), tuple(b)));
      if (q.startAt) records = records.filter(row => { const n = cmp(tuple(row), q.startAt.values.map(value)); return q.startAt.before ? n <= 0 : n < 0; });
      return records.slice(0, q.limit).map(([name, row]) => ({ document: { name: this.name(name), updateTime: versions.get(name), fields: encodeFields(Object.fromEntries(q.select.fields.flatMap(({ fieldPath }) => row[fieldPath] === undefined ? [] : [[fieldPath, row[fieldPath]]]))) } }));
    }
    async begin() { this.transaction = "fixture"; this.tracked.clear(); this.onBegin?.(); }
    async rollback() { this.transaction = null; this.tracked.clear(); }
    async commit(writes) {
      this.beforeCommit?.();
      if (this.transaction && [...this.tracked].some(([path, version]) => versions.get(path) !== version)) throw Object.assign(new Error("transaction conflict"), { status: 409 });
      for (const write of writes) {
        if (write.updateTime ? versions.get(write.path) !== write.updateTime : data.has(write.path)) throw Object.assign(new Error("write conflict"), { status: 409 });
      }
      for (const write of writes) put(write.path, write.operation === "update" ? { ...data.get(write.path), ...write.data } : write.data);
      this.commits++; this.transaction = null; this.tracked.clear();
    }
  }
  const store = new Store(); let googleCalls = 0;
  const fetcher = async (_url, options) => {
    googleCalls++;
    const payload = JSON.parse(Buffer.from(JSON.parse(options.body).idToken.split(".")[1], "base64url"));
    return Response.json({ users: identities.has(payload.sub) ? [identities.get(payload.sub)] : [] });
  };
  const call = async (action, body, opts = {}) => studentQuizzes({ env, request: new Request("https://imars.test/api/student-quizzes/" + action, {
    method: opts.method || "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + (opts.token || token(opts.uid)), ...opts.headers }, body: opts.method === "GET" ? undefined : JSON.stringify(body)
  }) }, { store, now: () => clock, rate: async () => {}, fetcher, ...opts.dependencies });
  const begin = async (id = "quiz1", attemptId = "a".repeat(32)) => {
    const request = { quizId: id, revision: versions.get("generatedQuizzes/" + id), attemptId };
    const response = await call("start", request); assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    return { request, opened: await response.json() };
  };
  const submission = request => ({ assignmentId: request.quizId, revision: request.revision, attemptId: request.attemptId,
    startedAtUtc: new Date(NOW).toISOString(), completedAtUtc: new Date(NOW + 1000).toISOString(),
    answers: [{ questionId: "q-original", optionIndex: 0, value: "", explanation: "", correction: "" }] });
  return { env, store, data, versions, identities, put, call, begin, submission, googleCalls: () => googleCalls, setNow: value => { clock = value; } };
}

