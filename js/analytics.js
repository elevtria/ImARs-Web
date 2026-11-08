import { escapeHtml } from "./teacher-view.js";
import { initializeApp } from "./firebase-auth.js";
import { setLoadingState, revealContent } from "./loading.js";
import { getAuth, onAuthStateChanged } from "./firebase-auth.js";
import { createTeacherReport } from "./teacher-report-data.js";
import { activityPercent } from "./activity-score.js";
import { buildStudentActivityRecords } from "./student-activity-record.js";
import { buildPostTestHeatmap } from "./post-test-heatmap.js";
import { getDocs as getHeatmapQuestions, collection as heatmapCollection, getFirestore as heatmapDatabase, getTeacherReportPage } from "./firebase-data.js";

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
const activitySectionFilter = document.getElementById("activitySectionFilter");
const questionHeatmapScope = document.getElementById("questionHeatmapScope");
const topicCompletionScope = document.getElementById("topicCompletionScope");
const openActivities = new Set();
const activityPages = new Map();
const studentsPerPage = 25;
let activitySection = "", activityRequest = "", activityData;

let dynamicRows = [];
let currentTermFilter = "term_01";
let lastAnalyticsTerm = currentTermFilter;
let selectedSection = "first", lastReport, tablePage = 0;
const heatmapTopicSelect = document.getElementById("heatmapTopicFilter");
const heatmapRows = document.getElementById("questionHeatmapRows");
const heatmapStatus = document.getElementById("questionHeatmapStatus");
const heatmapMore = document.getElementById("heatmapMore");
let heatmapTopic = "", heatmapLessons = [], heatmapPage, heatmapOwner;
const heatmapQuestionLoads = new Map();

// Term label map
const termLabels = {
  term_01: "Term 1",
  term_02: "Term 2",
  term_03: "Term 3"
};

function renderQuestionHeatmap(result, partial = false) {
  setLoadingState(heatmapStatus, false);
  heatmapRows.removeAttribute("aria-busy");
  heatmapStatus.textContent = `${result.mapped} mapped post-test result${result.mapped === 1 ? "" : "s"}.` +
    (result.unmapped ? ` ${result.unmapped} excluded because the original question order is missing or invalid.` : "") +
    (partial ? " More results are available." : "");
  if (result.rows.length && !result.mapped) {
    heatmapRows.textContent = result.unmapped
      ? "These attempts lack a valid question order. New attempts from a compatible app can appear here after syncing."
      : "No completed post-tests found for this topic yet.";
    return;
  }
  heatmapRows.innerHTML = result.rows.length ? result.rows.map(row => {
    const rate = row.rate ?? 0;
    const level = rate <= 33 ? "low" : rate <= 66 ? "moderate" : "high";
    const count = row.answered ? `${row.wrong}/${row.answered} wrong · ${Math.round(rate)}%` : "No mapped answers";
    return `<div class="question-heatmap-row"><div class="question-heatmap-question"><strong>Q${row.index + 1}.</strong> ${escapeHtml(row.text)}</div><div class="question-heatmap-result"><div class="question-heatmap-track" aria-hidden="true"><i class="heatmap-${level}" style="width:${rate}%"></i></div><span>${count}</span></div></div>`;
  }).join("") : '<p class="activity-record-empty">No post-test questions are recorded for this topic.</p>';
}

function clearHeatmapResults() {
  heatmapPage?.controller?.abort();
  heatmapPage = null;
  heatmapRows.replaceChildren();
  heatmapRows.removeAttribute("aria-busy");
  heatmapMore.hidden = true;
  setLoadingState(heatmapStatus, false);
}

