import { setLoadingState } from "./loading.js";
import { quizAssignedToSection, quizReviewPoints } from "./quiz-limits.js";
import { createQuizResultsTable, quizScoreLabel } from "./quiz-results-table.js";

let dialog, controller;
export function closeQuizReview() {
  controller?.abort(); controller = null;
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
  closeQuizReview(); controller = new AbortController();
  const uid = user.uid;
  const signal = controller.signal;
  dialog = element("dialog", undefined, "quiz-review-dialog"); dialog.setAttribute("aria-labelledby", "quizReviewTitle");
  if (!submission) dialog.classList.add("quiz-results-dialog");
  const heading = element("h2", `Results for ${resultsQuiz.title}`); heading.id = "quizReviewTitle";
  const close = element("button", "Close", "btn-ghost"); close.type = "button"; close.addEventListener("click", closeQuizReview);
  const header = element("div", undefined, "quiz-review-header"); header.append(heading, close);
  const status = element("p", "", "quiz-status"); status.setAttribute("role", "status");
  const filters = element("div", undefined, "quiz-review-filters");
  const sectionLabel = element("label", "Section"), section = element("select");
  sectionLabel.append(section); filters.append(sectionLabel);
  const choices = quizSections;
  section.replaceChildren(...choices.map(item => new Option(item.name, item.id)));
  if (choices.some(item => item.id === selectedSection)) section.value = selectedSection;
  else if (choices.some(item => quizAssignedToSection(resultsQuiz, item.id)))
    section.value = choices.find(item => quizAssignedToSection(resultsQuiz, item.id)).id;
  section.disabled = !choices.length;
  const content = element("div");
  dialog.append(header, filters, status, content);
  dialog.addEventListener("cancel", event => { event.preventDefault(); closeQuizReview(); });
  document.body.append(dialog); dialog.showModal();
  let busy = false;
  async function api(body) {
    return requestQuizReview(uid, { ...body, quizId: resultsQuiz.id, sectionId: section.value }, signal);
  }
  async function show(row, button, updateScore, previousForm) {
    if (busy) return; busy = true; section.disabled = true;
    if (button) button.disabled = true;
    setLoadingState(status, true, "Loading student answers");
    try {
      const attempt = await api({ action: "open", studentId: row.studentId, attemptId: row.attemptId });
      const grading = Boolean(previousForm) || attempt.status === "pending-review";
      const form = element("form", undefined, "quiz-review-form"), scores = [];
      form.append(element("h3", row.name || "Student " + row.studentId));
      const awarded = new Map(attempt.scores?.map(item => [item.questionId, item.score]));
      for (const [index, q] of attempt.questions.entries()) {
        const answer = attempt.answers.find(a => a.questionId === q.id), field = element("fieldset");
        const points = quizReviewPoints(attempt.type, q);
        const score = attempt.status === "graded" ? Number(answer.optionIndex === q.correctIndex) : awarded.get(q.id);
        field.append(element("legend", (index + 1) + ". " + q.text));
        const written = answer.optionIndex >= 0 ? q.options[answer.optionIndex] : answer.value;
        field.append(element("p", "Student answer: " + written));
        if (answer.explanation) field.append(element("p", "Explanation: " + answer.explanation));
        if (answer.correction) field.append(element("p", "Correction: " + answer.correction));
        const guide = element("details"), label = element("summary", "Teacher answer guide"); guide.append(label, element("p", q.answer || (q.correctIndex >= 0 ? q.options[q.correctIndex] : "")));
        if (q.rubric || q.explanation || q.correction) guide.append(element("p", q.rubric || q.explanation || q.correction)); field.append(guide);
        if (grading) {
          const scoreLabel = element("label", `Score (0–${points}) `), input = element("input"); input.type = "number"; input.min = "0"; input.max = String(points); input.step = "1"; input.required = true;
          if (score != null) input.value = String(score);
          scoreLabel.append(input); field.append(scoreLabel); scores.push({ questionId: q.id, input });
        } else if (score != null) {
          field.append(element("p", `Score: ${score}/${points}`));
        }
        form.append(field);
      }
      const cancel = element("button", "Back to results", "btn-ghost"); cancel.type = "button";
      const back = () => {
        if (submission) { closeQuizReview(); return; }
        form.remove(); content.hidden = filters.hidden = false;
      };
      cancel.addEventListener("click", () => {
        back();
        status.textContent = "";
        button?.focus();
      });
      if (!grading) {
        if (attempt.feedback) form.append(element("p", "Feedback: " + attempt.feedback));
        const edit = element("button", "Edit review", "primary-btn"); edit.type = "button";
        edit.addEventListener("click", () => void show(row, button, updateScore, form));
        form.append(edit, cancel);
        content.hidden = filters.hidden = true;
        dialog.append(form);
        status.textContent = "Quiz score: " + quizScoreLabel(attempt);
        return;
      }
      const feedbackLabel = element("label", "Feedback "), feedback = element("textarea"); feedback.maxLength = 4000; feedbackLabel.append(feedback); form.append(feedbackLabel);
      feedback.value = attempt.feedback || "";
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
          back();
          updateScore?.(result);
          status.textContent = "";
        } catch (error) { if (error.name !== "AbortError") status.textContent = error.message; }
        finally { save.disabled = cancel.disabled = false; save.setAttribute("aria-busy", "false"); }
      });
      content.hidden = filters.hidden = true;
      if (previousForm) previousForm.replaceWith(form);
      else dialog.append(form);
      status.textContent = "Review each answer and save the scores.";
      if (previousForm) scores[0]?.input.focus();
    } catch (error) { if (error.name !== "AbortError") status.textContent = error.message; }
    finally { busy = false; section.disabled = false; if (button) button.disabled = false; setLoadingState(status, false); }
  }
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
  } else {
    status.textContent = "There are no assigned sections to show.";
  }
}
