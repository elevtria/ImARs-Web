import { appStore, supabaseWebData } from "./supabase-app-store.js";
import { lessonNotifications, latestNotifications } from "../js/test-notifications.js";

const valid = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const active = data => data && data.active !== false && !["inactive", "disabled", "deleted", "archived"].includes(String(data.status || "").toLowerCase());
const positive = value => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
const time = value => { const date = new Date(value || 0); return Number.isFinite(date.getTime()) && date.getTime() > 0 ? date.getTime() : 0; };
const emptyTotals = () => ({ total: 0, preSum: 0, preCount: 0, postSum: 0, postCount: 0, arMinutes: 0, recent: [], notifications: [] });
const profileFields = ["active", "status", "role", "classCode", "displayName", "fullName"];
const resultFields = ["isPreTestCompleted", "preTestScore", "preTestTotalQuestions", "isPostTestCompleted", "postTestScore", "postTestTotalQuestions", "postTestHeatmap",
  "preTestCompletedAt", "postTestCompletedAt", "arTimeMinutes", "arNavigationTimeMinutes", "timestamp", "lastUpdated", "completedAt", "learningTimeByDevice", "lessonTimeMinutes", "isLessonCompleted", "isARCompleted", "completed", "activityScore", "activityTotalQuestions", "activityTotalPoints"];
export function dashboardScope(sections, env) {
  const scope = JSON.stringify(sections.map(row => [row.id, row.name]).sort(([a], [b]) => a.localeCompare(b)));
  return supabaseWebData(env) ? env.IMARS_SUPABASE_APP_DATASET_ID + ":" + scope : scope;
}
export function dashboardRefreshInterval(summary) {
  return Math.max(300_000, (summary?.total || 0) * 12 / 6_000 * 86_400_000);
}
export const lessonPaths = id => [1, 2, 3].flatMap(term => [1, 2, 3, 4].map(lesson => `users/${id}/test_results/term_0${term}/lessons/lesson_0${lesson}`));

export function assessmentPoints(data, kind, maximum) {
  const prefix = kind === "pre" ? "preTest" : "postTest";
  if (data[kind === "pre" ? "isPreTestCompleted" : "isPostTestCompleted"] !== true) return null;
  const total = data[prefix + "TotalQuestions"];
  const score = data[prefix + "Score"] ?? (kind === "post" && Array.isArray(data.postTestHeatmap) ? data.postTestHeatmap.filter(value => value === true).length : null);
  return typeof score === "number" && typeof total === "number" && Number.isFinite(score) && Number.isFinite(total) && total > 0 && score >= 0 && score <= total ? score / total * maximum : null;
}

export function summarizeStudent(id, profile, section, lessons) {
  const row = { id, name: String(profile.displayName || profile.fullName || "Student").slice(0, 300), section,
    preSum: 0, preCount: 0, postSum: 0, postCount: 0, arMinutes: 0, lastActive: 0, hasActivity: false };
  for (const data of lessons) {
    const pre = assessmentPoints(data, "pre", 5), post = assessmentPoints(data, "post", 10);
    if (pre !== null) { row.preSum += pre; row.preCount++; }
    if (post !== null) { row.postSum += post; row.postCount++; }
    const ar = positive(data.arTimeMinutes) || positive(data.arNavigationTimeMinutes);
    row.arMinutes += ar;
    const at = Math.max(time(data.timestamp), time(data.lastUpdated), time(data.completedAt));
    row.lastActive = Math.max(row.lastActive, at);
    row.hasActivity ||= at > 0 || pre !== null || post !== null || ar > 0 || positive(data.lessonTimeMinutes) > 0 ||
      Object.values(data.learningTimeByDevice || {}).some(device => positive(device?.lessonSeconds) > 0 || positive(device?.arSeconds) > 0) ||
      data.isLessonCompleted === true || data.isARCompleted === true || data.completed === true ||
      (typeof data.activityScore === "number" && data.activityScore >= 0 && (data.activityTotalQuestions > 0 || data.activityTotalPoints > 0));
  }
  return row;
}

export function addStudent(totals, row) {
  totals.total++;
  totals.notifications = latestNotifications([...(totals.notifications || []), ...(row.notifications || [])]);
  for (const field of ["preSum", "preCount", "postSum", "postCount", "arMinutes"]) totals[field] += row[field];
  const { notifications, ...recentRow } = row;
  if (row.hasActivity) totals.recent = [...totals.recent, recentRow].sort((a, b) => b.lastActive - a.lastActive || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)).slice(0, 25);
  return totals;
}

