import { escapeHtml } from "./teacher-view.js";
import { initializeApp } from "./firebase-auth.js";
import { getAuth, onAuthStateChanged } from "./firebase-auth.js";
import { createTeacherReport, reportContext } from "./teacher-report-data.js";
import { activityPercent, summarizeAssessments, percentLabel, gainLabel } from "./activity-score.js";
import { buildStudentActivityRecords } from "./student-activity-record.js";

const app = initializeApp();
const auth = getAuth(app);

const empty = document.getElementById("emptyState");
const search = document.getElementById("studentSearch");
const sectionFilter = document.getElementById("sectionFilter");
const sectionSummary = document.getElementById("sectionSummary");
const studentCount = document.getElementById("studentCount");
const studentGrid = document.querySelector("#studentGrid tbody");
const topicsContainer = document.getElementById("topicsContainer");
const studentActivityBody = document.getElementById("studentActivityBody");
const openActivities = new Set();
const activityPages = new Map();

let dynamicRows = [];
let allTopicStats = []; // Store fetched topics globally for term filtering
let currentTermFilter = "term_01";
let selectedSection = "first", lastReport, tablePage = 0;

// Term label map
const termLabels = {
  term_01: "Term 1",
  term_02: "Term 2",
  term_03: "Term 3"
};

function renderStudentActivities(curriculum, sections) {
  if (!studentActivityBody) return;
  const records = buildStudentActivityRecords(curriculum, sections, termLabels, [currentTermFilter]);
  if (!records.length) {
    studentActivityBody.innerHTML = '<tr class="empty-row"><td colspan="5">No student activities found.</td></tr>';
    return;
  }
  studentActivityBody.innerHTML = records.map((record, index) => {
    const key = record.key;
    const open = openActivities.has(key);
    const detailId = `studentActivityDetail${index}`;
    const page = Math.min(activityPages.get(key) || 0, Math.max(0, Math.ceil(record.learners.length / 25) - 1));
    const learnerRows = (open ? record.learners.slice(page * 25, (page + 1) * 25) : []).map(learner => {
      const initials = learner.name.split(/\s+/).filter(Boolean).map(part => part[0]).slice(0, 2).join("").toUpperCase();
      const score = learner.score === null ? "—" : `${learner.rawScore}/${learner.totalScore} · ${Math.round(learner.score)}%`;
      return `<tr><th scope="row"><span class="table-avatar">${escapeHtml(initials)}</span>${escapeHtml(learner.name)}</th><td><span class="activity-result-score${learner.score === null ? " is-empty" : ""}">${score}</span></td><td class="activity-result-time">${learner.minutes === null ? "—" : `${Math.round(learner.minutes)} min`}</td></tr>`;
    }).join("");
    return `<tr class="activity-record-row">
      <th scope="row"><button class="activity-record-toggle" type="button" data-activity-index="${index}" aria-expanded="${open}" aria-controls="${detailId}"><span class="activity-record-chevron" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg></span><span>${escapeHtml(record.title)}<small>${escapeHtml(record.term)} · AR lesson</small></span></button></th>
      <td>${escapeHtml(record.section)}</td><td>${record.averageMinutes === null ? "—" : `${record.averageMinutes} min`}</td><td>${record.learnerCount}</td>
      <td><span class="activity-record-completed">${record.completedCount}/${record.learnerCount} completed</span></td>
    </tr><tr class="activity-record-detail" id="${detailId}" ${open ? "" : "hidden"}><td colspan="5">
      <div class="activity-record-detail-head"><div><strong>Student Results</strong><small>${escapeHtml(record.title)} · ${record.learners.length} learner records shown</small></div><span>Average score: ${record.averageScore === null ? "—" : `${record.averageScore}%`}</span></div>
      ${learnerRows ? `<div class="activity-record-results-wrap"><table class="performance-table activity-record-results"><thead><tr><th scope="col">Student</th><th scope="col">Score</th><th scope="col">Time to finish</th></tr></thead><tbody>${learnerRows}</tbody></table></div>` : '<p class="activity-record-empty">No student activity results recorded yet.</p>'}
      ${open && record.learners.length > 25 ? `<div class="student-detail-navigation"><button type="button" class="ghost-btn activity-result-page" data-record="${index}" data-page="${page - 1}" ${page === 0 ? "disabled" : ""}>Previous page</button><span>Page ${page + 1}</span><button type="button" class="ghost-btn activity-result-page" data-record="${index}" data-page="${page + 1}" ${(page + 1) * 25 >= record.learners.length ? "disabled" : ""}>Next page</button></div>` : ""}
    </td></tr>`;
  }).join("");
  studentActivityBody.querySelectorAll(".activity-record-toggle").forEach(button => {
    button.addEventListener("click", () => {
      const record = records[Number(button.dataset.activityIndex)];
      const key = record.key;
      const detail = document.getElementById(button.getAttribute("aria-controls"));
      const open = button.getAttribute("aria-expanded") !== "true";
      button.setAttribute("aria-expanded", String(open));
      detail.hidden = !open;
      if (open) openActivities.add(key); else openActivities.delete(key);
      renderStudentActivities(curriculum, sections);
    });
  });
  studentActivityBody.querySelectorAll(".activity-result-page").forEach(button => button.addEventListener("click", () => {
    activityPages.set(records[Number(button.dataset.record)].key, Math.max(0, Number(button.dataset.page)));
    renderStudentActivities(curriculum, sections);
  }));
}

