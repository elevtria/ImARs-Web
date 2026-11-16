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

function snapshotScoreHint(teacher, kind) {
  const label = kind === "pre" ? "Pre-test" : "Post-test";
  const value = teacher[kind], count = teacher[kind === "pre" ? "preCount" : "postCount"];
  if (!Number.isFinite(value)) return `No completed ${label.toLowerCase()} results are available for this teacher's students. Missing tests are excluded, rather than counted as zero.`;
  const basis = Number.isInteger(count) ? ` Based on ${count} completed lesson ${label.toLowerCase()} result${count === 1 ? "" : "s"}.` : "";
  return `${label} average: ${formatAdminPercent(value)}.${basis} Results ${kind === "pre" ? "before" : "after"} learning each topic, across all three terms. Missing tests are excluded.`;
}

// A single tooltip sits outside the scrolling table so its text cannot be clipped.
const snapshot = document.getElementById("teacherSnapshot");
const expandedPerformance = new Set();
snapshot?.addEventListener("click", event => {
  const button = event.target.closest(".snapshot-details-toggle");
  if (!button) return;
  const detail = document.getElementById(button.getAttribute("aria-controls"));
  if (!detail) return;
  const expanded = button.getAttribute("aria-expanded") !== "true";
  button.setAttribute("aria-expanded", String(expanded));
  button.textContent = `${expanded ? "Hide" : "View"} performance details`;
  button.setAttribute("aria-label", `${expanded ? "Hide" : "View"} performance details for ${button.dataset.teacherName}`);
  detail.hidden = !expanded;
  if (expanded) expandedPerformance.add(button.dataset.teacherId);
  else expandedPerformance.delete(button.dataset.teacherId);
});
const performanceTooltip = document.getElementById("teacherPerformanceTooltip");
let activeMetric;
function hidePerformanceTooltip() {
  if (performanceTooltip) performanceTooltip.hidden = true;
  activeMetric = null;
}
function showPerformanceTooltip(target) {
  if (!target || !performanceTooltip) return;
  activeMetric = target;
  performanceTooltip.textContent = target.dataset.performanceTip;
  performanceTooltip.hidden = false;
  const anchor = target.getBoundingClientRect(), tip = performanceTooltip.getBoundingClientRect();
  performanceTooltip.style.left = `${Math.max(12, Math.min(anchor.left + anchor.width / 2 - tip.width / 2, window.innerWidth - tip.width - 12))}px`;
  const top = anchor.top - tip.height - 8 > 12 ? anchor.top - tip.height - 8 : anchor.bottom + 8;
  performanceTooltip.style.top = `${Math.max(12, Math.min(top, window.innerHeight - tip.height - 12))}px`;
}
snapshot?.addEventListener("pointerover", event => showPerformanceTooltip(event.target.closest("[data-performance-tip]")));
snapshot?.addEventListener("pointerout", event => {
  if (activeMetric && !activeMetric.contains(event.relatedTarget) && document.activeElement !== activeMetric) hidePerformanceTooltip();
});
snapshot?.addEventListener("focusin", event => showPerformanceTooltip(event.target.closest("[data-performance-tip]")));
snapshot?.addEventListener("focusout", hidePerformanceTooltip);
window.addEventListener("scroll", hidePerformanceTooltip, true);
window.addEventListener("resize", hidePerformanceTooltip);
document.addEventListener("keydown", event => { if (event.key === "Escape") hidePerformanceTooltip(); });

