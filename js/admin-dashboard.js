import { initializeApp } from "./firebase-auth.js";
import { getAuth, onAuthStateChanged } from "./firebase-auth.js";
import { getFirestore } from "./firebase-data.js";
import { showAdminTermReport } from "./admin-report-data.js";
import { percentLabel, gainLabel } from "./activity-score.js";
import { createPagePerformance } from "./page-performance.js";
import { initAdminIdleTimeout } from "./admin-idle-timeout.js";

const app = initializeApp();
const auth = getAuth(app);
const db = getFirestore(app);

// --- DRAWER UI LOGIC ---
const menuButton = document.getElementById("adminMenuButton");
const drawer = document.getElementById("adminNavigation");
const closeButton = document.getElementById("adminDrawerClose");

function setDrawerOpen(open) {
  drawer.classList.toggle("open", open);
  drawer.setAttribute("aria-hidden", String(!open));
  menuButton.setAttribute("aria-expanded", String(open));
}

if (menuButton) menuButton.addEventListener("click", () => setDrawerOpen(!drawer.classList.contains("open")));
if (closeButton) closeButton.addEventListener("click", () => setDrawerOpen(false));
if (drawer) {
  drawer.addEventListener("click", (event) => {
    if (event.target === drawer) setDrawerOpen(false);
  });
}
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setDrawerOpen(false);
});

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
    const teacherNoteEl = document.getElementById("totalTeachersNote");
    const tableTeacherCountEl = document.getElementById("tableTeacherCount");

    if (teacherValEl) teacherValEl.textContent = totalTeachers;
    if (teacherNoteEl) teacherNoteEl.textContent = `${totalTeachers} registered`;
    if (tableTeacherCountEl) tableTeacherCountEl.textContent = `${totalTeachers} teachers`;

    const teachersMap = new Map(report.teachers.map(teacher => [teacher.id, { ...teacher, initials: getInitials(teacher.name), studentCount: teacher.students }]));
    const totalStudents = report.totalStudents;

    const studentValEl = document.getElementById("totalStudentsVal");
    if (studentValEl) studentValEl.textContent = totalStudents;

    const { pre: avgPrePct, post: avgPostPct, gain: gainPct, hours: totalArHours } = report;

    const schoolAvgPostEl = document.getElementById("schoolAvgPostVal");
    const schoolAvgPreNoteEl = document.getElementById("schoolAvgPreNote");
    const totalArHoursEl = document.getElementById("totalArHoursVal");

    if (schoolAvgPostEl) schoolAvgPostEl.textContent = percentLabel(avgPostPct);
    if (schoolAvgPreNoteEl) schoolAvgPreNoteEl.textContent = `Pre-test average: ${percentLabel(avgPrePct)}`;
    if (totalArHoursEl) totalArHoursEl.textContent = totalArHours;

    const ringPostEl = document.getElementById("ringPostScore");
    const meterPreVal = document.getElementById("meterPreVal");
    const meterPostVal = document.getElementById("meterPostVal");
    const meterGainVal = document.getElementById("meterGainVal");

    const meterPreBar = document.getElementById("meterPreBar");
    const meterPostBar = document.getElementById("meterPostBar");
    const meterGainBar = document.getElementById("meterGainBar");

    if (ringPostEl) ringPostEl.textContent = `${avgPostPct || 0}%`;
    if (meterPreVal) meterPreVal.textContent = percentLabel(avgPrePct);
    if (meterPostVal) meterPostVal.textContent = percentLabel(avgPostPct);
    if (meterGainVal) meterGainVal.textContent = gainLabel(gainPct);

    if (meterPreBar) meterPreBar.style.width = `${avgPrePct || 0}%`;
    if (meterPostBar) meterPostBar.style.width = `${avgPostPct || 0}%`;
    if (meterGainBar) meterGainBar.style.background = gainPct < 0 ? "#b42318" : "#2d6287";
    if (meterGainBar) meterGainBar.style.background = gainPct < 0 ? "#b42318" : "#2d6287";
    if (meterGainBar) meterGainBar.style.width = `${Math.abs(gainPct || 0)}%`;

    const ringEl = document.getElementById("learningRing");
    if (ringEl) {
      ringEl.style.background = `conic-gradient(#2d6287 ${avgPostPct || 0}%, #e2e8f0 0%)`;
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
        const tAvgPre = teacher.pre;
        const tAvgPost = teacher.post;
        const tGain = teacher.gain;
        const gainSign = gainLabel(tGain);

        const tHours = teacher.arMinutes >= 60
          ? `${Math.round(teacher.arMinutes / 60)}h`
          : `${teacher.arMinutes}m`;

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
          <td>${percentLabel(tAvgPre)}</td>
          <td class="post-score">${percentLabel(tAvgPost)}</td>
          <td>${tHours}</td>
          <td><span class="gain-chip ${tGain < 0 ? "gain-negative" : ""}">${gainSign}</span></td>
        `;
        rows.appendChild(row);
      });
      tableBody.appendChild(rows);
    }

}

onAuthStateChanged(auth, async user => {
  if (!user) { window.location.href = "login.html"; return; }
  initAdminIdleTimeout(auth);
  const timing = createPagePerformance("Admin Dashboard");
  try {
    await showAdminTermReport({ app, user, db, timing, render: renderDashboard });
  } catch (error) { timing.finish("error"); console.error("Error loading admin dashboard metrics:", error); }
});
