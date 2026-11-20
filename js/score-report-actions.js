import { collectScoreReport, scoreReportFilename, SCHOOL_NAME, SCHOOL_ADDRESS } from "./score-report-data.js";

// Cache only public rendering resources; student scores are fetched for every export.
let resources;
function loadReportResources() {
  resources ||= import("./score-report-renderer.js").then(async renderer => ({ renderer, assets: await renderer.loadScoreReportAssets() }))
    .catch(error => { resources = null; throw error; });
  return resources;
}
export function warmScoreReportResources() {
  void loadReportResources().catch(() => {});
}

export async function createScoreReportOutput(options, services) {
  const [report, { renderer, assets }] = await Promise.all([collectScoreReport(options, services), loadReportResources()]);
  options.signal.throwIfAborted();
  options.onStage?.(options.mode === "print" ? "Preparing print pages…" : "Creating PDF…");
  const output = await renderer.renderScoreReport(report, assets, { mode: options.mode || "download" });
  options.signal.throwIfAborted();
  return { ...output, filename: scoreReportFilename(report), students: report.students.length };
}

export async function showScoreReport(output, { signal }) {
  signal.throwIfAborted();
  const url = URL.createObjectURL(new Blob([output.pdfBytes], { type: "application/pdf" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = output.filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function createSchoolYearHistoryOutput(archive, { signal, preparedBy, now = new Date() }) {
  signal.throwIfAborted();
  if (!Number.isInteger(archive.startYear) || !Array.isArray(archive.rows) ||
      archive.rows.some(row => !Array.isArray(row) || row.length !== 19))
    throw new Error("The archived report could not be read. Please try again.");
  const formatDate = value => new Date(value).toLocaleString("en-PH", { timeZone: "Asia/Manila" });
  const report = { ...archive, schoolName: SCHOOL_NAME, schoolAddress: SCHOOL_ADDRESS,
    teacherName: preparedBy, generatedAt: now.toISOString(), generatedLabel: formatDate(now),
    closedLabel: formatDate(archive.closedAt), reportTitle: `Archived School Year Report ${archive.startYear}-${archive.startYear + 1}` };
  const { renderer, assets } = await loadReportResources();
  signal.throwIfAborted();
  const output = await renderer.renderScoreReport(report, assets, { mode: "download", layout: renderer.layoutSchoolYearHistory });
  signal.throwIfAborted();
  return { ...output, filename: `ImARs-SY-${archive.startYear}-${archive.startYear + 1}-report.pdf` };
}
