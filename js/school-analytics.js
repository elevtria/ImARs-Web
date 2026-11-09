import { initializeApp } from "./firebase-auth.js";
import { getAuth, onAuthStateChanged } from "./firebase-auth.js";
import { getAdminReport } from "./firebase-data.js";
import { formatAdminGain, formatAdminPercent, showAdminView } from "./admin-view.js";
import { createPagePerformance } from "./page-performance.js";

const app = initializeApp();
const auth = getAuth(app);

// --- VIEW TOGGLE ---
const teacherContainer = document.getElementById("teacherAnalytics");
const sectionContainer = document.getElementById("sectionAnalytics");
const viewButtons = [...document.querySelectorAll("[data-view]")];

function setAnalyticsView(view) {
  const showTeachers = view === "teachers";

  viewButtons.forEach((button) => {
    const selected = button.dataset.view === view;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });

  if (teacherContainer && sectionContainer) {
    teacherContainer.hidden = !showTeachers;
    sectionContainer.hidden = showTeachers;
    teacherContainer.style.display = showTeachers ? "grid" : "none";
    sectionContainer.style.display = showTeachers ? "none" : "grid";
  }
}

viewButtons.forEach((button) => {
  button.addEventListener("click", () => setAnalyticsView(button.dataset.view));
});

// --- HELPERS ---
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[char]));

const getInitials = (name) => {
  if (!name) return "TR";
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0] || "").join("").toUpperCase();
};

const cardColors = ["#7048ff", "#ec168d", "#12a8df", "#10b981"];

function renderSchoolAnalytics(report) {
    const teacherMap = new Map(report.teachers.map((teacher, index) => [teacher.id, {
      ...teacher, name: teacher.analyticsName, initials: getInitials(teacher.analyticsName),
      sections: teacher.analyticsSections, color: cardColors[index % cardColors.length]
    }]));
    const sectionMap = new Map(report.sections.map((section, index) => [section.name, { ...section, color: cardColors[index % cardColors.length] }]));

    // 3. Render Teachers Analytics Cards
    if (teacherContainer) {
      if (teacherMap.size === 0) {
        teacherContainer.innerHTML = `<p style="grid-column: 1 / -1; text-align: center; color: #64748b; padding: 32px;">No teachers found.</p>`;
      } else {
        teacherContainer.innerHTML = Array.from(teacherMap.values()).map((teacher) => {
          const { pre, post, gain } = teacher;

          return `
            <article class="teacher-analytics-card" style="--teacher-color:${teacher.color};--score:${post ?? 0}%">
              <span class="analytics-avatar">${escapeHtml(teacher.initials)}</span>
              <h2 class="analytics-teacher-name">${escapeHtml(teacher.name)}</h2>
              <p class="analytics-teacher-sections">${escapeHtml(teacher.sections)}</p>
              <div class="analytics-donut" role="img" aria-label="${post === null ? "No completed post-tests" : `${post} percent average post-test`}">
                <div class="analytics-donut-inner" aria-hidden="true"></div>
              </div>
              <strong class="analytics-post-score">${formatAdminPercent(post)}</strong>
              <span class="analytics-post-label">avg post-test</span>
              <div class="analytics-card-footer">
                <span>Pre: <strong>${formatAdminPercent(pre)}</strong></span>
                <span class="teacher-gain">${formatAdminGain(gain)}</span>
              </div>
            </article>
          `;
        }).join("");
      }
    }

    // 4. Render Sections Analytics Cards
    if (sectionContainer) {
      if (sectionMap.size === 0) {
        sectionContainer.innerHTML = `<p style="text-align: center; color: #64748b; padding: 32px;">No student sections found.</p>`;
      } else {
        sectionContainer.innerHTML = Array.from(sectionMap.values()).map((section) => {
          const { pre, post, gain } = section;

          return `
            <article class="section-analytics-card" style="--section-color:${section.color}">
              <div class="section-title-row">
                <span class="section-color-dot" aria-hidden="true"></span>
                <h2>${escapeHtml(section.name)}</h2>
                <span class="section-student-count">${section.students} ${section.students === 1 ? "student" : "students"}</span>
                <span class="section-improvement">${formatAdminGain(gain)}</span>
              </div>
              <div class="section-meter">
                <div class="section-meter-head"><span>Pre-Test Average</span><strong>${formatAdminPercent(pre)}</strong></div>
                <div class="section-meter-track"><i style="width:${pre ?? 0}%"></i></div>
              </div>
              <div class="section-meter post">
                <div class="section-meter-head"><span>Post-Test Average</span><strong>${formatAdminPercent(post)}</strong></div>
                <div class="section-meter-track"><i style="width:${post ?? 0}%"></i></div>
              </div>
            </article>
          `;
        }).join("");
      }
    }

}

onAuthStateChanged(auth, async user => {
  if (!user) { window.location.href = "admin-login.html"; return; }
  const timing = createPagePerformance("School Analytics");
  try {
    await showAdminView({ app, user,
      load: () => timing.data(getAdminReport),
      render: report => timing.render(() => renderSchoolAnalytics(report)),
      painted: cacheHit => timing.finish("loaded", { cacheHit })
    });
  } catch (error) { timing.finish("error"); console.error("Error loading analytics data:", error); }
});

setAnalyticsView("teachers");
