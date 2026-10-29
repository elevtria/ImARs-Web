let dialog, controller, generation = 0;
export function closeQuizReview() {
  generation++; controller?.abort(); controller = null;
  dialog?.close(); dialog?.remove(); dialog = null;
}
window.addEventListener("pagehide", closeQuizReview);
const element = (tag, text, className) => { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; };
export async function openQuizReview(quizId, uid) {
  closeQuizReview(); const current = generation; controller = new AbortController();
  const signal = controller.signal;
  dialog = element("dialog", undefined, "quiz-review-dialog"); dialog.setAttribute("aria-labelledby", "quizReviewTitle");
  const heading = element("h2", "Review student answers"); heading.id = "quizReviewTitle";
  const close = element("button", "Close", "btn-ghost"); close.type = "button"; close.addEventListener("click", closeQuizReview);
  const header = element("div", undefined, "quiz-review-header"); header.append(heading, close);
  const status = element("p", "Loading submissions…", "quiz-status"); status.setAttribute("role", "status");
  const content = element("div"), next = element("button", "Load more", "btn-ghost"); next.type = "button"; next.hidden = true;
  dialog.append(header, status, content, next); dialog.addEventListener("cancel", event => { event.preventDefault(); closeQuizReview(); }); document.body.append(dialog); dialog.showModal();
  let busy = false, cursor = "";
  async function api(body) {
    const response = await fetch("/api/quiz-review/action", { method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "Content-Type": "application/json", "X-Web-User": uid }, body: JSON.stringify({ ...body, quizId }), signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
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
    if (busy) return; busy = true; next.disabled = true;
    try {
      const page = await api({ action: "list", cursor }); cursor = page.nextCursor;
      for (const row of page.items) {
        const button = element("button", row.studentId + " · " + new Date(row.submittedAtUtc).toLocaleString(), "quiz-review-submission"); button.type = "button";
        button.addEventListener("click", () => show(row, button)); content.append(button);
      }
      status.textContent = content.children.length ? "Select a submission to review." : "No answers are waiting for review."; next.hidden = !cursor;
    } catch (error) { if (error.name !== "AbortError") status.textContent = error.message; }
    finally { busy = false; next.disabled = false; }
  }
  async function show(row, button) {
    if (busy) return; busy = true; button.disabled = true; status.textContent = "Loading student answers…";
    try {
      const attempt = await api({ action: "open", studentId: row.studentId, attemptId: row.attemptId });
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
      cancel.addEventListener("click", () => { form.remove(); content.hidden = false; next.hidden = !cursor; status.textContent = "Select a submission to review."; }); form.append(save, cancel);
      form.addEventListener("submit", async event => {
        event.preventDefault(); if (save.disabled) return; save.disabled = cancel.disabled = true; status.textContent = "Saving review…";
        try {
          const result = await api({ action: "grade", studentId: row.studentId, attemptId: row.attemptId, revision: attempt.revision,
            scores: scores.map(item => ({ questionId: item.questionId, score: Number(item.input.value) })), feedback: feedback.value });
          if (!result.persisted) throw new Error("Review was not confirmed. Please retry.");
          form.remove(); button.remove(); content.hidden = false; next.hidden = !cursor; status.textContent = "Review saved: " + result.score + "/" + result.maximum + ".";
        } catch (error) { if (error.name !== "AbortError") status.textContent = error.message; }
        finally { save.disabled = cancel.disabled = false; }
      });
      content.hidden = true; next.hidden = true; dialog.append(form); status.textContent = "Review each answer and save the scores.";
    } catch (error) { if (error.name !== "AbortError") status.textContent = error.message; }
    finally { busy = false; button.disabled = false; }
  }
  next.addEventListener("click", load); await load();
}
