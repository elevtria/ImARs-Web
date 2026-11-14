import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { collectScoreReport, reportLessonScores, scoreReportFilename } from "../js/score-report-data.js";
import { layoutScoreReport, renderScoreReport, REPORT_PAGE } from "../js/score-report-renderer.js";
import { PDFDocument, PDFName, PDFDict } from "../js/vendor/pdf-lib.esm.min.js";

const doc = (id, data) => ({ id, data: () => data });
const student = i => ({ classId: "A", studentDoc: doc(`S${i}`, { displayName: `José Student ${i}` }), results: [
  { termId: "term_01", lessonsSnap: { docs: [doc("lesson_01", { isPreTestCompleted: true, preTestScore: 0, preTestTotalQuestions: 5,
    isPostTestCompleted: true, postTestScore: 8, postTestTotalQuestions: 10, activityScore: 3, activityTotalQuestions: 4 })] } }
] });
function source({ count = 53, search = "" } = {}) {
  const roster = Array.from({ length: count }, (_, i) => student(i));
  const requests = [], quizzes = [];
  const signal = new AbortController().signal;
  return { requests, quizzes, roster, signal, options: { termId: "term_01", sectionId: "A", search, teacherName: "María Peña",
    now: new Date("2026-11-14T16:10:00Z"), signal }, services: {
    fetchPage: async options => {
      requests.push(options);
      const offset = options.cursor?.offset || 0;
      return { classes: [doc("A", { SectionName: "Hydrogen" })], students: roster.slice(offset, offset + 25),
        curriculum: offset ? null : { curriculumSnap: { docs: [doc("lesson_01", { title: "Processes of Changes of State" })] } },
        cursor: offset + 25 < roster.length ? { offset: offset + 25 } : null };
    },
    fetchQuizzes: async ids => {
      quizzes.push(ids);
      return { quizzes: [{ id: "Q1", title: "General Science" }], items: ids.map(studentId => ({ studentId, quizId: "Q1", status: "pending-review", score: 1, maximum: 2 })) };
    }, fetchSchoolYear: async () => 2026
  } };
}

test("reports collect every roster page and bounded quiz batches, and preserve zeroes and pending grades", async () => {
  const data = source();
  const report = await collectScoreReport(data.options, data.services);
  assert.equal(report.students.length, 53);
  assert.equal(data.requests.length, 3);
  assert.deepEqual(data.quizzes.map(ids => ids.length), [25, 25, 3]);
  assert.ok(data.requests.every(options => options.termId === "term_01" && options.sectionId === "A" && options.rawActivityScores));
  assert.equal(report.schoolYear, "2026-2027");
  assert.deepEqual(report.students[0].lessons, [["3/4", "0/5", "8/10"]]);
  assert.deepEqual(report.students[0].quizzes, ["Pending review"]);
  assert.equal(report.generatedDate, "2026-11-15", "the filename uses the user's UTC+08 date");
  assert.equal(scoreReportFilename(report), "ImARs_Hydrogen_term_01_2026-11-15.pdf");
});

test("a search is explicitly recorded and filters the complete roster, not only the screen's current page", async () => {
  const data = source({ search: "Student 52" });
  const report = await collectScoreReport(data.options, data.services);
  assert.equal(report.totalStudents, 53);
  assert.equal(report.students.length, 1);
  assert.equal(report.search, "Student 52");
  assert.deepEqual(data.quizzes[0], ["S52"]);
});

test("quiz batches overlap with a limit of three requests while keeping the full class", async () => {
  const data = source({ count: 151 });
  const releases = [], milestones = new Map();
  const started = [3, 6, 7].map(count => new Promise(resolve => milestones.set(count, resolve)));
  let active = 0, peak = 0, requests = 0;
  const pending = collectScoreReport(data.options, { ...data.services, fetchQuizzes: async ids => {
    assert.ok(ids.length <= 25);
    active++; peak = Math.max(peak, active); requests++;
    const gate = new Promise(resolve => releases.push(resolve));
    milestones.get(requests)?.();
    await gate;
    active--;
    return { quizzes: [], items: [] };
  } });
  await started[0];
  assert.equal(active, 3);
  releases.slice(0, 3).forEach(resolve => resolve());
  await started[1];
  assert.equal(active, 3);
  releases.slice(3, 6).forEach(resolve => resolve());
  await started[2];
  releases[6]();
  const report = await pending;
  assert.equal(report.students.length, 151);
  assert.equal(peak, 3);
  assert.equal(requests, 7);
});

