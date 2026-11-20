import { initializeApp } from "./firebase-auth.js";
import { getAuth, onAuthStateChanged } from "./firebase-auth.js";
import { getAdminReport } from "./firebase-data.js";
import { formatAdminGain, formatAdminPercent, showAdminView } from "./admin-view.js";
import { createPagePerformance } from "./page-performance.js";

const app = initializeApp();
const auth = getAuth(app);

function renderDashboard(report) {
    const attention = document.getElementById("adminAttention");
    if (attention) {
      const completed = (report.preCount || 0) + (report.postCount || 0);
      const inactive = report.teachers.filter(teacher => !teacher.active).length;
      const unassigned = (report.sectionDirectory || []).filter(section => !report.teachers.some(teacher => teacher.id === section.teacherId && teacher.active)).length;
      attention.innerHTML = `<div><dt>Recorded pre-/post-tests</dt><dd>${completed}/${report.expectedTests || 0}</dd></div><div><dt>Tests not yet recorded</dt><dd>${Math.max(0, (report.expectedTests || 0) - completed)}</dd></div><div><dt>Sections without an active teacher</dt><dd>${unassigned}</dd></div><div><dt>Inactive teacher accounts</dt><dd>${inactive}</dd></div>`;
    }
    const totalTeachers = report.teachers.length;
    const teacherValEl = document.getElementById("totalTeachersVal");

    if (teacherValEl) teacherValEl.textContent = totalTeachers;

    const totalStudents = report.totalStudents;

    const studentValEl = document.getElementById("totalStudentsVal");
    if (studentValEl) studentValEl.textContent = totalStudents;

    const { pre: avgPrePct, post: avgPostPct, gain: gainPct, hours: totalArHours } = report;

    const schoolAvgPostEl = document.getElementById("schoolAvgPostVal");
    const schoolAvgPreNoteEl = document.getElementById("schoolAvgPreNote");
    const totalArHoursEl = document.getElementById("totalArHoursVal");

    if (schoolAvgPostEl) schoolAvgPostEl.textContent = formatAdminPercent(avgPostPct);
    if (schoolAvgPreNoteEl) schoolAvgPreNoteEl.textContent = avgPrePct === null ? "Completed tests" : `Pre-test average: ${formatAdminPercent(avgPrePct)}`;
    if (totalArHoursEl) totalArHoursEl.textContent = totalArHours;

    const meterPreVal = document.getElementById("meterPreVal");
    const meterPostVal = document.getElementById("meterPostVal");
    const meterGainVal = document.getElementById("meterGainVal");

    if (meterPreVal) meterPreVal.textContent = formatAdminPercent(avgPrePct);
    if (meterPostVal) meterPostVal.textContent = formatAdminPercent(avgPostPct);
    if (meterGainVal) meterGainVal.textContent = formatAdminGain(gainPct);

    for (const [kind, score] of [["Pre", avgPrePct], ["Post", avgPostPct]]) {
      const bar = document.getElementById(`school${kind}Bar`);
      const value = document.getElementById(`school${kind}Value`);
      const height = Number.isFinite(score) ? Math.max(0, Math.min(100, score)) * 1.7 : 0;
      if (bar) {
        bar.setAttribute("y", String(210 - height));
        bar.setAttribute("height", String(height));
      }
      if (value) {
        value.textContent = formatAdminPercent(score);
        value.setAttribute("y", String(Math.max(28, 202 - height)));
      }
    }
    document.getElementById("schoolScoreChart")?.setAttribute("aria-label",
      `School averages: pre-test ${formatAdminPercent(avgPrePct)}, post-test ${formatAdminPercent(avgPostPct)}, change ${formatAdminGain(gainPct)}`);

}

onAuthStateChanged(auth, async user => {
  if (!user) { window.location.href = "admin-login.html"; return; }
  const timing = createPagePerformance("Admin Dashboard");
  try {
    await showAdminView({ app, user,
      load: () => timing.data(getAdminReport),
      render: report => timing.render(() => renderDashboard(report)),
      painted: cacheHit => timing.finish("loaded", { cacheHit })
    });
  } catch (error) { timing.finish("error"); console.error("Error loading admin dashboard metrics:", error); }
});
