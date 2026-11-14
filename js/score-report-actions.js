import { collectScoreReport, scoreReportFilename } from "./score-report-data.js";

export function openScorePrintWindow() {
  const preview = window.open("", "_blank");
  if (!preview) throw new Error("Allow pop-ups for this site, then choose Print report again.");
  preview.opener = null;
  preview.document.title = "Preparing school report";
  preview.document.body.textContent = "Preparing your school report…";
  return preview;
}

export async function createScoreReportOutput(options, services) {
  const renderer = await import("./score-report-renderer.js");
  const [report, assets] = await Promise.all([collectScoreReport(options, services), renderer.loadScoreReportAssets(options.signal)]);
  options.signal.throwIfAborted();
  const output = await renderer.renderScoreReport(report, assets);
  options.signal.throwIfAborted();
  return { ...output, filename: scoreReportFilename(report), students: report.students.length };
}

export async function showScoreReport(output, { mode, preview, signal }) {
  signal.throwIfAborted();
  if (mode === "print") {
    if (preview.closed) throw new Error("The print window was closed. Choose Print report to open it again.");
    preview.document.open();
    preview.document.write(output.html);
    preview.document.close();
    await preview.document.fonts.ready;
    await new Promise(resolve => preview.requestAnimationFrame(() => preview.requestAnimationFrame(resolve)));
    signal.throwIfAborted();
    if (preview.closed) throw new Error("The print window was closed.");
    preview.focus();
    preview.print();
  } else {
    const url = URL.createObjectURL(new Blob([output.pdfBytes], { type: "application/pdf" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = output.filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
