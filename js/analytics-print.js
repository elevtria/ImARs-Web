import { escapeHtml } from "./teacher-view.js";
import { SCHOOL_NAME, SCHOOL_ADDRESS } from "./score-report-data.js";

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
  for (let offset = 0; offset < topics.length; offset += 4) panels.push({
    title: "Lesson results", start: 1 + offset * 3, count: Math.min(4, topics.length - offset) * 3,
    heads: `<tr><th rowspan="2" scope="col">Student name</th>${topics.slice(offset, offset + 4).map(title => `<th scope="colgroup" colspan="3">${escapeHtml(title)}</th>`).join("")}</tr><tr>${topics.slice(offset, offset + 4).map(() => "<th scope=col>Activity</th><th scope=col>Pre-test</th><th scope=col>Post-test</th>").join("")}</tr>`
  });
  for (let offset = 0; offset < quizTitles.length; offset += 5) panels.push({
    title: "Teacher quiz results", start: 1 + topics.length * 3 + offset, count: Math.min(5, quizTitles.length - offset),
    heads: `<tr><th scope="col">Student name</th>${quizTitles.slice(offset, offset + 5).map(title => `<th scope="col">${escapeHtml(title)}</th>`).join("")}</tr>`
  });
  const logoUrl = new URL("../assets/school-logo.png", import.meta.url).href;
  return panels.map(panel => `<section class="analytics-print-panel"><table><colgroup><col style="width:23%"><col span="${panel.count}" style="width:${77 / panel.count}%"></colgroup><thead><tr><th class="analytics-print-cover" colspan="${panel.count + 1}">
    <div class="analytics-print-heading"><svg width="64" height="64" viewBox="12 2 444 444" aria-label="School logo"><defs><clipPath id="printSeal${panel.start}"><circle cx="234" cy="224" r="222"/></clipPath></defs><image href="${escapeHtml(logoUrl)}" width="476" height="453" clip-path="url(#printSeal${panel.start})"/></svg><div><strong>${escapeHtml(SCHOOL_NAME)}</strong><span>${escapeHtml(SCHOOL_ADDRESS)}</span><h1>Student Score Summary</h1></div></div>
    <div class="analytics-print-meta"><span>${escapeHtml(term)} | Section: ${escapeHtml(section)} | ${escapeHtml(schoolYear)}</span><span>Prepared by: ${escapeHtml(teacher)}</span><span>${escapeHtml(scope)} | Current table page</span><span>Printed: ${escapeHtml(generatedLabel)} (UTC+08)</span></div><h2>${panel.title}</h2>
    </th></tr>${panel.heads}</thead><tbody>${students.map(cells => `<tr><th scope="row">${escapeHtml(cells[0])}</th>${cells.slice(panel.start, panel.start + panel.count).map(value => `<td>${escapeHtml(value)}</td>`).join("")}</tr>`).join("")}</tbody>
    <tfoot><tr><td colspan="${panel.count + 1}">Scores show points earned / points possible. A dash means no recorded score. Use Download full PDF for the complete section and search selection.</td></tr></tfoot></table></section>`).join("");
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
  window.addEventListener("beforeprint", prepare);
  window.addEventListener("afterprint", restore);
  window.addEventListener("pagehide", restore);
  return () => {
    if (!available()) return;
    notify("Printing the current table page. Download full PDF includes the complete section.");
    window.print();
  };
}
