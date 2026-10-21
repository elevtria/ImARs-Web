import { initializeApp } from "./firebase-auth.js";
import { getAuth, onAuthStateChanged } from "./firebase-auth.js";
import { getFirestore } from "./firebase-data.js";
import { loadAdminReports } from "./admin-report-data.js";
import { showAdminView } from "./admin-view.js";
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

    if (schoolAvgPostEl) schoolAvgPostEl.textContent = `${avgPostPct}%`;
    if (schoolAvgPreNoteEl) schoolAvgPreNoteEl.textContent = `Up from ${avgPrePct}% pre-test`;
    if (totalArHoursEl) totalArHoursEl.textContent = totalArHours;

    const ringPostEl = document.getElementById("ringPostScore");
    const meterPreVal = document.getElementById("meterPreVal");
    const meterPostVal = document.getElementById("meterPostVal");
    const meterGainVal = document.getElementById("meterGainVal");

    const meterPreBar = document.getElementById("meterPreBar");
    const meterPostBar = document.getElementById("meterPostBar");
    const meterGainBar = document.getElementById("meterGainBar");

    if (ringPostEl) ringPostEl.textContent = `${avgPostPct}%`;
    if (meterPreVal) meterPreVal.textContent = `${avgPrePct}%`;
    if (meterPostVal) meterPostVal.textContent = `${avgPostPct}%`;
    if (meterGainVal) meterGainVal.textContent = `${gainPct}%`;

    if (meterPreBar) meterPreBar.style.width = `${avgPrePct}%`;
    if (meterPostBar) meterPostBar.style.width = `${avgPostPct}%`;
    if (meterGainBar) meterGainBar.style.width = `${gainPct}%`;

    const ringEl = document.getElementById("learningRing");
    if (ringEl) {
      ringEl.style.background = `conic-gradient(#6c5ce7 ${avgPostPct}%, #e2e8f0 0%)`;
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
        const tAvgPre = teacher.preCount > 0 ? Math.round(teacher.prePctSum / teacher.preCount) : 0;
        const tAvgPost = teacher.postCount > 0 ? Math.round(teacher.postPctSum / teacher.postCount) : 0;
        const tGain = tAvgPost - tAvgPre;
        const gainSign = tGain >= 0 ? `+${tGain}%` : `${tGain}%`;

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
          <td>${tAvgPre}%</td>
          <td class="post-score">${tAvgPost}%</td>
          <td>${tHours}</td>
          <td><span class="gain-chip">${gainSign}</span></td>
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
    await showAdminView({ app, user, page: "reports",
      load: ({ read }) => timing.data(() => loadAdminReports(db, read)),
      render: report => timing.render(() => renderDashboard(report)),
      painted: cacheHit => timing.finish("loaded", { cacheHit })
    });
  } catch (error) { timing.finish("error"); console.error("Error loading admin dashboard metrics:", error); }
});
