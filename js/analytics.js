import { initializeApp, getAuth, onAuthStateChanged } from "./firebase-auth.js";
import { escapeHtml, watchVisibleData } from "./teacher-view.js";
import { createTeacherReport } from "./teacher-report-data.js";
import { setLoadingState, revealContent } from "./loading.js";
import { buildPostTestHeatmap } from "./post-test-heatmap.js";
import { buildStudentActivityRecords } from "./student-activity-record.js";
import { buildAnalyticsOverview } from "./analytics-overview.js";
import { requestQuizReview } from "./quiz-review.js";
import { getDocs as getHeatmapQuestions, collection as heatmapCollection, getFirestore as heatmapDatabase, getTeacherReportPage } from "./firebase-data.js";
const app = initializeApp(), auth = getAuth(app);
const sectionFilter = document.getElementById('sectionFilter');
const sectionSummary = document.getElementById('sectionSummary');
const studentCount = document.getElementById('studentCount');
const topicsContainer = document.getElementById('topicsContainer');
const questionHeatmapScope = document.getElementById('questionHeatmapScope');
const topicCompletionScope = document.getElementById('topicCompletionScope');
const heatmapTopicSelect = document.getElementById('heatmapTopicFilter');
const heatmapRows = document.getElementById('questionHeatmapRows');
const heatmapStatus = document.getElementById('questionHeatmapStatus');
const heatmapMore = document.getElementById('heatmapMore');
let heatmapTopic = '', heatmapLessons = [], heatmapPage, heatmapOwner;
const heatmapQuestionLoads = new Map();
const termLabels = {term_01:'Term 1',term_02:'Term 2',term_03:'Term 3'};
let currentTermFilter = 'term_01', selectedSection = 'first', activitySection = '', lastReport, supportLimit = 10;
let quizSummary, quizRequest, quizRequestKey, stopQuizUpdates;
const quizCache = new Map();

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


