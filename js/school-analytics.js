import { initializeApp } from "./firebase-auth.js";
import { getAuth, onAuthStateChanged } from "./firebase-auth.js";
import { getAdminReport } from "./firebase-data.js";
import { formatAdminGain, formatAdminPercent, showAdminView } from "./admin-view.js";
import { createPagePerformance } from "./page-performance.js";

const app = initializeApp();
const auth = getAuth(app);

// --- VIEW TOGGLE ---
const teacherContainer = document.getElementById("teacherAnalytics");
const teacherListSection = document.getElementById("teacherListSection");
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

  if (teacherListSection && sectionContainer) {
    teacherListSection.hidden = !showTeachers;
    sectionContainer.hidden = showTeachers;
    sectionContainer.style.display = showTeachers ? "none" : "grid";
  }
}

viewButtons.forEach((button) => {
  button.addEventListener("click", () => setAnalyticsView(button.dataset.view));
});

teacherContainer?.addEventListener("click", (event) => {
  const button = event.target.closest(".teacher-table-toggle");
  if (!button) return;
  const detail = document.getElementById(button.getAttribute("aria-controls"));
  if (!detail) return;
  const expanded = button.getAttribute("aria-expanded") !== "true";
  button.setAttribute("aria-expanded", String(expanded));
  button.setAttribute("aria-label", `${expanded ? "Hide" : "Show"} details for ${button.dataset.teacherName}`);
  detail.hidden = !expanded;
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

function performanceCard({ name, details, initials, color, pre, post, gain, preCount, postCount, students }) {
  const countLabel = count => Number.isInteger(count) && count >= 0 ? `${count} completed lesson test result${count === 1 ? "" : "s"}` : "Completed-result count unavailable";
  const preHint = `Pre-test: results before learning each topic. ${countLabel(preCount)} across all three terms. Missing tests are excluded.`;
  const postHint = `Post-test: results after learning each topic. ${countLabel(postCount)} across all three terms. Missing tests are excluded.`;
  const gainHint = "Post-test average minus pre-test average, measured in percentage points (pp). Both averages are needed.";
  return `
    <article class="teacher-analytics-card" style="--teacher-color:${color};--score:${post ?? 0}%">
      <span class="analytics-avatar">${escapeHtml(initials)}</span>
      <h2 class="analytics-teacher-name">${escapeHtml(name)}</h2>
      <p class="analytics-teacher-sections">${escapeHtml(details)}</p>
      <div class="analytics-donut" role="img" aria-label="${post === null ? "No completed post-tests" : `${post} percent average post-test`}">
        <div class="analytics-donut-inner" aria-hidden="true"></div>
      </div>
      <div class="analytics-metric-help analytics-post-result" tabindex="0" aria-describedby="${initials}-post-help">
        <strong class="analytics-post-score">${formatAdminPercent(post)}</strong>
        <span class="analytics-post-label">Post-test average <span class="analytics-help-icon" aria-hidden="true">i</span></span>
        <small class="analytics-test-stage">After learning</small>
        <span class="analytics-card-tooltip" id="${initials}-post-help" role="tooltip">${escapeHtml(postHint)}</span>
      </div>
      <div class="analytics-card-footer">
        <div class="analytics-metric-help" tabindex="0" aria-describedby="${initials}-pre-help"><span>Pre-test average <span class="analytics-help-icon" aria-hidden="true">i</span></span><strong>${formatAdminPercent(pre)}</strong><small class="analytics-test-stage">Before learning</small><span class="analytics-card-tooltip" id="${initials}-pre-help" role="tooltip">${escapeHtml(preHint)}</span></div>
        <div class="analytics-metric-help analytics-gain-result" tabindex="0" aria-describedby="${initials}-gain-help"><span>Learning gain <span class="analytics-help-icon" aria-hidden="true">i</span></span><strong class="teacher-gain">${formatAdminGain(gain)}</strong><small class="analytics-test-stage">Post-test minus pre-test</small><span class="analytics-card-tooltip" id="${initials}-gain-help" role="tooltip">${gainHint}</span></div>
      </div>
      <details class="analytics-performance-details"><summary>View performance details</summary><dl>
        <div><dt>Students included</dt><dd>${Number.isInteger(students) ? students : "Not available"}</dd></div>
        <div><dt>Pre-test · Before learning</dt><dd>${formatAdminPercent(pre)} · ${countLabel(preCount)}</dd></div>
        <div><dt>Post-test · After learning</dt><dd>${formatAdminPercent(post)} · ${countLabel(postCount)}</dd></div>
        <div><dt>Learning gain</dt><dd>${formatAdminGain(gain)}${Number.isFinite(pre) && Number.isFinite(post) ? ` (${formatAdminPercent(post)} minus ${formatAdminPercent(pre)})` : " · Both test averages are needed"}</dd></div>
        <div><dt>Reporting period</dt><dd>All three terms</dd></div>
        </dl><p>Averages use completed lesson test results. Missing tests are excluded rather than counted as zero. Gain is measured in percentage points (pp).</p>
      </details>
    </article>
  `;
}

function renderSchoolAnalytics(report) {
    const teacherMap = new Map(report.teachers.map((teacher, index) => [teacher.id, {
      ...teacher, name: teacher.analyticsName, initials: getInitials(teacher.analyticsName),
      assignedSections: Array.isArray(teacher.sections) ? teacher.sections.filter(Boolean) : [],
      color: cardColors[index % cardColors.length]
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
    const schoolCounts = report.sections.reduce((totals, section) => ({ pre: totals.pre + (section.preCount || 0), post: totals.post + (section.postCount || 0) }), { pre: 0, post: 0 });
    if (overallContainer) {
      overallContainer.innerHTML = [
        performanceCard({ name: "Overall Teacher Performance", details: "Students assigned to teachers", initials: "TR", color: "#7048ff", pre: overallPre, post: overallPost, gain: overallGain,
          preCount: teacherTotals.preCount, postCount: teacherTotals.postCount, students: report.teachers.reduce((sum, teacher) => sum + teacher.students, 0) }),
        performanceCard({ name: "Average School Performance", details: "All students across the school", initials: "SC", color: "#247bce", pre: report.pre, post: report.post, gain: report.gain,
          preCount: schoolCounts.pre, postCount: schoolCounts.post, students: report.totalStudents })
      ].join("");
    }

    // 3. Render the teacher list and its expandable details
    if (teacherContainer) {
      if (teacherMap.size === 0) {
        teacherContainer.innerHTML = `<tr><td colspan="5" class="teacher-table-empty">No teachers found.</td></tr>`;
      } else {
        teacherContainer.innerHTML = Array.from(teacherMap.values()).map((teacher, index) => `
          <tr class="teacher-table-row" style="--teacher-color:${teacher.color}">
            <th scope="row"><button class="teacher-table-toggle" type="button" aria-expanded="false" aria-controls="teacherDetail-${index}" aria-label="Show details for ${escapeHtml(teacher.name)}" data-teacher-name="${escapeHtml(teacher.name)}"><span class="teacher-table-chevron" aria-hidden="true">›</span><span class="table-avatar">${escapeHtml(teacher.initials)}</span><span>${escapeHtml(teacher.name)}</span></button></th>
            <td>${teacher.assignedSections.length ? `${teacher.assignedSections.length} ${teacher.assignedSections.length === 1 ? "section" : "sections"}` : "—"}</td>
            <td>${formatAdminPercent(teacher.pre)}</td>
            <td>${formatAdminPercent(teacher.post)}</td>
            <td class="teacher-table-gain">${formatAdminGain(teacher.gain)}</td>
          </tr>
          <tr class="teacher-table-detail" id="teacherDetail-${index}" hidden><td colspan="5"><dl>
            <div><dt>Subject</dt><dd>${escapeHtml(teacher.subject)}</dd></div>
            <div><dt>Students</dt><dd>${teacher.students}</dd></div>
            <div><dt>AR Time</dt><dd>${escapeHtml(teacher.hours)}</dd></div>
            <div><dt>School ID</dt><dd>${escapeHtml(teacher.schoolId)}</dd></div>
            <div><dt>Email</dt><dd>${escapeHtml(teacher.email)}</dd></div>
            <div><dt>Status</dt><dd>${teacher.active ? "Active" : "Inactive"}</dd></div>
            <div class="teacher-detail-sections"><dt>Assigned Sections</dt><dd class="teacher-section-list">${teacher.assignedSections.length ? teacher.assignedSections.map((section) => `<span>${escapeHtml(section)}</span>`).join("") : "No sections assigned"}</dd></div>
            <div class="teacher-detail-mobile-score"><dt>Improvement</dt><dd>${formatAdminGain(teacher.gain)}</dd></div>
          </dl></td></tr>
        `).join("");
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
