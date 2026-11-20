import { initializeApp } from "./firebase-auth.js";
import { getAuth, onAuthStateChanged } from "./firebase-auth.js";
import { getAdminReport, getFirestore, doc, getDoc } from "./firebase-data.js";
import { buildSchoolAnalyticsReport, schoolAnalyticsCsv } from "./school-analytics-report-data.js";
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
let analyticsView = "teachers", reportReady = false, exporting = false, exportController;
const downloadButtons = [document.getElementById("downloadSchoolPdf"), document.getElementById("downloadSchoolCsv")];
const exportStatus = document.getElementById("schoolExportStatus");
const syncDownloads = () => downloadButtons.forEach(button => { if (button) button.disabled = exporting || !reportReady; });
const cancelExport = () => { exportController?.abort(); };

function setAnalyticsView(view) {
  if (view !== analyticsView) cancelExport();
  analyticsView = view;
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

let reportingPeriod = "All terms";
const cardColors = ["#7048ff", "#ec168d", "#12a8df", "#10b981"];

function performanceCard({ name, details, initials, color, pre, post, gain, preCount, postCount, students }) {
  const countLabel = count => Number.isInteger(count) && count >= 0 ? `${count} completed lesson test result${count === 1 ? "" : "s"}` : "Completed-result count unavailable";
  const preHint = `Pre-test: results before learning each topic. ${countLabel(preCount)} for ${reportingPeriod.toLowerCase()}. Missing tests are excluded.`;
  const postHint = `Post-test: results after learning each topic. ${countLabel(postCount)} for ${reportingPeriod.toLowerCase()}. Missing tests are excluded.`;
  const gainHint = "Post-test average minus pre-test average, measured in percentage points (pp). These are independent averages; this is not a paired student comparison. Both averages are needed.";
  return `
    <article class="teacher-analytics-card school-performance" style="--teacher-color:${color};--score:${post ?? 0}%">
      <span class="analytics-avatar">${escapeHtml(initials)}</span>
      <h2 class="analytics-teacher-name">${escapeHtml(name)}</h2>
      <p class="analytics-teacher-sections">${escapeHtml(details)}</p>
      <div class="school-performance-metrics">
        <div class="analytics-metric-help analytics-pre-result" tabindex="0" aria-describedby="${initials}-pre-help"><span class="analytics-post-label">Pre-test average <span class="analytics-help-icon" aria-hidden="true">i</span></span><div class="analytics-donut" style="--test-score:${pre ?? 0}%;--ring-color:#247bce" role="img" aria-label="${Number.isFinite(pre) ? `${pre} percent average pre-test` : "No completed pre-tests"}"><div class="analytics-donut-inner"><strong class="analytics-post-score" aria-hidden="true">${formatAdminPercent(pre)}</strong></div></div><small class="analytics-test-stage">Before learning</small><span class="analytics-card-tooltip" id="${initials}-pre-help" role="tooltip">${escapeHtml(preHint)}</span></div>
        <div class="analytics-metric-help analytics-post-result" tabindex="0" aria-describedby="${initials}-post-help"><span class="analytics-post-label">Post-test average <span class="analytics-help-icon" aria-hidden="true">i</span></span><div class="analytics-donut" style="--test-score:${post ?? 0}%;--ring-color:#0ca58c" role="img" aria-label="${Number.isFinite(post) ? `${post} percent average post-test` : "No completed post-tests"}"><div class="analytics-donut-inner"><strong class="analytics-post-score" aria-hidden="true">${formatAdminPercent(post)}</strong></div></div><small class="analytics-test-stage">After learning</small><span class="analytics-card-tooltip" id="${initials}-post-help" role="tooltip">${escapeHtml(postHint)}</span></div>
        <div class="analytics-metric-help analytics-gain-result" tabindex="0" aria-describedby="${initials}-gain-help"><span class="analytics-post-label">Change in average <span class="analytics-help-icon" aria-hidden="true">i</span></span><strong class="analytics-post-score teacher-gain">${formatAdminGain(gain)}</strong><small class="analytics-test-stage">Post-test minus pre-test</small><span class="analytics-card-tooltip" id="${initials}-gain-help" role="tooltip">${gainHint}</span></div>
      </div>
      <details class="analytics-performance-details"><summary>View performance details</summary><dl>
        <div><dt>Students included</dt><dd>${Number.isInteger(students) ? students : "Not available"}</dd></div>
        <div><dt>Pre-test · Before learning</dt><dd>${formatAdminPercent(pre)} · ${countLabel(preCount)}</dd></div>
        <div><dt>Post-test · After learning</dt><dd>${formatAdminPercent(post)} · ${countLabel(postCount)}</dd></div>
        <div><dt>Change in average</dt><dd>${formatAdminGain(gain)}${Number.isFinite(pre) && Number.isFinite(post) ? ` (${formatAdminPercent(post)} minus ${formatAdminPercent(pre)})` : " · Both test averages are needed"}</dd></div>
        <div><dt>Reporting period</dt><dd>${escapeHtml(reportingPeriod)}</dd></div>
        </dl><p>Averages use completed lesson test results. Missing tests are excluded rather than counted as zero. Change in average is measured in percentage points (pp).</p>
      </details>
    </article>
  `;
}

function renderSchoolAnalytics(report) {
    reportReady = true; syncDownloads();
    reportingPeriod = report.termId ? "Term " + Number(report.termId.slice(-2)) : "All terms";
    const sectionSelect = document.getElementById("adminSection");
    if (sectionSelect && Array.isArray(report.sectionDirectory)) {
      const previous = report.sectionId || "";
      sectionSelect.innerHTML = '<option value="">All sections</option>' + report.sectionDirectory.map(section => '<option value="' + escapeHtml(section.id) + '">' + escapeHtml(section.name) + '</option>').join("");
      sectionSelect.value = previous;
    }
    const scope = document.getElementById("adminReportScope");
    if (scope) scope.textContent = reportingPeriod + " · " + (report.sectionDirectory?.find(section => section.id === report.sectionId)?.name || "All sections") + ". Completed tests only. Change compares independent averages, not matched student pairs.";
    const teacherMap = new Map(report.teachers.map((teacher, index) => [teacher.id, {
      ...teacher, name: teacher.analyticsName, initials: getInitials(teacher.analyticsName),
      assignedSections: Array.isArray(teacher.sections) ? teacher.sections.filter(Boolean) : [],
      color: cardColors[index % cardColors.length]
    }]));
    const sectionMap = new Map(report.sections.map((section, index) => [section.name, { ...section, color: cardColors[index % cardColors.length] }]));
    if (teacherListCount) teacherListCount.textContent = `${teacherMap.size} ${teacherMap.size === 1 ? "teacher" : "teachers"}`;

    const schoolCounts = report.sections.reduce((totals, section) => ({ pre: totals.pre + (section.preCount || 0), post: totals.post + (section.postCount || 0) }), { pre: 0, post: 0 });
    if (overallContainer) {
      overallContainer.innerHTML = [
        performanceCard({ name: "School Performance", details: reportingPeriod + " · Selected sections", initials: "SC", color: "#247bce", pre: report.pre, post: report.post, gain: report.gain,
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
            <div class="teacher-detail-mobile-score"><dt>Change in average</dt><dd>${formatAdminGain(teacher.gain)}</dd></div>
          </dl></td></tr>
        `).join("");
      }
    }

    // 4. Render Sections Analytics Cards
    if (sectionContainer) {
      if (sectionMap.size === 0) {
        sectionContainer.innerHTML = `<p style="text-align: center; color: var(--theme-muted, #64748b); padding: 32px;">No student sections found.</p>`;
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

let currentUser;
async function loadSelectedReport() {
  cancelExport(); reportReady = false; syncDownloads();
  const user = currentUser;
  if (!user) return;
  const termId = document.getElementById("adminTerm")?.value || "";
  const sectionId = document.getElementById("adminSection")?.value || "";
  const key = termId + ":" + sectionId;
  const timing = createPagePerformance("School Analytics");
  try {
    await showAdminView({ app, user, page: !termId && !sectionId ? "admin:reports-v3" : "admin:reports-v3:" + key, watchKey: "admin:analytics",
      load: () => timing.data(() => getAdminReport({ termId, sectionId })),
      render: report => {
        if (currentUser?.uid !== user.uid || (document.getElementById("adminTerm")?.value || "") !== termId || (document.getElementById("adminSection")?.value || "") !== sectionId) return;
        timing.render(() => renderSchoolAnalytics(report));
      },
      painted: cacheHit => timing.finish("loaded", { cacheHit })
    });
  } catch (error) { timing.finish("error"); console.error("Error loading analytics data:", error); }
}
onAuthStateChanged(auth, user => {
  cancelExport(); reportReady = false; syncDownloads();
  currentUser = user;
  if (!user) { window.location.href = "admin-login.html"; return; }
  void loadSelectedReport();
});
for (const id of ["adminTerm", "adminSection"]) document.getElementById(id)?.addEventListener("change", () => { void loadSelectedReport(); });
setAnalyticsView("teachers");

async function downloadSchoolReport(format) {
  if (!reportReady || exporting || auth.currentUser?.role !== "admin") return;
  const user = auth.currentUser, termId = document.getElementById("adminTerm").value, sectionId = document.getElementById("adminSection").value;
  const view = analyticsView, controller = new AbortController(); exportController = controller;
  exporting = true; syncDownloads(); exportStatus.textContent = "Loading the complete report for your selection…";
  const check = () => { controller.signal.throwIfAborted(); if (auth.currentUser?.uid !== user.uid) throw new DOMException("Sign-in changed.", "AbortError"); };
  try {
    const [data, year] = await Promise.all([getAdminReport({ termId, sectionId }), getDoc(doc(getFirestore(app), "webSettings", "schoolYear"))]);
    check();
    if ((data.termId || "") !== termId || (data.sectionId || "") !== sectionId) throw new Error("The report selection changed. Try again.");
    const report = buildSchoolAnalyticsReport(data, { startYear: year.data()?.startYear, view, generatedBy: user.displayName || "Administrator" });
    exportStatus.textContent = `Preparing ${format.toUpperCase()}…`;
    let blob;
    if (format === "pdf") {
      const { schoolAnalyticsPdf } = await import("./school-analytics-report-pdf.js"); check();
      const output = await schoolAnalyticsPdf(report); check();
      blob = new Blob([output.pdfBytes], { type: "application/pdf" });
    } else blob = new Blob([schoolAnalyticsCsv(report)], { type: "text/csv;charset=utf-8" });
    check();
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url; link.download = report.filename + "." + format; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    exportStatus.textContent = `${format.toUpperCase()} downloaded · ${report.period} · ${report.scope} · ${report.view}.`;
  } catch (error) { exportStatus.textContent = error.name === "AbortError" ? "Selection or sign-in changed. Please download again." : "Unable to download. " + error.message; }
  finally { exporting = false; if (exportController === controller) exportController = null; syncDownloads(); }
}
downloadButtons[0]?.addEventListener("click", () => downloadSchoolReport("pdf"));
downloadButtons[1]?.addEventListener("click", () => downloadSchoolReport("csv"));
