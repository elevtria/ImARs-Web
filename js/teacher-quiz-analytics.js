import { getAuth, onAuthStateChanged } from "./firebase-auth.js";
import { collection, getDocs, getFirestore, query, where } from "./firebase-data.js";
import { questionTypeLabel, quizAssignedToSection } from "./quiz-limits.js";
import { closeQuizReview, openQuizReview, requestQuizReview } from "./quiz-review.js";
import { createQuizResultsTable } from "./quiz-results-table.js";
import { escapeHtml } from "./teacher-view.js";

const filter = document.getElementById("teacherQuizSection");
const body = document.getElementById("teacherQuizBody");
const status = document.getElementById("teacherQuizStatus");
const refresh = document.getElementById("teacherQuizRefresh");
const auth = getAuth(), db = getFirestore();
let sections = [], quizzes = [], pageRequest;

function sectionName(data, id) {
  return data.SectionName || data.sectionName || data.name || id;
}

function renderQuiz(quiz, section, index, user, signal) {
  const row = body.insertRow();
  const details = body.insertRow();
  details.id = `teacherQuizDetails${index}`;
  details.className = "activity-record-detail";
  details.hidden = true;
  row.innerHTML = `<th scope="row"><button class="activity-record-toggle" type="button" aria-expanded="false" aria-controls="${details.id}">
    <span class="activity-record-chevron" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg></span>
    <span>${escapeHtml(quiz.title || "Teacher quiz")}<small>${escapeHtml(questionTypeLabel(quiz.type))}</small></span></button></th>
    <td>${escapeHtml(section.label)}</td><td>—</td><td>—</td><td><span class="activity-record-completed">—</span></td>`;
  const table = createQuizResultsTable({
    signal,
    fetchPage: cursor => requestQuizReview(user.uid, { action: "section-results", quizId: quiz.id, sectionId: section.id, cursor }, signal),
    reviewAnswers(student, _button, updateScore) {
      void openQuizReview(user, quiz, [section], section.id, {
        submission: student,
        onReviewed(grade) {
          if (signal.aborted) return;
          updateScore(grade);
          void loadSummary(user, section, signal);
        }
      });
    }
  });
  const cell = details.insertCell();
  cell.colSpan = 5;
  cell.append(table.element);
  const toggle = row.querySelector("button");
  toggle.addEventListener("click", () => {
    details.hidden = !details.hidden;
    toggle.setAttribute("aria-expanded", String(!details.hidden));
    if (!details.hidden) table.load();
  });
  row.dataset.quizId = quiz.id;
}

async function loadSummary(user, section, signal) {
  status.textContent = "Loading quiz totals…";
  try {
    const summary = await requestQuizReview(user.uid, { action: "section-summary", sectionId: section.id }, signal);
    const totals = new Map(summary.items.map(item => [item.quizId, item]));
    for (const row of body.querySelectorAll("[data-quiz-id]")) {
      const quiz = totals.get(row.dataset.quizId);
      row.cells[2].textContent = quiz?.average == null ? "—" : `${quiz.average}%`;
      row.cells[3].textContent = summary.learners;
      row.cells[4].firstElementChild.textContent = `${quiz?.submitted ?? 0}/${summary.learners} submitted`;
    }
    status.textContent = "";
  } catch (error) {
    if (signal.aborted) return;
    status.textContent = error.message;
  }
}

function renderSection() {
  pageRequest?.abort();
  pageRequest = new AbortController();
  const { signal } = pageRequest;
  const user = auth.currentUser, section = sections.find(item => item.id === filter.value);
  body.replaceChildren();
  const now = Date.now();
  const available = section ? quizzes.filter(quiz => quizAssignedToSection(quiz, section.id)
    && (quiz.availability === "now" || (quiz.availability === "scheduled" && Date.parse(quiz.availableAt) <= now))) : [];
  if (!available.length) {
    const cell = body.insertRow().insertCell();
    cell.colSpan = 5;
    cell.textContent = section ? "No published teacher quizzes for this section." : "No sections available.";
    status.textContent = "";
    return;
  }
  available.forEach((quiz, index) => renderQuiz(quiz, section, index, user, signal));
  return loadSummary(user, section, signal);
}

let loadGeneration = 0;
let sectionOwner, selectedSection = "";
async function loadChoices(user) {
  const generation = ++loadGeneration;
  closeQuizReview();
  pageRequest?.abort();
  selectedSection = sectionOwner === user?.uid ? filter.value || selectedSection : "";
  sectionOwner = user?.uid;
  filter.replaceChildren(new Option("Select a section", ""));
  filter.disabled = true;
  body.replaceChildren();
  sections = [];
  quizzes = [];
  refresh.disabled = true;
  status.textContent = "";
  if (user?.role !== "teacher") return;
  status.textContent = "Loading sections and quizzes…";
  try {
    const [classes, library] = await Promise.all([
      getDocs(query(collection(db, "classes"), where("teacherId", "==", user.id))),
      getDocs(query(collection(db, "generatedQuizzes"), where("teacherUid", "==", user.uid)))
    ]);
    if (generation !== loadGeneration) return;
    sections = classes.docs.map(doc => {
      const data = doc.data(), name = sectionName(data, doc.id);
      const grade = data.gradeLevel || data.GradeLevel;
      const gradeLabel = grade ? (/^grade\b/i.test(grade) ? grade : `Grade ${grade}`) : "";
      return { id: doc.id, name, label: gradeLabel ? `${gradeLabel} – ${name}` : name };
    }).sort((a, b) => a.name.localeCompare(b.name));
    quizzes = library.docs.map(doc => ({ ...doc.data(), id: doc.id }))
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    if (sections.length) {
      filter.replaceChildren(...sections.map(section => new Option(section.name, section.id)));
      if (sections.some(section => section.id === selectedSection)) filter.value = selectedSection;
      filter.disabled = false;
    }
    await renderSection();
  } catch (error) {
    if (generation !== loadGeneration) return;
    status.textContent = error.message || "Could not load quizzes.";
  } finally {
    if (generation === loadGeneration) refresh.disabled = false;
  }
}
filter.addEventListener("change", renderSection);
refresh.addEventListener("click", () => void loadChoices(auth.currentUser));
onAuthStateChanged(auth, loadChoices);
window.addEventListener("pagehide", () => { loadGeneration++; pageRequest?.abort(); });