async function loadHeatmapTopics() {
  const uid = auth.currentUser?.uid, term = currentTermFilter;
  if (!uid || !activitySection) return;
  const key = uid + ":" + term;
  const report = [lastReport, activityData].find(data => data?.termId === term && data.curriculumSnap);
  const saved = report?.curriculumSnap;
  if (!heatmapQuestionLoads.has(key)) {
    const hasLabels = saved?.docs.some(lesson => Array.isArray(lesson.data().postTest));
    heatmapQuestionLoads.set(key, hasLabels ? Promise.resolve(saved) :
      getHeatmapQuestions(heatmapCollection(heatmapDatabase(app), "terms", term, "lessons")));
  }
  try {
    const snapshot = await heatmapQuestionLoads.get(key);
    if (auth.currentUser?.uid !== uid || currentTermFilter !== term || !activitySection) return;
    heatmapLessons = snapshot.docs;
    const choices = heatmapLessons.map(lesson => ({ id: lesson.id, title: lesson.data().title || lesson.data().name || lesson.id }));
    const signature = JSON.stringify([term, choices]);
    if (heatmapTopicSelect.dataset.options !== signature) {
      heatmapTopicSelect.innerHTML = '<option value="">Select a topic</option>' +
        choices.map(lesson => `<option value="${escapeHtml(lesson.id)}">${escapeHtml(lesson.title)}</option>`).join("");
      heatmapTopicSelect.dataset.options = signature;
    }
    heatmapTopicSelect.value = heatmapTopic;
    heatmapTopicSelect.disabled = !choices.length;
    if (!heatmapTopic) heatmapStatus.textContent = choices.length ? "Choose a topic to view post-test results." : "No topics are available for this term.";
  } catch {
    heatmapQuestionLoads.delete(key);
    if (auth.currentUser?.uid === uid && currentTermFilter === term && activitySection) heatmapStatus.textContent = "Could not load topics. Try choosing the term again.";
  }
}

async function openQuestionHeatmap(loadMore = false) {
  const uid = auth.currentUser?.uid, termId = currentTermFilter, sectionId = activitySection;
  const selected = heatmapLessons.find(item => item.id === heatmapTopic);
  if (!uid || !sectionId || !selected) return;
  const report = [activityData, lastReport].find(data => data?.termId === termId &&
    data.sections.some(section => section.classDoc.id === sectionId));
  if (report) {
    if (heatmapPage) clearHeatmapResults();
    const sections = report.sections.filter(section => section.classDoc.id === sectionId);
    renderQuestionHeatmap(buildPostTestHeatmap(selected, sections, termId), report.complete === false);
    return;
  }
  const key = [uid, termId, sectionId, selected.id].join(":");
  if (heatmapPage?.key !== key) {
    clearHeatmapResults();
    heatmapPage = { key, cursor: null, result: null };
  }
  const page = heatmapPage;
  if (page.controller || (page.result && !loadMore) || (loadMore && !page.cursor && page.result)) return;
  page.controller = new AbortController();
  heatmapMore.hidden = true;
  heatmapRows.setAttribute("aria-busy", "true");
  setLoadingState(heatmapStatus, true, "Updating post-test results");
  try {
    const data = await getTeacherReportPage({ termId, sectionId, heatmapLesson: selected.id,
      includeCurriculum: false, includeCounts: false, cursor: page.cursor, batchSize: 25 }, { signal: page.controller.signal });
    if (heatmapPage !== page || auth.currentUser?.uid !== uid) return;
    const result = buildPostTestHeatmap(selected, [{ students: data.students }], termId);
    if (page.result) {
      result.mapped += page.result.mapped;
      result.unmapped += page.result.unmapped;
      result.rows.forEach((row, index) => {
        row.wrong += page.result.rows[index].wrong;
        row.answered += page.result.rows[index].answered;
        row.rate = row.answered ? 100 * row.wrong / row.answered : null;
      });
    }
    page.cursor = data.cursor;
    page.result = result;
    renderQuestionHeatmap(result, Boolean(page.cursor));
    heatmapMore.textContent = "Load more results";
    heatmapMore.hidden = !page.cursor;
  } catch (error) {
    if (heatmapPage !== page || auth.currentUser?.uid !== uid || error.name === "AbortError") return;
    setLoadingState(heatmapStatus, false);
    heatmapRows.removeAttribute("aria-busy");
    heatmapStatus.textContent = "Could not update post-test results.";
    if ([401, 403].includes(error.status)) {
      clearHeatmapResults();
    } else {
      heatmapMore.textContent = "Retry";
      heatmapMore.hidden = false;
    }
  } finally { page.controller = null; }
}