// Filtering logic for students
const filterStudents = () => {
  const queryText = (search?.value || "").trim().toLowerCase();
  const matches = dynamicRows.filter(row => row.name.includes(queryText));
  const maximum = Math.max(0, Math.ceil(matches.length / 25) - 1);
  tablePage = Math.min(tablePage, maximum);
  studentGrid.innerHTML = matches.slice(tablePage * 25, (tablePage + 1) * 25).map(row => row.html).join("");
  if (!matches.length) { empty.hidden = false; studentGrid.appendChild(empty); }
  if (studentCount) studentCount.textContent = lastReport?.total ?? matches.length;
  document.getElementById("analyticsPageStatus").textContent = `Page ${tablePage + 1} · ${matches.length} results loaded`;
  document.getElementById("analyticsPrevious").disabled = tablePage === 0;
  document.getElementById("analyticsNext").disabled = tablePage >= maximum;
};
search?.addEventListener("input", () => { tablePage = 0; filterStudents(); });
sectionFilter?.addEventListener("change", () => { selectedSection = sectionFilter.value; tablePage = 0; return openReport(); });
document.getElementById("analyticsPrevious").addEventListener("click", () => { if (tablePage > 0) { tablePage--; filterStudents(); } });
document.getElementById("analyticsNext").addEventListener("click", () => { tablePage++; filterStudents(); });

// Topic rendering by term filter
function renderTopics(baseStudents) {
  if (!topicsContainer) return;
  topicsContainer.innerHTML = "";

  const filteredTopics = allTopicStats.filter((t) =>
    currentTermFilter === "all" || t.termId === currentTermFilter
  );

  if (filteredTopics.length === 0) {
    topicsContainer.innerHTML = `<p style="grid-column: 1 / -1; text-align: center; color: #64748b; padding: 20px;">No lessons found for this term.</p>`;
    return;
  }

  filteredTopics.forEach((stat) => {
    const completionRate = Math.min(100, Math.round((stat.completedCount / baseStudents) * 100));
    const fillDash = ((completionRate / 100) * 289.03).toFixed(1);
    const termTag = termLabels[stat.termId] || stat.termId;

    const topicEl = document.createElement("div");
    topicEl.className = "topic";
    topicEl.style.textAlign = "center";
    topicEl.innerHTML = `
      <div class="mini-wrap" style="width:120px;height:120px;margin:0 auto 10px;position:relative;">
        <svg viewBox="0 0 120 120" style="width:100%;height:100%;transform:rotate(-90deg);">
          <circle class="track" cx="60" cy="60" r="46" fill="none" stroke="#eef1f6" stroke-width="12" />
          ${completionRate > 0 ? `
            <circle cx="60" cy="60" r="46" fill="none" stroke="#81A2C1" stroke-width="12" stroke-linecap="round" stroke-dasharray="${fillDash} 289.03" />
          ` : ""}
        </svg>
      </div>
      <strong style="font-size: 1.25rem; display: block;">${completionRate}%</strong>
      <span style="display:inline-block; font-size: 0.72rem; font-weight: 700; color: #4f46e5; background: #eef2ff; padding: 2px 8px; border-radius: 9999px; margin-bottom: 4px;">${escapeHtml(termTag)}</span>
      <span style="display:block; max-width: 150px; margin: 0 auto; line-height: 1.25; font-size: 0.85rem; font-weight: 600; color: #374151;">${escapeHtml(stat.name)}</span>
    `;
    topicsContainer.appendChild(topicEl);
  });
}

