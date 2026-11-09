// Browse the currently rendered, filtered records without changing data or calculations.
import { getAuth } from "./firebase-auth.js";
import { requestQuizReview } from "./quiz-review.js";
import { webRequest } from "./web-login.js";

const list = document.getElementById("recordsContainer");
const dialog = document.getElementById("studentRecordDialog");
const content = document.getElementById("studentRecordContent");
const previous = document.getElementById("previousStudentRecord");
const next = document.getElementById("nextStudentRecord");
let selectedId;
let opener;
let scoreRequest, scoreKey, scoreTiles;

function showScoreTiles(studentId, stats) {
  const termId = document.getElementById("recordsTerm").value || "term_01";
  const user = getAuth().currentUser;
  if (user?.role !== "teacher" || !stats) return;
  const key = `${user.uid}:${studentId}:${termId}`;
  if (scoreKey !== key) {
    scoreRequest?.abort();
    scoreRequest = new AbortController();
    const { signal } = scoreRequest;
    scoreKey = key;
    const template = document.createElement("template");
    template.innerHTML = '<div class="stat"><span>Quiz Score <small>All-time</small></span><b class="c-cyan">…</b></div><div class="stat"><span>Activity Score</span><b class="c-green">…</b></div>';
    scoreTiles = Array.from(template.content.children);
    const load = async (tile, request) => {
      const value = tile.querySelector("b");
      try {
        const { average } = await request;
        if (!signal.aborted) value.textContent = average == null ? "—" : `${average}%`;
      } catch {
        if (!signal.aborted) {
          value.textContent = "—";
          tile.title = "Score could not load. Reopen the record to retry.";
        }
      }
    };
    void load(scoreTiles[0], requestQuizReview(user.uid, { action: "student-average", studentId }, signal));
    void load(scoreTiles[1], webRequest("/api/web-data", { action: "student-activity-average", studentId, termId },
      { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) }));
  }
  stats.classList.add("record-score-grid");
  stats.append(...scoreTiles);
}
const rows = () => Array.from(list.querySelectorAll(".record")).filter(row => !row.classList.contains("hidden"));
const id = row => row.dataset.studentId;
function showRecord(row) {
  if (!row) return;
  selectedId = id(row);
  list.dispatchEvent(new CustomEvent("student-record-open", { detail: { studentId: selectedId } }));
  row = rows().find(candidate => id(candidate) === selectedId) || row;
  const current = rows();
  const index = current.indexOf(row);
  const detail = row.cloneNode(true);
  detail.className = "record student-record-detail";
  detail.querySelector(".open-student-record")?.remove();
  showScoreTiles(selectedId, detail.querySelector(".stats"));
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
  scoreRequest?.abort();
  scoreKey = null;
  if (opener?.isConnected) opener.focus();
});
window.addEventListener("pagehide", () => { if (dialog.open) dialog.close(); });
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
