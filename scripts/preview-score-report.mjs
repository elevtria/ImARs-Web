// Synthetic data only. Generate PDF/print samples for visual layout review.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { renderScoreReport } from "../js/score-report-renderer.js";

const output = new URL("../tmp/pdfs/", import.meta.url);
await mkdir(output, { recursive: true });
const report = {
  schoolName: "Pintong Gubat Elementary School", schoolAddress: "City of Dasmariñas, Cavite", schoolYear: "2026-2027",
  section: "Hydrogen", term: "Term 1", termId: "term_01", teacherName: "María Peña (demo data)",
  generatedAt: "2026-11-14T12:00:00.000Z", generatedDate: "2026-11-14", generatedLabel: "14 Nov 2026, 8:00 pm",
  totalStudents: 31, search: "", activitySyncPending: false,
  lessons: ["Processes of Changes of State", "Physical and Chemical Change", "Mixtures and Separation Techniques", "The Circulatory System"].map((title, i) => ({ id: `lesson_0${i + 1}`, title })),
  quizzes: Array.from({ length: 7 }, (_, i) => ({ id: `Q${i}`, title: i ? `General Science Quiz ${i + 1}` : "Physical and Chemical Changes - Extended Assessment and Application" })),
  students: Array.from({ length: 31 }, (_, i) => ({ name: i === 0 ? "DEMO - Ma. Sofía del Carmen de la Cruz Peña Santos" : `DEMO Student ${String(i + 1).padStart(2, "0")}`,
    lessons: Array.from({ length: 4 }, () => [i % 3 === 0 ? "-" : "3/4", `${i % 6}/5`, `${i % 11}/10`]),
    quizzes: Array.from({ length: 7 }, (_, q) => (i + q) % 4 === 0 ? "Pending review" : (i + q) % 3 === 0 ? "-" : "7/10") }))
};
const [logo, regular, bold] = await Promise.all(["school-logo.png", "fonts/NotoSans-Regular.ttf", "fonts/NotoSans-Bold.ttf"].map(name => readFile(new URL(`../assets/${name}`, import.meta.url))));
const result = await renderScoreReport(report, { logo, regular, bold });
await writeFile(new URL("sample-score-report.pdf", output), result.pdfBytes);
await writeFile(new URL("sample-score-report.html", output), result.html);
console.log(`Generated ${result.pageCount} pages of demo data in tmp/pdfs.`);