const percent = value => value === null ? '—' : Math.round(value) + '%';
const minutes = value => value === null ? 'Not recorded' : Math.round(value * 10) / 10 + ' min';
function renderOverview() {
  if (!lastReport) return;
  const overview = buildAnalyticsOverview(lastReport, activitySection, currentTermFilter);
  const quizzes = quizSummary;
  const metrics = [['Students', String(lastReport.total ?? overview.students)], ['Completed assessments', overview.assessments + '/' + overview.possibleAssessments],
    ['Average pre-test', percent(overview.pre)], ['Average post-test', percent(overview.post)],
    ['Change in paired scores', overview.change === null ? '—' : (overview.change > 0 ? '+' : '') + Math.round(overview.change) + ' pp'],
    ['Awaiting grading', quizzes ? String(quizzes.items.reduce((sum, row) => sum + row.awaitingGrade, 0)) : '—']];
  document.getElementById('analyticsMetrics').innerHTML = metrics.map(([label, value]) => '<article class="card analytics-metric"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + '</strong></article>').join('');
  document.getElementById('analyticsCoverage').textContent = (lastReport.complete ? 'Results for ' : 'Updating results: ') + overview.students + ' students loaded. ' +
    (quizzes ? quizzes.items.reduce((sum, row) => sum + row.submitted, 0) + '/' + (quizzes.learners * quizzes.quizCount) + ' generated-quiz submissions. ' : '') +
    'Missing assessments are excluded from averages. pp = percentage points.';
  document.getElementById('lessonComparison').innerHTML = overview.lessons.map(row => '<article class="analytics-lesson"><h3>' + escapeHtml(row.title) + '</h3>' +
    [['Pre-test', row.pre, row.preCount], ['Post-test', row.post, row.postCount]].map(([label, value, count]) => '<div class="analytics-bar-row"><span>' + label + '</span><div class="analytics-bar"><i style="width:' + (value ?? 0) + '%"></i></div><strong>' + percent(value) + '</strong><small>' + count + ' recorded</small></div>').join('') +
    '<p class="scheduler-progress-copy">Paired change: ' + (row.change === null ? '—' : (row.change > 0 ? '+' : '') + Math.round(row.change) + ' pp') + ' · ' + row.pairs + ' paired results</p></article>').join('') || '<p>No lesson records are available for this term.</p>';
  document.getElementById('learningTimeOverview').innerHTML = overview.lessons.map(row => '<article class="analytics-time-row"><strong>' + escapeHtml(row.title) + '</strong><span>AR average: ' + minutes(row.ar) + ' (' + row.arCount + ' recorded)</span><span>Module average: ' + minutes(row.module) + ' (' + row.moduleCount + ' recorded)</span></article>').join('') || '<p>No recorded learning time is available.</p>';
  document.getElementById('supportStudents').innerHTML = overview.support.slice(0, supportLimit).map(row => '<article class="analytics-time-row"><a href="student-records.html?student=' + encodeURIComponent(row.id) + '">' + escapeHtml(row.name) + '</a><span>' + row.lessons.map(lesson => escapeHtml(lesson.title) + ': ' + lesson.score + '/' + lesson.maximum).join(' · ') + '</span></article>').join('') || '<p>' + (lastReport.complete ? 'No completed post-test results fall below the 60% review threshold.' : 'No students flagged in the results loaded so far.') + '</p>';
  document.getElementById('supportMore').hidden = overview.support.length <= supportLimit;
}
async function loadQuizSummary() {
  const user = auth.currentUser, sectionId = activitySection, termId = currentTermFilter;
  if (!user || !sectionId) return;
  const key = JSON.stringify([user.uid, sectionId, termId]);
  const saved = quizCache.get(key);
  quizSummary = saved?.data;
  renderOverview();
  if (saved && Date.now() - saved.at < 300000) return;
  if (quizRequestKey === key && quizRequest && !quizRequest.signal.aborted) return;
  quizRequest?.abort();
  quizRequestKey = key;
  const request = quizRequest = new AbortController();
  try {
    const result = await requestQuizReview(user.uid, { action: 'grading-summary', sectionId, termId }, request.signal);
    if (request.signal.aborted || activitySection !== sectionId || currentTermFilter !== termId || auth.currentUser?.uid !== user.uid) return;
    quizSummary = result; quizCache.set(key, {data:result, at:Date.now()}); renderOverview();
  } catch {
    if (!request.signal.aborted) document.getElementById('analyticsReportStatus').textContent = 'Quiz submission counts could not update. Lesson results remain available.';
  } finally { if (quizRequest === request) quizRequestKey = undefined; }
}
document.getElementById('supportMore').addEventListener('click', () => { supportLimit += 10; renderOverview(); });
const report = createTeacherReport({ app,
  progress: ({ loaded, total, complete }) => {
    const status = document.getElementById('analyticsReportStatus');
    setLoadingState(status, !complete, 'Results: ' + loaded + ' of ' + (total ?? 'available') + ' students');
    if (complete) status.textContent = '';
  },
  failed: () => {
    const status = document.getElementById('analyticsReportStatus'); setLoadingState(status, false);
    status.textContent = 'Could not update results. Retrying automatically.';
  },
  render: data => {
    if (data.termId !== currentTermFilter) return;
    const section = data.sections.find(row => selectedSection === 'first' || row.classDoc.id === selectedSection);
    if (!section && data.classes.length && selectedSection !== 'first') { selectedSection = 'first'; void openReport(); return; }
    const scopeChanged = lastReport?.termId !== data.termId || activitySection !== (section?.classDoc.id || '');
    lastReport = data; activitySection = section?.classDoc.id || '';
    if (scopeChanged) showTopicsPending();
    const options = data.classes.map(row => '<option value="' + escapeHtml(row.id) + '">' + escapeHtml(row.data().SectionName || row.data().sectionName || row.id) + '</option>').join('');
    if (sectionFilter.innerHTML !== options) sectionFilter.innerHTML = options;
    sectionFilter.value = activitySection; sectionFilter.disabled = !activitySection;
    sectionSummary.textContent = section?.classDoc.data().SectionName || 'No section';
    studentCount.textContent = data.total ?? data.loaded;
    document.getElementById('analyticsTermLabel').textContent = termLabels[currentTermFilter];
    questionHeatmapScope.textContent = topicCompletionScope.textContent = termLabels[currentTermFilter] + ' · ' + sectionSummary.textContent;
    renderOverview(); void loadQuizSummary();
    if (!section) renderTopics([], 'No sections are assigned to your account.');
    else if (data.complete && data.curriculumSnap) renderTopics(buildStudentActivityRecords([data.curriculumSnap], [section], termLabels, [data.termId]));
    updateHeatmap(); revealContent('analytics-students');
  }
});
function openReport({ restoredPage = false } = {}) {
  if (!auth.currentUser) return;
  quizRequest?.abort(); quizSummary = undefined; supportLimit = 10;
  heatmapTopic = ''; heatmapLessons = []; heatmapTopicSelect.value = ''; heatmapTopicSelect.disabled = true; clearHeatmapResults();
  return report.open({ user:auth.currentUser, termId:currentTermFilter, sectionId:selectedSection, rawActivityScores:true, restoredPage });
}
sectionFilter.addEventListener('change', () => {
  if (!lastReport?.classes.some(row => row.id === sectionFilter.value)) return;
  selectedSection = sectionFilter.value; return openReport();
});
const termButtons = document.querySelectorAll('#termSwitch .term-tab-btn');
termButtons.forEach(button => button.addEventListener('click', () => {
  if (currentTermFilter === button.dataset.term) return;
  currentTermFilter = button.dataset.term;
  termButtons.forEach(tab => tab.setAttribute('aria-pressed', String(tab === button)));
  return openReport();
}));
onAuthStateChanged(auth, (user, { restored = false } = {}) => {
  stopQuizUpdates?.();
  if (heatmapOwner !== user?.uid) {
    quizRequest?.abort(); quizCache.clear(); quizSummary = undefined; lastReport = null;
    heatmapOwner = user?.uid; heatmapQuestionLoads.clear(); clearHeatmapResults(); selectedSection = 'first'; activitySection = '';
    document.querySelectorAll('#analyticsMetrics strong').forEach(value => { value.textContent = '—'; });
    for (const id of ['lessonComparison','learningTimeOverview','supportStudents','topicsContainer']) document.getElementById(id).replaceChildren();
  }
  if (!user) { report.stop(); window.location.href = 'login.html'; return; }
  stopQuizUpdates = watchVisibleData(app, user, loadQuizSummary, 300000);
  void openReport({ restoredPage:restored });
});
window.addEventListener('pagehide', () => quizRequest?.abort());
