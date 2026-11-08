import { readFile } from "node:fs/promises";
import { FirestoreAdmin } from "../server/firestore-admin.js";

// Stage a read-only snapshot for comparison. Nothing here routes app traffic.
const fields = {
  users: ["uid", "schoolId", "role", "active", "status", "displayName", "fullName", "classCode", "teacherId"],
  classes: ["teacherId", "SectionName", "sectionName", "name", "gradeLevel", "GradeLevel"]
};
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const modes = new Set(["--plan", "--stage", "--sample"]);
const mode = process.argv[2] || "--plan";
if (!modes.has(mode) || process.argv.length > 3) throw new Error("Use --plan, --stage, or --sample.");

async function readSnapshot() {
  const credential = process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    await readFile(process.env.IMARS_FIREBASE_CREDENTIAL_FILE, "utf8");
  const db = new FirestoreAdmin({ FIREBASE_SERVICE_ACCOUNT_JSON: credential });
  const session = await db.request("documents:beginTransaction", {
    method: "POST", body: JSON.stringify({ options: { readOnly: {} } })
  });
  if (!session?.transaction) throw new Error("Could not start a consistent Firestore read.");
  db.transaction = session.transaction;
  try {
    const documents = [];
    for (const [collection, fieldPaths] of Object.entries(fields)) {
      let after;
      for (;;) {
        const rows = await db.query(collection, { fieldPaths, limit: 250, after });
        for (const row of rows) documents.push(projectRow(collection, row));
        if (rows.length < 250) break;
        after = rows.at(-1).id;
      }
    }
    return documents;
  } finally {
    await db.rollback();
  }
}

function projectRow(collection, row) {
  if (!idPattern.test(row.id) || !row.updateTime || !Number.isFinite(Date.parse(row.updateTime))) {
    throw new Error("A source document has an unsupported identifier or timestamp.");
  }
  return {
    path: `${collection}/${row.id}`, source_updated_at: row.updateTime,
    data: Object.fromEntries(fields[collection].filter(field => Object.hasOwn(row.data, field))
      .map(field => [field, row.data[field]]))
  };
}

function samples() {
  const updateTime = new Date().toISOString();
  const record = (collection, id, data) => projectRow(collection, { id, updateTime, data });
  return [
    record("classes", "A", { teacherId: "T1", SectionName: "Sample A" }),
    record("classes", "B", { teacherId: "T2", SectionName: "Sample B" }),
    record("users", "T1", { uid: "sample-teacher-a", role: "teacher", active: true }),
    record("users", "T2", { uid: "sample-teacher-b", role: "teacher", active: true }),
    ...Array.from({ length: 600 }, (_, index) => record("users", `S${index}`, {
      role: "student", displayName: `Sample Learner ${index + 1}`, active: true,
      classCode: index < 300 ? "A" : "B", teacherId: index < 300 ? "T1" : "T2"
    }))
  ];
}

function inspect(documents) {
  const index = new Map(documents.map(row => [row.path, row.data]));
  if (index.size !== documents.length) throw new Error("The snapshot contains duplicate document paths.");
  const report = { profiles: 0, teachers: 0, students: 0, classes: 0, unlinkedClasses: 0, unlinkedStudents: 0, duplicateUids: 0 };
  const uids = new Set();
  for (const row of documents) {
    if (row.path.startsWith("classes/")) {
      report.classes++;
      if (index.get("users/" + row.data.teacherId)?.role !== "teacher") report.unlinkedClasses++;
    } else {
      report.profiles++;
      if (row.data.role === "teacher") report.teachers++;
      if (row.data.role === "student" || (!row.data.role && row.data.classCode)) {
        report.students++;
        const section = index.get("classes/" + row.data.classCode);
        if (!section || (row.data.teacherId && row.data.teacherId !== section.teacherId)) report.unlinkedStudents++;
      }
      if (row.data.uid) {
        if (uids.has(row.data.uid)) report.duplicateUids++;
        uids.add(row.data.uid);
      }
    }
  }
  return report;
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]));
  }
  return value;
}

async function stage(documents) {
  const project = new URL(process.env.IMARS_SUPABASE_URL);
  const key = process.env.SUPABASE_SECRET_KEY || "";
  if (project.protocol !== "https:" || !/^[a-z0-9]+\.supabase\.co$/.test(project.host) ||
      project.username || project.password || project.pathname !== "/" || project.search || project.hash ||
      !/^sb_secret_\S+$/.test(key)) throw new Error("Set the hosted Supabase project URL and local server key.");
  const snapshotId = crypto.randomUUID();
  async function request(method, params, body) {
    const url = new URL("/rest/v1/imars_migration_documents", project);
    url.search = new URLSearchParams(params);
    const response = await fetch(url, {
      method, redirect: "error", headers: { apikey: key, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(20_000), ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (!response.ok) throw new Error(`Supabase staging ${method} failed (HTTP ${response.status}).`);
    if (method === "GET") return response.json();
  }
  const filter = { snapshot_id: "eq." + snapshotId };
  await request("GET", { ...filter, select: "path", limit: "1" });
  let verified = false;
  try {
    for (let start = 0; start < documents.length; start += 200) {
      await request("POST", {}, documents.slice(start, start + 200).map(row => ({ ...row, snapshot_id: snapshotId })));
    }
    const expected = new Map(documents.map(row => [row.path, row]));
    let offset = 0;
    for (;;) {
      const page = await request("GET", { ...filter, select: "path,source_updated_at,data", order: "path.asc", limit: "200", offset: String(offset) });
      for (const row of page) {
        const source = expected.get(row.path);
        if (!source || Date.parse(row.source_updated_at) !== Date.parse(source.source_updated_at) ||
            JSON.stringify(normalize(row.data)) !== JSON.stringify(normalize(source.data))) {
          throw new Error("A staged record did not match Firestore.");
        }
        expected.delete(row.path);
      }
      if (page.length < 200) break;
      offset += page.length;
    }
    if (expected.size) throw new Error("The staged snapshot is incomplete.");
    verified = true;
    return snapshotId;
  } finally {
    if (!verified || mode === "--sample") {
      await request("DELETE", filter);
      if ((await request("GET", { ...filter, select: "path", limit: "1" })).length) {
        throw new Error("The staged snapshot could not be removed.");
      }
    }
  }
}

try {
  const documents = mode === "--sample" ? samples() : await readSnapshot();
  const report = inspect(documents);
  if (!documents.length) throw new Error("The source snapshot is empty.");
  const snapshotId = mode === "--plan" ? undefined : await stage(documents);
  console.log(JSON.stringify({ mode, ...report, ...(mode === "--stage" ? { snapshotId } : {}),
    ...(mode === "--sample" ? { sampleCleanupVerified: true } : {}) }));
} catch (error) {
  const message = error.code === "DATABASE_QUOTA_EXCEEDED"
    ? "Firestore is over quota. The live snapshot was not staged."
    : error.message;
  console.error(message);
  process.exitCode = 1;
}