test("exports stop on missing pages, cancellation, foreign sections, or changed quiz assignments", async () => {
  const data = source();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(collectScoreReport({ ...data.options, signal: controller.signal }, data.services), { name: "AbortError" });
  assert.equal(data.requests.length, 0);
  await assert.rejects(collectScoreReport(data.options, { ...data.services, fetchPage: async () => { throw new Error("Offline"); } }), /Offline/);
  await assert.rejects(collectScoreReport(data.options, { ...data.services, fetchPage: async () => ({ classes: [doc("A", {})], students: [{ ...student(0), classId: "B" }], cursor: null }) }), /different section/);
  let batch = 0;
  await assert.rejects(collectScoreReport(data.options, { ...data.services, fetchQuizzes: async () => ({ quizzes: [{ id: `Q${batch++}`, title: "Changed quiz" }], items: [] }) }), /Quiz assignments changed/);
});

test("report scores retain manual corrections and distinguish missing activity points from percentages", () => {
  assert.deepEqual(reportLessonScores({ activityScore: 88, activityTotalQuestions: 100, activityRawMaximum: null, activityRawScore: null }), ["-", "-", "-"]);
  assert.deepEqual(reportLessonScores({ teacherScoreOverrides: { activity: { score: 0, maximum: 4 }, pre: { score: 3, maximum: 5 } } }), ["0/4", "3/5", "-"]);
});

test("long names wrap, every report page repeats its headings, and all students survive pagination", async () => {
  const data = source({ count: 53 }), report = await collectScoreReport(data.options, data.services);
  report.students[0].name = "María del Carmen de la Cruz Peña Santos with a very long student name";
  report.lessons[0].title = "Properties of Water and Sound Waves with a long but fully visible heading";
  report.quizzes = Array.from({ length: 7 }, (_, i) => ({ id: `Q${i}`, title: `Quiz ${i + 1}` }));
  report.students.forEach(row => { row.quizzes = Array(7).fill("Pending review"); });
  const font = { widthOfTextAtSize: (text, size) => Array.from(text).length * size * 0.55 };
  const pages = layoutScoreReport(report, { regular: font, bold: font });
  assert.ok(pages.length > 3);
  for (const page of pages) {
    assert.ok(page.ops.some(op => op.type === "logo"));
    assert.ok(page.ops.some(op => op.value === "PINTONG GUBAT ELEMENTARY SCHOOL"));
    assert.ok(page.ops.some(op => op.value?.startsWith("Page ")));
    assert.ok(page.lastStudent >= page.firstStudent);
    for (const op of page.ops) {
      assert.ok(op.x >= 0 && op.y >= 0);
      if (op.type === "rect" && op.h > 2) assert.ok(op.y + op.h < REPORT_PAGE.height - 70);
      if (op.type === "text") assert.ok(op.y + op.size <= REPORT_PAGE.height);
    }
  }
  for (const band of new Set(pages.map(page => page.band))) {
    const rows = pages.filter(page => page.band === band).flatMap(page => Array.from({ length: page.lastStudent - page.firstStudent + 1 }, (_, i) => page.firstStudent + i));
    assert.deepEqual(rows, Array.from({ length: 53 }, (_, i) => i + 1));
  }
});

test("the download is a real landscape PDF with embedded fonts and school logo; print markup escapes data", async () => {
  const data = source({ count: 2 }), report = await collectScoreReport(data.options, data.services);
  report.students[0].name = '<img src=x onerror="alert(1)"> José Peña';
  const [logo, regular, bold] = await Promise.all(["school-logo.png", "fonts/NotoSans-Regular.ttf", "fonts/NotoSans-Bold.ttf"].map(name => readFile(new URL(`../assets/${name}`, import.meta.url))));
  const output = await renderScoreReport(report, { logo, regular, bold });
  assert.equal(Buffer.from(output.pdfBytes).subarray(0, 5).toString(), "%PDF-");
  const pdf = await PDFDocument.load(output.pdfBytes);
  assert.equal(pdf.getPageCount(), output.pageCount);
  assert.equal(pdf.getPage(0).getWidth(), REPORT_PAGE.width);
  const resources = pdf.getPage(0).node.Resources();
  assert.equal(new Set(resources.lookup(PDFName.of("Font"), PDFDict).values().map(ref => ref.toString())).size, 2);
  assert.equal(resources.lookup(PDFName.of("XObject"), PDFDict).keys().length, 1);
  assert.ok(output.html.includes("&lt;img src=x"));
  assert.ok(!output.html.includes('<img src=x onerror="alert(1)">'));
  assert.ok(output.html.includes("data:image/png;base64,"));
  assert.ok(output.html.includes("@page{size:A4 landscape"));
  const download = await renderScoreReport(report, { logo, regular, bold }, { mode: "download" });
  assert.equal(download.html, undefined, "PDF downloads do not also build the print document");
  assert.equal(download.pageCount, output.pageCount);
  const print = await renderScoreReport(report, { logo, regular, bold }, { mode: "print" });
  assert.equal(print.pdfBytes, undefined, "printing does not also encode a PDF");
  assert.equal(print.pageCount, output.pageCount);
  assert.ok(print.html.includes("data:image/png;base64,"));
});
