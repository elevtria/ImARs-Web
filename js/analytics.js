import { escapeHtml } from "./teacher-view.js";
import { initializeApp } from "./firebase-auth.js";
import { setLoadingState, revealContent } from "./loading.js";
import { getAuth, onAuthStateChanged } from "./firebase-auth.js";
import { createTeacherReport } from "./teacher-report-data.js";
import { buildStudentActivityRecords, testRawScore } from "./student-activity-record.js";
import { buildPostTestHeatmap } from "./post-test-heatmap.js";
import { closeQuizReview, openQuizReview, requestQuizReview } from "./quiz-review.js";
import { getDocs as getHeatmapQuestions, collection as heatmapCollection, getFirestore as heatmapDatabase, getTeacherReportPage } from "./firebase-data.js";

const app = initializeApp();
const auth = getAuth(app);

const search = document.getElementById("studentSearch");
const sectionFilter = document.getElementById("sectionFilter");
const sectionSummary = document.getElementById("sectionSummary");
const studentCount = document.getElementById("studentCount");
const studentGrid = document.querySelector("#studentGrid tbody");
const topicsContainer = document.getElementById("topicsContainer");
const questionHeatmapScope = document.getElementById("questionHeatmapScope");
const topicCompletionScope = document.getElementById("topicCompletionScope");
const studentsPerPage = 25;
let activitySection = "";
const scoreHead = document.getElementById("scoreSummaryHead");
const quizStatus = document.getElementById("teacherQuizStatus");
const quizRetry = document.getElementById("teacherQuizRefresh");
let quizPage;
const collapsedQuizGroups = new Set();
window.addEventListener("pagehide", () => quizPage?.controller.abort());
let currentTermFilter = "term_01";
let lastAnalyticsTerm = currentTermFilter;
let selectedSection = "first", lastReport, tablePage = 0;
const heatmapTopicSelect = document.getElementById("heatmapTopicFilter");
const heatmapRows = document.getElementById("questionHeatmapRows");
const heatmapStatus = document.getElementById("questionHeatmapStatus");
const heatmapMore = document.getElementById("heatmapMore");
let heatmapTopic = "", heatmapLessons = [], heatmapPage, heatmapOwner;
const heatmapQuestionLoads = new Map();

const termLabels = {
  term_01: "Term 1",
  term_02: "Term 2",
  term_03: "Term 3"
};

function renderQuestionHeatmap(result, partial = false) {
  setLoadingState(heatmapStatus, false);
  heatmapRows.removeAttribute("aria-busy");
  heatmapMore.hidden = !partial;
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
  const report = lastReport?.termId === term ? lastReport : null;
  const saved = report?.curriculumSnap;
  if (!heatmapQuestionLoads.has(key)) {
    const hasLabels = saved?.docs?.some(lesson => Array.isArray(lesson.data().postTest));
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
    if (!heatmapTopic && choices.length > 0) {
      heatmapTopic = choices[0].id;
    }
    heatmapTopicSelect.value = heatmapTopic;
    heatmapTopicSelect.disabled = !choices.length;
    if (!heatmapTopic) {
      heatmapStatus.textContent = choices.length ? "Choose a topic to view post-test results." : "No topics are available for this term.";
    } else {
      void openQuestionHeatmap();
    }
  } catch {
    heatmapQuestionLoads.delete(key);
    if (auth.currentUser?.uid === uid && currentTermFilter === term && activitySection) heatmapStatus.textContent = "Could not load topics. Try choosing the term again.";
  }
}

async function openQuestionHeatmap(loadMore = false) {
  const uid = auth.currentUser?.uid, termId = currentTermFilter, sectionId = activitySection;
  const selected = heatmapLessons.find(item => item.id === heatmapTopic);
  if (!uid || !sectionId || !selected) return;
  const report = lastReport?.termId === termId &&
    lastReport.sections.some(section => section.classDoc.id === sectionId) ? lastReport : null;
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
  else if (heatmapTopic) void openQuestionHeatmap();
}

