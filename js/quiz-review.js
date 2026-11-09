import { setLoadingState } from "./loading.js";
import { getAuth, onAuthStateChanged } from "./firebase-auth.js";
import { collection, getDocs, getFirestore, query, where } from "./firebase-data.js";
import { quizAssignedToSection, quizAssignmentScope, writtenQuestion } from "./quiz-limits.js";
import { createQuizResultsTable, quizScoreLabel } from "./quiz-results-table.js";

let dialog, controller, generation = 0;
export function closeQuizReview() {
  generation++; controller?.abort(); controller = null;
  dialog?.close(); dialog?.remove(); dialog = null;
}
window.addEventListener("pagehide", closeQuizReview);
const element = (tag, text, className) => { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; };
export async function requestQuizReview(uid, body, signal) {
  const response = await fetch("/api/quiz-review/action", { method: "POST", credentials: "same-origin", cache: "no-store",
    headers: { "Content-Type": "application/json", "X-Web-User": uid }, body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
  if (!response.headers.get("Content-Type")?.includes("application/json")) throw new Error("Please sign in again.");
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event("imars-session-ended"));
    throw new Error(result.error || "Could not load quiz results.");
  }
  signal.throwIfAborted();
  return result;
}
export async function openQuizReview(user, resultsQuiz, quizSections = [], selectedSection, { submission, onReviewed } = {}) {
  closeQuizReview(); const current = generation; controller = new AbortController();
  const uid = user.uid;
  const signal = controller.signal;
  dialog = element("dialog", undefined, "quiz-review-dialog"); dialog.setAttribute("aria-labelledby", "quizReviewTitle");
  if (resultsQuiz && !submission) dialog.classList.add("quiz-results-dialog");
  const heading = element("h2", resultsQuiz ? `Results for ${resultsQuiz.title}` : "Quiz Submissions"); heading.id = "quizReviewTitle";
  const close = element("button", "Close", "btn-ghost"); close.type = "button"; close.addEventListener("click", closeQuizReview);
  const header = element("div", undefined, "quiz-review-header"); header.append(heading, close);
  const status = element("p", "", "quiz-status"); status.setAttribute("role", "status");
  const filters = element("div", undefined, "quiz-review-filters");
  const sectionLabel = element("label", "Section"), quizLabel = element("label", "Quiz");
  const section = element("select"), quiz = element("select");
  sectionLabel.append(section); quizLabel.append(quiz); filters.append(sectionLabel, quizLabel);
  const option = (label, value = "") => { const item = element("option", label); item.value = value; return item; };
  section.append(option("All sections")); quiz.append(option("Choose a quiz"));
  section.disabled = quiz.disabled = true;
  const content = element("div"), navigation = element("div", undefined, "student-detail-navigation");
  const previous = element("button", "Previous page", "ghost-btn"), next = element("button", "Next page", "ghost-btn");
  previous.type = next.type = "button";
  previous.disabled = next.disabled = true;
  navigation.hidden = true;
  navigation.setAttribute("role", "group");
  navigation.setAttribute("aria-label", "Submission pages");
  navigation.append(previous, next);
  dialog.append(header, filters, status, content);
  if (!resultsQuiz) dialog.append(navigation);
  dialog.addEventListener("cancel", event => { event.preventDefault(); closeQuizReview(); }); document.body.append(dialog); dialog.showModal();
  const cursors = [""];
  let busy = false, pageIndex = 0, nextCursor = "";
  let availableQuizzes = [];
  const sections = new Map();
  async function api(body) {
    return requestQuizReview(uid, { ...body, quizId: quiz.value, sectionId: section.value }, signal);
  }
  async function load(index = pageIndex, cursor = cursors[index]) {
    if (busy || !quiz.value) return;
    busy = true; previous.disabled = next.disabled = section.disabled = quiz.disabled = true;
    setLoadingState(status, true, "Loading submissions");
    try {
      const page = await api({ action: "list", cursor });
      pageIndex = index;
      cursors[index] = cursor;
      nextCursor = page.nextCursor;
      content.replaceChildren();
      for (const row of page.items) {
        const button = element("button", undefined, "quiz-review-submission"); button.type = "button";
        button.append(element("strong", row.name || row.studentId), element("span", "Pending review", "quiz-review-pending"));
        button.addEventListener("click", () => show(row, button)); content.append(button);
      }
      status.textContent = content.children.length ? `Page ${index + 1} · Select a student to review.`
        : nextCursor || index ? "No pending submissions on this page." : "No answers are waiting for review.";
      navigation.hidden = false;
    } catch (error) { if (error.name !== "AbortError") status.textContent = error.message; }
    finally {
      busy = false;
      previous.disabled = pageIndex === 0;
      next.disabled = !nextCursor;
      section.disabled = quiz.disabled = false;
      setLoadingState(status, false);
    }
  }
  async function show(row, button, updateScore) {
    if (busy) return; busy = true; section.disabled = quiz.disabled = true;
    if (button) button.disabled = true;
    setLoadingState(status, true, "Loading student answers");
    try {
      const attempt = await api({ action: "open", studentId: row.studentId, attemptId: row.attemptId });
      const grading = attempt.status === "pending-review";
      if (!grading && !resultsQuiz) {
        button.remove();
        status.textContent = "This submission has already been graded.";
        return;
      }
      const form = element("form", undefined, "quiz-review-form"), scores = [];
      form.append(element("h3", row.name || "Student " + row.studentId));
      const awarded = new Map(attempt.scores?.map(item => [item.questionId, item.score]));
      for (const [index, q] of attempt.questions.entries()) {
        const answer = attempt.answers.find(a => a.questionId === q.id), field = element("fieldset");
        field.append(element("legend", (index + 1) + ". " + q.text));
        const written = answer.optionIndex >= 0 ? q.options[answer.optionIndex] : answer.value;
        field.append(element("p", "Student answer: " + written));
        if (answer.explanation) field.append(element("p", "Explanation: " + answer.explanation));
        if (answer.correction) field.append(element("p", "Correction: " + answer.correction));
        const guide = element("details"), label = element("summary", "Teacher answer guide"); guide.append(label, element("p", q.answer || (q.correctIndex >= 0 ? q.options[q.correctIndex] : "")));
        if (q.rubric || q.explanation || q.correction) guide.append(element("p", q.rubric || q.explanation || q.correction)); field.append(guide);
        if (grading) {
          const scoreLabel = element("label", "Score (0–" + (q.points || 1) + ") "), input = element("input"); input.type = "number"; input.min = "0"; input.max = String(q.points || 1); input.step = "1"; input.required = true;
          scoreLabel.append(input); field.append(scoreLabel); scores.push({ questionId: q.id, input });
        } else if (attempt.status === "graded") {
          field.append(element("p", "Score: " + (answer.optionIndex === q.correctIndex ? "1/1" : "0/1")));
        } else if (awarded.has(q.id)) {
          field.append(element("p", `Score: ${awarded.get(q.id)}/${q.points || 1}`));
        }
        form.append(field);
      }
      const cancel = element("button", resultsQuiz ? "Back to results" : "Back to submissions", "btn-ghost"); cancel.type = "button";
      const back = () => {
        if (submission) { closeQuizReview(); return; }
        form.remove(); content.hidden = false; filters.hidden = false; navigation.hidden = Boolean(resultsQuiz);
      };
      cancel.addEventListener("click", () => {
        back();
        status.textContent = resultsQuiz ? "" : "Select a submission to review.";
        button?.focus();
      });
      if (!grading) {
        if (attempt.feedback) form.append(element("p", "Feedback: " + attempt.feedback));
        form.append(cancel);
        content.hidden = filters.hidden = navigation.hidden = true;
        dialog.append(form);
        status.textContent = "Quiz score: " + quizScoreLabel(attempt);
        return;
      }
      const feedbackLabel = element("label", "Feedback "), feedback = element("textarea"); feedback.maxLength = 4000; feedbackLabel.append(feedback); form.append(feedbackLabel);
      const save = element("button", "Save review", "primary-btn"); save.type = "submit";
      form.append(save, cancel);
      form.addEventListener("submit", async event => {
        event.preventDefault(); if (save.disabled) return; save.disabled = cancel.disabled = true;
        save.setAttribute("aria-busy", "true"); status.textContent = "";
        try {
          const result = await api({ action: "grade", studentId: row.studentId, attemptId: row.attemptId, revision: attempt.revision,
            scores: scores.map(item => ({ questionId: item.questionId, score: Number(item.input.value) })), feedback: feedback.value });
          if (!result.persisted) throw new Error("Review was not confirmed. Please retry.");
          if (submission) {
            closeQuizReview();
            onReviewed?.(result);
            return;
          }
          if (!resultsQuiz) button.remove();
          back();
          updateScore?.(result);
          status.textContent = resultsQuiz ? "" : "Grade saved: " + result.score + "/" + result.maximum + ".";
        } catch (error) { if (error.name !== "AbortError") status.textContent = error.message; }
        finally { save.disabled = cancel.disabled = false; save.setAttribute("aria-busy", "false"); }
      });
      content.hidden = filters.hidden = navigation.hidden = true; dialog.append(form); status.textContent = "Review each answer and save the scores.";
    } catch (error) { if (error.name !== "AbortError") status.textContent = error.message; }
    finally { busy = false; section.disabled = quiz.disabled = false; if (button) button.disabled = false; setLoadingState(status, false); }
  }
  function resetList() {
    cursors.length = 1;
    pageIndex = 0;
    nextCursor = "";
    content.replaceChildren(); navigation.hidden = true;
    status.textContent = "Choose a quiz to view pending submissions.";
  }
  function filterQuizzes() {
    const choices = availableQuizzes.filter(item => !section.value || quizAssignedToSection(item, section.value));
    quiz.replaceChildren(option("Choose a quiz"), ...choices.map(item => option(item.title || "Untitled quiz", item.id)));
    quiz.disabled = !choices.length;
    resetList();
    if (!choices.length) status.textContent = "No assigned written quizzes for this section.";
  }
  const reload = () => { resetList(); void load(); };
  if (resultsQuiz) {
    quizLabel.hidden = true;
    quiz.replaceChildren(option(resultsQuiz.title, resultsQuiz.id));
    const choices = quizSections.filter(item => quizAssignedToSection(resultsQuiz, item.id));
    section.replaceChildren(...choices.map(item => option(item.name, item.id)));
    if (choices.some(item => item.id === selectedSection)) section.value = selectedSection;
    section.disabled = !choices.length;
    if (submission && section.value) {
      filters.hidden = true;
      await show(submission);
    } else if (choices.length) {
      const showResults = () => {
        const sectionId = section.value;
        const table = createQuizResultsTable({
          compact: true,
          signal,
          fetchPage: cursor => requestQuizReview(uid, { action: "section-results", quizId: resultsQuiz.id, sectionId, cursor }, signal),
          reviewAnswers: (row, button, updateScore) => void show(row, button, updateScore)
        });
        content.replaceChildren(table.element);
        table.load();
      };
      section.addEventListener("change", showResults);
      showResults();
    }
    else status.textContent = "There are no assigned sections to show.";
    return;
  }
  section.addEventListener("change", filterQuizzes);
  quiz.addEventListener("change", reload);
  previous.addEventListener("click", () => void load(pageIndex - 1));
  next.addEventListener("click", () => void load(pageIndex + 1, nextCursor));
  setLoadingState(status, true, "Loading sections and quizzes");
  try {
    const db = getFirestore();
    const [classList, quizzes] = await Promise.all([
      getDocs(query(collection(db, "classes"), where("teacherId", "==", user.id))),
      getDocs(query(collection(db, "generatedQuizzes"), where("teacherUid", "==", uid)))
    ]);
    if (current !== generation) return;
    for (const row of classList.docs) sections.set(row.id, row.data().SectionName || row.data().name || row.id);
    for (const [id, name] of sections) section.append(option(name, id));
    const selected = document.getElementById("sectionFilter")?.value;
    if (sections.has(selected)) section.value = selected;
    availableQuizzes = quizzes.docs.map(row => ({ ...row.data(), id: row.id })).filter(item =>
      ["all", "section"].includes(quizAssignmentScope(item)) && (writtenQuestion(item.type) || item.type === "modified-true-false"));
    section.disabled = !sections.size;
    filterQuizzes();
  } catch {
    if (current === generation) status.textContent = "Could not load sections or quizzes. Close and try again.";
  } finally { setLoadingState(status, false); }
}

const submissionsButton = document.getElementById("quizSubmissionsBtn");
if (submissionsButton) {
  const auth = getAuth();
  onAuthStateChanged(auth, user => { closeQuizReview(); submissionsButton.disabled = user?.role !== "teacher"; });
  submissionsButton.addEventListener("click", () => {
    if (auth.currentUser?.role === "teacher") void openQuizReview(auth.currentUser);
  });
}
