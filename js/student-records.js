import { getDocs as quietDocs, getDoc as quietDoc } from "./firebase-data.js";
import { showTeacherView } from "./teacher-view.js";
import { initializeApp } from "./firebase-auth.js";
import { getAuth, onAuthStateChanged } from "./firebase-auth.js";
import { getFirestore, collection, query, where, doc, updateDoc, deleteDoc, writeBatch, getDocsWithLoading as getDocs } from "./firebase-data.js";
import { loadClassReports } from "./teacher-report-data.js";
import { createPagePerformance } from "./page-performance.js";

const app = initializeApp();
const auth = getAuth(app);
const db = getFirestore(app);

const recordsContainer = document.getElementById("recordsContainer");
const emptyState = document.getElementById("emptyState");
const searchInput = document.getElementById("studentSearch");
const sectionFilter = document.getElementById("sectionFilter");
const archiveSectionButton = document.getElementById("archiveSectionBtn");

let dynamicCards = [];
let recordStatus = "active";
const escapeHTML = value => String(value).replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[character]);

const applyFilters = () => {
  const searchTerm = searchInput.value.trim().toLowerCase();
  const selectedSection = sectionFilter.value;
  let shown = 0;

  dynamicCards.forEach((card) => {
    const matchesName = card.dataset.name.includes(searchTerm);
    const matchesSection = !selectedSection || card.dataset.section === selectedSection;
    const visible = matchesName && matchesSection && (recordStatus === "archived" ? card.dataset.archived === "true" : card.dataset.archived !== "true");
    card.classList.toggle("hidden", !visible);
    if (visible) shown += 1;
  });

  const sectionActive = dynamicCards.filter(card => card.dataset.section === selectedSection && card.dataset.archived !== "true");
  archiveSectionButton.disabled = !selectedSection || recordStatus !== "active" || !sectionActive.length;
  archiveSectionButton.title = !selectedSection ? "Select a section first" : "Archive all active students in this section, including those hidden by search";
  emptyState.hidden = shown > 0;
  emptyState.textContent = "No " + recordStatus + " students match your filters.";
  const inSection = dynamicCards.filter(card => !selectedSection || card.dataset.section === selectedSection);
  document.getElementById("activeStudentsCount").textContent = inSection.filter(card => card.dataset.archived !== "true").length;
  document.getElementById("archivedStudentsCount").textContent = inSection.filter(card => card.dataset.archived === "true").length;
};

for (const status of ["active", "archived"]) document.getElementById(status + "StudentsTab").addEventListener("click", () => {
  recordStatus = status;
  for (const value of ["active", "archived"]) document.getElementById(value + "StudentsTab").setAttribute("aria-pressed", String(status === value));
  applyFilters();
});
searchInput.addEventListener("input", applyFilters);
sectionFilter.addEventListener("change", applyFilters);

// Helper to format minutes nicely
function formatMinutes(totalMinutes) {
  if (!totalMinutes || totalMinutes <= 0) return "-- min";
  if (totalMinutes < 1) return "< 1 min";
  return `${Math.round(totalMinutes)} min`;
}