heatmapTopicSelect?.addEventListener("change", () => {
  heatmapTopic = heatmapTopicSelect.value;
  clearHeatmapResults();
  if (!heatmapTopic) { heatmapStatus.textContent = "Choose a topic to view post-test results."; return; }
  return openQuestionHeatmap();
});
heatmapMore?.addEventListener("click", () => openQuestionHeatmap(true));

function raw(score, max) {
  return Number.isFinite(score) && Number.isFinite(max) && max > 0 && score >= 0 && score <= max ? score + "/" + max : "—";
}

function lessonCells(data = {}) {
  const pre = testRawScore(data, "pre"), post = testRawScore(data, "post");
  const activity = Object.hasOwn(data, "activityRawMaximum")
    ? raw(data.activityRawScore, data.activityRawMaximum)
    : raw(data.activityScore, data.activityTotalQuestions ?? data.activityTotalPoints);
  const gain = pre && post ? post.score - pre.score : null;
  return `<td class="score-lesson-start" role="cell" data-score-label="Activity">${activity}</td><td role="cell" data-score-label="Pre-test">${raw(pre?.score, pre?.total)}</td><td role="cell" data-score-label="Post-test">${raw(post?.score, post?.total)}</td><td role="cell" data-score-label="Improvement">${gain === null ? "—" : (gain > 0 ? "+" : "") + gain}</td>`;
}

function renderScores(refresh = true) {
  const curriculum = lastReport?.curriculumSnap?.docs || [];
  const lessons = curriculum.map(lesson => {
    const data = lesson.data();
    return { id: lesson.id, title: data.title || data.name || data.topicTitle || lesson.id };
  });
  const section = lastReport?.sections.find(item => item.classDoc.id === activitySection);
  const termId = currentTermFilter;
  const query = search.value.trim().toLowerCase();
  const students = (section?.students || []).map(row => {
    const student = row.studentDoc.data();
    return { ...row, name: student.displayName || student.fullName || "Student" };
  }).filter(row => row.name.toLowerCase().includes(query));
  tablePage = Math.min(tablePage, Math.max(0, Math.ceil(students.length / studentsPerPage) - 1));
  const start = tablePage * studentsPerPage, visible = students.slice(start, start + studentsPerPage);
  if (refresh) void loadQuizScores(visible.map(row => row.studentDoc.id));
  const quizzes = quizPage?.quizzes || [];
  const scoreLabels = ["Activity", "Pre-test", "Post-test", "Improvement"];
  scoreHead.innerHTML = `<tr role="row"><th class="score-student" scope="col" rowspan="2">Student / Section</th>
    ${lessons.map(lesson => `<th class="score-lesson-start" scope="colgroup" colspan="4">${escapeHtml(lesson.title)}</th>`).join("")}<th class="score-quiz-column" scope="col">Quiz</th></tr>
    <tr role="row">${lessons.map(() => scoreLabels.map((label, index) => `<th class="${index === 0 ? "score-lesson-start" : ""}" scope="col">${label}</th>`).join("")).join("")}<th class="score-quiz-column" scope="col">Generated quizzes</th></tr>`;
  studentGrid.innerHTML = visible.map(row => {
    const results = new Map((row.results.find(result => result.termId === termId)?.lessonsSnap.docs || []).map(doc => [doc.id, doc.data()]));
    const cells = lessons.map(lesson => lessonCells(results.get(lesson.id))).join("");
    const name = `<th class="score-student" scope="row" role="rowheader">${escapeHtml(row.name)}<span>${escapeHtml(sectionSummary.textContent)}</span></th>`;
    const quizRows = quizzes.map(quiz => {
      const item = quizPage.scores.get(quiz.id)?.get(row.studentDoc.id);
      const score = item?.status === "pending-review" ? "Awaiting grade" : raw(item?.score, item?.maximum);
      const value = item?.attemptId
        ? `<button class="score-review" type="button" data-quiz="${escapeHtml(quiz.id)}" data-student="${escapeHtml(row.studentDoc.id)}" aria-label="${escapeHtml(row.name)} · ${escapeHtml(quiz.title || "Quiz")} · ${score}. Open submission">${score}</button>`
        : score;
      return `<div><dt>${escapeHtml(quiz.title || "Quiz")}</dt><dd>${value}</dd></div>`;
    });
    const quiz = quizRows.length ? `<details class="score-quiz-group" data-quiz-group="${escapeHtml(row.studentDoc.id)}"${collapsedQuizGroups.has(row.studentDoc.id) ? "" : " open"}><summary>View quizzes</summary><dl class="score-values">${quizRows.join("")}</dl></details>` : "—";
    return `<tr class="student-row" role="row">${name}${cells}<td class="score-quiz-column" role="cell">${quiz}</td></tr>`;
  }).join("") || `<tr class="empty-row"><td colspan="${2 + lessons.length * 4}">${query ? "No students match that search." : "No students in this section."}</td></tr>`;
  document.getElementById("analyticsPageStatus").textContent = students.length
    ? `Showing ${start + 1}–${start + visible.length} of ${students.length} students${lastReport?.complete === false ? " loaded" : ""}` : "0 students";
  document.getElementById("analyticsPrevious").disabled = tablePage === 0;
  document.getElementById("analyticsNext").disabled = start + visible.length >= students.length;
}

