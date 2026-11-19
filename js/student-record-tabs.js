const directory = document.getElementById("recordsDirectory");
const summary = document.getElementById("studentScoreSummary");
const directoryTab = document.getElementById("recordsDirectoryTab");
const summaryTab = document.getElementById("recordsSummaryTab");
let summaryModule;
async function selectSummary(selected) {
  directory.hidden = selected;
  summary.hidden = !selected;
  directoryTab.setAttribute("aria-pressed", String(!selected));
  summaryTab.setAttribute("aria-pressed", String(selected));
  if (selected && !summaryModule) {
    summaryModule = import("./student-score-summary.js");
    try { await summaryModule; }
    catch { summaryModule = null; document.getElementById("score-analyticsReportStatus").textContent = "Could not open the summary. Choose Students, then try Score summary again."; }
  } else window.dispatchEvent(new Event("imars-score-summary-view"));
}
directoryTab.addEventListener("click", () => void selectSummary(false));
summaryTab.addEventListener("click", () => void selectSummary(true));
const student = new URLSearchParams(window.location.search).get("student");
if (student && /^[A-Za-z0-9_-]{1,100}$/.test(student)) {
  const search = document.getElementById("studentSearch");
  search.value = student;
  search.dispatchEvent(new Event("input"));
}
