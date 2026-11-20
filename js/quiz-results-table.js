import { escapeHtml } from "./teacher-view.js";

export function quizScoreLabel(row) {
  if (row.status === "not-submitted") return "Not submitted";
  if (row.status === "pending-review") return "Awaiting grade";
  return row.score == null || row.maximum == null ? "Score unavailable" : `${row.score}/${row.maximum}`;
}

export function createQuizResultsTable({ fetchPage, reviewAnswers, signal, compact = false }) {
  const element = document.createElement("div");
  element.innerHTML = `<div class="activity-record-detail-head"><div><strong>Student quiz results</strong><small>Latest submission per student</small></div></div>
    <div class="activity-record-results-wrap" hidden><table class="performance-table activity-record-results teacher-quiz-results">
    <thead><tr><th scope="col">Student</th>${compact ? "" : '<th scope="col">Score</th>'}<th scope="col">Status</th>
    ${compact ? '<th scope="col">Grading</th>' : '<th scope="col">Submitted</th><th scope="col">Review</th>'}</tr></thead><tbody></tbody></table></div>
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
        const completed = student.status === "graded" || student.status === "reviewed";
        const badge = completed ? "is-completed" : student.status === "pending-review" ? "is-pending" : "is-empty";
        const label = completed ? "Graded" : student.status === "pending-review" ? "Awaiting grade"
          : student.status === "not-submitted" ? "Not submitted" : "Submitted";
        const points = student.score == null || student.maximum == null ? "—" : `${student.score}/${student.maximum}`;
        const preliminary = points !== "—" && student.status === "pending-review" ? ' title="Preliminary score before teacher review"' : "";
        line.innerHTML = `<th scope="row"><span class="table-avatar" aria-hidden="true">${escapeHtml(initials)}</span><span>${escapeHtml(student.name)}</span></th>
          ${compact ? "" : `<td class="quiz-result-points"${preliminary}>${escapeHtml(points)}</td>`}
          <td><span class="activity-result-score quiz-result-status ${badge}">${escapeHtml(label)}</span></td>
          ${compact ? '<td class="quiz-grading-action">—</td>' : `<td>${escapeHtml(date)}</td><td></td>`}`;
        if (!student.attemptId) continue;
        const review = document.createElement("button");
        review.type = "button";
        review.className = "ghost-btn";
        review.textContent = compact ? completed ? "View / edit grade" : "Grade submission" : "Review answers";
        review.setAttribute("aria-label", `${review.textContent} for ${student.name}`);
        review.addEventListener("click", () => reviewAnswers(student, review, grade => {
          if (signal.aborted || !line.isConnected) return;
          const status = line.querySelector(".quiz-result-status");
          status.textContent = "Graded";
          status.classList.remove("is-pending", "is-empty");
          status.classList.add("is-completed");
          if (compact) {
            review.textContent = "View / edit grade";
            review.setAttribute("aria-label", `View / edit grade for ${student.name}`);
          }
          if (!compact) {
            const score = line.querySelector(".quiz-result-points");
            score.textContent = quizScoreLabel({ ...grade, status: "reviewed" });
            score.removeAttribute("title");
          }
          review.focus();
          message.textContent = "Grade saved.";
        }));
        if (compact) line.lastElementChild.textContent = "";
        line.lastElementChild.append(review);
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