// Term tab switcher events
const termButtons = document.querySelectorAll(".term-tab-btn");
termButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    termButtons.forEach((b) => {
      b.setAttribute("aria-pressed", "false");
    });
    btn.setAttribute("aria-pressed", "true");
    currentTermFilter = btn.dataset.term;
    tablePage = 0;
    void openReport();
  });
});


const report = createTeacherReport({ app,
  progress: ({ loaded, total, complete, termId }) => {
    document.getElementById("analyticsReportStatus").textContent = complete ? "" : `Results so far · ${loaded} of ${total} students`;
    document.getElementById("analyticsTermLabel").textContent = termLabels[termId];
  },
  failed: error => { console.error("Analytics update failed:", error); document.getElementById("analyticsReportStatus").textContent = "Could not update results. Retrying automatically."; },
  render: data => {
    lastReport = data;
    const { sections, classes, curriculumSnap } = data;
    const curriculum = [curriculumSnap], terms = [data.termId];
    dynamicRows = [];
        const topicStatsMap = new Map();
        for (const [index, termLessonsSnap] of curriculum.entries()) {
        const termId = terms[index];
        termLessonsSnap.forEach((lDoc) => {
          const lData = lDoc.data();
          const title = lData.title || lData.name || lDoc.id;

          // COMPOSITE KEY prevents term_03 from overwriting term_01 & term_02
          const compositeKey = `${termId}_${lDoc.id}`;

          topicStatsMap.set(compositeKey, {
            key: compositeKey,
            lessonId: lDoc.id,
            termId: termId,
            name: title,
            completedCount: 0
          });
        });
    }
      let totalEnrolledStudents = 0;

      if (studentGrid) {
        studentGrid.innerHTML = "";
        if (empty) studentGrid.appendChild(empty);
      }

      if (sectionFilter) {
        const options = [{id:"all",name:"All Sections"},...classes.map(row=>({id:row.id,name:"Grade 6 – " + (row.data().SectionName || row.id)}))];
        const signature = JSON.stringify(options);
        if (sectionFilter.dataset.options !== signature) {
          sectionFilter.innerHTML = "";
          for (const row of options) { const option = document.createElement("option"); option.value=row.id; option.textContent=row.name; sectionFilter.appendChild(option); }
          sectionFilter.dataset.options = signature;
        }
        sectionFilter.value = selectedSection === "first" ? data.counts[0]?.classId || "all" : selectedSection || "all";
        if (selectedSection === "first" && data.counts.length) { selectedSection = sectionFilter.value; reportContext(app, auth.currentUser, {termId:currentTermFilter,sectionId:selectedSection === "all" ? "" : selectedSection}); }
        if (sectionSummary) sectionSummary.textContent = sectionFilter.options[sectionFilter.selectedIndex]?.textContent || "All Sections";
      }
      // Process only the selected term and sections.
      const rows = document.createDocumentFragment();
      for (const { classDoc, students } of sections) {
        const classCode = classDoc.id;
        const cData = classDoc.data();
        const sectionName = cData.SectionName || cData.sectionName || cData.name || classCode;

        for (const { studentDoc, results } of students) {
          totalEnrolledStudents++;
          const sData = studentDoc.data();
          const sName = sData.displayName || sData.fullName || "Student";

          const nameParts = sName.split(" ");
          let initials = nameParts[0] ? nameParts[0][0] : "?";
          if (nameParts.length > 1) initials += nameParts[nameParts.length - 1][0];

          let studentActivitySum = 0;
          let activityCount = 0;

          // Check tests across all active terms
          for (const { termId, lessonsSnap } of results) {
            lessonsSnap.forEach((lessonDoc) => {
              const tData = lessonDoc.data();
              const compositeKey = `${termId}_${lessonDoc.id}`;
              const activity = activityPercent(tData);
              if (activity !== null) {
                studentActivitySum += activity;
                activityCount++;
              }

              // Check completion for the matching term & lesson
              if (topicStatsMap.has(compositeKey)) {
                if (tData.isPostTestCompleted || tData.completed) {
                  topicStatsMap.get(compositeKey).completedCount++;
                }
              } else if (tData.isPostTestCompleted || tData.completed) {
                // Fallback if document has customized title
                const fallbackTitle = tData.topicTitle || tData.title || lessonDoc.id;
                topicStatsMap.set(compositeKey, {
                  key: compositeKey,
                  lessonId: lessonDoc.id,
                  termId: termId,
                  name: fallbackTitle,
                  completedCount: 1
                });
              }


            });
          }

          {
            const summary = summarizeAssessments(results.flatMap(row => row.lessonsSnap.docs.map(lesson => lesson.data())));
            const avgPre = summary.pre, avgPost = summary.post, improvement = summary.gain;
            const avgActivity = activityCount ? Math.round(studentActivitySum / activityCount) : null;
            const impClass = improvement > 0 ? "c-green" : improvement < 0 ? "c-danger" : "";

            const html = `<tr class="student-row">
              <th scope="row"><span class="table-avatar">${escapeHtml(initials.toUpperCase())}</span>${escapeHtml(sName)}</th>
              <td>Grade 6 – ${escapeHtml(sectionName)}</td>
              <td>${avgPre === null ? "—" : `${avgPre}%`}</td>
              <td>${avgPost === null ? "—" : `${avgPost}%`}</td>
              <td>${avgActivity === null ? "—" : `${avgActivity}%`}</td>
              <td><span class="improvement-value ${impClass}">${gainLabel(improvement)}</span></td>
            </tr>`;

            dynamicRows.push({ name: sName.toLowerCase(), html });
          }
        }
      }

      filterStudents();

      // 5. Update Overall Class Averages
      {
        const summary = summarizeAssessments(sections.flatMap(section => section.students.flatMap(student => student.results.flatMap(row => row.lessonsSnap.docs.map(lesson => lesson.data())))));
        const finalPre = summary.pre, finalPost = summary.post, finalImp = summary.gain;

        const preVal = document.getElementById("overallPreVal");
        const preFill = document.getElementById("overallPreFill");
        if (preVal) preVal.textContent = percentLabel(finalPre);
        if (preFill) preFill.style.width = `${finalPre || 0}%`;

        const postVal = document.getElementById("overallPostVal");
        const postFill = document.getElementById("overallPostFill");
        if (postVal) postVal.textContent = percentLabel(finalPost);
        if (postFill) postFill.style.width = `${finalPost || 0}%`;

        const impVal = document.getElementById("overallImpVal");
        const impFill = document.getElementById("overallImpFill");
        if (impVal) impVal.textContent = gainLabel(finalImp);
        if (impVal) impVal.classList.toggle("c-danger", finalImp < 0);
        if (impFill) impFill.style.background = finalImp < 0 ? "#b42318" : "var(--action)";
        if (impFill) impFill.style.width = `${Math.min(100, Math.abs(finalImp || 0))}%`;

        const donutLabel = document.getElementById("donutValue");
        if (donutLabel) donutLabel.textContent = percentLabel(finalPost);

        const donutRing = document.getElementById("donutRing");
        if (donutRing) {
          const donutFillAmount = (finalPost / 100) * 289.03;
          donutRing.setAttribute("stroke-dasharray", `${donutFillAmount} 289.03`);
        }
      }

      // 6. Store topics globally and render
      allTopicStats = Array.from(topicStatsMap.values());
      window.totalStudentsBase = Math.max(1, totalEnrolledStudents);
      renderTopics(window.totalStudentsBase);
      renderStudentActivities(curriculum, sections);
  }
});
function openReport() {
  if (!auth.currentUser) return;
  reportContext(app, auth.currentUser, { termId: currentTermFilter, sectionId: selectedSection === "all" ? "" : selectedSection });
  document.getElementById("analyticsReportStatus").textContent = "Loading selected results…";
  return report.open({ user: auth.currentUser, termId: currentTermFilter, sectionId: selectedSection === "all" ? "" : selectedSection });
}
onAuthStateChanged(auth, user => {
  if (!user) { window.location.href = "login.html"; return; }
  const selected = reportContext(app, user); currentTermFilter = selected.termId; selectedSection = selected.sectionId || "all";
  for (const button of termButtons) { button.setAttribute("aria-pressed", String(button.dataset.term === currentTermFilter)); button.classList.toggle("active", button.dataset.term === currentTermFilter); }
  void openReport();
});
