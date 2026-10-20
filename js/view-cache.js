const PREFIX = "imars-view-v1:";
const OWNER = "imars-view-owner-v1";
const VERSION = "imars-view-version-v1";

// Only this tab's signed-in account can reuse a view. Entries expire after 15 minutes.
export function createViewCache({ storage, versions, now = Date.now, maxAge = 15 * 60 * 1000 } = {}) {
  let owner = null;
  const version = () => { try { return versions?.getItem(VERSION) || ""; } catch { return ""; } };
  const clear = () => {
    try {
      for (let i = storage.length - 1; i >= 0; i--) {
        const key = storage.key(i);
        if (key?.startsWith(PREFIX)) storage.removeItem(key);
      }
    } catch {}
  };
  return {
    version,
    setOwner(uid) {
      try {
        if ((storage.getItem(OWNER) || null) !== uid) clear();
        if (uid) storage.setItem(OWNER, uid); else storage.removeItem(OWNER);
      } catch {}
      owner = uid;
    },
    get(uid, page) {
      if (!uid || uid !== owner) return null;
      try {
        const entry = JSON.parse(storage.getItem(PREFIX + page));
        if (!entry || entry.uid !== uid || entry.version !== version() || now() - entry.savedAt > maxAge || entry.savedAt > now()) return null;
        return entry.value;
      } catch { return null; }
    },
    put(uid, page, value, expectedVersion = version()) {
      if (!uid || uid !== owner || expectedVersion !== version()) return false;
      try {
        const encoded = JSON.stringify({ uid, version: expectedVersion, savedAt: now(), value });
        if (encoded.length > 2 * 1024 * 1024) return false;
        try { storage.setItem(PREFIX + page, encoded); }
        catch { clear(); storage.setItem(PREFIX + page, encoded); }
        return true;
      } catch { return false; }
    },
    remove(page) { try { storage?.removeItem(PREFIX + page); } catch {} },
    invalidate() {
      clear();
      try { versions?.setItem(VERSION, `${now()}:${Math.random()}`); } catch {}
    },
    clear
  };
}

let instance;
export function teacherViewCache() {
  if (!instance) {
    let storage, versions;
    try { storage = window.sessionStorage; versions = window.localStorage; } catch {}
    instance = createViewCache({ storage, versions });
  }
  return instance;
}
export const invalidateTeacherViews = () => teacherViewCache().invalidate();

const DISPLAY_FIELDS = new Set([
  "displayName", "fullName", "active", "SectionName", "sectionName", "name", "title", "topicTitle", "lessonOrder", "isLocked", "scheduledDate",
  "isPreTestCompleted", "isPostTestCompleted", "completed", "preTestScore", "preTestTotalQuestions", "postTestScore", "postTestTotalQuestions", "postTestHeatmap",
  "arTimeMinutes", "arNavigationTimeMinutes", "lessonTimeMinutes", "learningTimeByDevice", "timestamp", "lastUpdated", "completedAt"
]);

// Store only the document contents needed for displaying a report, not SDK internals.
export function encodeView(value, seen = new WeakSet()) {
  if (value === undefined) return { $imars: "undefined" };
  if (typeof value === "function" || (typeof value === "number" && !Number.isFinite(value))) throw new TypeError("Unsupported view value");
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) throw new TypeError("Circular view value");
  seen.add(value);
  try {
  if (value instanceof Date) return { $imars: "date", value: value.toISOString() };
  if (typeof value.toDate === "function") return { $imars: "date", value: value.toDate().toISOString() };
  if (Array.isArray(value.docs) && typeof value.forEach === "function") return { $imars: "query", docs: value.docs.map(item => encodeView(item, seen)) };
  if (typeof value.data === "function" && typeof value.exists === "function") {
    const data = value.data();
    const display = data && Object.fromEntries(Object.entries(data).filter(([key]) => DISPLAY_FIELDS.has(key)));
    return { $imars: "doc", id: value.id, exists: value.exists(), data: encodeView(display, seen) };
  }
  if (Array.isArray(value)) return value.map(item => encodeView(item, seen));
  const prototype = Object.getPrototypeOf(value);
  if (prototype && prototype.constructor?.name !== "Object") throw new TypeError("Unsupported SDK value");
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeView(item, seen)]));
  } finally { seen.delete(value); }
}
export function decodeView(value) {
  if (value === null || typeof value !== "object") return value;
  if (value.$imars === "undefined") return undefined;
  if (value.$imars === "date") return new Date(value.value);
  if (value.$imars === "doc") {
    const data = decodeView(value.data);
    return { id: value.id, exists: () => value.exists, data: () => data };
  }
  if (value.$imars === "query") {
    const docs = value.docs.map(decodeView);
    return { docs, size: docs.length, empty: !docs.length, forEach: callback => docs.forEach(callback), metadata: { fromCache: true, hasPendingWrites: false } };
  }
  if (Array.isArray(value)) return value.map(decodeView);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeView(item)]));
}
