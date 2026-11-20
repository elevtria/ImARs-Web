import test from "node:test";
import assert from "node:assert/strict";
import { buildSchoolAnalyticsReport, schoolAnalyticsCsv, schoolTrend } from "../js/school-analytics-report-data.js";

const sample = { pre: 46, post: 75, gain: 29, totalStudents: 76, termId: "term_02", sectionId: "A",
  sectionDirectory: [{ id: "A", name: "Hydrogen" }],
  teachers: [{ id: "T1", analyticsName: "Teacher A", sections: ["Hydrogen"], students: 76, pre: 46, post: 75, gain: 29, hours: "9 min" }],
  sections: [{ name: "Hydrogen", students: 76, pre: 46, post: 75, gain: 29, preCount: 100, postCount: 90 }] };
test("school downloads preserve term, section, view, school year, and complete report rows", () => {
  const teacher = buildSchoolAnalyticsReport(sample, { startYear: 2026 });
  assert.equal(teacher.period, "Term 2"); assert.equal(teacher.scope, "Hydrogen");
  assert.equal(teacher.schoolYear, "SY 2026–2027"); assert.equal(teacher.view, "By teacher");
  assert.deepEqual(teacher.rows[0], ["Teacher A", "Hydrogen", 76, "46%", "75%", "+29 pp", "9 min"]);
  assert.equal(teacher.widths.reduce((a, b) => a + b), 774);
  const section = buildSchoolAnalyticsReport(sample, { startYear: 2026, view: "sections" });
  assert.deepEqual(section.rows[0], ["Hydrogen", 76, "46%", "75%", "+29 pp", 100, 90]);
  assert.throws(() => buildSchoolAnalyticsReport(sample, {}), /school year/);
});
test("missing scores remain missing and CSV quotes untrusted names safely", () => {
  const data = structuredClone(sample);
  Object.assign(data.teachers[0], { analyticsName: '=HYPERLINK("example")', pre: null, post: 0, gain: null });
  const report = buildSchoolAnalyticsReport(data, { startYear: 2026 });
  assert.deepEqual(report.rows[0].slice(3, 6), ["—", "0%", "—"]);
  const csv = schoolAnalyticsCsv(report);
  assert.ok(csv.includes('"\'=HYPERLINK(""example"")"'));
  assert.ok(csv.includes('"Term 2","Hydrogen","By teacher"'));
});
test("the arrow represents the two actual averages, including decline, ties, zeros and missing results", () => {
  assert.equal(schoolTrend(46, 75).direction, "up");
  assert.ok(schoolTrend(46, 75).postY < schoolTrend(46, 75).preY);
  assert.equal(schoolTrend(80, 40).direction, "down");
  assert.equal(schoolTrend(0, 0).direction, "flat");
  for (const pair of [[null, 75], [undefined, 75], [-1, 50], [40, 101]]) assert.equal(schoolTrend(...pair), null);
});