function updateHeatmap() {
  if (!activitySection) {
    clearHeatmapResults();
    heatmapTopicSelect.disabled = true;
    heatmapStatus.textContent = "No sections are assigned to your account.";
    return;
  }
  if (!heatmapLessons.length || heatmapTopicSelect.disabled) void loadHeatmapTopics();
  if (heatmapTopic) void openQuestionHeatmap();
}

heatmapTopicSelect?.addEventListener("change", () => {
  heatmapTopic = heatmapTopicSelect.value;
  clearHeatmapResults();
  if (!heatmapTopic) { heatmapStatus.textContent = "Choose a topic to view post-test results."; return; }
  return openQuestionHeatmap();
});
heatmapMore?.addEventListener("click", () => openQuestionHeatmap(true));

const activityReport = createTeacherReport({ app,
  render: data => {
    if (data.termId !== currentTermFilter) return;
    const section = data.sections.find(section => section.classDoc.id === activitySection);
    if (section) renderActivityReport(data, section);
  },
  failed: error => {
    console.error("Activity records update failed:", error);
    studentActivityBody.removeAttribute("aria-busy");
    if (!activityData) {
      studentActivityBody.innerHTML = '<tr class="empty-row"><td colspan="5">Could not update activity records. Retrying automatically.</td></tr>';
      revealContent("analytics-activities");
    }
    if (!activityData?.complete) renderTopics([], "Could not update topic completion rates.");
  }
});

function updateActivitySections(data) {
  if (!activitySectionFilter) return;
  if (!data.classes.some(section => section.id === activitySection)) {
    selectActivitySection(data.sections[0]?.classDoc.id || data.classes[0]?.id || "");
  }
  const options = data.classes.map(section => ({ id: section.id, name: section.data().SectionName || section.data().sectionName || section.data().name || section.id }));
  // Reuse the same options during report batches so an open native dropdown is
  // not reset by background updates.
  const key = JSON.stringify(options);
  if (activitySectionFilter.dataset.sections !== key) {
    activitySectionFilter.replaceChildren(...options.map(section => {
      const option = document.createElement("option"); option.value = section.id; option.textContent = section.name; return option;
    }));
    activitySectionFilter.dataset.sections = key;
  }
  activitySectionFilter.value = activitySection;
  activitySectionFilter.disabled = !options.length;
  void openActivityReport();
}

function selectActivitySection(sectionId) {
  if (activitySection === sectionId) return;
  activitySection = sectionId;
  clearHeatmapResults();
  heatmapStatus.textContent = heatmapTopic ? "" : "Choose a topic to view post-test results.";
  showTopicsPending();
}

function openActivityReport() {
  if (!auth.currentUser || !studentActivityBody) return;
  const classDoc = lastReport?.classes.find(section => section.id === activitySection);
  const classData = classDoc?.data();
  const sectionName = classData?.SectionName || classData?.sectionName || classData?.name || activitySection;
  const scope = sectionName ? `${termLabels[currentTermFilter]} · ${sectionName}` : termLabels[currentTermFilter];
  questionHeatmapScope.textContent = topicCompletionScope.textContent = scope;
  const section = lastReport?.termId === currentTermFilter && lastReport.sections.find(section => section.classDoc.id === activitySection);
  if (section && lastReport.curriculumSnap) {
    activityReport.stop(); activityRequest = "";
    renderActivityReport(lastReport, section);
    return;
  }
  if (!activitySection) {
    activityReport.stop(); activityRequest = ""; activityData = null;
    studentActivityBody.removeAttribute("aria-busy");
    studentActivityBody.innerHTML = '<tr class="empty-row"><td colspan="5">No sections assigned yet.</td></tr>';
    revealContent("analytics-activities");
    renderTopics([], "No sections assigned yet.");
    updateHeatmap();
    return;
  }
  const key = `${auth.currentUser.uid}:${currentTermFilter}:${activitySection}`;
  if (activityRequest === key) return;
  activityRequest = key; activityData = null;
  studentActivityBody.setAttribute("aria-busy", "true");
  studentActivityBody.innerHTML = '<tr class="empty-row"><td colspan="5"><span data-loading="true" role="status" aria-label="Loading student activities"></span></td></tr>';
  // The existing report loader reuses its section/term cache and cancels a
  // superseded request. Other analytics cards keep their current report.
  return activityReport.open({ user: auth.currentUser, termId: currentTermFilter, sectionId: activitySection });
}
activitySectionFilter?.addEventListener("change", () => {
  if (!lastReport?.classes.some(section => section.id === activitySectionFilter.value)) return;
  if (activitySection === activitySectionFilter.value) return;
  selectActivitySection(activitySectionFilter.value);
  return openActivityReport();
});