function renderComparisonCharts(teachers) {
  const scoreChart = document.getElementById("teacherScoreChart");
  const studentChart = document.getElementById("teacherStudentChart");
  const scope = document.getElementById("comparisonScope");
  if (!scoreChart || !studentChart || !scope) return;

  const studentCount = teacher => Number.isFinite(teacher.students) ? Math.max(0, teacher.students) : 0;
  const shown = [...teachers].sort((a, b) => studentCount(b) - studentCount(a) || String(a.name).localeCompare(String(b.name))).slice(0, 6);
  scope.textContent = teachers.length > shown.length
    ? `Showing the ${shown.length} teachers with the most assigned students, out of ${teachers.length}. View School Analytics for the full list.`
    : `Showing ${shown.length} ${shown.length === 1 ? "teacher" : "teachers"}.`;
  if (!shown.length) {
    scoreChart.textContent = "No teachers registered yet.";
    studentChart.textContent = "No teachers registered yet.";
    return;
  }

  const scoreBar = (teacher, kind, label) => {
    const score = teacher[kind];
    const value = Number.isFinite(score) ? formatAdminPercent(score) : "—";
    const width = Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 0;
    return `<div class="comparison-score-line"><span>${label}</span><div class="comparison-track" aria-hidden="true"><i class="comparison-fill ${kind}" style="width:${width}%"></i></div><strong>${value}</strong></div>`;
  };
  scoreChart.innerHTML = `<ul class="comparison-list">${shown.map(teacher => `
    <li class="comparison-item"><strong class="comparison-name">${escapeHtml(teacher.name)}</strong>
      ${scoreBar(teacher, "pre", "Pre")}${scoreBar(teacher, "post", "Post")}
    </li>`).join("")}</ul>`;

  const maxStudents = Math.max(1, ...shown.map(studentCount));
  studentChart.innerHTML = `<ul class="comparison-list">${shown.map(teacher => {
    const count = studentCount(teacher);
    return `<li class="comparison-item"><div class="comparison-student-heading"><strong class="comparison-name">${escapeHtml(teacher.name)}</strong><span>${count} ${count === 1 ? "student" : "students"}</span></div>
      <div class="comparison-track" aria-hidden="true"><i class="comparison-fill students" style="width:${count / maxStudents * 100}%"></i></div>
    </li>`;
  }).join("")}</ul>`;
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

    renderComparisonCharts(report.teachers);

    // 5. Populate Teacher Performance Snapshot Table
    const tableBody = document.getElementById("teacherTableBody");
    if (tableBody) {
      tableBody.innerHTML = "";

      if (teachersMap.size === 0) {
        tableBody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding: 20px;">No teachers registered yet.</td></tr>`;
        return;
      }

      const rows = document.createDocumentFragment();
      let detailIndex = 0;
      teachersMap.forEach((teacher, teacherId) => {
        const detailId = `teacherPerformanceDetails-${detailIndex++}`;
        const expanded = expandedPerformance.has(teacherId);
        const row = document.createElement("tr");
        row.className = "snapshot-teacher-row";
        row.innerHTML = `
          <td>
            <div class="teacher-cell">
              <span class="teacher-avatar">${escapeHtml(teacher.initials)}</span>
              <span>
                <strong>${escapeHtml(teacher.name)}</strong>
                <small>${escapeHtml(teacher.meta)}</small>
                <button class="snapshot-details-toggle" type="button" aria-expanded="${expanded}" aria-controls="${detailId}" aria-label="${expanded ? "Hide" : "View"} performance details for ${escapeHtml(teacher.name)}" data-teacher-id="${escapeHtml(teacherId)}" data-teacher-name="${escapeHtml(teacher.name)}">${expanded ? "Hide" : "View"} performance details</button>
              </span>
            </div>
          </td>
          <td>${teacher.studentCount}</td>
          <td><span class="snapshot-help snapshot-score snapshot-score-pre" tabindex="0" aria-describedby="teacherPerformanceTooltip" data-performance-tip="${escapeHtml(snapshotScoreHint(teacher, "pre"))}">${formatAdminPercent(teacher.pre)}</span></td>
          <td class="post-score"><span class="snapshot-help snapshot-score snapshot-score-post" tabindex="0" aria-describedby="teacherPerformanceTooltip" data-performance-tip="${escapeHtml(snapshotScoreHint(teacher, "post"))}">${formatAdminPercent(teacher.post)}</span></td>
          <td>${escapeHtml(teacher.hours)}</td>
          <td><span class="gain-chip snapshot-help" tabindex="0" aria-describedby="teacherPerformanceTooltip" data-performance-tip="${escapeHtml(Number.isFinite(teacher.gain) ? `Change in average: ${formatAdminGain(teacher.gain)}. Post-test average minus pre-test average; measured in percentage points.` : "Gain is unavailable until both pre-test and post-test averages have recorded results.")}">${formatAdminGain(teacher.gain)}</span></td>
        `;
        rows.appendChild(row);
        const detail = document.createElement("tr");
        detail.id = detailId;
        detail.hidden = !expanded;
        detail.className = "snapshot-detail-row";
        const resultCount = count => Number.isInteger(count) && count >= 0 ? `${count} completed lesson test result${count === 1 ? "" : "s"}` : "Completed-result count unavailable";
        detail.innerHTML = `<td colspan="6"><div class="snapshot-details"><h3>Performance details for ${escapeHtml(teacher.name)}</h3><dl>
          <div><dt>Pre-test · Before learning</dt><dd><strong>${formatAdminPercent(teacher.pre)}</strong><span>${resultCount(teacher.preCount)}</span></dd></div>
          <div><dt>Post-test · After learning</dt><dd><strong>${formatAdminPercent(teacher.post)}</strong><span>${resultCount(teacher.postCount)}</span></dd></div>
          <div><dt>Learning gain</dt><dd><strong>${formatAdminGain(teacher.gain)}</strong><span>${Number.isFinite(teacher.pre) && Number.isFinite(teacher.post) ? `${formatAdminPercent(teacher.post)} post-test minus ${formatAdminPercent(teacher.pre)} pre-test` : "Both test averages are needed"}</span></dd></div>
          <div><dt>Assigned students</dt><dd>${teacher.studentCount}</dd></div><div><dt>Recorded AR time</dt><dd>${escapeHtml(teacher.hours)}</dd></div>
          </dl><p>Based on this teacher’s students across all three terms. Averages use completed lesson test results; missing tests are excluded rather than counted as zero. Gain is measured in percentage points (pp).</p></div></td>`;
        rows.appendChild(detail);
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
