import { escapeHtml } from "./teacher-view.js";
import { SCHOOL_NAME, SCHOOL_ADDRESS } from "./score-report-data.js";

const logoUrl = new URL("../assets/school-logo.png", import.meta.url).href;

function cellText(cell) {
  const clone = cell.cloneNode(true);
  clone.querySelectorAll("[aria-hidden=true], .score-student span").forEach(item => item.remove());
  return clone.textContent.trim();
}

export function analyticsPrintHtml({ table, section, term, schoolYear, teacher, scope, generatedLabel }) {
  const rows = [...table.querySelectorAll("tbody tr.student-row")];
  if (!rows.length) return "";
  const head = table.tHead.rows;
  const topics = [...head[0].cells].slice(1, -1).map(cell => cell.textContent.trim());
  const quizTitles = [...head[1].cells].slice(topics.length * 3).map(cell => cell.textContent.trim());
  const students = rows.map(row => [...row.cells].map(cellText));
  const panels = [];
  const inlineQuizzes = topics.length ? Math.min(2, quizTitles.length) : 0;
  for (let offset = 0; offset < topics.length; offset += 4) {
    const lessons = topics.slice(offset, offset + 4);
    const quizCount = offset === 0 ? inlineQuizzes : 0;
    panels.push({
      title: quizCount ? "Lesson and generated quiz results" : "Lesson results",
      indices: [...Array.from({ length: lessons.length * 3 }, (_, i) => 1 + offset * 3 + i),
        ...Array.from({ length: quizCount }, (_, i) => 1 + topics.length * 3 + i)],
      heads: `<tr><th rowspan="2" scope="col">Student name</th>${lessons.map(title => `<th scope="colgroup" colspan="3">${escapeHtml(title)}</th>`).join("")}${quizCount ? `<th scope="colgroup" colspan="${quizCount}">Generated quizzes</th>` : ""}</tr><tr>${lessons.map(() => "<th scope=col>Activity</th><th scope=col>Pre-test</th><th scope=col>Post-test</th>").join("")}${quizTitles.slice(0, quizCount).map(title => `<th scope="col">${escapeHtml(title)}</th>`).join("")}</tr>`
    });
  }
  for (let offset = inlineQuizzes; offset < quizTitles.length; offset += 5) panels.push({
    title: "Teacher quiz results", start: 1 + topics.length * 3 + offset, count: Math.min(5, quizTitles.length - offset),
    heads: `<tr><th scope="col">Student name</th>${quizTitles.slice(offset, offset + 5).map(title => `<th scope="col">${escapeHtml(title)}</th>`).join("")}</tr>`
  });
  const pages = panels.flatMap(panel => Array.from({ length: Math.ceil(students.length / 10) }, (_, index) => ({ panel, start: index * 10 })));
  // Keep the school heading outside the table: browsers can discard oversized repeating table headers.
  // Apply zero margins to the default page too, including the first page selected by the print dialog.
  return `<style media="print">@page { size: A4 landscape; margin: 0 !important; } @page analyticsReport { size: A4 landscape; margin: 0 !important; }</style>` + pages.map(({ panel, start }, page) => {
    const indices = panel.indices || Array.from({ length: panel.count }, (_, i) => panel.start + i);
    return `<section class="analytics-print-panel">
    <div class="analytics-print-heading"><img class="analytics-print-logo" src="${escapeHtml(logoUrl)}" width="76" height="72" alt="Pintong Gubat Elementary School logo" /><div><strong>${escapeHtml(SCHOOL_NAME)}</strong><span>${escapeHtml(SCHOOL_ADDRESS)}</span><h1>Student Score Summary</h1></div></div>
    <div class="analytics-print-meta"><span>${escapeHtml(term)} | Section: ${escapeHtml(section)} | ${escapeHtml(schoolYear)}</span><span>Prepared by: ${escapeHtml(teacher)}</span><span>${escapeHtml(scope)} | Current table page</span><span>Printed: ${escapeHtml(generatedLabel)} (UTC+08)</span></div><h2>${panel.title}</h2>
    <table><colgroup><col style="width:20%"><col span="${indices.length}" style="width:${80 / indices.length}%"></colgroup><thead>${panel.heads}</thead><tbody>${students.slice(start, start + 10).map(cells => `<tr><th scope="row">${escapeHtml(cells[0])}</th>${indices.map(index => `<td>${escapeHtml(cells[index] ?? "—")}</td>`).join("")}</tr>`).join("")}</tbody></table>
    <div class="analytics-print-footer"><span>Scores show points earned / points possible. A dash means no recorded score. Download PDF includes the complete section.</span><span>Page ${page + 1} of ${pages.length}</span></div></section>`;
  }).join("");
}

// Like Print Guide, use the browser's print lifecycle without fetching or building a PDF.
export function installAnalyticsPrint({ readView, available, notify }) {
  let printed;
  const restore = () => {
    document.body.classList.remove("analytics-printing");
    printed?.remove();
    printed = null;
  };
  const prepare = () => {
    restore();
    if (!available()) return;
    const html = analyticsPrintHtml(readView());
    if (!html) return;
    printed = document.createElement("div");
    printed.id = "analyticsPrintReport";
    printed.innerHTML = html;
    document.body.append(printed);
    document.body.classList.add("analytics-printing");
  };
  window.addEventListener("beforeprint", () => { if (!printed) prepare(); });
  window.addEventListener("afterprint", restore);
  window.addEventListener("pagehide", restore);
  return async () => {
    if (!available()) return;
    prepare();
    if (!printed) return;
    try {
      const images = [...(printed.querySelectorAll?.("img") || [])];
      const pending = images.filter(image => !image.complete || !image.naturalWidth);
      if (pending.length) await Promise.all(pending.map(image => image.decode()));
    } catch {
      restore();
      notify("The school logo could not load. Please try Print report again.");
      return;
    }
    notify("Printing the current table page. Download full PDF includes the complete section.");
    window.print();
  };
}
