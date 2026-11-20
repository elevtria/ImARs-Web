import { matchesSearch, normalizeSearch, personSearchText } from "./search.js";
import { escapeHtml, watchVisibleData } from "./teacher-view.js";
import { initializeApp } from "./firebase-auth.js";
import { setLoadingState, revealContent } from "./loading.js";
import { getAuth, onAuthStateChanged } from "./firebase-auth.js";
import { createTeacherReport } from "./teacher-report-data.js";
import { testRawScore } from "./student-activity-record.js";
import { closeQuizReview, openQuizReview, requestQuizReview } from "./quiz-review.js";
import { scoreOverride } from "./lesson-score.js";
import { openLessonScoreEditor, closeLessonScoreEditor } from "./lesson-score-editor.js";
import { doc, getDoc, setDoc, serverTimestamp } from "./firebase-data.js";
import { createScoreReportOutput, showScoreReport, warmScoreReportResources } from "./score-report-actions.js";
import { installAnalyticsPrint } from "./analytics-print.js";
import { getDocs as getHeatmapQuestions, collection as heatmapCollection, getFirestore as heatmapDatabase, getTeacherReportPage } from "./firebase-data.js";

const scoreElement = id => document.getElementById("score-" + id);
const app = initializeApp();
const auth = getAuth(app);

const search = scoreElement("studentSearch");
const sectionFilter = scoreElement("sectionFilter");
const sectionSummary = scoreElement("sectionSummary");
const studentCount = scoreElement("studentCount");
const studentGrid = document.querySelector("#score-studentGrid tbody");
const editScores = scoreElement("editScores");
const scoreEditStatus = scoreElement("scoreEditStatus");
let editingScores = false;
const printScoreReport = scoreElement("printScoreReport");
const downloadScoreReport = scoreElement("downloadScoreReport");
const scoreReportStatus = scoreElement("scoreReportStatus");
let scoreReportExport;
function cancelScoreReport() {
  scoreReportExport?.controller.abort();
  scoreReportExport = null;
}
window.addEventListener("pagehide", cancelScoreReport);
const studentsPerPage = 25;
let activitySection = "";
const scoreHead = scoreElement("scoreSummaryHead");
const emptyScoreHeader = scoreHead.innerHTML;
let scoreColumnCount = 2;
const quizStatus = scoreElement("teacherQuizStatus");
const quizRetry = scoreElement("teacherQuizRefresh");
let quizPage;
let stopQuizRefresh;
window.addEventListener("pagehide", () => quizPage?.controller.abort());
let currentTermFilter = "term_01";
let lastAnalyticsTerm = currentTermFilter;
let selectedSection = "first", lastReport, tablePage = 0;
let summaryOwner;

const termLabels = {
  term_01: "Term 1",
  term_02: "Term 2",
  term_03: "Term 3"
};

function raw(score, max) {
  return Number.isFinite(score) && Number.isFinite(max) && max > 0 && score >= 0 && score <= max ? score + "/" + max : "—";
}

function lessonCells(data = {}, student, lesson) {
  const pre = testRawScore(data, "pre"), post = testRawScore(data, "post");
  const edited = scoreOverride(data, "activity");
  const activity = edited ? raw(edited.score, edited.maximum) : Object.hasOwn(data, "activityRawMaximum")
    ? raw(data.activityRawScore, data.activityRawMaximum)
    : raw(data.activityScore, data.activityTotalQuestions ?? data.activityTotalPoints);
  return [["activity", "Activity", activity], ["pre", "Pre-test", raw(pre?.score, pre?.total)], ["post", "Post-test", raw(post?.score, post?.total)]].map(([kind, label, value], index) => {
    const content = editingScores
      ? `<button class="score-edit" type="button" data-edit-score="${kind}" data-student="${escapeHtml(student.studentDoc.id)}" data-lesson="${escapeHtml(lesson.id)}" aria-label="${escapeHtml(`Edit ${label.toLowerCase()} score for ${student.name} · ${lesson.title}: ${value}`)}">${value}<span aria-hidden="true"> ✎</span></button>`
      : value;
    return `<td class="${index === 0 ? "score-lesson-start" : ""}" role="cell" data-score-label="${label}">${content}</td>`;
  }).join("");
}

