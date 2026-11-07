import { setLoadingState } from "./loading.js";
import { getAuth, onAuthStateChanged } from "./firebase-auth.js";
import { collection, getDocs, getFirestore, query, where } from "./firebase-data.js";
import { quizAssignedToSection, quizAssignmentScope, writtenQuestion } from "./quiz-limits.js";

let dialog, controller, generation = 0;
function closeQuizReview() {
  generation++; controller?.abort(); controller = null;
  dialog?.close(); dialog?.remove(); dialog = null;
}
window.addEventListener("pagehide", closeQuizReview);
const element = (tag, text, className) => { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; };
async function openQuizReview(user) {
  closeQuizReview(); const current = generation; controller = new AbortController();
  const uid = user.uid;
  const signal = controller.signal;
  dialog = element("dialog", undefined, "quiz-review-dialog"); dialog.setAttribute("aria-labelledby", "quizReviewTitle");
  const heading = element("h2", "Quiz Submissions"); heading.id = "quizReviewTitle";
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
    const response = await fetch("/api/quiz-review/action", { method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "Content-Type": "application/json", "X-Web-User": uid }, body: JSON.stringify({ ...body, quizId: quiz.value, sectionId: section.value }), signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
    if (!response.headers.get("Content-Type")?.includes("application/json")) throw new Error("Please sign in again.");
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 401) window.dispatchEvent(new Event("imars-session-ended"));
      if ([401, 403].includes(response.status)) closeQuizReview();
      throw new Error(result.error || "Could not load quiz reviews.");
    }
    if (current !== generation) throw new DOMException("Canceled", "AbortError"); return result;
  }
  async function load() {
    if (busy || !quiz.value) return;
    busy = true; next.disabled = section.disabled = quiz.disabled = true;
    setLoadingState(status, true, "Loading submissions");
    try {
      const page = await api({ action: "list", cursor }); cursor = page.nextCursor;
      next.textContent = "Load more";
      for (const row of page.items) {
        const button = element("button", [row.studentId, sections.get(row.sectionId), new Date(row.submittedAtUtc).toLocaleString()].filter(Boolean).join(" · "), "quiz-review-submission"); button.type = "button";
        button.addEventListener("click", () => show(row, button)); content.append(button);
      }
      status.textContent = content.children.length ? "Select a submission to review." : "No answers are waiting for review."; next.hidden = !cursor;
    } catch (error) { if (error.name !== "AbortError") { status.textContent = error.message; next.textContent = "Retry"; next.hidden = false; } }
    finally { busy = false; next.disabled = section.disabled = quiz.disabled = false; setLoadingState(status, false); }
  }
  async function show(row, button) {
    if (busy) return; busy = true; button.disabled = section.disabled = quiz.disabled = true;
    setLoadingState(status, true, "Loading student answers");
    try {
      const attempt = await api({ action: "open", studentId: row.studentId, attemptId: row.attemptId });
      if (attempt.status !== "pending-review") {
        button.remove();
        status.textContent = "This submission has already been graded.";
        return;
      }
      const form = element("form", undefined, "quiz-review-form"), scores = [];
      form.append(element("h3", "Student " + row.studentId));
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
      const save = element("button", "Save review", "primary-btn"), cancel = element("button", "Back to submissions", "btn-ghost"); save.type = "submit"; cancel.type = "button";
      const back = () => { form.remove(); content.hidden = false; filters.hidden = false; next.hidden = !cursor; };
      cancel.addEventListener("click", () => { back(); status.textContent = "Select a submission to review."; }); form.append(save, cancel);
      form.addEventListener("submit", async event => {
        event.preventDefault(); if (save.disabled) return; save.disabled = cancel.disabled = true;
        save.setAttribute("aria-busy", "true"); status.textContent = "";
        try {
          const result = await api({ action: "grade", studentId: row.studentId, attemptId: row.attemptId, revision: attempt.revision,
            scores: scores.map(item => ({ questionId: item.questionId, score: Number(item.input.value) })), feedback: feedback.value });
          if (!result.persisted) throw new Error("Review was not confirmed. Please retry.");
          button.remove(); back(); status.textContent = "Grade saved: " + result.score + "/" + result.maximum + ".";
        } catch (error) { if (error.name !== "AbortError") status.textContent = error.message; }
        finally { save.disabled = cancel.disabled = false; save.setAttribute("aria-busy", "false"); }
      });
      content.hidden = filters.hidden = next.hidden = true; dialog.append(form); status.textContent = "Review each answer and save the scores.";
    } catch (error) { if (error.name !== "AbortError") status.textContent = error.message; }
    finally { busy = false; button.disabled = section.disabled = quiz.disabled = false; setLoadingState(status, false); }
  }
  function resetList() {
    cursor = "";
    content.replaceChildren(); next.hidden = true; next.textContent = "Load more";
    status.textContent = "Choose a quiz to view pending submissions.";
  }
  function filterQuizzes() {
    const choices = availableQuizzes.filter(item => !section.value || quizAssignedToSection(item, section.value));
    quiz.replaceChildren(option("Choose a quiz"), ...choices.map(item => option(item.title || "Untitled quiz", item.id)));
    quiz.disabled = !choices.length;
    resetList();
    if (!choices.length) status.textContent = "No assigned written quizzes for this section.";
  }
  section.addEventListener("change", filterQuizzes);
  quiz.addEventListener("change", () => { resetList(); void load(); });
  next.addEventListener("click", load);
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
