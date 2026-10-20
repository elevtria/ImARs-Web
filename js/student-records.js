import { getDocs as quietDocs, getDoc as quietDoc } from "./firebase-data.js";
import { showTeacherView } from "./teacher-view.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "./firebase-auth.js";
import { getFirestore, collection, query, where, doc, updateDoc, getDocsWithLoading as getDocs } from "./firebase-data.js";
import { loadClassReports } from "./teacher-report-data.js";
import { createPagePerformance } from "./page-performance.js";

const firebaseConfig = {
  apiKey: "AIzaSyBwH8D-mJSpjqu_C7Y7e7ljCjSZiO7FTm0",
  authDomain: "imars-db-a733b.firebaseapp.com",
  projectId: "imars-db-a733b",
  storageBucket: "imars-db-a733b.firebasestorage.app",
  messagingSenderId: "539058786779",
  appId: "1:539058786779:web:201076a476a471a0bdd7fe",
  measurementId: "G-TEERTREQF3"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const recordsContainer = document.getElementById("recordsContainer");
const emptyState = document.getElementById("emptyState");
const searchInput = document.getElementById("studentSearch");
const sectionFilter = document.getElementById("sectionFilter");

let dynamicCards = [];
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
    const visible = matchesName && matchesSection;
    card.classList.toggle("hidden", !visible);
    if (visible) shown += 1;
  });

  emptyState.hidden = shown > 0;
};

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
            if (sData.active === false) continue;
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
            card.dataset.name = sName.toLowerCase();
            card.dataset.section = classCode;

            card.innerHTML = `
              <div class="record-head">
                <div class="student">
                  <div class="avatar">${escapeHTML(initials)}</div>
                  <div>
                    <div style="display: flex; align-items: center; gap: 0.5rem;">
                      <strong>${escapeHTML(sName)}</strong>
                      <button type="button" class="edit-student-btn" style="background: none; border: none; cursor: pointer; color: #64748b;">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                      </button>
                      <button type="button" class="delete-student-btn" style="background: none; border: none; cursor: pointer; color: #ef4444;">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                      </button>
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
              <div class="bar" aria-label="${overallPercent} percent overall"><i style="width:${overallPercent}%"></i></div>
            `;
            for (const [selector, action] of [[".edit-student-btn", "Edit"], [".delete-student-btn", "Archive"]]) {
              const button = card.querySelector(selector);
              button.dataset.id = studentDoc.id;
              button.dataset.name = sName;
              button.setAttribute("aria-label", `${action} ${sName}`);
            }

            cards.appendChild(card);
          }
        }

        recordsContainer.appendChild(cards);
        // Update DOM cache array to make the search filter function work
        dynamicCards = Array.from(document.querySelectorAll(".record"));
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

// Keep the incoming edit/archive actions while using cache-invalidating writes.
const editModal = document.getElementById("editStudentModal");
const editForm = document.getElementById("editStudentForm");
const idInput = document.getElementById("editStudentId");
const nameInput = document.getElementById("editFullName");
const emailInput = document.getElementById("editEmail");
const saveBtn = document.getElementById("saveEditBtn");
let editRequest = 0;

document.getElementById("cancelEditBtn").addEventListener("click", () => {
  editRequest++;
  editModal.classList.remove("open");
});

recordsContainer.addEventListener("click", async event => {
  const editBtn = event.target.closest(".edit-student-btn");
  if (editBtn) {
    const request = ++editRequest;
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    idInput.value = editBtn.dataset.id;
    nameInput.value = editBtn.dataset.name;
    emailInput.value = "";
    saveBtn.disabled = true;
    saveBtn.textContent = "Loading...";
    editModal.classList.add("open");
    try {
      // Saved report views intentionally omit email addresses. Read the current
      // profile when editing so returning to a saved view cannot blank an email.
      const profile = await quietDoc(doc(db, "users", editBtn.dataset.id));
      if (request !== editRequest || auth.currentUser?.uid !== uid) return;
      if (!profile.exists() || profile.data().active === false) throw new Error("Student is no longer available.");
      const data = profile.data();
      nameInput.value = data.displayName || data.fullName || editBtn.dataset.name;
      emailInput.value = data.email || data.providedEmail || "";
    } catch (error) {
      if (request !== editRequest || auth.currentUser?.uid !== uid) return;
      editModal.classList.remove("open");
      console.error("Error loading student profile:", error);
      alert("Could not load the current student profile. Please retry.");
    } finally {
      if (request === editRequest && auth.currentUser?.uid === uid) {
        saveBtn.disabled = false;
        saveBtn.textContent = "Save Changes";
      }
    }
    return;
  }

  const delBtn = event.target.closest(".delete-student-btn");
  if (delBtn && confirm(`Are you sure you want to archive ${delBtn.dataset.name}?\n\nTheir data is kept for recovery but hidden from this list.`)) {
    try {
      await updateDoc(doc(db, "users", delBtn.dataset.id), { active: false, deletedAt: new Date() });
      window.location.reload();
    } catch (error) {
      console.error("Error archiving student:", error);
      alert("Failed to archive student.");
    }
  }
});

editForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (saveBtn.disabled) return;
  saveBtn.disabled = true;
  saveBtn.textContent = "Saving...";
  try {
    await updateDoc(doc(db, "users", idInput.value), {
      displayName: nameInput.value.trim(),
      fullName: nameInput.value.trim(),
      email: emailInput.value.trim().toLowerCase(),
      providedEmail: emailInput.value.trim().toLowerCase()
    });
    editModal.classList.remove("open");
    window.location.reload();
  } catch (error) {
    console.error("Error updating student:", error);
    alert("Failed to update student profile.");
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Save Changes";
  }
});
