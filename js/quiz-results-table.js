import { escapeHtml } from "./teacher-view.js";

export function quizScoreLabel(row) {
  if (row.status === "not-submitted") return "Not submitted";
  if (row.status === "pending-review") return "Pending review";
  return row.score == null || row.maximum == null ? "Score unavailable" : `${row.score}/${row.maximum}`;
}

export function createQuizResultsTable({ fetchPage, reviewAnswers, signal, compact = false }) {
  const element = document.createElement("div");
  element.innerHTML = `<div class="activity-record-detail-head"><div><strong>Student quiz results</strong><small>Latest submission per student</small></div></div>
    <div class="activity-record-results-wrap" hidden><table class="performance-table activity-record-results teacher-quiz-results">
    <thead><tr><th scope="col">Student</th>${compact ? '<th scope="col">Status</th>' : '<th scope="col">Score or status</th><th scope="col">Submitted</th><th scope="col">Review</th>'}</tr></thead><tbody></tbody></table></div>
    ${compact ? "" : '<p class="activity-record-empty">Scores show earned points / total points for this quiz.</p>'}
    <p class="activity-record-empty" role="status"></p>
    <div class="student-detail-navigation" role="group" aria-label="Student quiz result pages">
      <button type="button" class="ghost-btn quiz-page-previous" disabled>Previous page</button>
      <button type="button" class="ghost-btn quiz-page-next" disabled>Next page</button>
    </div>`;
  const results = element.querySelector("tbody"), wrap = element.querySelector(".activity-record-results-wrap");
  const message = element.querySelector("[role=status]");
  const previous = element.querySelector(".quiz-page-previous"), next = element.querySelector(".quiz-page-next");
  const cursors = [""];
  let pageIndex = 0, nextCursor = "", loaded = false, loading = false;
  async function loadPage(index, cursor) {
    if (loading || signal.aborted) return;
    loading = previous.disabled = next.disabled = true;
    message.textContent = "Loading student results…";
    try {
      const page = await fetchPage(cursor);
      if (signal.aborted || !element.isConnected) return;
      results.replaceChildren();
      for (const student of page.items) {
        const line = results.insertRow();
        const date = student.submittedAtUtc ? new Date(student.submittedAtUtc).toLocaleString() : "—";
        const initials = student.name.trim().split(/\s+/).slice(0, 2).map(part => part.charAt(0)).join("").toUpperCase();
        const badge = student.status === "pending-review" ? "is-pending" : student.score == null ? "is-empty" : "is-completed";
        const label = compact && badge === "is-completed" ? "Completed" : quizScoreLabel(student);
        line.innerHTML = `<th scope="row"><span class="table-avatar" aria-hidden="true">${escapeHtml(initials)}</span><span>${escapeHtml(student.name)}</span></th>
          <td><span class="activity-result-score ${badge}">${escapeHtml(label)}</span></td>
          ${compact ? "" : `<td>${escapeHtml(date)}</td><td></td>`}`;
        if (!student.attemptId) continue;
        const review = document.createElement("button");
        review.type = "button";
        review.className = compact ? "quiz-result-student" : "ghost-btn";
        review.textContent = compact ? student.name : "Review answers";
        review.setAttribute("aria-label", `Review answers for ${student.name}`);
        review.addEventListener("click", () => reviewAnswers(student, review, grade => {
          if (signal.aborted || !line.isConnected) return;
          const score = line.cells[1].firstElementChild;
          score.textContent = compact ? "Completed" : quizScoreLabel({ ...grade, status: "reviewed" });
          score.classList.replace("is-pending", "is-completed");
          review.focus();
          message.textContent = "Grade saved.";
        }));
        if (compact) line.cells[0].lastElementChild.replaceWith(review);
        else line.lastElementChild.append(review);
      }
      loaded = true;
      pageIndex = index;
      cursors[index] = cursor;
      nextCursor = page.nextCursor;
      wrap.hidden = results.rows.length === 0;
      message.textContent = results.rows.length ? `Page ${index + 1}`
        : nextCursor ? "No active students on this page." : "No more active students in this section.";
    } catch (error) {
      if (!signal.aborted) message.textContent = error.message;
    } finally {
      loading = false;
      previous.disabled = pageIndex === 0;
      next.disabled = !nextCursor;
    }
  }
  previous.addEventListener("click", () => void loadPage(pageIndex - 1, cursors[pageIndex - 1]));
  next.addEventListener("click", () => void loadPage(pageIndex + 1, nextCursor));
  return { element, load: () => { if (!loaded) void loadPage(0, ""); } };
}
