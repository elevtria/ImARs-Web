import { initializeApp, getAuth, onAuthStateChanged } from "./firebase-auth.js";
import { getFirestore, collection, doc, getDoc, getDocsWithLoading, query, setDoc, where } from "./firebase-data.js";

const app = initializeApp();
const auth = getAuth(app);
const db = getFirestore(app);
const list = document.getElementById("quizScheduleList");
const status = document.getElementById("quizScheduleStatus");
let quizzes = [];
let teacherUid = "";
let loadingGeneration = 0;
let saving = false;

const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[character]);
const formatDate = value => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Invalid release time" : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
};
const localInputValue = value => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
};
const effectiveAvailability = quiz => quiz.availability === "scheduled" && Date.parse(quiz.availableAt) <= Date.now() ? "now" : quiz.availability || "draft";

function render() {
  if (!quizzes.length) {
    list.innerHTML = '<p class="quiz-schedule-empty">No generated quizzes yet. Create one in Quiz Generator to plan its release here.</p>';
    return;
  }
  list.innerHTML = quizzes.map(quiz => {
    const mode = effectiveAvailability(quiz);
    const scheduled = mode === "scheduled";
    const badge = mode === "now" ? "Available" : scheduled ? `Unlocks ${formatDate(quiz.availableAt)}` : "Draft · locked";
    return `<article class="quiz-schedule-card" data-quiz-id="${escapeHtml(quiz.id)}">
      <div class="quiz-schedule-info"><span class="quiz-schedule-section">${escapeHtml(quiz.section || quiz.sectionId || "Section")}</span><h3>${escapeHtml(quiz.title)}</h3><p>${escapeHtml(badge)}</p></div>
      <div class="quiz-schedule-controls">
        <label class="quiz-schedule-access">Access <select class="quiz-schedule-mode" aria-label="Access for ${escapeHtml(quiz.title)}" ${saving ? "disabled" : ""}>
          <option value="draft" ${mode === "draft" ? "selected" : ""}>Locked draft</option>
          <option value="now" ${mode === "now" ? "selected" : ""}>Available now</option>
          <option value="scheduled" ${scheduled ? "selected" : ""}>Scheduled release</option>
        </select></label>
        <label class="quiz-schedule-date" ${scheduled ? "" : "hidden"}>Release date and time <input type="datetime-local" value="${scheduled ? escapeHtml(localInputValue(quiz.availableAt)) : ""}" aria-label="Release time for ${escapeHtml(quiz.title)}" ${saving ? "disabled" : ""}></label>
        <button class="primary-btn quiz-schedule-save" type="button" ${saving ? "disabled" : ""}>Save access</button>
      </div>
    </article>`;
  }).join("");
}

async function loadQuizzes(user) {
  const generation = ++loadingGeneration;
  teacherUid = user?.uid || "";
  quizzes = [];
  if (!user) { status.textContent = "Sign in to manage generated quizzes."; list.replaceChildren(); return; }
  status.textContent = "Loading quizzes…";
  try {
    const snapshot = await getDocsWithLoading(query(collection(db, "generatedQuizzes"), where("teacherUid", "==", user.uid)));
    if (generation !== loadingGeneration) return;
    quizzes = snapshot.docs.map(item => ({ ...item.data(), id: item.id }))
      .sort((a, b) => String(a.section || "").localeCompare(String(b.section || "")) || String(a.title || "").localeCompare(String(b.title || "")));
    status.textContent = `${quizzes.length} ${quizzes.length === 1 ? "quiz" : "quizzes"} in your schedule`;
    render();
  } catch (error) {
    if (generation !== loadingGeneration) return;
    console.error("Unable to load generated quizzes:", error);
    status.textContent = "Could not load quizzes. Refresh the page to try again.";
  }
}

list.addEventListener("change", event => {
  if (!event.target.matches(".quiz-schedule-mode")) return;
  const card = event.target.closest(".quiz-schedule-card");
  card.querySelector(".quiz-schedule-date").hidden = event.target.value !== "scheduled";
});

list.addEventListener("click", async event => {
  const button = event.target.closest(".quiz-schedule-save");
  if (!button || saving || !teacherUid) return;
  const card = button.closest(".quiz-schedule-card");
  const quiz = quizzes.find(item => item.id === card.dataset.quizId);
  if (!quiz) return;
  const mode = card.querySelector(".quiz-schedule-mode").value;
  const dateInput = card.querySelector(".quiz-schedule-date input");
  const release = mode === "scheduled" ? new Date(dateInput.value) : null;
  if (mode === "scheduled" && (!dateInput.value || Number.isNaN(release.getTime()) || release.getTime() <= Date.now())) {
    status.textContent = "Choose a future date and time for this quiz.";
    dateInput.focus();
    return;
  }
  saving = true;
  button.disabled = true;
  status.textContent = `Saving access for ${quiz.title}…`;
  let saved = false;
  try {
    const reference = doc(db, "generatedQuizzes", quiz.id);
    const current = await getDoc(reference);
    if (!current.exists()) throw new Error("This quiz was deleted. Refresh the page.");
    if (current.data().updatedAt !== quiz.updatedAt) throw new Error("This quiz changed elsewhere. Refresh the page before saving.");
    const updated = {
      ...current.data(),
      id: quiz.id,
      availability: mode,
      availableAt: mode === "scheduled" ? release.toISOString() : "",
      updatedAt: new Date().toISOString()
    };
    await setDoc(reference, updated);
    Object.assign(quiz, updated);
    status.textContent = `Saved access for ${quiz.title}.`;
    saved = true;
  } catch (error) {
    console.error("Unable to update quiz access:", error);
    status.textContent = error.message || `Could not save access for ${quiz.title}. Try again.`;
  } finally {
    saving = false;
    button.disabled = false;
    if (saved) render();
  }
});

onAuthStateChanged(auth, loadQuizzes);