function renderActivityReport(data, section) {
  if (!data.curriculumSnap) return;
  activityData = data;
  const records = buildStudentActivityRecords([data.curriculumSnap], [section], termLabels, [data.termId]);
  studentActivityBody.removeAttribute("aria-busy");
  renderStudentActivities(records, data.complete === false);
  if (data.complete !== false) renderTopics(records);
  updateHeatmap();
}

function renderStudentActivities(records, partial) {
  if (!studentActivityBody) return;
  if (!records.length) {
    studentActivityBody.innerHTML = '<tr class="empty-row"><td colspan="5">No student activities found.</td></tr>';
    revealContent("analytics-activities");
    return;
  }
  studentActivityBody.innerHTML = records.map((record, index) => {
    const key = record.key;
    const open = openActivities.has(key);
    const detailId = `studentActivityDetail${index}`;
    const total = record.learners.length;
    const page = Math.min(activityPages.get(key) || 0, Math.max(0, Math.ceil(total / studentsPerPage) - 1));
    const start = page * studentsPerPage, end = Math.min(start + studentsPerPage, total);
    const learnerRows = (open ? record.learners.slice(start, end) : []).map(learner => {
      const initials = learner.name.split(/\s+/).filter(Boolean).map(part => part[0]).slice(0, 2).join("").toUpperCase();
      const rawCell = result => `<td><span class="activity-result-score${result === null ? " is-empty" : ""}">${result === null ? "—" : `${result.score}/${result.total}`}</span></td>`;
      const activity = learner.score === null ? null : { score: learner.rawScore, total: learner.totalScore };
      return `<tr><th scope="row"><span class="table-avatar">${escapeHtml(initials)}</span>${escapeHtml(learner.name)}</th>${rawCell(learner.preTest)}${rawCell(learner.postTest)}${rawCell(activity)}<td class="activity-result-time">${learner.minutes === null ? "—" : `${Math.round(learner.minutes)} min`}</td></tr>`;
    }).join("");
    return `<tr class="activity-record-row">
      <th scope="row"><button class="activity-record-toggle" type="button" data-activity-index="${index}" aria-expanded="${open}" aria-controls="${detailId}"><span class="activity-record-chevron" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg></span><span>${escapeHtml(record.title)}<small>${escapeHtml(record.term)} · AR lesson</small></span></button></th>
      <td>${escapeHtml(record.section)}</td><td>${record.averageMinutes === null ? "—" : `${record.averageMinutes} min`}</td><td>${record.learnerCount}</td>
      <td><span class="activity-record-completed">${record.completedCount}/${record.learnerCount} completed</span></td>
    </tr><tr class="activity-record-detail" id="${detailId}" ${open ? "" : "hidden"}><td colspan="5">
      <div class="activity-record-detail-head"><div><strong>Topic Student Results</strong><small>${escapeHtml(record.title)} · ${studentPageLabel(start, end, total, partial)}</small></div></div>
      ${learnerRows ? `<div class="activity-record-results-wrap"><table class="performance-table activity-record-results"><thead><tr><th scope="col">Student</th><th scope="col">Pre-test</th><th scope="col">Post-test</th><th scope="col">Activity score</th><th scope="col">Recorded time</th></tr></thead><tbody>${learnerRows}</tbody></table></div><p class="activity-record-empty">Scores show earned points / total points for this topic. A dash means a score or time is missing.</p>` : '<p class="activity-record-empty">No students to show for this section.</p>'}
      ${open && total > studentsPerPage ? `<div class="student-detail-navigation"><button type="button" class="ghost-btn activity-result-page" data-record="${index}" data-page="${page - 1}" ${page === 0 ? "disabled" : ""}>Previous page</button><button type="button" class="ghost-btn activity-result-page" data-record="${index}" data-page="${page + 1}" ${end >= total ? "disabled" : ""}>Next page</button></div>` : ""}
    </td></tr>`;
  }).join("");
  revealContent("analytics-activities");
  studentActivityBody.querySelectorAll(".activity-record-toggle").forEach(button => {
    button.addEventListener("click", () => {
      const record = records[Number(button.dataset.activityIndex)];
      const key = record.key;
      const detail = document.getElementById(button.getAttribute("aria-controls"));
      const open = button.getAttribute("aria-expanded") !== "true";
      button.setAttribute("aria-expanded", String(open));
      detail.hidden = !open;
      if (open) openActivities.add(key); else openActivities.delete(key);
      renderStudentActivities(records, partial);
    });
  });
  studentActivityBody.querySelectorAll(".activity-result-page").forEach(button => button.addEventListener("click", () => {
    activityPages.set(records[Number(button.dataset.record)].key, Math.max(0, Number(button.dataset.page)));
    renderStudentActivities(records, partial);
  }));
}

