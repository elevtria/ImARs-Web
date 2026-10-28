import { startLoading, withLoading } from "./loading.js";
import { wrapFirestoreReads } from "./firebase-loading.js";
import { createReadPool } from "./data-read-pool.js";
import { invalidateTeacherViews } from "./view-cache.js";
import { webRequest } from "./web-login.js";

const database = Object.freeze({ name: "website" });
const listeners = new Map();
export const getFirestore = () => database;
const pathOf = (parent, parts) => [parent?.path, ...parts].filter(Boolean).join("/");
export const collection = (parent, ...parts) => ({ kind: "query", path: pathOf(parent, parts) });
export function doc(parent, ...parts) {
  const path = pathOf(parent, parts.length ? parts : [crypto.randomUUID().replaceAll("-", "")]);
  return { kind: "document", path, id: path.split("/").at(-1) };
}
export const where = (field, op, value) => ({ constraint: "filter", field, op, value });
export const orderBy = (field, direction = "asc") => ({ constraint: "order", field, direction });
export const limit = value => ({ constraint: "limit", value });
export function query(base, ...constraints) {
  const result = { ...base, filters: [...(base.filters || [])], order: [...(base.order || [])] };
  for (const item of constraints) {
    if (item.constraint === "filter") result.filters.push({ field: item.field, op: item.op, value: item.value });
    else if (item.constraint === "order") result.order.push({ field: item.field, direction: item.direction });
    else if (item.constraint === "limit") result.limit = item.value;
    else throw new Error("Unsupported data query.");
  }
  return result;
}
export const serverTimestamp = () => ({ $type: "serverTimestamp" });
export const arrayUnion = (...values) => ({ $type: "arrayUnion", values });
function encode(value) {
  if (value instanceof Date) return { $type: "timestamp", value: value.toISOString() };
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
  return value;
}
function decode(value) {
  if (value?.$type === "timestamp") {
    const result = new Date(value.value);
    Object.defineProperty(result, "toDate", { value: () => new Date(result.getTime()) });
    return result;
  }
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
  return value;
}
function snapshot(record) {
  return { id: record.id, ref: { kind: "document", path: record.path, id: record.id }, metadata: { fromCache: false, hasPendingWrites: false }, exists: () => record.data !== null, data: () => decode(record.data) };
}
let reads = [], scheduled = false;
function request(body) {
  if (!["get", "query"].includes(body.action)) return webRequest("/api/web-data", encode(body));
  const pending = new Promise((resolve, reject) => reads.push({ body, resolve, reject }));
  if (!scheduled) {
    scheduled = true;
    queueMicrotask(async () => {
      scheduled = false;
      const group = reads.splice(0);
      try {
        const result = await webRequest("/api/web-data", { action: "reads", reads: group.map(item => item.body) });
        if (!Array.isArray(result.results) || result.results.length !== group.length) throw new Error("The website returned incomplete data.");
        group.forEach((item, index) => item.resolve(result.results[index]));
      } catch (error) { group.forEach(item => item.reject(error)); }
    });
  }
  return pending;
}
async function readDocument(reference) {
  if (reference.path === "webSettings/schoolYear" && /^\/login(?:\.html)?\/?$/.test(window.location.pathname)) {
    const response = await fetch("/api/web-data/school-year", { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) throw new Error("The school year could not be loaded.");
    return snapshot({ id: "schoolYear", path: reference.path, data: await response.json() });
  }
  return snapshot((await request({ action: "get", reference })).document);
}
async function readCollection(reference) {
  const docs = (await request({ action: "query", reference })).documents.map(snapshot);
  return { docs, size: docs.length, empty: !docs.length, forEach: callback => docs.forEach(callback), metadata: { fromCache: false, hasPendingWrites: false } };
}
const key = reference => JSON.stringify(reference);
const pool = createReadPool({ equal: (_kind, a, b) => key(a) === key(b) });
export const getDoc = reference => pool.read("document", reference, () => readDocument(reference));
export const getDocs = reference => pool.read("query", reference, () => readCollection(reference));
export const getReadMetrics = pool.metrics;
export function onSnapshot(reference, ...args) {
  if (typeof args[0] === "object" && !("next" in args[0])) args.shift();
  const [next, error] = args;
  const callback = typeof next === "function" ? next : result => next.next(result);
  const failure = error || next?.error;
  const id = key(reference);
  let group = listeners.get(id);
  if (!group) {
    group = { reference, subscribers: new Set(), timer: null, running: false, dirty: false, last: null, revision: 0 };
    listeners.set(id, group);
    group.refresh = async () => {
      if (group.running) { group.dirty = true; return; }
      group.running = true;
      const revision = group.revision;
      try {
        const result = await (reference.kind === "document" ? getDoc(reference) : getDocs(reference));
        if (listeners.get(id) !== group || group.revision !== revision) return;
        group.last = result;
        for (const subscriber of group.subscribers) subscriber.callback(result);
      } catch (err) { if (listeners.get(id) === group) for (const subscriber of group.subscribers) subscriber.failure?.(err); }
      finally {
        group.running = false;
        if (listeners.get(id) === group) {
          clearTimeout(group.timer);
          group.timer = setTimeout(() => { if (document.visibilityState !== "hidden") void group.refresh(); }, group.dirty ? 0 : 15000);
          group.dirty = false;
        }
      }
    };
    group.focus = () => { if (document.visibilityState !== "hidden") void group.refresh(); };
    window.addEventListener("focus", group.focus);
    document.addEventListener("visibilitychange", group.focus);
  }
  const subscriber = { callback, failure };
  group.subscribers.add(subscriber);
  if (group.last) queueMicrotask(() => { if (group.subscribers.has(subscriber)) callback(group.last); });
  else if (!group.running) void group.refresh();
  return () => {
    group.subscribers.delete(subscriber);
    if (!group.subscribers.size) {
      clearTimeout(group.timer);
      window.removeEventListener("focus", group.focus);
      document.removeEventListener("visibilitychange", group.focus);
      listeners.delete(id);
    }
  };
}
const loadingReads = wrapFirestoreReads({ getDoc, getDocs, onSnapshot }, { start: startLoading, run: withLoading });
export const getDocWithLoading = loadingReads.getDoc;
export const getDocsWithLoading = loadingReads.getDocs;
export const onSnapshotWithLoading = loadingReads.onSnapshot;
async function commit(writes) {
  await request({ action: "commit", writes });
  invalidateTeacherViews();
  for (const group of listeners.values()) {
    if (!writes.some(write => group.reference.kind === "document" ? write.path === group.reference.path : write.path.slice(0, write.path.lastIndexOf("/")) === group.reference.path)) continue;
    group.revision++;
    void group.refresh();
  }
}
export const setDoc = (reference, data, options = {}) => commit([{ operation: "set", path: reference.path, data, merge: options.merge === true }]);
export const updateDoc = (reference, data) => commit([{ operation: "update", path: reference.path, data }]);
export const deleteDoc = reference => commit([{ operation: "delete", path: reference.path }]);
export async function addDoc(reference, data) { const target = doc(reference); await setDoc(target, data); return target; }
export function writeBatch() {
  const writes = [];
  let sent = false;
  const batch = {
    set(reference, data, options = {}) { writes.push({ operation: "set", path: reference.path, data, merge: options.merge === true }); return batch; },
    update(reference, data) { writes.push({ operation: "update", path: reference.path, data }); return batch; },
    delete(reference) { writes.push({ operation: "delete", path: reference.path }); return batch; },
    async commit() { if (sent) throw new Error("This save has already been submitted."); sent = true; await commit(writes); }
  };
  return batch;
}
export const checkStudentIds = ids => request({ action: "check-student-ids", ids }).then(result => result.existing);
export async function getStudentPage(options = {}, requestOptions = {}) {
  const result = await webRequest("/api/web-data", encode({ ...options, action: "student-page" }), requestOptions);
  return { ...result, classes: result.classes.map(snapshot),
    students: result.students.map(row => ({ classId: row.classId, studentDoc: snapshot(row.document) })) };
}
export async function getTeacherReportPage(options = {}, requestOptions = {}) {
  const result = await webRequest("/api/web-data", encode({ ...options, action: "teacher-report-page" }), requestOptions);
  const list = rows => { const docs = rows.map(snapshot); return { docs, size: docs.length, empty: !docs.length, forEach: callback => docs.forEach(callback) }; };
  return { ...result, classes: result.classes.map(snapshot),
    students: result.students.map(row => ({ classId: row.classId, studentDoc: snapshot(row.document),
      results: (row.termResults || [{ termId: result.termId, lessons: row.lessons }]).map(term => ({ termId: term.termId, lessonsSnap: list(term.lessons) })) })),
    curriculum: result.curriculum ? { termSnap: snapshot(result.curriculum.term), curriculumSnap: list(result.curriculum.lessons) } : null };
}
export async function createTeacher(profile) {
  const result = await request({ action: "create-teacher", profile });
  invalidateTeacherViews();
  return result;
}
