// Browse the currently rendered, filtered records without changing data or calculations.
import { getAuth } from "./firebase-auth.js";
import { questionTypeLabel } from "./quiz-limits.js";
import { quizScoreLabel, requestQuizReview } from "./quiz-review.js";

const list = document.getElementById("recordsContainer");
const dialog = document.getElementById("studentRecordDialog");
const content = document.getElementById("studentRecordContent");
const previous = document.getElementById("previousStudentRecord");
const next = document.getElementById("nextStudentRecord");
let selectedId;
let opener;
let scoreSection, scoreController;
function studentQuizScores(studentId) {
  scoreController?.abort();
  const controller = new AbortController();
  scoreController = controller;
  const auth = getAuth(), user = auth.currentUser;
  const section = document.createElement("section");
  section.className = "student-quiz-scores";
  const heading = document.createElement("h3");
  heading.textContent = "Teacher Quizzes";
  const scope = document.createElement("p");
  scope.textContent = "Latest submission per quiz · All terms";
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  const results = document.createElement("ul");
  const nextPage = document.createElement("button");
  nextPage.type = "button";
  nextPage.className = "ghost-btn";
  nextPage.hidden = true;
  section.append(heading, scope, status, results, nextPage);
  const seen = new Set();
  let cursor = "";
  async function loadScores() {
    if (user?.role !== "teacher") { section.hidden = true; return; }
    nextPage.disabled = true;
    status.textContent = "Loading quiz scores…";
    try {
      const page = await requestQuizReview(user.uid, { action: "student-scores", studentId, cursor }, controller.signal);
      if (auth.currentUser?.uid !== user.uid) return;
      for (const row of page.items) {
        if (seen.has(row.quizId)) continue;
        seen.add(row.quizId);
        const item = document.createElement("li");
        item.className = "teacher-quiz-score";
        const title = document.createElement("strong"), detail = document.createElement("span");
        title.textContent = row.title;
        detail.textContent = [row.type && questionTypeLabel(row.type), quizScoreLabel(row),
          new Date(row.submittedAtUtc).toLocaleDateString()].filter(Boolean).join(" · ");
        item.append(title, detail);
        results.append(item);
      }
      cursor = page.nextCursor;
      status.textContent = seen.size ? "" : "No teacher quiz submissions yet.";
      nextPage.hidden = !cursor;
      nextPage.textContent = "Load more";
    } catch (error) {
      if (controller.signal.aborted) return;
      status.textContent = error.message;
      nextPage.textContent = "Retry";
      nextPage.hidden = false;
    } finally {
      nextPage.disabled = false;
    }
  }
  nextPage.addEventListener("click", loadScores);
  void loadScores();
  return section;
}
const rows = () => Array.from(list.querySelectorAll(".record")).filter(row => !row.classList.contains("hidden"));
const id = row => row.dataset.studentId;
function showRecord(row) {
  if (!row) return;
  if (!scoreSection || selectedId !== id(row)) scoreSection = studentQuizScores(id(row));
  selectedId = id(row);
  list.dispatchEvent(new CustomEvent("student-record-open", { detail: { studentId: selectedId } }));
  row = rows().find(candidate => id(candidate) === selectedId) || row;
  const current = rows();
  const index = current.indexOf(row);
  const detail = row.cloneNode(true);
  detail.className = "record student-record-detail";
  detail.querySelector(".open-student-record")?.remove();
  detail.querySelector(".stats")?.after(scoreSection);
  content.replaceChildren(detail);
  document.getElementById("studentRecordPosition").textContent = `${index + 1} of ${current.length} students`;
  previous.disabled = index === 0;
  next.disabled = index === current.length - 1;
  if (!dialog.open) dialog.showModal();
}
function enhanceRows() {
  list.querySelectorAll(".record").forEach(row => {
    if (row.querySelector(".open-student-record")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "open-student-record";
    button.textContent = "View record";
    button.setAttribute("aria-label", `View record for ${row.querySelector(".student strong")?.textContent || "student"}`);
    row.append(button);
  });
  if (dialog.open) {
    const row = rows().find(row => id(row) === selectedId);
    if (row) showRecord(row); else dialog.close();
  }
}
list.addEventListener("click", event => {
  if (event.target.closest(".archive-student-btn,.unarchive-student-btn,.remove-student-btn")) return;
  const row = event.target.closest(".record");
  if (row) { opener = row.querySelector(".open-student-record"); showRecord(row); }
});
content.addEventListener("click", event => {
  const action = event.target.closest(".archive-student-btn,.unarchive-student-btn,.remove-student-btn");
  if (!action) return;
  const row = rows().find(row => id(row) === selectedId);
  const selector = action.classList.contains("unarchive-student-btn") ? ".unarchive-student-btn" : action.classList.contains("remove-student-btn") ? ".remove-student-btn" : ".archive-student-btn";
  dialog.close();
  row?.querySelector(selector)?.click();
});
function step(direction) {
  const current = rows();
  const index = current.findIndex(row => id(row) === selectedId);
  showRecord(current[index + direction]);
}
previous.addEventListener("click", () => step(-1));
next.addEventListener("click", () => step(1));
document.getElementById("closeStudentRecord").addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => {
  if (dialog.open) return;
  scoreController?.abort();
  scoreSection = null;
  if (opener?.isConnected) opener.focus();
});
window.addEventListener("pagehide", () => scoreController?.abort());
dialog.addEventListener("click", event => {
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
});
dialog.addEventListener("keydown", event => {
  if (event.target.closest("button,input,select,textarea")) return;
  if (event.key === "ArrowLeft") step(-1);
  if (event.key === "ArrowRight") step(1);
});
new MutationObserver(enhanceRows).observe(list, { childList:true, subtree:true, attributes:true, attributeFilter:["class"] });
enhanceRows();
