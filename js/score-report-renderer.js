import { PDFDocument, rgb, pushGraphicsState, popGraphicsState, drawEllipsePath, clip, endPath } from "./vendor/pdf-lib.esm.min.js";
import fontkit from "./vendor/fontkit.esm.min.js";

export const REPORT_PAGE = { width: 841.89, height: 595.28, margin: 34 };
const ink = "#233149", blue = "#3d4e98", muted = "#58657a", line = "#cbd4e3", pale = "#eaf0fa";
const clean = value => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
const escape = value => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const color = hex => rgb(...hex.slice(1).match(/../g).map(part => parseInt(part, 16) / 255));

export function wrapReportText(value, width, measure) {
  const lines = [];
  let current = "";
  for (const word of clean(value).split(/\s+/)) {
    if (current && measure(`${current} ${word}`) <= width) { current += ` ${word}`; continue; }
    if (current) { lines.push(current); current = ""; }
    for (const character of word) {
      if (current && measure(current + character) > width) { lines.push(current); current = ""; }
      current += character;
    }
  }
  if (current || !lines.length) lines.push(current);
  return lines;
}

// One measured layout drives the PDF and the browser's print view.
export function layoutScoreReport(report, fonts) {
  const { width, height, margin } = REPORT_PAGE;
  const available = width - 2 * margin, pages = [];
  const textLines = (value, size, bold, maxWidth) => wrapReportText(value, maxWidth, text => fonts[bold ? "bold" : "regular"].widthOfTextAtSize(text, size));
  function text(ops, value, x, top, size = 9, bold = false, fill = ink, align = "left", maxWidth) {
    const lines = textLines(value, size, bold, maxWidth ?? available);
    lines.forEach((value, index) => {
      const length = fonts[bold ? "bold" : "regular"].widthOfTextAtSize(value, size);
      ops.push({ type: "text", value, x: x - (align === "center" ? length / 2 : align === "right" ? length : 0), y: top + index * size * 1.35, size, bold, fill });
    });
    return lines.length * size * 1.35;
  }
  function rect(ops, x, y, w, h, fill, border = line) { ops.push({ type: "rect", x, y, w, h, fill, border }); }
  function header(ops, label) {
    ops.push({ type: "logo", x: margin, y: 24, size: 66 });
    text(ops, report.schoolName.toUpperCase(), width / 2, 30, 15, true, blue, "center", 560);
    text(ops, report.schoolAddress, width / 2, 53, 9, false, muted, "center");
    text(ops, "STUDENT SCORE SUMMARY", width / 2, 76, 12, true, ink, "center");
    rect(ops, margin, 104, available, 1.5, blue, blue);
    const termHeight = text(ops, `${report.term}  |  School year ${report.schoolYear}`, margin, 118, 9, true);
    const sectionHeight = text(ops, `Section: ${report.section}`, margin, 118 + termHeight + 4, 9, false, ink, "left", 390);
    const teacherHeight = text(ops, `Prepared by: ${report.teacherName}`, margin, 118 + termHeight + sectionHeight + 8, 8, false, muted, "left", 390);
    text(ops, `Generated: ${report.generatedLabel} (UTC+08)`, width - margin, 118, 8, false, muted, "right", 330);
    const studentHeight = text(ops, `${report.students.length} of ${report.totalStudents} students${report.search ? ` | Search: ${report.search}` : " | Complete section"}`, width - margin, 135, 8, false, muted, "right", 330);
    let top = Math.max(118 + termHeight + sectionHeight + teacherHeight + 18, 135 + studentHeight + 10);
    text(ops, label, margin, top, 9, true, blue);
    top += 20;
    if (report.activitySyncPending) top += text(ops, "Note: Recent submissions from older app versions could not be checked.", margin, top, 8, false, muted) + 5;
    return top;
  }
  function cell(ops, value, x, y, w, h, { fill = "#ffffff", bold = false, align = "center", size = 9 } = {}) {
    rect(ops, x, y, w, h, fill);
    const lines = textLines(value, size, bold, w - 12);
    const textHeight = lines.length * size * 1.35;
    text(ops, value, align === "left" ? x + 6 : x + w / 2, y + Math.max(5, (h - textHeight) / 2), size, bold, ink, align, w - 12);
  }
  const bands = [];
  for (let offset = 0; offset < report.lessons.length; offset += 4) {
    const lessons = report.lessons.slice(offset, offset + 4);
    bands.push({ label: `Lesson results${report.lessons.length > 4 ? ` | Topics ${offset + 1}-${offset + lessons.length}` : ""}`,
      groups: lessons.map(item => item.title), subheads: ["Activity", "Pre-test", "Post-test"],
      values: row => row.lessons.slice(offset, offset + 4).flat() });
  }
  for (let offset = 0; offset < report.quizzes.length; offset += 5) {
    const quizzes = report.quizzes.slice(offset, offset + 5);
    bands.push({ label: `Teacher quiz results${report.quizzes.length > 5 ? ` | Quizzes ${offset + 1}-${offset + quizzes.length}` : ""}`,
      groups: quizzes.map(item => item.title), subheads: null, values: row => row.quizzes.slice(offset, offset + 5) });
  }
  for (const band of bands) {
    const numberWidth = 28, nameWidth = 180, subCount = band.subheads?.length || 1;
    const cellWidth = (available - numberWidth - nameWidth) / (band.groups.length * subCount);
    const groupHeight = Math.max(30, ...band.groups.map(value => textLines(value, 8.5, true, cellWidth * subCount - 12).length * 11.5 + 12));
    const headerHeight = groupHeight + (band.subheads ? 24 : 0);
    let rowIndex = 0;
    while (rowIndex < report.students.length) {
      const ops = [], top = header(ops, band.label), bottom = height - 76;
      if (top + headerHeight + 28 > bottom) throw new Error("A report heading is too long to fit on a page. Shorten the topic or quiz title and try again.");
      cell(ops, "No.", margin, top, numberWidth, headerHeight, { fill: pale, bold: true, size: 8 });
      cell(ops, "Student name", margin + numberWidth, top, nameWidth, headerHeight, { fill: pale, bold: true, align: "left" });
      let x = margin + numberWidth + nameWidth;
      for (const title of band.groups) {
        cell(ops, title, x, top, cellWidth * subCount, groupHeight, { fill: pale, bold: true, size: 8.5 });
        if (band.subheads) band.subheads.forEach((title, i) => cell(ops, title, x + i * cellWidth, top + groupHeight, cellWidth, 24, { fill: pale, size: 8 }));
        x += cellWidth * subCount;
      }
      let y = top + headerHeight;
      const first = rowIndex;
      for (; rowIndex < report.students.length; rowIndex++) {
        const student = report.students[rowIndex], values = band.values(student);
        const rowHeight = Math.max(23, textLines(student.name, 9, false, nameWidth - 12).length * 12.15 + 10,
          ...values.map(value => textLines(value, 9, false, cellWidth - 12).length * 12.15 + 10));
        if (y + rowHeight > bottom) break;
        const fill = rowIndex % 2 ? "#f6f8fc" : "#ffffff";
        cell(ops, String(rowIndex + 1), margin, y, numberWidth, rowHeight, { fill, size: 8 });
        cell(ops, student.name, margin + numberWidth, y, nameWidth, rowHeight, { fill, align: "left" });
        values.forEach((value, i) => cell(ops, value, margin + numberWidth + nameWidth + i * cellWidth, y, cellWidth, rowHeight, { fill }));
        y += rowHeight;
      }
      if (rowIndex === first) throw new Error("A student name is too long to fit on the report. Please shorten it and try again.");
      text(ops, "Scores = points earned / points possible.  - = no recorded score.  Pending review = awaiting a teacher grade.", margin, height - 61, 7.5, false, muted);
      rect(ops, margin, height - 42, available, 0.5, line, line);
      text(ops, "For school use only | ImARs", margin, height - 30, 7.5, false, muted);
      pages.push({ ops, firstStudent: first + 1, lastStudent: rowIndex, band: band.label });
    }
  }
  pages.forEach((page, index) => text(page.ops, `Page ${index + 1} of ${pages.length} | Students ${page.firstStudent}-${page.lastStudent}`, width - margin, height - 30, 7.5, false, muted, "right"));
  return pages;
}