onAuthStateChanged(auth, async user => {
  if (!user) { window.location.href = "login.html"; return; }
  const timing = createPagePerformance("Records");
  try {
    await showTeacherView({ app, user, page: "records",
      load: ({ background }) => timing.data(async () => {
        const readDocs = background ? quietDocs : getDocs;
        const profile = await readDocs(query(collection(db, "users"), where("uid", "==", user.uid)));
        if (profile.empty || String(profile.docs[0].data().role || "").toLowerCase() !== "teacher") throw Object.assign(new Error("No teacher profile was found for your account."), { code: "permission-denied" });
        const classes = await readDocs(query(collection(db, "classes"), where("teacherId", "==", profile.docs[0].id)));
        const sections = await loadClassReports(db, classes.docs, ["term_01", "term_02", "term_03"], readDocs);
        return { sections, message: classes.empty ? "No sections were found for your account." : "" };
      }),
      render: ({ sections, message }) => timing.render(() => {
        recordsContainer.innerHTML = "";
        const selectedSection = sectionFilter.value;
        sectionFilter.innerHTML = '<option value="">All Sections</option>';
        const cards = document.createDocumentFragment();
        for (const { classDoc, students } of sections) {
          const classCode = classDoc.id;
          const sectionName = classDoc.data().SectionName || classCode;
          const sectionOption = document.createElement("option");
          sectionOption.value = classCode;
          sectionOption.textContent = "Grade 6 – " + sectionName;
          sectionFilter.appendChild(sectionOption);

          for (const { studentDoc, results } of students) {
            const sData = studentDoc.data();

            const sName = sData.displayName || "Unknown Student";

            // Generate Initials
            const nameParts = sName.split(" ");
            let initials = nameParts[0] ? nameParts[0][0] : "?";
            if (nameParts.length > 1) initials += nameParts[nameParts.length - 1][0];
            initials = initials.toUpperCase();

            let studentPreSum = 0;
            let studentPostSum = 0;
            let testCount = 0;
            let totalArTime = 0;
            let totalModuleTime = 0;
            let lastActiveDate = new Date(0);

            // Check across all 3 terms
            for (const { lessonsSnap } of results) {
              lessonsSnap.forEach((lessonDoc) => {
                const tData = lessonDoc.data();

                // Pre-Test and Post-Test scores
                if (tData.isPreTestCompleted && tData.isPostTestCompleted && tData.preTestTotalQuestions > 0 && tData.postTestTotalQuestions > 0) {
                  const prePercent = (tData.preTestScore / tData.preTestTotalQuestions) * 100;
                  const rawPostScore = tData.postTestScore !== undefined ? tData.postTestScore : (tData.postTestHeatmap ? tData.postTestHeatmap.filter(Boolean).length : 0);
                  const postPercent = (rawPostScore / tData.postTestTotalQuestions) * 100;

                  studentPreSum += prePercent;
                  studentPostSum += postPercent;
                  testCount++;
                }

                // 1. AR Time (arTimeMinutes + arNavigationTimeMinutes)
                if (typeof tData.arTimeMinutes === "number") {
                  totalArTime += tData.arTimeMinutes;
                }
                if (typeof tData.arNavigationTimeMinutes === "number" && !tData.arTimeMinutes) {
                  totalArTime += tData.arNavigationTimeMinutes;
                }

                // 2. Module Time (lessonTimeMinutes)
                if (typeof tData.lessonTimeMinutes === "number") {
                  totalModuleTime += tData.lessonTimeMinutes;
                } else if (tData.learningTimeByDevice && typeof tData.learningTimeByDevice === "object") {
                  // Fallback: sum lessonSeconds across devices if lessonTimeMinutes isn't top-level
                  Object.values(tData.learningTimeByDevice).forEach((dev) => {
                    if (dev && typeof dev.lessonSeconds === "number") {
                      totalModuleTime += dev.lessonSeconds / 60;
                    }
                  });
                }

                // Last Active Timestamp
                const ts = tData.timestamp || tData.lastUpdated || tData.completedAt;
                if (ts) {
                  const testDate = ts.toDate ? ts.toDate() : new Date(ts);
                  if (!isNaN(testDate.getTime()) && testDate > lastActiveDate) {
                    lastActiveDate = testDate;
                  }
                }
              });
            }

            // Formatting data strings
            const avgPreStr = testCount > 0 ? `${Math.round(studentPreSum / testCount)}%` : "N/A";
            const avgPostNum = testCount > 0 ? Math.round(studentPostSum / testCount) : 0;
            const avgPostStr = testCount > 0 ? `${avgPostNum}%` : "N/A";
            const overallPercent = avgPostNum;

            const arTimeStr = formatMinutes(totalArTime);
            const moduleTimeStr = formatMinutes(totalModuleTime);

            const dateStr = lastActiveDate.getTime() > 0
              ? `Last active ${lastActiveDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
              : "No activity recorded";

            // Building the actual HTML Card
            const card = document.createElement("article");
            card.className = "record";
            card.dataset.studentId = studentDoc.id;
            card.dataset.archived = String(sData.active === false);
            card.dataset.name = sName.toLowerCase();
            card.dataset.section = classCode;

            card.innerHTML = `
              <div class="record-head">
                <div class="student">
                  <div class="avatar">${escapeHTML(initials)}</div>
                  <div>
                    <div style="display: flex; align-items: center; gap: 0.5rem;">
                      <strong>${escapeHTML(sName)}</strong>
                      ${sData.active === false ? '<span class="student-archive-badge">' + (sData.archiveReason === "graduated" ? "Graduated" : sData.archiveReason === "dropped-out" ? "Dropped out" : "Archived") + '</span><button type="button" class="unarchive-student-btn">Unarchive</button><button type="button" class="remove-student-btn">Delete</button>' : '<button type="button" class="archive-student-btn">Archive</button>'}
                    </div>
                    <small>Grade 6 – ${escapeHTML(sectionName)} · ${dateStr}</small>
                  </div>
                </div>
                <span class="overall">${overallPercent}% overall</span>
              </div>
              <div class="stats">
                <div class="stat"><span>AR Time</span><b class="c-pink">${arTimeStr}</b></div>
                <div class="stat"><span>Module Time</span><b class="c-cyan">${moduleTimeStr}</b></div>
                <div class="stat"><span>Pre-Test</span><b class="c-amber">${avgPreStr}</b></div>
                <div class="stat"><span>Post-Test</span><b class="c-green">${avgPostStr}</b></div>
              </div>
              <div class="record-progress-tile">
                <span class="record-progress-title">Overall performance</span>
                <div class="bar" role="progressbar" aria-label="Overall performance" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${overallPercent}"><i style="width:${overallPercent}%"></i></div>
                <strong class="record-progress-value">${overallPercent}%</strong>
              </div>
            `;
            for (const selector of [".archive-student-btn", ".unarchive-student-btn", ".remove-student-btn"]) {
            const button = card.querySelector(selector);
            if (button) {
              button.dataset.id = studentDoc.id;
              button.dataset.name = sName;
              button.setAttribute("aria-label", (selector === ".archive-student-btn" ? "Archive " : selector === ".unarchive-student-btn" ? "Unarchive " : "Delete ") + sName);
            }

            }
            cards.appendChild(card);
          }
        }

        recordsContainer.appendChild(cards);
        // Update DOM cache array to make the search filter function work
        dynamicCards = Array.from(recordsContainer.querySelectorAll(".record"));
        emptyState.textContent = "No students match the selected section or search.";
        if (Array.from(sectionFilter.options).some(option => option.value === selectedSection)) sectionFilter.value = selectedSection;
        applyFilters();
        if (message) { emptyState.textContent = message; emptyState.hidden = false; }
      }),
      painted: cacheHit => timing.finish("loaded", { cacheHit })
    });
  } catch (error) {
    console.error("Error loading student records:", error);
    emptyState.textContent = "Could not load student records. Please refresh to try again.";
    emptyState.hidden = false;
    timing.finish("error");
  }
});


const archiveModal = document.getElementById("archiveStudentModal");
const archiveForm = document.getElementById("archiveStudentForm");
const archiveReason = document.getElementById("archiveReason");
const archiveSave = document.getElementById("confirmArchiveStudent");
const archiveError = document.getElementById("archiveStudentError");
let archiveTarget;
let archiveSectionTargets = null;
document.getElementById("cancelArchiveStudent").addEventListener("click", () => {
  if (!archiveSave.disabled) archiveModal.classList.remove("open");
});
recordsContainer.addEventListener("click", event => {
  const button = event.target.closest(".archive-student-btn");
  if (!button) return;
  archiveSectionTargets = null;
  archiveTarget = { id: button.dataset.id, name: button.dataset.name };
  document.getElementById("archiveStudentTitle").textContent = "Archive student";
  archiveSave.textContent = "Archive student";
  archiveReason.value = "";
  archiveError.textContent = "";
  document.getElementById("archiveStudentName").textContent = archiveTarget.name;
  archiveModal.classList.add("open");
  archiveReason.focus();
});
archiveSectionButton.addEventListener("click", () => {
  if (archiveSectionButton.disabled) return;
  archiveSectionTargets = dynamicCards.filter(card => card.dataset.section === sectionFilter.value && card.dataset.archived !== "true").map(card => card.dataset.studentId);
  if (!archiveSectionTargets.length) return;
  archiveTarget = null;
  const label = Array.from(sectionFilter.options).find(option => option.value === sectionFilter.value)?.textContent || sectionFilter.value;
  document.getElementById("archiveStudentTitle").textContent = "Archive section";
  document.getElementById("archiveStudentName").textContent = label + " — " + archiveSectionTargets.length + " active students. This includes students hidden by the search filter.";
  archiveSave.textContent = "Archive " + archiveSectionTargets.length + " students";
  archiveReason.value = "";
  archiveError.textContent = "";
  archiveModal.classList.add("open");
  archiveReason.focus();
});
archiveForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (archiveSave.disabled || (!archiveTarget && !archiveSectionTargets?.length) || !["graduated", "dropped-out"].includes(archiveReason.value)) return;
  archiveSave.disabled = true;
  archiveSave.textContent = "Archiving…";
  archiveError.textContent = "";
  let savedCount = 0;
  try {
    const data = { active: false, deletedAt: new Date(), archiveReason: archiveReason.value };
    if (archiveSectionTargets) {
      // The server accepts at most 100 writes per atomic batch.
      while (archiveSectionTargets.length) {
        const group = archiveSectionTargets.slice(0, 100);
        const batch = writeBatch(db);
        for (const id of group) batch.update(doc(db, "users", id), data);
        await batch.commit();
        archiveSectionTargets.splice(0, group.length);
        savedCount += group.length;
      }
    } else await updateDoc(doc(db, "users", archiveTarget.id), data);
    archiveModal.classList.remove("open");
    window.location.reload();
  } catch (error) {
    console.error("Error archiving student:", error);
    archiveError.textContent = savedCount ? savedCount + " students archived. Some could not be archived. Retry to finish the remaining students, or refresh to see the current list." : "Could not archive the selected students. Please try again.";
  } finally {
    archiveSave.disabled = false;
    archiveSave.textContent = archiveSectionTargets?.length ? "Retry remaining students" : "Archive student";
  }
});

recordsContainer.addEventListener("click", async event => {
  const restore = event.target.closest(".unarchive-student-btn");
  const remove = event.target.closest(".remove-student-btn");
  const button = restore || remove;
  if (!button || button.disabled) return;
  const message = restore
    ? "Return " + button.dataset.name + " to the Active students list?"
    : "Delete the archived student profile for " + button.dataset.name + "? This cannot be undone. Existing lesson results and their sign-in account are not erased.";
  if (!window.confirm(message)) return;
  button.disabled = true;
  try {
    const reference = doc(db, "users", button.dataset.id);
    if (restore) await updateDoc(reference, { active: true, archiveReason: null, deletedAt: null });
    else await deleteDoc(reference);
    window.location.reload();
  } catch (error) {
    console.error("Student action failed:", error);
    window.alert(restore ? "Could not unarchive this student. Please try again." : "Could not delete this student. Please try again.");
    button.disabled = false;
  }
});