function resetQuizScores() {
  collapsedQuizGroups.clear();
  quizPage?.controller.abort();
  quizPage = undefined;
  closeQuizReview();
  quizStatus.textContent = "";
  quizRetry.hidden = true;
}

async function loadQuizScores(studentIds, force = false) {
  const user = auth.currentUser;
  if (!activitySection || !user) return;
  const key = JSON.stringify([user.uid, currentTermFilter, activitySection, studentIds]);
  const old = quizPage;
  if (!force && old?.key === key && Date.now() - old.checkedAt < 300_000) return;
  old?.controller.abort();
  const page = { key, studentIds, checkedAt: Date.now(), controller: new AbortController(),
    quizzes: old?.quizzes || [], scores: old?.scores || new Map() };
  quizPage = page;
  quizRetry.hidden = true;
  quizStatus.textContent = page.quizzes.length ? "" : "Loading quiz scores…";
  try {
    const response = await requestQuizReview(user.uid, { action: "term-results", termId: currentTermFilter, sectionId: activitySection, studentIds }, page.controller.signal);
    if (quizPage !== page) return;
    page.quizzes = response.quizzes;
    page.scores = new Map(response.quizzes.map(quiz => [quiz.id, new Map()]));
    for (const item of response.items) page.scores.get(item.quizId)?.set(item.studentId, item);
    quizStatus.textContent = response.quizzes.length ? "" : "No quizzes assigned to this term and section. Set a quiz’s term in My quizzes.";
    renderScores(false);
  } catch {
    if (quizPage !== page || page.controller.signal.aborted) return;
    quizStatus.textContent = "Could not load quiz scores.";
    quizRetry.hidden = false;
  }
}

