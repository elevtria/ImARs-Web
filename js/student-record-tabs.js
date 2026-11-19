const directory = document.getElementById("recordsDirectory");
const summary = document.getElementById("studentScoreSummary");
const directoryTab = document.getElementById("recordsDirectoryTab");
const summaryTab = document.getElementById("recordsSummaryTab");
let summaryModule, directoryModule;
async function selectSummary(selected) {
  directory.hidden = selected;
  summary.hidden = !selected;
  directoryTab.setAttribute("aria-pressed", String(!selected));
  summaryTab.setAttribute("aria-pressed", String(selected));
  if (!selected && !directoryModule) {
    directoryModule = import("./student-records.js").then(() => import("./student-record-browser.js"));
    try { await directoryModule; }
    catch { directoryModule = null; document.getElementById("recordsPageStatus").textContent = "Could not open student management. Choose Score summary, then try again."; }
  }
  if (selected && !summaryModule) {
    summaryModule = import("./student-score-summary.js");
    try { await summaryModule; }
    catch { summaryModule = null; document.getElementById("score-analyticsReportStatus").textContent = "Could not open the summary. Choose Student management, then try Score summary again."; }
  } else window.dispatchEvent(new Event("imars-score-summary-view"));
}
directoryTab.addEventListener("click", () => void selectSummary(false));
summaryTab.addEventListener("click", () => void selectSummary(true));
const student = new URLSearchParams(window.location.search).get("student");
if (student && /^[A-Za-z0-9_-]{1,100}$/.test(student)) {
  void selectSummary(false).then(() => {
    const search = document.getElementById("studentSearch");
    search.value = student;
    search.dispatchEvent(new Event("input"));
  });
} else void selectSummary(true);