function base64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

export function scoreReportHtml(report, pages, assets) {
  const { width, height } = REPORT_PAGE;
  const logo = `data:image/png;base64,${base64(assets.logo)}`;
  const pageHtml = pages.map((page, index) => `<section class="sheet" aria-label="Page ${index + 1}"><svg xmlns="http://www.w3.org/2000/svg" width="${width}pt" height="${height}pt" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escape(page.band)} - page ${index + 1}">
    ${page.ops.map(op => {
      if (op.type === "text") return `<text x="${op.x}" y="${op.y + op.size}" font-size="${op.size}" font-weight="${op.bold ? 700 : 400}" fill="${op.fill}">${escape(op.value)}</text>`;
      if (op.type === "rect") return `<rect x="${op.x}" y="${op.y}" width="${op.w}" height="${op.h}" fill="${op.fill}" stroke="${op.border}" stroke-width="0.5"/>`;
      // Display the supplied logo without the screenshot's controls outside the school seal.
      return `<svg x="${op.x}" y="${op.y}" width="${op.size}" height="${op.size}" viewBox="12 2 444 444"><defs><clipPath id="seal${index}"><circle cx="234" cy="224" r="222"/></clipPath></defs><image href="${logo}" width="476" height="453" clip-path="url(#seal${index})"/></svg>`;
    }).join("")}</svg></section>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>${escape(report.schoolName)} - ${escape(report.section)} - ${escape(report.term)}</title>
    <style>@font-face{font-family:Report;src:url(data:font/ttf;base64,${base64(assets.regular)}) format('truetype');font-weight:400}@font-face{font-family:Report;src:url(data:font/ttf;base64,${base64(assets.bold)}) format('truetype');font-weight:700}
    @page{size:A4 landscape;margin:0}*{box-sizing:border-box}body{margin:0;background:#e8edf4;font-family:Report,sans-serif}svg{display:block;font-family:Report,sans-serif}.sheet{width:${width}pt;height:${height}pt;margin:20px auto;background:white;box-shadow:0 4px 20px #24345126;break-after:page;break-inside:avoid}.sheet:last-child{break-after:auto}
    @media print{body{background:white}.sheet{margin:0;box-shadow:none;print-color-adjust:exact;-webkit-print-color-adjust:exact}}</style></head><body>${pageHtml}</body></html>`;
}

export async function loadScoreReportAssets(signal) {
  const read = async url => {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error("The school logo or report fonts could not be loaded. Please try again.");
    return new Uint8Array(await response.arrayBuffer());
  };
  const [logo, regular, bold] = await Promise.all([
    read(new URL("../assets/school-logo.png", import.meta.url)),
    read(new URL("../assets/fonts/NotoSans-Regular.ttf", import.meta.url)),
    read(new URL("../assets/fonts/NotoSans-Bold.ttf", import.meta.url))
  ]);
  return { logo, regular, bold };
}

export async function renderScoreReport(report, assets) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(`${report.schoolName} - ${report.section} - ${report.term} Student Score Summary`);
  pdf.setAuthor(report.teacherName);
  pdf.setCreator("ImARs");
  pdf.setCreationDate(new Date(report.generatedAt));
  const [regular, bold, logo] = await Promise.all([pdf.embedFont(assets.regular, { subset: true }), pdf.embedFont(assets.bold, { subset: true }), pdf.embedPng(assets.logo)]);
  const fonts = { regular, bold }, pages = layoutScoreReport(report, fonts);
  for (const layout of pages) {
    const page = pdf.addPage([REPORT_PAGE.width, REPORT_PAGE.height]);
    for (const op of layout.ops) {
      if (op.type === "text") page.drawText(op.value, { x: op.x, y: REPORT_PAGE.height - op.y - op.size, size: op.size, font: fonts[op.bold ? "bold" : "regular"], color: color(op.fill) });
      else if (op.type === "rect") page.drawRectangle({ x: op.x, y: REPORT_PAGE.height - op.y - op.h, width: op.w, height: op.h, color: color(op.fill), borderColor: color(op.border), borderWidth: 0.5 });
      else {
        const scale = op.size / 444, centerX = op.x + op.size / 2, centerY = REPORT_PAGE.height - op.y - op.size / 2;
        page.pushOperators(pushGraphicsState(), ...drawEllipsePath({ x: centerX, y: centerY, xScale: op.size / 2, yScale: op.size / 2 }), clip(), endPath());
        page.drawImage(logo, { x: centerX - 234 * scale, y: centerY - (453 - 224) * scale, width: 476 * scale, height: 453 * scale });
        page.pushOperators(popGraphicsState());
      }
    }
  }
  return { pdfBytes: await pdf.save(), html: scoreReportHtml(report, pages, assets), pageCount: pages.length };
}
