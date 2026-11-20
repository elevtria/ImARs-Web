import { initializeApp, getAuth, onAuthStateChanged } from "./firebase-auth.js";
import { showAdminView } from "./admin-view.js";
import { escapeHtml } from "./teacher-view.js";
import { teacherViewCache } from "./view-cache.js";
import { webRequest } from "./web-login.js";

const app = initializeApp(), auth = getAuth(app);
const list = document.getElementById("bugReportList"), status = document.getElementById("reportsStatus");
const search = document.getElementById("reportSearch");
const refresh = document.getElementById("refreshReports"), more = document.getElementById("moreReports");
const labels = { new: "New", "in-progress": "In progress", resolved: "Resolved" };
let reports = [], cursor = null, ready = false, loading = false;
const date = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short" }) : "Not recorded";
function render() {
  const query = search.value.trim().toLowerCase();
  const visible = reports.filter(row => [row.issue, row.description, row.reporterName, row.reporterId, row.category, row.scene].join(" ").toLowerCase().includes(query));
  document.getElementById("reportCount").textContent = `${reports.length} reports loaded · ${reports.filter(row => row.status === "new").length} new`;
  list.innerHTML = visible.map(row => `<article class="bug-report" data-status="${escapeHtml(row.status)}">
    <div class="bug-report-heading"><div><span class="report-category">${escapeHtml(row.category)}</span><h3>${escapeHtml(row.issue)}</h3></div>
      <label class="report-status-control">Status<select data-report-id="${escapeHtml(row.id)}" aria-label="Status for ${escapeHtml(row.issue)}">${Object.entries(labels).map(([value, label]) => `<option value="${value}"${value === row.status ? " selected" : ""}>${label}</option>`).join("")}</select></label></div>
    <p class="report-author">${escapeHtml(row.reporterName || row.reporterId)} · ${escapeHtml(row.reporterId)} <span>Submitted ${escapeHtml(date(row.createdAt))}</span></p>
    <p class="report-description">${escapeHtml(row.description)}</p>
    <details class="report-details"><summary>App and report details</summary><dl>${[["App version", row.appVersion], ["Platform", row.platform], ["Screen", row.scene], ["Section ID", row.sectionId], ["Updated", row.updatedAt ? date(row.updatedAt) : "Not reviewed yet"], ["Report ID", row.id]].map(([key, value]) => `<div><dt>${key}</dt><dd>${escapeHtml(value || "Not recorded")}</dd></div>`).join("")}</dl></details>
  </article>`).join("");
  const empty = document.getElementById("reportsEmpty");
  empty.hidden = visible.length !== 0;
  empty.querySelector("h3").textContent = reports.length ? "No matching reports" : "No reports yet";
  empty.querySelector("p").textContent = reports.length ? "Try another search. Load older reports to search more submissions." : "New mobile submissions will appear here. Reports sent by email in older app versions are not included.";
  more.hidden = !cursor;
}
function accept(result, append = false) {
  reports = append ? [...new Map([...reports, ...result.reports].map(row => [row.id, row])).values()] : result.reports;
  cursor = result.cursor; render();
}
async function load(append = false) {
  if (!ready || loading) return;
  loading = true; refresh.disabled = more.disabled = true;
  status.textContent = "Checking mobile submissions…";
  const uid = auth.currentUser?.uid;
  try {
    const result = await webRequest("/api/bug-reports/list", { ...(append && cursor ? { cursor } : {}) });
    if (auth.currentUser?.uid !== uid) return;
    teacherViewCache().remove("admin:bug-reports-v1");
    accept(result, append); status.textContent = "Latest submissions first · Times use Philippine time.";
  } catch (error) { if (auth.currentUser?.uid === uid) status.textContent = error.message; }
  finally { loading = false; refresh.disabled = more.disabled = !ready; }
}
onAuthStateChanged(auth, async user => {
  ready = false; refresh.disabled = true;
  if (!user) return;
  try {
    await showAdminView({ app, user, page: "admin:bug-reports-v1",
      load: () => webRequest("/api/bug-reports/list", {}),
      render: result => { accept(result); ready = true; refresh.disabled = false; status.textContent = "Latest submissions first · Times use Philippine time."; } });
  } catch (error) { status.textContent = error.message; }
});
refresh.addEventListener("click", () => load());
more.addEventListener("click", () => load(true));
search.addEventListener("input", render);
list.addEventListener("change", async event => {
  const select = event.target.closest("select[data-report-id]");
  if (!select || !ready) return;
  const row = reports.find(row => row.id === select.dataset.reportId);
  if (!row) return;
  const next = select.value, uid = auth.currentUser?.uid;
  select.disabled = true;
  try {
    await webRequest("/api/bug-reports/status", { id: row.id, status: next });
    if (auth.currentUser?.uid !== uid) return;
    row.status = next; row.updatedAt = new Date().toISOString();
    teacherViewCache().remove("admin:bug-reports-v1"); render(); status.textContent = "Report marked " + labels[next].toLowerCase() + ".";
  } catch (error) { select.value = row.status; status.textContent = error.message; }
  finally { select.disabled = false; }
});
