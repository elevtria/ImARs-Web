import { SCHOOL_NAME, SCHOOL_ADDRESS } from "./score-report-data.js";

const percent = value => Number.isFinite(value) ? `${value}%` : "—";
const gain = value => Number.isFinite(value) ? `${value > 0 ? "+" : ""}${value} pp` : "—";
const count = value => Number.isInteger(value) && value >= 0 ? value : "—";
export function buildSchoolAnalyticsReport(report, { startYear, view = "teachers", generatedAt = new Date(), generatedBy = "Administrator" } = {}) {
  if (!Number.isInteger(startYear) || startYear < 2000 || startYear > 2100) throw new Error("The current school year could not be verified. Try again.");
  const sections = view === "sections";
  const period = report.termId ? `Term ${Number(report.termId.slice(-2))}` : "All terms";
  const scope = report.sectionId ? report.sectionDirectory?.find(row => row.id === report.sectionId)?.name || report.sectionId : "All sections";
  const rows = sections ? report.sections.map(row => [row.name, count(row.students), percent(row.pre), percent(row.post), gain(row.gain), count(row.preCount), count(row.postCount)])
    : report.teachers.map(row => [row.analyticsName || row.name || row.id, (row.sections || []).join(", ") || "None assigned", count(row.students), percent(row.pre), percent(row.post), gain(row.gain), row.hours || "0 min"]);
  const dateParts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(generatedAt);
  const date = ["year", "month", "day"].map(type => dateParts.find(part => part.type === type).value).join("-");
  return { schoolName: SCHOOL_NAME, schoolAddress: SCHOOL_ADDRESS, schoolYear: `SY ${startYear}–${startYear + 1}`,
    title: "School Analytics", view: sections ? "By section" : "By teacher", period, scope, generatedBy,
    generatedAt: generatedAt.toISOString(), generatedLabel: generatedAt.toLocaleString("en-PH", { timeZone: "Asia/Manila" }),
    filename: `ImARs_School_Analytics_${sections ? "Sections" : "Teachers"}_${report.termId || "AllTerms"}_${report.sectionId || "AllSections"}_${date}`,
    summary: [["Students", count(report.totalStudents)], ["Pre-test average", percent(report.pre)], ["Post-test average", percent(report.post)], ["Change in average", gain(report.gain)]],
    columns: sections ? ["Section", "Students", "Pre-test", "Post-test", "Change", "Pre-test results", "Post-test results"]
      : ["Teacher", "Assigned sections", "Students", "Pre-test", "Post-test", "Change", "AR time"],
    widths: sections ? [220, 70, 90, 90, 100, 102, 102] : [170, 195, 60, 75, 75, 90, 109], rows,
    note: "Completed lesson tests only. Missing tests are excluded. Change compares independent averages in percentage points (pp), not matched student pairs." };
}
export function schoolAnalyticsCsv(report) {
  const cell = value => {
    const raw = String(value ?? "");
    const safe = /^(?:\s*[=+@-]|[\t\r\n])/.test(raw) ? "'" + raw : raw;
    return '"' + safe.replaceAll('"', '""') + '"';
  };
  return "\uFEFF" + [[report.schoolName], [report.title, report.schoolYear], [report.period, report.scope, report.view],
    ["Generated", report.generatedLabel, "Asia/Manila"], ...report.summary, [], report.columns, ...report.rows, [], [report.note]].map(row => row.map(cell).join(",")).join("\r\n");
}
