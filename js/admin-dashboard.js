import { initializeApp } from "./firebase-auth.js";
import { getAuth, onAuthStateChanged } from "./firebase-auth.js";
import { getAdminReport } from "./firebase-data.js";
import { formatAdminGain, formatAdminPercent, showAdminView } from "./admin-view.js";
import { createPagePerformance } from "./page-performance.js";

const app = initializeApp();
const auth = getAuth(app);

const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

// Helper: Extract Initials from Teacher Name
function getInitials(name) {
  if (!name) return "TR";
  const parts = name.trim().split(" ");
  if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function renderDashboard(report) {
    const totalTeachers = report.teachers.length;
    const teacherValEl = document.getElementById("totalTeachersVal");
    const tableTeacherCountEl = document.getElementById("tableTeacherCount");

    if (teacherValEl) teacherValEl.textContent = totalTeachers;
    if (tableTeacherCountEl) tableTeacherCountEl.textContent = `${totalTeachers} ${totalTeachers === 1 ? "teacher" : "teachers"}`;

    const teachersMap = new Map(report.teachers.map(teacher => [teacher.id, { ...teacher, initials: getInitials(teacher.name), studentCount: teacher.students }]));
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

    const ringPostEl = document.getElementById("ringPostScore");
    const meterPreVal = document.getElementById("meterPreVal");
    const meterPostVal = document.getElementById("meterPostVal");
    const meterGainVal = document.getElementById("meterGainVal");

    const meterPreBar = document.getElementById("meterPreBar");
    const meterPostBar = document.getElementById("meterPostBar");
    const meterGainBar = document.getElementById("meterGainBar");

    if (ringPostEl) ringPostEl.textContent = formatAdminPercent(avgPostPct);
    if (meterPreVal) meterPreVal.textContent = formatAdminPercent(avgPrePct);
    if (meterPostVal) meterPostVal.textContent = formatAdminPercent(avgPostPct);
    if (meterGainVal) meterGainVal.textContent = formatAdminGain(gainPct);

    if (meterPreBar) meterPreBar.style.width = `${avgPrePct ?? 0}%`;
    if (meterPostBar) meterPostBar.style.width = `${avgPostPct ?? 0}%`;
    if (meterGainBar) meterGainBar.style.width = `${Math.abs(gainPct ?? 0)}%`;

    const ringEl = document.getElementById("learningRing");
    if (ringEl) {
      ringEl.setAttribute("aria-label", avgPostPct === null ? "No completed post-tests" : `School average post-test score: ${avgPostPct}%`);
      ringEl.style.background = `conic-gradient(var(--steel) ${avgPostPct ?? 0}%, var(--chart-track, #e2e8f0) 0%)`;
    }

    // 5. Populate Teacher Performance Snapshot Table
    const tableBody = document.getElementById("teacherTableBody");
    if (tableBody) {
      tableBody.innerHTML = "";

      if (teachersMap.size === 0) {
        tableBody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding: 20px;">No teachers registered yet.</td></tr>`;
        return;
      }

      const rows = document.createDocumentFragment();
      teachersMap.forEach((teacher) => {
        const row = document.createElement("tr");
        row.innerHTML = `
          <td>
            <div class="teacher-cell">
              <span class="teacher-avatar">${escapeHtml(teacher.initials)}</span>
              <span>
                <strong>${escapeHtml(teacher.name)}</strong>
                <small>${escapeHtml(teacher.meta)}</small>
              </span>
            </div>
          </td>
          <td>${teacher.studentCount}</td>
          <td>${formatAdminPercent(teacher.pre)}</td>
          <td class="post-score">${formatAdminPercent(teacher.post)}</td>
          <td>${escapeHtml(teacher.hours)}</td>
          <td><span class="gain-chip">${formatAdminGain(teacher.gain)}</span></td>
        `;
        rows.appendChild(row);
      });
      tableBody.appendChild(rows);
    }

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