function renderScores(refresh = true) {
  if (!lastReport) return;
  studentGrid.removeAttribute("aria-busy");
  const curriculum = lastReport?.curriculumSnap?.docs || [];
  const lessons = curriculum.map(lesson => {
    const data = lesson.data();
    return { id: lesson.id, title: data.title || data.name || data.topicTitle || lesson.id };
  });
  const section = lastReport?.sections.find(item => item.classDoc.id === activitySection);
  const termId = currentTermFilter;
  const query = normalizeSearch(search.value);
  const students = (section?.students || []).map(row => {
    const student = row.studentDoc.data();
    return { ...row, name: student.displayName || student.fullName || "Student" };
  }).filter(row => matchesSearch(query, personSearchText(row.studentDoc.id, row.studentDoc.data())));
  tablePage = Math.min(tablePage, Math.max(0, Math.ceil(students.length / studentsPerPage) - 1));
  const start = tablePage * studentsPerPage, visible = students.slice(start, start + studentsPerPage);
  editScores.disabled = !lessons.length || !visible.length;
  printScoreReport.disabled = downloadScoreReport.disabled = editScores.disabled || Boolean(scoreReportExport);
  if (refresh) void loadQuizScores(visible.map(row => row.studentDoc.id));
  const quizzes = quizPage?.quizzes || [];
  const quizColumnCount = Math.max(1, quizzes.length);
  const scoreLabels = ["Activity", "Pre-test", "Post-test"];
  scoreColumnCount = 1 + quizColumnCount + lessons.length * scoreLabels.length;
  scoreHead.innerHTML = `<tr role="row"><th class="score-student" scope="col" rowspan="2">Student / Section</th>
    ${lessons.map(lesson => `<th class="score-lesson-start" scope="colgroup" colspan="${scoreLabels.length}">${escapeHtml(lesson.title)}</th>`).join("")}<th class="score-quiz-column" scope="colgroup" colspan="${quizColumnCount}">Quiz</th></tr>
    <tr role="row">${lessons.map(() => scoreLabels.map((label, index) => `<th class="${index === 0 ? "score-lesson-start" : ""}" scope="col">${label}</th>`).join("")).join("")}
    ${quizzes.length ? quizzes.map((quiz, index) => `<th class="score-quiz-title${index === 0 ? " score-quiz-column" : " score-lesson-start"}" scope="col">${escapeHtml(quiz.title || "Quiz")}</th>`).join("") : '<th class="score-quiz-title score-quiz-column" scope="col">Generated quizzes</th>'}</tr>`;
  studentGrid.innerHTML = visible.map(row => {
    const results = new Map((row.results.find(result => result.termId === termId)?.lessonsSnap.docs || []).map(doc => [doc.id, doc.data()]));
    const cells = lessons.map(lesson => lessonCells(results.get(lesson.id), row, lesson)).join("");
    const name = `<th class="score-student" scope="row" role="rowheader">${escapeHtml(row.name)}<span>${escapeHtml(sectionSummary.textContent)}</span></th>`;
    const quizCells = quizzes.map((quiz, index) => {
      const item = quizPage.scores.get(quiz.id)?.get(row.studentDoc.id);
      const score = item?.status === "pending-review" ? "Awaiting grade" : raw(item?.score, item?.maximum);
      const value = item?.attemptId
        ? `<button class="score-review" type="button" data-quiz="${escapeHtml(quiz.id)}" data-student="${escapeHtml(row.studentDoc.id)}" aria-label="${escapeHtml(row.name)} · ${escapeHtml(quiz.title || "Quiz")} · ${score}. Open submission">${score}</button>`
        : score;
      return `<td class="${index === 0 ? "score-quiz-column" : "score-lesson-start"}" role="cell">${value}</td>`;
    });
    return `<tr class="student-row" role="row">${name}${cells}${quizCells.join("") || '<td class="score-quiz-column" role="cell">—</td>'}</tr>`;
  }).join("") || `<tr class="empty-row"><td colspan="${scoreColumnCount}">${query ? "No students match that search." : "No students in this section."}</td></tr>`;
  scoreElement("analyticsPageStatus").textContent = students.length
    ? `Showing ${start + 1}–${start + visible.length} of ${students.length} students${lastReport?.complete === false ? " loaded" : ""}` : "0 students";
  scoreElement("analyticsPrevious").disabled = tablePage === 0;
  scoreElement("analyticsNext").disabled = start + visible.length >= students.length;
}