// Each teacher has a separate private Durable Object. Only compact rollups are
// retained; answers, passwords and full lesson documents are never cached here.
export class DashboardSummary {
  constructor(storage, env, { store = appStore(env), now = () => Date.now(), report = () => {} } = {}) {
    this.storage = storage; this.store = store; this.now = now; this.report = report; this.env = env;
  }
  async schedule(delay = 1000) {
    const next = this.now() + delay, alarm = await this.storage.getAlarm();
    if (!alarm || alarm > next) await this.storage.setAlarm(next);
  }
  async configure(body) {
    if (!valid(body.id) || !valid(body.uid) || !Array.isArray(body.sections) || body.sections.length > 500 ||
        body.sections.some(row => !valid(row.id) || typeof row.name !== "string" || row.name.length > 300) ||
        new Set(body.sections.map(row => row.id)).size !== body.sections.length) throw new Error("Invalid dashboard scope");
    const previous = await this.storage.get("dashboard:config"), scope = dashboardScope(body.sections, this.env);
    if (!previous || previous.id !== body.id || previous.uid !== body.uid || previous.scope !== scope) {
      await this.storage.put("dashboard:config", { id: body.id, uid: body.uid, sections: body.sections, scope });
      await this.start();
    }
    const summary = await this.storage.get("dashboard:summary");
    // Legacy app builds have no sync notification. Reconcile quietly while the
    // dashboard is in use. Leave room for mobile, login checks and both hosts
    // within the shared free database quota.
    const interval = dashboardRefreshInterval(summary);
    if (!summary || summary.scope !== scope || (!body.warmOnly && this.now() - summary.reconciledAt >= interval)) {
      if (!await this.storage.get("dashboard:job")) await this.start();
    }
    if (await this.storage.get("dashboard:job")) await this.schedule();
    return this.read(body);
  }
  async read(body) {
    const config = await this.storage.get("dashboard:config"), summary = await this.storage.get("dashboard:summary");
    if (!config || config.id !== body.id || config.uid !== body.uid || config.scope !== dashboardScope(body.sections, this.env)) return null;
    if (!summary || summary.scope !== config.scope) return { ready: false };
    const { generation, scope, ...result } = summary;
    const pending = Boolean(await this.storage.get("dashboard:job")) || (await this.storage.list({ prefix: "dashboard:dirty:", limit: 1 })).size > 0;
    return { ready: true, pending, summary: result };
  }
  async start() {
    const config = await this.storage.get("dashboard:config");
    if (!config) return;
    await this.storage.put("dashboard:job", { generation: crypto.randomUUID(), scope: config.scope, phase: "scan", sectionIndex: 0, after: "", startedAt: this.now() });
    await this.schedule();
  }
  async invalidate(ids, lesson) {
    if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => !valid(id))) throw new Error("Invalid dashboard update");
    if (lesson !== undefined && !/^term_0[1-3]\/lessons\/lesson_0[1-4]$/.test(lesson)) throw new Error("Invalid lesson update");
    for (const id of ids) {
      const key = "dashboard:dirty:" + id, previous = await this.storage.get(key);
      await this.storage.put(key, lesson && previous !== true ? [...new Set([...(previous || []), lesson])] : true);
    }
    if (await this.storage.get("dashboard:config")) await this.schedule();
  }
  async loadStudents(profiles, config, generation, changes) {
    const sectionIds = [...new Set(profiles.map(row => row.data.classCode).filter(id => config.sections.some(section => section.id === id)))];
    const sections = sectionIds.length ? await this.store.getAll(sectionIds.map(id => "classes/" + id)) : new Map();
    const accepted = profiles.filter(row => active(row.data) && (!row.data.role || row.data.role === "student") && sections.get("classes/" + row.data.classCode)?.data.teacherId === config.id);
    const previous = new Map(await Promise.all(profiles.map(async row => [row.id, await this.storage.get("dashboard:student:" + row.id)])));
    const requested = row => {
      const change = changes?.get("dashboard:dirty:" + row.id), saved = previous.get(row.id);
      return Array.isArray(change) && saved?.generation === generation && saved.lessons
        ? change.map(lesson => `users/${row.id}/test_results/${lesson}`) : lessonPaths(row.id);
    };
    const paths = accepted.flatMap(requested), records = new Map();
    // At most 25 students (300 fixed documents) per alarm; no unbounded query
    // of students' subcollections, and no report-sized response to a browser.
    await Promise.all(Array.from({ length: Math.ceil(paths.length / 100) }, async (_, index) => {
      for (const [path, record] of await this.store.getAll(paths.slice(index * 100, index * 100 + 100), { fieldPaths: resultFields })) records.set(path, record);
    }));
    for (const profile of profiles) {
      const section = config.sections.find(section => section.id === profile.data.classCode);
      let row = null, lessons = {};
      if (accepted.includes(profile)) {
        const saved = previous.get(profile.id);
        if (saved?.generation === generation) lessons = saved.lessons || {};
        for (const path of requested(profile)) {
          const part = summarizeStudent("", {}, "", records.get(path) ? [records.get(path).data] : []);
          const [termId, , lessonId] = path.split("/test_results/")[1].split("/");
          part.notifications = lessonNotifications(profile.id, profile.data.displayName || profile.data.fullName || "Student", section.name,
            termId, lessonId, records.get(path)?.data || {});
          delete part.id; delete part.name; delete part.section;
          lessons[path.split("/test_results/")[1]] = part;
        }
        row = summarizeStudent(profile.id, profile.data, section.name, []);
        row.notifications = Object.values(lessons).flatMap(part => (part.notifications || []).map(item => ({ ...item, name: row.name, section: row.section })));
        for (const part of Object.values(lessons)) {
          for (const field of ["preSum", "preCount", "postSum", "postCount", "arMinutes"]) row[field] += part[field];
          row.lastActive = Math.max(row.lastActive, part.lastActive); row.hasActivity ||= part.hasActivity;
        }
      }
      await this.storage.put("dashboard:student:" + profile.id, { generation, row, lessons });
    }
  }
  async step() {
    const config = await this.storage.get("dashboard:config");
    if (!config) return;
    const profile = (await this.store.get("users/" + config.id))?.data;
    if (!active(profile) || profile.role !== "teacher" || profile.uid !== config.uid) {
      await this.storage.delete("dashboard:summary"); await this.storage.delete("dashboard:job"); return;
    }
    let job = await this.storage.get("dashboard:job"), summary = await this.storage.get("dashboard:summary");
    if (!job) {
      const dirty = await this.storage.list({ prefix: "dashboard:dirty:", limit: 25 });
      if (!dirty.size) return;
      if (!summary || summary.scope !== config.scope) { await this.start(); return; }
      job = { generation: summary.generation, scope: config.scope, phase: "dirty", startedAt: this.now(), reconciledAt: summary.reconciledAt };
    }
    if (job.scope !== config.scope) { await this.start(); return; }
    if (job.phase === "scan") {
      const section = config.sections[job.sectionIndex];
      if (section) {
        // Recheck ownership before every batch, including background batches.
        const current = (await this.store.get("classes/" + section.id))?.data;
        if (!current || current.teacherId !== config.id) { await this.storage.delete("dashboard:summary"); await this.storage.delete("dashboard:job"); return; }
        const rows = await this.store.query("users", { filters: [{ field: "classCode", value: section.id }], limit: 25, after: job.after || undefined, fieldPaths: profileFields });
        await this.loadStudents(rows, config, job.generation);
        if (rows.length === 25) job.after = rows.at(-1).id;
        else { job.sectionIndex++; job.after = ""; }
      } else job.phase = "dirty";
    } else if (job.phase === "dirty") {
      const dirty = await this.storage.list({ prefix: "dashboard:dirty:", limit: 25 });
      if (dirty.size) {
        const profiles = await this.store.getAll([...dirty.keys()].map(key => "users/" + key.slice("dashboard:dirty:".length)), { fieldPaths: profileFields });
        await this.loadStudents([...profiles].map(([path, record]) => ({ id: path.slice(6), data: record?.data || {} })), config, job.generation, dirty);
        for (const key of dirty.keys()) await this.storage.delete(key);
      } else { job.phase = "aggregate"; job.totals = emptyTotals(); job.afterKey = ""; }
    } else {
      const rows = await this.storage.list({ prefix: "dashboard:student:", limit: 250, ...(job.afterKey ? { startAfter: job.afterKey } : {}) });
      for (const [key, record] of rows) {
        if (record.generation !== job.generation) await this.storage.delete(key);
        else if (record.row) addStudent(job.totals, record.row);
      }
      if (rows.size === 250) job.afterKey = [...rows.keys()].at(-1);
      else {
        if ((await this.storage.list({ prefix: "dashboard:dirty:", limit: 1 })).size) job.phase = "dirty";
        else {
          await this.storage.put("dashboard:summary", { ...job.totals, generation: job.generation, scope: config.scope,
            sectionNames: config.sections.map(section => section.name), asOf: job.startedAt, reconciledAt: job.reconciledAt || job.startedAt });
          await this.storage.delete("dashboard:job");
          this.report({ students: job.totals.total });
          return;
        }
      }
    }
    await this.storage.put("dashboard:job", job);
    await this.schedule();
  }
}