function studentPageLabel(start, end, total, partial) {
  return total ? `Showing ${start + 1}–${end} of ${total} students${partial ? " loaded" : ""}` : "0 students";
}

// Filtering logic for students
const filterStudents = () => {
  const queryText = (search?.value || "").trim().toLowerCase();
  const matches = dynamicRows.filter(row => row.name.includes(queryText));
  const maximum = Math.max(0, Math.ceil(matches.length / studentsPerPage) - 1);
  tablePage = Math.min(tablePage, maximum);
  const start = tablePage * studentsPerPage, end = Math.min(start + studentsPerPage, matches.length);
  studentGrid.innerHTML = matches.slice(start, end).map(row => row.html).join("");
  if (!matches.length) { empty.hidden = false; studentGrid.appendChild(empty); }
  if (studentCount) studentCount.textContent = lastReport ? lastReport.total ?? "—" : matches.length;
  document.getElementById("analyticsPageStatus").textContent = studentPageLabel(start, end, matches.length, lastReport?.complete === false);
  document.getElementById("analyticsPrevious").disabled = tablePage === 0;
  document.getElementById("analyticsNext").disabled = tablePage >= maximum;
};
search?.addEventListener("input", () => { tablePage = 0; filterStudents(); });
sectionFilter?.addEventListener("change", () => { selectedSection = sectionFilter.value; tablePage = 0; return openReport(); });
document.getElementById("analyticsPrevious").addEventListener("click", () => { if (tablePage > 0) { tablePage--; filterStudents(); } });
document.getElementById("analyticsNext").addEventListener("click", () => { tablePage++; filterStudents(); });

function showTopicsPending() {
  topicsContainer.setAttribute("aria-busy", "true");
  topicsContainer.innerHTML = '<p><span data-loading="true" role="status" aria-label="Loading topic completion rates"></span></p>';
}