async function exportScoreReport() {
  const user = auth.currentUser;
  if (!user || !activitySection || !lastReport || scoreReportExport) return;
  const controller = new AbortController(), task = { controller };
  scoreReportExport = task;
  printScoreReport.disabled = downloadScoreReport.disabled = true;
  scoreReportStatus.textContent = "Preparing the complete section report…";
  const termId = currentTermFilter, sectionId = activitySection;
  try {
    const output = await createScoreReportOutput({ mode: "download", termId, sectionId, search: search.value,
      teacherName: user.displayName || lastReport.teacherName || "Signed-in teacher", signal: controller.signal,
      onStage: message => { if (scoreReportExport === task) scoreReportStatus.textContent = message; },
      onProgress: count => { if (scoreReportExport === task) scoreReportStatus.textContent = `Preparing report: ${count} students loaded…`; }
    }, {
      fetchPage: options => getTeacherReportPage(options, { signal: controller.signal }),
      fetchQuizzes: studentIds => requestQuizReview(user.uid, { action: "term-results", termId, sectionId, studentIds }, controller.signal),
      fetchSchoolYear: async () => (await getDoc(doc(heatmapDatabase(app), "webSettings", "schoolYear"))).data()?.startYear
    });
    controller.signal.throwIfAborted();
    if (auth.currentUser?.uid !== user.uid || currentTermFilter !== termId || activitySection !== sectionId) return;
    await showScoreReport(output, { mode: "download", signal: controller.signal });
    scoreReportStatus.textContent = `${output.students} students · ${output.pageCount} pages. PDF downloaded.`;
  } catch (error) {
    if (scoreReportExport === task && !controller.signal.aborted) scoreReportStatus.textContent = error.message || "Could not prepare the report. Please try again.";
  } finally {
    if (scoreReportExport === task) {
      scoreReportExport = null;
      printScoreReport.disabled = downloadScoreReport.disabled = editScores.disabled;
    }
  }
}
const printAnalytics = installAnalyticsPrint({
  available: () => Boolean(auth.currentUser && lastReport && !printScoreReport.disabled),
  notify: message => { scoreReportStatus.textContent = message; },
  readView: () => ({ table: scoreElement("studentGrid"), section: sectionSummary.textContent,
    term: termLabels[currentTermFilter], schoolYear: document.querySelector("[data-school-year]")?.textContent || "",
    teacher: auth.currentUser.displayName || lastReport.teacherName || "Signed-in teacher",
    scope: scoreElement("analyticsPageStatus").textContent,
    generatedLabel: new Intl.DateTimeFormat("en-PH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Taipei" }).format(new Date()) })
});
printScoreReport.addEventListener("click", printAnalytics);
downloadScoreReport.addEventListener("click", () => { void exportScoreReport(); });
downloadScoreReport.addEventListener("mouseenter", warmScoreReportResources);
downloadScoreReport.addEventListener("focus", warmScoreReportResources);

