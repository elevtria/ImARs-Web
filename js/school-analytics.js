import { initializeApp } from "./firebase-auth.js";
import { getAuth, onAuthStateChanged } from "./firebase-auth.js";
import { getAdminReport } from "./firebase-data.js";
import { formatAdminGain, formatAdminPercent, showAdminView } from "./admin-view.js";
import { createPagePerformance } from "./page-performance.js";

const app = initializeApp();
const auth = getAuth(app);

// --- VIEW TOGGLE ---
const teacherContainer = document.getElementById("teacherAnalytics");
const teacherListDisclosure = document.getElementById("teacherListDisclosure");
const teacherListCount = document.getElementById("teacherListCount");
const overallContainer = document.getElementById("overallAnalytics");
const sectionContainer = document.getElementById("sectionAnalytics");
const viewButtons = [...document.querySelectorAll("[data-view]")];

function setAnalyticsView(view) {
  const showTeachers = view === "teachers";

  viewButtons.forEach((button) => {
    const selected = button.dataset.view === view;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });

  if (teacherListDisclosure && sectionContainer) {
    teacherListDisclosure.hidden = !showTeachers;
    sectionContainer.hidden = showTeachers;
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

function performanceCard({ name, details, initials, color, pre, post, gain }) {
  return `
    <article class="teacher-analytics-card" style="--teacher-color:${color};--score:${post ?? 0}%">
      <span class="analytics-avatar">${escapeHtml(initials)}</span>
      <h2 class="analytics-teacher-name">${escapeHtml(name)}</h2>
      <p class="analytics-teacher-sections">${escapeHtml(details)}</p>
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
}

function renderSchoolAnalytics(report) {
    const teacherMap = new Map(report.teachers.map((teacher, index) => [teacher.id, {
      ...teacher, name: teacher.analyticsName, initials: getInitials(teacher.analyticsName),
      sections: teacher.analyticsSections, color: cardColors[index % cardColors.length]
    }]));
    const sectionMap = new Map(report.sections.map((section, index) => [section.name, { ...section, color: cardColors[index % cardColors.length] }]));
    if (teacherListCount) teacherListCount.textContent = `${teacherMap.size} ${teacherMap.size === 1 ? "teacher" : "teachers"}`;

    const teacherTotals = report.teachers.reduce((totals, teacher) => {
      totals.preSum += teacher.prePctSum || 0;
      totals.preCount += teacher.preCount || 0;
      totals.postSum += teacher.postPctSum || 0;
      totals.postCount += teacher.postCount || 0;
      return totals;
    }, { preSum: 0, preCount: 0, postSum: 0, postCount: 0 });
    const overallPre = teacherTotals.preCount ? Math.round(teacherTotals.preSum / teacherTotals.preCount) : null;
    const overallPost = teacherTotals.postCount ? Math.round(teacherTotals.postSum / teacherTotals.postCount) : null;
    const overallGain = overallPre === null || overallPost === null ? null : overallPost - overallPre;
    if (overallContainer) {
      overallContainer.innerHTML = [
        performanceCard({ name: "Overall Teacher Performance", details: "Students assigned to teachers", initials: "TR", color: "#7048ff", pre: overallPre, post: overallPost, gain: overallGain }),
        performanceCard({ name: "Average School Performance", details: "All students across the school", initials: "SC", color: "#247bce", pre: report.pre, post: report.post, gain: report.gain })
      ].join("");
    }

    // 3. Render Teachers Analytics Cards
    if (teacherContainer) {
      if (teacherMap.size === 0) {
        teacherContainer.innerHTML = `<p style="grid-column: 1 / -1; text-align: center; color: #64748b; padding: 32px;">No teachers found.</p>`;
      } else {
        teacherContainer.innerHTML = Array.from(teacherMap.values()).map((teacher) => performanceCard({
          name: teacher.name, details: teacher.sections, initials: teacher.initials,
          color: teacher.color, pre: teacher.pre, post: teacher.post, gain: teacher.gain
        })).join("");
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