function renderTopics(records, emptyMessage = "No lessons found for this term.") {
  topicsContainer.removeAttribute("aria-busy");
  topicsContainer.innerHTML = records.length ? "" : `<p>${emptyMessage}</p>`;
  records.forEach((record) => {
    const completionRate = record.learnerCount ? Math.round((record.completedCount / record.learnerCount) * 100) : null;
    const fillDash = (((completionRate ?? 0) / 100) * 289.03).toFixed(1);

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
      <strong style="font-size: 1.25rem; display: block;">${completionRate === null ? "—" : `${completionRate}%`}</strong>
      <span style="display:block; max-width: 150px; margin: 0 auto; line-height: 1.25; font-size: 0.85rem; font-weight: 600; color: var(--ink, #374151);">${escapeHtml(record.title)}</span>
    `;
    topicsContainer.appendChild(topicEl);
  });
  revealContent("analytics-topics");
}

// Term tab switcher events
const termButtons = document.querySelectorAll(".term-tab-btn");
termButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    if (currentTermFilter === btn.dataset.term) return;
    termButtons.forEach(button => button.setAttribute("aria-pressed", String(button === btn)));
    currentTermFilter = btn.dataset.term;
    tablePage = 0;
    return openReport();
  });
});


const report = createTeacherReport({ app,
  progress: ({ loaded, total, complete, termId }) => {
    const status = document.getElementById("analyticsReportStatus");
    setLoadingState(status, !complete, total === null ? "Updating results" : `Results: ${loaded} of ${total} students`);
    status.textContent = "";
    document.getElementById("analyticsTermLabel").textContent = termLabels[termId];
  },
  failed: error => { console.error("Analytics update failed:", error); setLoadingState(document.getElementById("analyticsReportStatus"), false); document.getElementById("analyticsReportStatus").textContent = "Could not update results. Retrying automatically."; },
  render: data => {
    if (data.termId !== currentTermFilter) return;
    lastReport = data;
    const { sections, classes } = data;
    dynamicRows = [];
      let totalClassPrePercentageSum = 0;
      let totalClassPostPercentageSum = 0;
      let totalStudentTestsCount = 0;

      if (sectionFilter) sectionFilter.innerHTML = '<option value="all">All Sections</option>';
      if (studentGrid) {
        studentGrid.innerHTML = "";
        if (empty) studentGrid.appendChild(empty);
      }

      if (sectionFilter) {
        for (const classDoc of classes) {
          const option = document.createElement("option"); option.value = classDoc.id;
          option.textContent = "Grade 6 – " + (classDoc.data().SectionName || classDoc.id);
          sectionFilter.appendChild(option);
        }
        sectionFilter.value = selectedSection === "first" ? data.counts[0]?.classId || data.classes[0]?.id || "all" : selectedSection || "all";
        if (sectionSummary) sectionSummary.textContent = sectionFilter.options[sectionFilter.selectedIndex]?.textContent || "All Sections";
      }
      // Process only the selected term and sections.
      for (const { classDoc, students } of sections) {
        const classCode = classDoc.id;
        const cData = classDoc.data();
        const sectionName = cData.SectionName || cData.sectionName || cData.name || classCode;

        for (const { studentDoc, results } of students) {
          const sData = studentDoc.data();
          const sName = sData.displayName || sData.fullName || "Student";

          const nameParts = sName.split(" ");
          let initials = nameParts[0] ? nameParts[0][0] : "?";
          if (nameParts.length > 1) initials += nameParts[nameParts.length - 1][0];

          let studentPreSum = 0;
          let studentPostSum = 0;
          let testCount = 0;
          let studentActivitySum = 0;
          let activityCount = 0;

          for (const { lessonsSnap } of results) {
            lessonsSnap.forEach((lessonDoc) => {
              const tData = lessonDoc.data();
              const activity = activityPercent(tData);
              if (activity !== null) {
                studentActivitySum += activity;
                activityCount++;
              }

              // Aggregate test scores
              if (tData.isPreTestCompleted && tData.preTestTotalQuestions > 0 && tData.isPostTestCompleted && tData.postTestTotalQuestions > 0) {
                const prePercent = (tData.preTestScore / tData.preTestTotalQuestions) * 100;
                const rawPostScore = tData.postTestScore !== undefined ? tData.postTestScore : (tData.postTestHeatmap ? tData.postTestHeatmap.filter(Boolean).length : 0);
                const postPercent = (rawPostScore / tData.postTestTotalQuestions) * 100;

                studentPreSum += prePercent;
                studentPostSum += postPercent;
                testCount++;
              }
            });
          }

          const avgPre = testCount ? Math.round(studentPreSum / testCount) : null;
          const avgPost = testCount ? Math.round(studentPostSum / testCount) : null;
          const avgActivity = activityCount ? Math.round(studentActivitySum / activityCount) : null;
          const improvement = testCount ? avgPost - avgPre : null;

          if (testCount) {
            totalClassPrePercentageSum += avgPre;
            totalClassPostPercentageSum += avgPost;
            totalStudentTestsCount++;
          }

          const impClass = improvement > 0 ? "c-green" : improvement < 0 ? "c-danger" : "";
          const impSign = improvement > 0 ? "+" : "";

          const html = `<tr class="student-row">
            <th scope="row"><span class="table-avatar">${escapeHtml(initials.toUpperCase())}</span>${escapeHtml(sName)}</th>
            <td>Grade 6 – ${escapeHtml(sectionName)}</td>
            <td>${avgPre === null ? "—" : `${avgPre}%`}</td>
            <td>${avgPost === null ? "—" : `${avgPost}%`}</td>
            <td>${avgActivity === null ? "—" : `${avgActivity}%`}</td>
            <td><span class="improvement-value ${impClass}">${improvement === null ? "—" : `${impSign}${improvement}%`}</span></td>
          </tr>`;

          dynamicRows.push({ name: sName.toLowerCase(), html });
        }
      }

      filterStudents();

      // 5. Update Overall Class Averages
      {
        const finalPre = totalStudentTestsCount ? Math.round(totalClassPrePercentageSum / totalStudentTestsCount) : 0;
        const finalPost = totalStudentTestsCount ? Math.round(totalClassPostPercentageSum / totalStudentTestsCount) : 0;
        const finalImp = finalPost - finalPre;

        const preVal = document.getElementById("overallPreVal");
        const preFill = document.getElementById("overallPreFill");
        if (preVal) preVal.textContent = `${finalPre}%`;
        if (preFill) preFill.style.width = `${finalPre}%`;

        const postVal = document.getElementById("overallPostVal");
        const postFill = document.getElementById("overallPostFill");
        if (postVal) postVal.textContent = `${finalPost}%`;
        if (postFill) postFill.style.width = `${finalPost}%`;

        const impVal = document.getElementById("overallImpVal");
        const impFill = document.getElementById("overallImpFill");
        if (impVal) impVal.textContent = `${finalImp >= 0 ? "+" : ""}${finalImp}%`;
        if (impFill) impFill.style.width = `${Math.min(100, Math.abs(finalImp))}%`;

        const donutLabel = document.getElementById("donutValue");
        if (donutLabel) donutLabel.textContent = `${finalPost}%`;

        const donutRing = document.getElementById("donutRing");
        if (donutRing) {
          const donutFillAmount = (finalPost / 100) * 289.03;
          donutRing.setAttribute("stroke-dasharray", `${donutFillAmount} 289.03`);
        }
      }

      updateActivitySections(data);
      revealContent("analytics-students");
      if (data.complete) revealContent("analytics-summary");
  }
});
function openReport({ restoredPage = false } = {}) {
  if (!auth.currentUser) return;
  if (lastAnalyticsTerm !== currentTermFilter) {
    lastAnalyticsTerm = currentTermFilter;
    heatmapTopic = "";
    heatmapLessons = [];
    heatmapTopicSelect.value = "";
    heatmapTopicSelect.disabled = true;
    clearHeatmapResults();
    heatmapStatus.textContent = "";
    questionHeatmapScope.textContent = topicCompletionScope.textContent = termLabels[currentTermFilter];
    showTopicsPending();
    activityReport.stop(); activityRequest = ""; activityData = null;
    studentActivityBody.setAttribute("aria-busy", "true");
    studentActivityBody.innerHTML = '<tr class="empty-row"><td colspan="5"><span data-loading="true" role="status" aria-label="Loading student activities"></span></td></tr>';
  }
  if (!restoredPage || !lastReport) setLoadingState(document.getElementById("analyticsReportStatus"), true, "Loading results");
  return report.open({ user: auth.currentUser, termId: currentTermFilter, sectionId: selectedSection === "all" ? "" : selectedSection, restoredPage });
}
onAuthStateChanged(auth, (user, { restored = false } = {}) => {
  if (heatmapOwner !== user?.uid) {
    heatmapOwner = user?.uid;
    clearHeatmapResults();
    heatmapQuestionLoads.clear();
    heatmapLessons = [];
    heatmapTopic = "";
    heatmapTopicSelect.value = "";
    heatmapTopicSelect.disabled = true;
    lastReport = activityData = null;
    activitySection = "";
  }
  if (!user) { activityReport.stop(); activityData = null; window.location.href = "login.html"; return; }
  void openReport({ restoredPage: restored });
});