editScores.addEventListener("click", () => {
  editingScores = !editingScores;
  editScores.setAttribute("aria-pressed", String(editingScores));
  editScores.textContent = editingScores ? "Done editing" : "Edit scores";
  scoreEditStatus.textContent = editingScores ? "Choose a score to edit, including a dash to add a missing score." : "";
  renderScores(false);
});
function editLessonScore(event) {
  const button = event.target.closest("button[data-edit-score]");
  const user = auth.currentUser;
  if (!button || !editingScores || !user || !lastReport) return;
  const kind = button.dataset.editScore, termId = currentTermFilter, sectionId = activitySection;
  const row = lastReport.sections.find(section => section.classDoc.id === sectionId)?.students.find(row => row.studentDoc.id === button.dataset.student);
  const lesson = lastReport.curriculumSnap?.docs.find(lesson => lesson.id === button.dataset.lesson);
  if (!row || !lesson) return;
  const result = row.results.find(result => result.termId === termId)?.lessonsSnap.docs.find(doc => doc.id === lesson.id)?.data() || {};
  const edited = scoreOverride(result, kind);
  const test = kind === "activity" ? null : testRawScore(result, kind);
  const score = edited?.score ?? (test ? test.score : kind === "activity" ? (Object.hasOwn(result, "activityRawMaximum") ? result.activityRawScore : result.activityScore) : null);
  const maximum = edited?.maximum ?? (kind === "pre" ? 5 : kind === "post" ? 10 : Object.hasOwn(result, "activityRawMaximum") ? result.activityRawMaximum : result.activityTotalQuestions ?? result.activityTotalPoints);
  const details = row.studentDoc.data(), topic = lesson.data();
  const current = () => auth.currentUser?.uid === user.uid && currentTermFilter === termId && activitySection === sectionId;
  openLessonScoreEditor({ kind, studentName: details.displayName || details.fullName || "Student", lessonTitle: topic.title || topic.name || lesson.id,
    score, maximum,
    onSave: async value => {
      if (!current()) throw new Error("The selected class or sign-in changed. Reopen the score to try again.");
      await setDoc(doc(heatmapDatabase(app), "users", row.studentDoc.id, "test_results", termId, "lessons", lesson.id), {
        lessonId: lesson.id, timestamp: serverTimestamp(), teacherScoreOverrides: { [kind]: value }
      }, { merge: true });
    },
    onSaved: () => {
      if (!current()) return;
      scoreEditStatus.textContent = "Score saved.";
      void openReport({ refresh: true });
    }
  });
}

function resetQuizScores() {
  stopQuizRefresh?.();
  stopQuizRefresh = undefined;
  quizPage?.controller.abort();
  quizPage = undefined;
  closeQuizReview();
  quizStatus.textContent = "";
  quizRetry.hidden = true;
}

async function loadQuizScores(studentIds, force = false) {
  const user = auth.currentUser;
  if (!activitySection || !user) return;
  stopQuizRefresh ||= watchVisibleData(app, user, () => {
    if (quizPage && !quizPage.loading) return loadQuizScores(quizPage.studentIds, true);
  }, 60_000, true);
  const key = JSON.stringify([user.uid, currentTermFilter, activitySection, studentIds]);
  const old = quizPage;
  if (!force && old?.key === key && !old.controller.signal.aborted && Date.now() - old.checkedAt < 300_000) return;
  old?.controller.abort();
  const page = { key, studentIds, checkedAt: Date.now(), loading: true, controller: new AbortController(),
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
  } finally { page.loading = false; }
}

