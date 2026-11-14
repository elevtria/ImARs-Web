import { escapeHtml } from "./teacher-view.js";
import { validLessonScore } from "./lesson-score.js";

let activeDialog;
export function closeLessonScoreEditor() {
  activeDialog?.close();
  activeDialog?.remove();
  activeDialog = null;
}
window.addEventListener("pagehide", closeLessonScoreEditor);

export function openLessonScoreEditor({ kind, studentName, lessonTitle, score, maximum, onSave, onSaved }) {
  closeLessonScoreEditor();
  const dialog = document.createElement("dialog");
  activeDialog = dialog;
  dialog.className = "quiz-review-dialog lesson-score-dialog";
  dialog.setAttribute("aria-labelledby", "lessonScoreTitle");
  const label = { activity: "Activity", pre: "Pre-test", post: "Post-test" }[kind];
  dialog.innerHTML = `<form class="quiz-review-form">
    <h2 id="lessonScoreTitle">Edit ${label.toLowerCase()} score</h2>
    <p>${escapeHtml(studentName)} · ${escapeHtml(lessonTitle)}</p>
    <label>Points earned <input name="score" type="number" min="0" step="${kind === "activity" ? "any" : "1"}" required /></label>
    <label>Points possible <input name="maximum" type="number" min="0.01" max="1000" step="any" required ${kind === "activity" ? "" : "readonly"} /></label>
    <p class="quiz-status" role="status" aria-live="polite"></p>
    <div class="quiz-review-actions"><button class="ghost-btn" type="button">Cancel</button><button class="ghost-btn score-save" type="submit">Save score</button></div>
  </form>`;
  const form = dialog.querySelector("form");
  const points = form.elements.namedItem("score"), total = form.elements.namedItem("maximum");
  points.value = score ?? "";
  total.value = maximum ?? (kind === "pre" ? 5 : kind === "post" ? 10 : "");
  const status = dialog.querySelector("[role=status]");
  const cancel = dialog.querySelector("button[type=button]"), save = dialog.querySelector("button[type=submit]");
  let saving = false;
  const close = () => { if (activeDialog === dialog) closeLessonScoreEditor(); };
  cancel.addEventListener("click", close);
  dialog.addEventListener("cancel", event => { event.preventDefault(); if (!saving) close(); });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (saving || !form.reportValidity()) return;
    const score = Number(points.value), maximum = Number(total.value);
    if (points.value === "" || total.value === "" || !validLessonScore(kind, score, maximum)) {
      status.textContent = "Enter points earned between 0 and the points possible.";
      points.focus();
      return;
    }
    saving = true;
    save.disabled = cancel.disabled = points.disabled = total.disabled = true;
    status.textContent = "Saving score…";
    try {
      await onSave({ score, maximum });
      if (activeDialog !== dialog) return;
      close();
      onSaved?.();
    } catch (error) {
      if (activeDialog === dialog) status.textContent = error.message || "Could not save the score. Try again.";
    } finally {
      saving = false;
      save.disabled = cancel.disabled = points.disabled = total.disabled = false;
    }
  });
  document.body.append(dialog);
  dialog.showModal();
  points.focus();
  points.select();
}
