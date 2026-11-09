import { setLoadingState } from "./loading.js";
import { getAuth, onAuthStateChanged } from "./firebase-auth.js";
import { collection, getDocs, getFirestore, query, where } from "./firebase-data.js";
import { quizAssignedToSection, quizAssignmentScope, writtenQuestion } from "./quiz-limits.js";

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
export function quizScoreLabel(row) {
  if (row.status === "not-submitted") return "Not submitted";
  if (row.status === "pending-review") return "Pending review";
  return row.score == null || row.maximum == null ? "Score unavailable" : `${row.score}/${row.maximum}`;
}
export async function openQuizReview(user, resultsQuiz, quizSections = [], selectedSection, { submission, onReviewed } = {}) {
  closeQuizReview(); const current = generation; controller = new AbortController();
  const uid = user.uid;
  const signal = controller.signal;
  dialog = element("dialog", undefined, "quiz-review-dialog"); dialog.setAttribute("aria-labelledby", "quizReviewTitle");
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
  const content = element("div"), next = element("button", "Load more", "btn-ghost"); next.type = "button"; next.hidden = true;
  dialog.append(header, filters, status, content, next); dialog.addEventListener("cancel", event => { event.preventDefault(); closeQuizReview(); }); document.body.append(dialog); dialog.showModal();
  let busy = false, cursor = "";
  let availableQuizzes = [];
  const sections = new Map();
  async function api(body) {
    return requestQuizReview(uid, { ...body, quizId: quiz.value, sectionId: section.value }, signal);
  }
  async function load() {
    if (busy || !quiz.value || (resultsQuiz && !section.value)) return;
    busy = true; next.disabled = section.disabled = quiz.disabled = true;
    setLoadingState(status, true, resultsQuiz ? "Loading quiz results" : "Loading submissions");
    try {
      const page = await api({ action: resultsQuiz ? "section-results" : "list", cursor }); cursor = page.nextCursor;
      next.textContent = "Load more";
      for (const row of page.items) {
        if (resultsQuiz) {
          const line = element("div", undefined, "teacher-quiz-score");
          const date = row.submittedAtUtc ? new Date(row.submittedAtUtc).toLocaleString() : "";
          line.append(element("strong", row.name), element("span", [quizScoreLabel(row), date].filter(Boolean).join(" · ")));
          if (row.status === "pending-review") {
            const button = element("button", "Review answers", "ghost-btn"); button.type = "button";
            button.setAttribute("aria-label", `Review answers for ${row.name}`);
            button.addEventListener("click", () => show(row, button)); line.append(button);
          }
          content.append(line);
          continue;
        }
        const button = element("button", [row.studentId, sections.get(row.sectionId), new Date(row.submittedAtUtc).toLocaleString()].filter(Boolean).join(" · "), "quiz-review-submission"); button.type = "button";
        button.addEventListener("click", () => show(row, button)); content.append(button);
      }
      status.textContent = resultsQuiz
        ? content.children.length ? "Showing each student's latest submission." : cursor ? "Load more to see the rest of the section." : "No active students in this section."
        : content.children.length ? "Select a submission to review." : "No answers are waiting for review.";
      next.hidden = !cursor;
    } catch (error) { if (error.name !== "AbortError") { status.textContent = error.message; next.textContent = "Retry"; next.hidden = false; } }
    finally { busy = false; next.disabled = section.disabled = quiz.disabled = false; setLoadingState(status, false); }
  }
  async function show(row, button) {
    if (busy) return; busy = true; section.disabled = quiz.disabled = true;
    if (button) button.disabled = true;
    setLoadingState(status, true, "Loading student answers");
    try {
      const attempt = await api({ action: "open", studentId: row.studentId, attemptId: row.attemptId });
      if (attempt.status !== "pending-review") {
        if (submission) {
          closeQuizReview();
          onReviewed?.();
          return;
        }
        if (resultsQuiz) { resetList(); busy = false; await load(); }
        else button.remove();
        status.textContent = "This submission has already been graded.";
        return;
      }
      const form = element("form", undefined, "quiz-review-form"), scores = [];
      form.append(element("h3", row.name || "Student " + row.studentId));
      for (const [index, q] of attempt.questions.entries()) {
        const answer = attempt.answers.find(a => a.questionId === q.id), field = element("fieldset");
        field.append(element("legend", (index + 1) + ". " + q.text));
        const written = answer.optionIndex >= 0 ? q.options[answer.optionIndex] : answer.value;
        field.append(element("p", "Student answer: " + written));
        if (answer.explanation) field.append(element("p", "Explanation: " + answer.explanation));
        if (answer.correction) field.append(element("p", "Correction: " + answer.correction));
        const guide = element("details"), label = element("summary", "Teacher answer guide"); guide.append(label, element("p", q.answer || (q.correctIndex >= 0 ? q.options[q.correctIndex] : "")));
        if (q.rubric || q.explanation || q.correction) guide.append(element("p", q.rubric || q.explanation || q.correction)); field.append(guide);
        const scoreLabel = element("label", "Score (0–" + (q.points || 1) + ") "), input = element("input"); input.type = "number"; input.min = "0"; input.max = String(q.points || 1); input.step = "1"; input.required = true;
        scoreLabel.append(input); field.append(scoreLabel); scores.push({ questionId: q.id, input }); form.append(field);
      }
      const feedbackLabel = element("label", "Feedback "), feedback = element("textarea"); feedback.maxLength = 4000; feedbackLabel.append(feedback); form.append(feedbackLabel);
      const save = element("button", "Save review", "primary-btn"), cancel = element("button", resultsQuiz ? "Back to results" : "Back to submissions", "btn-ghost"); save.type = "submit"; cancel.type = "button";
      const back = () => {
        if (submission) { closeQuizReview(); return; }
        form.remove(); content.hidden = false; filters.hidden = false; next.hidden = !cursor;
      };
      cancel.addEventListener("click", () => { back(); status.textContent = resultsQuiz ? "Showing each student's latest submission." : "Select a submission to review."; }); form.append(save, cancel);
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
          if (resultsQuiz) button.previousElementSibling.textContent = [
            quizScoreLabel({ ...result, status: "reviewed" }), new Date(row.submittedAtUtc).toLocaleString()
          ].join(" · ");
          button.remove(); back(); status.textContent = "Grade saved: " + result.score + "/" + result.maximum + ".";
        } catch (error) { if (error.name !== "AbortError") status.textContent = error.message; }
        finally { save.disabled = cancel.disabled = false; save.setAttribute("aria-busy", "false"); }
      });
      content.hidden = filters.hidden = next.hidden = true; dialog.append(form); status.textContent = "Review each answer and save the scores.";
    } catch (error) { if (error.name !== "AbortError") status.textContent = error.message; }
    finally { busy = false; section.disabled = quiz.disabled = false; if (button) button.disabled = false; setLoadingState(status, false); }
  }
  function resetList() {
    cursor = "";
    content.replaceChildren(); next.hidden = true; next.textContent = "Load more";
    status.textContent = resultsQuiz ? "Choose a section to view results." : "Choose a quiz to view pending submissions.";
  }
  function filterQuizzes() {
    const choices = availableQuizzes.filter(item => !section.value || quizAssignedToSection(item, section.value));
    quiz.replaceChildren(option("Choose a quiz"), ...choices.map(item => option(item.title || "Untitled quiz", item.id)));
    quiz.disabled = !choices.length;
    resetList();
    if (!choices.length) status.textContent = "No assigned written quizzes for this section.";
  }
  const reload = () => { resetList(); void load(); };
  section.addEventListener("change", resultsQuiz ? reload : filterQuizzes);
  quiz.addEventListener("change", reload);
  next.addEventListener("click", load);
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
    } else if (choices.length) await load();
    else status.textContent = "There are no assigned sections to show.";
    return;
  }
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