quizRetry.addEventListener("click", () => { if (quizPage) void loadQuizScores(quizPage.studentIds, true); });
studentGrid.addEventListener("click", event => {
  if (event.target.closest("button[data-edit-score]")) { editLessonScore(event); return; }
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
scoreElement("analyticsPrevious").addEventListener("click", () => { if (tablePage > 0) { tablePage--; renderScores(); } });
scoreElement("analyticsNext").addEventListener("click", () => { tablePage++; renderScores(); });

const termButtons = document.querySelectorAll("#studentScoreSummary .term-tab-btn");
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
    const status = scoreElement("analyticsReportStatus");
    setLoadingState(status, !complete, total === null ? "Updating results" : `Results: ${loaded} of ${total} students`);
    status.textContent = "";
    scoreElement("analyticsTermLabel").textContent = termLabels[termId];
  },
  failed: error => {
    console.error("Analytics update failed:", error);
    const status = scoreElement("analyticsReportStatus");
    setLoadingState(status, false);
    if (lastReport) status.textContent = "Could not update results. Retrying automatically.";
    else {
      studentGrid.removeAttribute("aria-busy");
      studentGrid.innerHTML = `<tr class="empty-row"><td colspan="${scoreColumnCount}">Could not load scores. Retrying automatically.</td></tr>`;
    }
  },
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
    const sync = scoreElement("activitySyncStatus");
    sync.hidden = !data.activitySyncPending;
    sync.textContent = data.activitySyncPending ? "Recent submissions from older app versions could not be checked." : "";
    renderScores();
    revealContent("student-score-summary");
  }
});
function openReport({ restoredPage = false, refresh = false } = {}) {
  cancelScoreReport();
  scoreReportStatus.textContent = "";
  closeLessonScoreEditor();
  if (!auth.currentUser) return;
  const termChanged = lastAnalyticsTerm !== currentTermFilter;
  if (termChanged) {
    lastAnalyticsTerm = currentTermFilter;
  }
  if (lastReport && (lastReport.termId !== currentTermFilter || (selectedSection !== "first" && selectedSection !== activitySection))) {
    lastReport = null; activitySection = "";
    resetQuizScores();
  }
  if (!lastReport) {
    editScores.disabled = true;
    printScoreReport.disabled = downloadScoreReport.disabled = true;
    sectionFilter.disabled = true;
    if (termChanged) {
      scoreHead.innerHTML = emptyScoreHeader;
      scoreColumnCount = 2;
    }
    studentCount.textContent = "—";
    studentGrid.setAttribute("aria-busy", "true");
    studentGrid.innerHTML = `<tr class="empty-row"><td colspan="${scoreColumnCount}"><span data-loading="true" role="status" aria-label="Loading scores"></span></td></tr>`;
    scoreElement("analyticsPrevious").disabled = true;
    scoreElement("analyticsNext").disabled = true;
    scoreElement("analyticsPageStatus").textContent = "";
  }
  if (!lastReport) {
    const status = scoreElement("analyticsReportStatus");
    setLoadingState(status, false);
    status.textContent = "";
  }
  return report.open({ user: auth.currentUser, termId: currentTermFilter, sectionId: selectedSection, rawActivityScores: true, restoredPage,
    refresh });
}
onAuthStateChanged(auth, (user, { restored = false } = {}) => {
  if (summaryOwner !== user?.uid) {
    cancelScoreReport();
    scoreReportStatus.textContent = "";
    closeLessonScoreEditor();
    editingScores = false;
    editScores.setAttribute("aria-pressed", "false");
    editScores.textContent = "Edit scores";
    scoreEditStatus.textContent = "";
    summaryOwner = user?.uid;
    lastReport = null;
    selectedSection = "first"; tablePage = 0;
    resetQuizScores();
    activitySection = "";
    scoreHead.innerHTML = emptyScoreHeader;
    scoreColumnCount = 2;
    studentGrid.replaceChildren();
  }
  if (!user) { report.stop(); window.location.href = "login.html"; return; }
  if (!document.getElementById("studentScoreSummary").hidden) void openReport({ restoredPage: restored });
});

window.addEventListener("imars-score-summary-view", () => {
  if (document.getElementById("studentScoreSummary").hidden) { report.stop(); stopQuizRefresh?.(); stopQuizRefresh = undefined; closeQuizReview(); closeLessonScoreEditor(); }
  else if (auth.currentUser) void openReport({ restoredPage: true });
});
