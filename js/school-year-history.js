import { initializeApp, getAuth, onAuthStateChanged } from "./firebase-auth.js";
import { showAdminView } from "./admin-view.js";
import { webRequest } from "./web-login.js";
import { escapeHtml } from "./teacher-view.js";
import { teacherViewCache } from "./view-cache.js";
import { confirmAdminAction } from "./admin-account-action.js";
import { createSchoolYearHistoryOutput, showScoreReport } from "./score-report-actions.js";

const app = initializeApp(), auth = getAuth(app);
const status = document.getElementById("schoolYearHistoryStatus"), close = document.getElementById("closeSchoolYear");
const refresh = document.getElementById("refreshYearPreview"), archives = document.getElementById("schoolYearArchives");
const tabs = [document.getElementById("currentYearTab"), document.getElementById("historyYearTab")];
let preview, loading = false, reportLifetime;
function selectTab(index) {
  tabs.forEach((tab, i) => { tab.setAttribute("aria-selected", String(i === index)); tab.tabIndex = i === index ? 0 : -1; document.getElementById(tab.getAttribute("aria-controls")).hidden = i !== index; });
}
tabs.forEach((tab, i) => {
  tab.addEventListener("click", () => selectTab(i));
  tab.addEventListener("keydown", event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? 1 : 1 - i; selectTab(next); tabs[next].focus(); } });
});
function render(data) {
  preview = data;
  document.getElementById("currentYearTitle").textContent = `SY ${data.currentYear}–${data.currentYear + 1}`;
  document.getElementById("schoolYearPreview").innerHTML = Object.entries({ "Active students to archive": data.counts.students, "Teacher accounts retained": data.counts.teachers,
    "Sections retained": data.counts.sections, "Recorded pre-/post-tests": data.counts.recordedTests }).map(([label, value]) => `<div><dt>${label}</dt><dd>${Number(value)}</dd></div>`).join("");
  archives.innerHTML = data.archives.map(row => `<tr><th scope="row">SY ${row.start_year}–${row.start_year + 1}</th><td>${escapeHtml(new Date(row.closed_at).toLocaleString("en-PH", { timeZone: "Asia/Manila" }))}</td><td>${Number(row.counts.students)}</td><td>${Number(row.counts.documents)} saved records</td><td><div class="admin-actions"><button type="button" class="ghost-btn" data-year-report="${escapeHtml(row.id)}" data-format="pdf">Download PDF</button><button type="button" class="ghost-btn" data-year-report="${escapeHtml(row.id)}" data-format="csv">Download CSV</button><button type="button" class="ghost-btn" data-year-report="${escapeHtml(row.id)}" data-format="json">Download detailed report</button></div></td></tr>`).join("") || '<tr><td colspan="5">No school years have been closed yet. Your current records are still in the live year.</td></tr>';
  close.disabled = !data.storageReady;
  status.textContent = "Review this preview before closing the year. No records are changed by opening this page.";
}
async function load(force = false) {
  const user = auth.currentUser;
  if (!user || loading) return;
  loading = true; refresh.disabled = true; close.disabled = true;
  if (force) teacherViewCache().invalidate();
  try {
    await showAdminView({ app, user, page: "admin:school-years-v1", load: () => webRequest("/api/school-years/action", { action: "overview" }), render });
  } catch (error) { preview = null; close.disabled = true; status.textContent = error.message; }
  finally { loading = false; refresh.disabled = false; }
}
onAuthStateChanged(auth, user => {
  reportLifetime?.abort();
  reportLifetime = null;
  if (user) void load();
});
refresh.addEventListener("click", () => load(true));
close.addEventListener("click", async () => {
  if (!preview || loading || auth.currentUser?.role !== "admin") return;
  const startYear = preview.currentYear;
  const result = await confirmAdminAction({ action: "close", startYear, revision: preview.revision }, `Close SY ${startYear}–${startYear + 1}?`,
    `This archives the school’s student roster, results, quizzes and submissions, resets live results and schedules, and starts SY ${startYear + 1}–${startYear + 2}. Teacher accounts and lesson content stay. Import a new roster afterward. This page cannot reopen a closed year.`,
    { endpoint: "/api/school-years/action", confirmationText: `CLOSE ${startYear}-${startYear + 1}` });
  if (result) {
    try { localStorage.setItem("imars-school-year-v1", JSON.stringify({ startYear: result.nextYear, checkedAt: Date.now() })); } catch {}
    await load(true); selectTab(1); status.textContent = result.message;
  }
});
export function reportCsv(report) {
  const cell = value => '"' + String(value ?? "").replace(/^[=+@\-\t\r]/, match => "'" + match).replaceAll('"', '""') + '"';
  return "\uFEFF" + [report.columns, ...report.rows].map(row => row.map(cell).join(",")).join("\r\n");
}
archives.addEventListener("click", async event => {
  const button = event.target.closest("[data-year-report]");
  if (!button || auth.currentUser?.role !== "admin" || reportLifetime) return;
  const lifetime = reportLifetime = new AbortController();
  button.disabled = true; status.textContent = "Preparing the archived report…";
  const uid = auth.currentUser.uid;
  try {
    const report = await webRequest("/api/school-years/action", { action: "report", archiveId: button.dataset.yearReport });
    if (auth.currentUser?.uid !== uid || lifetime.signal.aborted) return;
    if (button.dataset.format === "pdf") {
      status.textContent = "Creating the archived PDF report…";
      const output = await createSchoolYearHistoryOutput(report, {
        signal: lifetime.signal, preparedBy: auth.currentUser.displayName || auth.currentUser.id || "School Administrator"
      });
      if (auth.currentUser?.uid !== uid || lifetime.signal.aborted) return;
      await showScoreReport(output, { signal: lifetime.signal });
      status.textContent = "Archived PDF report downloaded.";
      return;
    }
    const csv = button.dataset.format === "csv";
    const url = URL.createObjectURL(new Blob([csv ? reportCsv(report) : JSON.stringify(report, null, 2)], { type: csv ? "text/csv;charset=utf-8" : "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `ImARs-SY-${report.startYear}-${report.startYear + 1}.${csv ? "csv" : "json"}`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); status.textContent = "Archived report downloaded.";
  } catch (error) {
    if (auth.currentUser?.uid === uid && !lifetime.signal.aborted) status.textContent = error.message;
  } finally {
    button.disabled = false;
    if (reportLifetime === lifetime) reportLifetime = null;
  }
});
