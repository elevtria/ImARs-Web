import { onAuthStateChanged } from "./firebase-auth.js";
import { getDashboardSummary } from "./firebase-data.js";
import { createTeacherReport } from "./teacher-report-data.js";
import { watchVisibleData } from "./teacher-view.js";
import { reportNotifications } from "./test-notifications.js";

const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};

export function initTeacherNotifications(app, auth) {
  const toolbar = document.querySelector(".topbar-right");
  if (!toolbar) return;
  const host = element("div", undefined, "teacher-notifications");
  const bell = element("button", undefined, "theme-toggle notification-toggle");
  bell.type = "button";
  bell.setAttribute("aria-label", "Test notifications");
  bell.setAttribute("aria-expanded", "false");
  bell.setAttribute("aria-controls", "teacherNotifications");
  bell.title = "Test notifications";
  bell.innerHTML = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg>';
  const badge = element("span", "", "notification-badge"); badge.setAttribute("aria-hidden", "true"); badge.hidden = true; bell.append(badge);
  const panel = element("section", undefined, "notification-panel");
  panel.id = "teacherNotifications"; panel.hidden = true; panel.setAttribute("aria-labelledby", "notificationTitle");
  const heading = element("h2", "Test notifications"); heading.id = "notificationTitle";
  const mark = element("button", "Mark all read", "notification-mark"); mark.type = "button";
  const header = element("div", undefined, "notification-header"); header.append(heading, mark);
  const status = element("p", "Loading test completions…", "notification-status"); status.setAttribute("role", "status");
  const list = element("ul", undefined, "notification-list");
  const footer = element("a", "View student records", "notification-footer"); footer.href = "student-records.html";
  panel.append(header, status, list, footer); host.append(bell, panel); host.hidden = true;
  const theme = toolbar.querySelector(".theme-toggle");
  if (theme) theme.after(host); else toolbar.prepend(host);
  let owner, items = [], read = new Set(), stopUpdates, report, busy = false, retryTimer;
  const storageKey = () => "imars-test-notifications:" + owner;
  const save = () => { try { localStorage.setItem(storageKey(), JSON.stringify([...read].slice(-2000))); } catch { /* Session-only when storage is unavailable. */ } };
  function paint() {
    const unread = items.filter(item => !read.has(item.id)).length;
    badge.hidden = !unread; badge.textContent = String(unread);
    bell.setAttribute("aria-label", `Test notifications, ${unread} unread`);
    mark.disabled = !unread;
    list.replaceChildren();
    for (const item of items) {
      const row = element("li");
      const link = element("a", undefined, read.has(item.id) ? "notification-item" : "notification-item unread");
      link.href = "student-records.html";
      const name = element("strong", item.name);
      const test = item.kind === "pre" ? "pre-test" : "post-test";
      const detail = element("span", `Completed the ${test} · Term ${Number(item.termId.slice(-2))}, Lesson ${Number(item.lessonId.slice(-2))}`);
      const section = element("small", item.section);
      link.append(name, detail, section);
      link.addEventListener("click", () => { read.add(item.id); save(); paint(); });
      row.append(link); list.append(row);
    }
  }
  function receive(next, complete = true) {
    items = next; paint();
    status.textContent = complete ? items.length ? "Latest completed tests" : "No completed tests yet." : "Checking student test completions…";
  }
  function close() { panel.hidden = true; bell.setAttribute("aria-expanded", "false"); }
  bell.addEventListener("click", () => {
    panel.hidden = !panel.hidden; bell.setAttribute("aria-expanded", String(!panel.hidden));
    if (!panel.hidden) void refresh();
  });
  mark.addEventListener("click", () => { for (const item of items) read.add(item.id); save(); paint(); });
  document.addEventListener("click", event => { if (!host.contains(event.target)) close(); });
  host.addEventListener("keydown", event => { if (event.key === "Escape") { close(); bell.focus(); } });
  window.addEventListener("storage", event => {
    if (owner && (event.key === storageKey() || event.key === null)) {
      try { const saved = JSON.parse(event.newValue || "[]"); read = new Set(Array.isArray(saved) ? saved : []); } catch { read = new Set(); }
      paint();
    }
  });
  async function refresh() {
    if (!owner || busy || report) return;
    busy = true; const uid = owner;
    try {
      const result = await getDashboardSummary();
      if (owner !== uid) return;
      if (result.enabled && (!result.ready || !Array.isArray(result.summary?.notifications))) {
        status.textContent = "Preparing test notifications…";
        clearTimeout(retryTimer); retryTimer = setTimeout(() => void refresh(), 30_000);
        return;
      }
      if (result.enabled) {
        receive(result.summary.notifications);
        if (result.pending) { clearTimeout(retryTimer); retryTimer = setTimeout(() => void refresh(), 30_000); }
        return;
      }
      // Older deployments use the same paged, teacher-scoped report cache as
      // the dashboard. No student reads or writes bypass the existing gateway.
      report = createTeacherReport({ app,
        render: data => { if (owner === uid) receive(reportNotifications(data.sections), data.complete); },
        failed: () => { if (owner === uid) status.textContent = "Could not update notifications. Retrying automatically."; }
      });
      await report.open({ user: auth.currentUser, sectionId: "", allTerms: true, includeCurriculum: false });
    } catch (error) {
      if (owner === uid) {
        if (["permission-denied", "unauthenticated"].includes(error.code)) { items = []; paint(); close(); }
        status.textContent = "Could not update notifications. Reopen to retry.";
      }
    } finally { if (owner === uid) busy = false; }
  }
  onAuthStateChanged(auth, user => {
    stopUpdates?.(); report?.stop(); report = null; clearTimeout(retryTimer); close();
    owner = user?.role === "teacher" ? user.uid : null;
    items = []; read = new Set(); busy = false; host.hidden = !owner;
    if (!owner) { paint(); return; }
    try { const saved = JSON.parse(localStorage.getItem(storageKey()) || "[]"); if (Array.isArray(saved)) read = new Set(saved); } catch { /* Use empty read state. */ }
    paint(); status.textContent = "Loading test completions…";
    stopUpdates = watchVisibleData(app, user, refresh, 300_000);
    void refresh();
  });
  window.addEventListener("pagehide", () => { clearTimeout(retryTimer); stopUpdates?.(); report?.stop(); });
}
