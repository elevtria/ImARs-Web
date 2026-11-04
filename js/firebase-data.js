import { startLoading, withLoading } from "./loading.js";
import { wrapFirestoreReads } from "./firebase-loading.js";
import { createReadPool } from "./data-read-pool.js";
import { invalidateTeacherViews, teacherViewCache } from "./view-cache.js";
import { webRequest, visitUser } from "./web-login.js";

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
  if (reference.path === "webSettings/schoolYear") {
    const response = await fetch("/api/web-data/school-year", { cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("The school year could not be loaded.");
    return snapshot({ id: "schoolYear", path: reference.path, data: await response.json() });
  }
  return snapshot((await request({ action: "get", reference })).document);
}
async function readCollection(reference) {
  return querySnapshot((await request({ action: "query", reference })).documents);
}
function querySnapshot(records) {
  const docs = records.map(snapshot);
  return { docs, size: docs.length, empty: !docs.length, forEach: callback => docs.forEach(callback), metadata: { fromCache: false, hasPendingWrites: false } };
}
const key = reference => JSON.stringify(reference);
const pool = createReadPool({ equal: (_kind, a, b) => key(a) === key(b) });
export const getDoc = reference => pool.read("document", reference, () => readDocument(reference));
export const getDocs = reference => pool.read("query", reference, () => readCollection(reference));
export const getReadMetrics = pool.metrics;
export function onSnapshot(reference, ...args) {
  const options = typeof args[0] === "object" && !("next" in args[0]) ? args.shift() : {};
  const refreshIntervalMs = Math.max(15000, Number(options.refreshIntervalMs) || 15000);
  const initialDelayMs = Math.min(refreshIntervalMs, Math.max(0, Number(options.initialDelayMs) || 0));
  const [next, error] = args;
  const callback = typeof next === "function" ? next : result => next.next(result);
  const failure = error || next?.error;
  const id = key(reference);
  let group = listeners.get(id);
  if (!group) {
    group = { reference, subscribers: new Set(), timer: null, running: false, dirty: false, last: null, revision: 0, checkedAt: Date.now() - refreshIntervalMs + initialDelayMs };
    listeners.set(id, group);
    group.schedule = delay => {
      clearTimeout(group.timer);
      group.timer = setTimeout(() => {
        if (document.visibilityState !== "hidden") void group.refresh();
        else group.schedule(refreshIntervalMs);
      }, delay);
    };
    group.refresh = async (afterWrite = false) => {
      if (listeners.get(id) !== group) return;
      if (group.running) { if (afterWrite) group.dirty = true; return; }
      clearTimeout(group.timer);
      group.running = true;
      const revision = group.revision;
      try {
        const result = await (reference.kind === "document" ? getDoc(reference) : getDocs(reference));
        if (listeners.get(id) !== group || group.revision !== revision) return;
        group.last = result;
        for (const subscriber of group.subscribers) subscriber.callback(result);
      } catch (err) { if (listeners.get(id) === group) for (const subscriber of group.subscribers) subscriber.failure?.(err); }
      finally {
        group.checkedAt = Date.now();
        group.running = false;
        if (listeners.get(id) === group) {
          group.schedule(group.dirty ? 0 : refreshIntervalMs);
          group.dirty = false;
        }
      }
    };
    group.focus = () => { if (document.visibilityState !== "hidden" && Date.now() - group.checkedAt >= refreshIntervalMs) void group.refresh(); };
    window.addEventListener("focus", group.focus);
    document.addEventListener("visibilitychange", group.focus);
  }
  const subscriber = { callback, failure };
  group.subscribers.add(subscriber);
  if (group.last) queueMicrotask(() => { if (group.subscribers.has(subscriber)) callback(group.last); });
  else if (!group.running && !group.timer) {
    if (initialDelayMs) group.schedule(initialDelayMs);
    else void group.refresh();
  }
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
    void group.refresh(true);
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
async function studentPageRequest(action, options, requestOptions) {
  const uid = visitUser(), cache = teacherViewCache(), version = cache.version();
  const scope = options.sectionId || (options.firstSection ? "first" : "all");
  const cacheKey = "student-counts:" + scope;
  let saved = options.includeCounts === false ? null : cache.get(uid, cacheKey, 60000) || cache.get(uid, "student-counts:all", 60000);
  if (!Array.isArray(saved?.classes) || !Array.isArray(saved?.counts) || saved.counts.some(row => !row || typeof row.classId !== "string" ||
      !Number.isSafeInteger(row.active) || row.active < 0 || !Number.isSafeInteger(row.archived) || row.archived < 0)) saved = null;
  const cachedOnly = options.includeCounts === "cached";
  const body = { ...options, action, ...(saved || cachedOnly ? { includeCounts: false } : {}) };
  let result = await webRequest("/api/web-data", encode(body), requestOptions);
  let classes = result.classes.map(row => row.id), reused = Boolean(saved);
  // Authorization and class membership are still read live by the gateway.
  // Cached totals are usable only while that exact assigned class list agrees.
  if (saved && JSON.stringify(saved.classes) !== JSON.stringify(classes)) {
    if (!cachedOnly) {
      result = await webRequest("/api/web-data", encode({ ...options, action }), requestOptions);
      classes = result.classes.map(row => row.id);
    }
    reused = false;
  } else if (saved) {
    const section = options.sectionId || (options.firstSection ? classes[0] : "");
    result.counts = saved.counts.filter(row => !section || row.classId === section);
  }
  if (result.counts && !reused) cache.put(uid, cacheKey, { classes, counts: result.counts }, version);
  return result;
}
export async function getStudentPage(options = {}, requestOptions = {}) {
  const result = await studentPageRequest("student-page", options, requestOptions);
  return { ...result, classes: result.classes.map(snapshot),
    ...(result.teacher ? { teacherDoc: snapshot(result.teacher) } : {}),
    students: result.students.map(row => ({ classId: row.classId, studentDoc: snapshot(row.document),
      ...(Array.isArray(row.lessons) ? { results: [{ termId: row.termId, lessonsSnap: querySnapshot(row.lessons) }] } : {}) })) };
}
export async function getTeacherReportPage(options = {}, requestOptions = {}) {
  const result = await studentPageRequest("teacher-report-page", options, requestOptions);
  const list = querySnapshot;
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
