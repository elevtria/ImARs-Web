import { getTeacherReportPage } from "./firebase-data.js";
import { getAuth } from "./firebase-auth.js";
import { encodeView, decodeView, reuseTeacherReport } from "./view-cache.js";
import { prepareTeacherCache, watchVisibleData } from "./teacher-view.js";

// Reports arrive in bounded pages. Leaving cancels further work; an automatic
// check replaces one page instead of downloading the class again.
export function createTeacherReport({ app, render, progress = () => {}, failed = () => {} }) {
  let generation = 0, abort, timer, stopUpdates, state, user, options, cache, version, running = false;
  const stop = () => { generation++; abort?.abort(); clearTimeout(timer); stopUpdates?.(); running = false; };
  if (typeof window !== "undefined") window.addEventListener("pagehide", stop);
  const current = token => token === generation && getAuth(app).currentUser?.uid === user?.uid;
  const visibleClasses = () => {
    const selected = options.sectionId === "first" ? state.classes[0]?.id : options.sectionId;
    return state.classes.filter(row => !selected || row.id === selected);
  };
  const paint = () => {
    const merged = new Map();
    for (const page of state.pages) for (const row of page.students) merged.set(row.studentDoc.id, row);
    const students = [...merged.values()];
    const sections = visibleClasses().map(classDoc => ({ classDoc, students: students.filter(row => row.classId === classDoc.id) }));
    const total = state.complete ? students.length : state.countsKnown ? state.counts.reduce((sum, row) => sum + row.active, 0) : null;
    render({ ...state, sections, loaded: students.length, total, termId: options.termId, teacherName: user.displayName || "Teacher" });
    progress({ loaded: students.length, total, complete: state.complete, termId: options.termId });
  };
  const remember = changedIndex => {
    if (state.complete) {
      const students = new Map(state.pages.flatMap(page => page.students).map(row => [row.studentDoc.id, row]));
      state.counts = visibleClasses().map(row => ({ classId: row.id,
        active: [...students.values()].filter(student => student.classId === row.id).length,
        archived: state.counts.find(count => count.classId === row.id)?.archived ?? null }));
      state.countsKnown = true;
    }
    state.pages.forEach((page, index) => { if (changedIndex === undefined || index === changedIndex) cache.put(user.uid, options.key + ":" + index, encodeView(page), version); });
    cache.put(user.uid, options.key, encodeView({ ...state, pages: state.pages.map((_, index) => index) }), version);
  };
  const update = async token => {
    if (!current(token) || running || document.visibilityState === "hidden") return;
    running = true;
    const cursor = state.complete ? state.refreshCursor : state.cursor;
    const existing = state.pages.find(page => JSON.stringify(page.cursor) === JSON.stringify(cursor));
    const batchSize = state.complete ? existing?.batchSize || 25 : state.pages.length ? 100 : 25;
    const curriculumOnly = options.includeCurriculum && state.pages.length > 0 && !state.curriculumSnap;
    try {
      abort = new AbortController();
      const result = await getTeacherReportPage({ termId: options.termId, sectionId: options.sectionId === "first" ? "" : options.sectionId,
        ...(options.allTerms ? { allTerms: true } : {}),
        firstSection: options.sectionId === "first", cursor, batchSize, includeCounts: !cursor ? "cached" : false, includeCurriculum: options.includeCurriculum && !state.curriculumSnap,
        ...(curriculumOnly ? { includeStudents: false, includeCounts: false } : {}) }, { signal: abort.signal });
      if (!current(token)) return;
      if (cache.version() !== version) {
        version = cache.version();
        state = { pages: [], classes: [], counts: [], cursor: null, refreshCursor: null, complete: false };
        timer = setTimeout(() => { void update(token); }, 0);
        return;
      }
      if (result.curriculum) {
        Object.assign(state, result.curriculum);
        cache.put(user.uid, "report:curriculum:" + options.termId, encodeView(result.curriculum), version);
      }
      if (curriculumOnly) {
        if (JSON.stringify(state.classes.map(row => row.id)) !== JSON.stringify(result.classes.map(row => row.id))) {
          state = { pages: [], classes: [], counts: [], cursor: null, refreshCursor: null, complete: false };
          timer = setTimeout(() => { void update(token); }, 0);
          return;
        }
        remember(); paint(); return;
      }
      const slot = state.pages.findIndex(page => JSON.stringify(page.cursor) === JSON.stringify(cursor));
      const page = { cursor, batchSize, students: result.students };
      const changed = slot < 0 || JSON.stringify(encodeView(state.pages[slot])) !== JSON.stringify(encodeView(page)) || (result.counts && JSON.stringify(state.counts) !== JSON.stringify(result.counts));
      if (slot < 0) state.pages.push(page); else state.pages[slot] = page;
      state.classes = result.classes; if (result.counts) { state.counts = result.counts; state.countsKnown = true; }
      let reindexed = false;
      if (state.complete) {
        if (!cursor) state.refreshSeen = [];
        (state.refreshSeen ||= []).push(JSON.stringify(cursor));
        state.refreshCursor = result.cursor;
        if (!result.cursor) { state.pages = state.pages.filter(page => state.refreshSeen.includes(JSON.stringify(page.cursor))); reindexed = true; }
      }
      else { state.cursor = result.cursor; state.complete = !result.cursor; }
      state.checkedAt = Date.now();
      remember(reindexed ? undefined : slot < 0 ? state.pages.length - 1 : slot);
      if (changed || !state.complete) paint();
      // The first class report fills in gradually while this page is visible.
      // Later automatic checks update one existing page per tick.
      if (!state.complete) timer = setTimeout(() => { void update(token); }, 0);
    } catch (error) {
      if (current(token) && error.name !== "AbortError") {
        if (["permission-denied", "unauthenticated"].includes(error.code)) { cache.invalidate(); document.querySelector("main")?.replaceChildren(); stop(); }
        else failed(error);
      }
    } finally { if (current(token)) running = false; }
  };
  return { stop, async open({ user: account, termId = "term_01", sectionId = "first", allTerms = false, includeCurriculum = true }) {
    stop(); user = account; const token = generation;
    cache = prepareTeacherCache(app, user); version = cache.version();
    options = { termId, sectionId, allTerms, includeCurriculum, key: "teacher-report:" + (allTerms ? "all-terms-v1" : termId) + ":" + (sectionId || "all") };
    state = { pages: [], classes: [], counts: [], cursor: null, refreshCursor: null, complete: false };
    const saved = cache.get(user.uid, options.key);
    if (saved) try {
      const restored = decodeView(saved);
      const pages = restored.pages.map(index => { const page = cache.get(user.uid, options.key + ":" + index); if (!page) throw new Error("Incomplete cached report"); return decodeView(page); });
      state = { ...restored, pages }; paint();
    } catch { cache.remove(options.key); }
    if (!state.pages.length) {
      const reused = reuseTeacherReport(cache, user.uid, { ...options, now: Date.now() });
      if (reused) {
        state = reused;
        if (state.curriculumSnap || !includeCurriculum) paint();
      }
    }
    stopUpdates = watchVisibleData(app, user, () => update(token));
    if (!state.pages.length || (includeCurriculum && !state.curriculumSnap) || Date.now() - state.checkedAt >= 60000) await update(token);
    else if (!state.complete) timer = setTimeout(() => { void update(token); }, 0);
  } };
}