quizRetry.addEventListener("click", () => { if (quizPage) void loadQuizScores(quizPage.studentIds, true); });
studentGrid.addEventListener("toggle", event => {
  const group = event.target;
  const studentId = group.dataset.quizGroup;
  if (!studentId || !group.isConnected) return;
  if (group.open) collapsedQuizGroups.delete(studentId);
  else collapsedQuizGroups.add(studentId);
}, true);
studentGrid.addEventListener("click", event => {
  const button = event.target.closest("button[data-quiz]");
  const page = quizPage, user = auth.currentUser;
  if (!button || !page || !user) return;
  const quiz = page.quizzes.find(item => item.id === button.dataset.quiz);
  const submission = page.scores.get(quiz?.id)?.get(button.dataset.student);
  if (!submission?.attemptId) return;
  const section = { id: activitySection, label: sectionSummary.textContent, name: sectionSummary.textContent };
  const student = lastReport?.sections.find(row => row.classDoc.id === section.id)?.students.find(row => row.studentDoc.id === submission.studentId)?.studentDoc.data();
  void openQuizReview(user, quiz, [section], section.id, { submission: { ...submission, name: student?.displayName || student?.fullName }, onReviewed: grade => {
    if (quizPage !== page) return;
    Object.assign(submission, { score: grade.score, maximum: grade.maximum, status: "reviewed" });
    renderScores(false);
  } });
});
search.addEventListener("input", () => { tablePage = 0; renderScores(); });
sectionFilter.addEventListener("change", () => {
  if (!lastReport?.classes.some(item => item.id === sectionFilter.value)) return;
  selectedSection = sectionFilter.value;
  tablePage = 0;
  return openReport();
});
document.getElementById("analyticsPrevious").addEventListener("click", () => { if (tablePage > 0) { tablePage--; renderScores(); } });
document.getElementById("analyticsNext").addEventListener("click", () => { tablePage++; renderScores(); });

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
    const section = data.sections.find(row => selectedSection === "first" || row.classDoc.id === selectedSection);
    if (!section && data.classes.some(row => row.id === selectedSection)) return;
    if (!section && data.classes.length && selectedSection !== "first") {
      selectedSection = "first";
      return openReport();
    }
    lastReport = data;
    const nextSection = section?.classDoc.id || "";
    if (activitySection && activitySection !== nextSection) resetQuizScores();
    activitySection = nextSection;
    const options = data.classes.map(row => {
      const option = document.createElement("option"), info = row.data();
      option.value = row.id;
      option.textContent = info.SectionName || info.sectionName || info.name || row.id;
      return option;
    });
    const signature = JSON.stringify(options.map(option => [option.value, option.textContent]));
    if (sectionFilter.dataset.sections !== signature) {
      sectionFilter.replaceChildren(...options);
      sectionFilter.dataset.sections = signature;
    }
    sectionFilter.value = activitySection;
    sectionFilter.disabled = !activitySection;
    sectionSummary.textContent = options.find(option => option.value === activitySection)?.textContent || "No section";
    studentCount.textContent = data.total ?? "—";
    const sync = document.getElementById("activitySyncStatus");
    sync.hidden = !data.activitySyncPending;
    sync.textContent = data.activitySyncPending ? "Recent submissions from older app versions could not be checked." : "";
    renderScores();
    const scope = activitySection ? termLabels[currentTermFilter] + " · " + sectionSummary.textContent : termLabels[currentTermFilter];
    questionHeatmapScope.textContent = topicCompletionScope.textContent = scope;
    if (!section) renderTopics([], "No sections are assigned to your account.");
    else if (data.complete && data.curriculumSnap) renderTopics(buildStudentActivityRecords([data.curriculumSnap], [section], termLabels, [data.termId]));
    updateHeatmap();
    revealContent("analytics-students");
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
  }
  if (lastReport && (lastReport.termId !== currentTermFilter || (selectedSection !== "first" && selectedSection !== activitySection))) {
    lastReport = null; activitySection = "";
    resetQuizScores(); clearHeatmapResults(); showTopicsPending();
    scoreHead.replaceChildren(); studentGrid.replaceChildren();
  }
  if (!lastReport) {
    sectionFilter.disabled = true;
    studentCount.textContent = "—";
  }
  if (!restoredPage || !lastReport) setLoadingState(document.getElementById("analyticsReportStatus"), true, "Loading results");
  return report.open({ user: auth.currentUser, termId: currentTermFilter, sectionId: selectedSection, rawActivityScores: true, restoredPage });
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
    lastReport = null;
    selectedSection = "first"; tablePage = 0;
    resetQuizScores();
    activitySection = "";
    scoreHead.replaceChildren();
    studentGrid.replaceChildren();
  }
  if (!user) { report.stop(); window.location.href = "login.html"; return; }
  void openReport({ restoredPage: restored });
});
