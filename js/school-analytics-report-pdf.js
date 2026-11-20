import { PDFDocument, rgb } from "./vendor/pdf-lib.esm.min.js";
import fontkit from "./vendor/fontkit.esm.min.js";
import { loadScoreReportAssets, wrapReportText } from "./score-report-renderer.js";

const color = hex => rgb(...hex.match(/[a-f0-9]{2}/gi).map(value => parseInt(value, 16) / 255));
let assets;
export async function schoolAnalyticsPdf(report) {
  assets ||= loadScoreReportAssets().catch(error => { assets = null; throw error; });
  const resource = await assets, pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const regular = await pdf.embedFont(resource.regular, { subset: true }), bold = await pdf.embedFont(resource.bold, { subset: true });
  const logo = await pdf.embedPng(resource.logo);
  pdf.setTitle(`${report.schoolName} · School Analytics · ${report.view}`);
  pdf.setAuthor(report.generatedBy); pdf.setCreationDate(new Date(report.generatedAt)); pdf.setCreator("ImARs");
  const width = 841.89, height = 595.28, left = 34;
  let page, y;
  const text = (value, x, baseline, size = 10, strong = false, fill = "233149") => page.drawText(String(value), { x, y: baseline, size, font: strong ? bold : regular, color: color(fill) });
  const wrapped = (value, available, size = 9) => wrapReportText(value, available, value => regular.widthOfTextAtSize(value, size));
  function newPage() {
    page = pdf.addPage([width, height]);
    page.drawImage(logo, { x: left, y: 510, width: 48, height: 48 });
    text(report.schoolName, 96, 543, 15, true); text(report.schoolAddress, 96, 526, 10, false, "58657a");
    text(`${report.title} · ${report.view}`, left, 486, 18, true);
    text(`${report.schoolYear} · ${report.period}`, left, 465, 11, true);
    const scopeLines = wrapped(`Scope: ${report.scope}`, 770, 10);
    scopeLines.forEach((line, i) => text(line, left, 447 - i * 13, 10));
    const scopeShift = Math.max(0, scopeLines.length - 1) * 13;
    text(`Generated ${report.generatedLabel} (Philippine time)`, left, 427 - scopeShift, 9, false, "58657a");
    report.summary.forEach(([label, value], i) => {
      const x = left + i * 193.5;
      page.drawRectangle({ x, y: 361 - scopeShift, width: 185, height: 50, color: color("eaf3fc") });
      text(label, x + 10, 394 - scopeShift, 9, false, "58657a"); text(value, x + 10, 374 - scopeShift, 15, true);
    });
    let x = left;
    report.columns.forEach((label, i) => {
      page.drawRectangle({ x, y: 321 - scopeShift, width: report.widths[i], height: 28, color: color("dcebf8") });
      text(label, x + 8, 331 - scopeShift, 9, true); x += report.widths[i];
    });
    y = 321 - scopeShift;
  }
  newPage();
  if (!report.rows.length) text("No records match this selection.", left + 8, y - 25, 11);
  report.rows.forEach((row, rowIndex) => {
    const lines = row.map((value, i) => wrapped(value, report.widths[i] - 16));
    const lineCount = Math.max(1, ...lines.map(cell => cell.length));
    let offset = 0;
    while (offset < lineCount) {
      if (y < 108) newPage();
      const count = Math.min(lineCount - offset, Math.max(1, Math.floor((y - 76 - 16) / 12)));
      const rowHeight = Math.max(30, count * 12 + 16);
      let x = left;
      lines.forEach((cell, column) => {
        page.drawRectangle({ x, y: y - rowHeight, width: report.widths[column], height: rowHeight,
          color: color(rowIndex % 2 ? "f0f6fc" : "ffffff"), borderColor: color("cbd4e3"), borderWidth: .4 });
        cell.slice(offset, offset + count).forEach((line, index) => text(line, x + 8, y - 17 - index * 12, 9));
        x += report.widths[column];
      });
      y -= rowHeight; offset += count;
      if (offset < lineCount) newPage();
    }
  });
  const pages = pdf.getPages();
  pages.forEach((current, i) => {
    page = current;
    wrapped(report.note, 700, 8).forEach((line, index) => text(line, left, 48 - index * 11, 8, false, "58657a"));
    text(`${i + 1} / ${pages.length}`, width - 70, 29, 9);
  });
  return { pdfBytes: await pdf.save(), pageCount: pages.length };
}
