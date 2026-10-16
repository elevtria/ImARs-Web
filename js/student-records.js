import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { getFirestore, collection, query, where, getDocsWithLoading as getDocs } from "./firebase-data.js";

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

// Firebase Loading Logic
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = "login.html";
    return;
  }

  try {
    const userQ = query(collection(db, "users"), where("uid", "==", user.uid));
    const userSnap = await getDocs(userQ);

    if (!userSnap.empty) {
      const teacherId = userSnap.docs[0].id; 
      
      const classQ = query(collection(db, "classes"), where("teacherId", "==", teacherId));
      const classSnap = await getDocs(classQ);
      
      if (classSnap.empty) {
        emptyState.textContent = "No sections were found for your account.";
        emptyState.hidden = false;
        return;
      }

      recordsContainer.innerHTML = "";
      sectionFilter.innerHTML = '<option value="">All Sections</option>';

      const terms = ["term_01", "term_02", "term_03"];

      for (const classDoc of classSnap.docs) {
        const classCode = classDoc.id;
        const sectionName = classDoc.data().SectionName || classCode;
        const sectionOption = document.createElement("option");
        sectionOption.value = classCode;
        sectionOption.textContent = "Grade 6 – " + sectionName;
        sectionFilter.appendChild(sectionOption);

        const studentQ = query(collection(db, "users"), where("role", "==", "student"), where("classCode", "==", classCode));
        const studentSnap = await getDocs(studentQ);
        
        for (const studentDoc of studentSnap.docs) {
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
          for (const termId of terms) {
            const lessonsRef = collection(db, "users", studentDoc.id, "test_results", termId, "lessons");
            const lessonsSnap = await getDocs(lessonsRef);

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
            <div class="avatar">${initials}</div>
            <div>
              <div style="display: flex; align-items: center; gap: 0.5rem;">
                <strong>${sName}</strong>
                <button type="button" class="edit-student-btn" style="background: none; border: none; cursor: pointer; color: #64748b;" 
                        data-id="${studentDoc.id}" 
                        data-name="${sName.replace(/"/g, '&quot;')}" 
                        data-email="${(sData.email || "").replace(/"/g, '&quot;')}">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </button>
              </div>
              <small>Grade 6 – ${sectionName} · ${dateStr}</small>
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
          
          recordsContainer.appendChild(card);
        }
      }
      
      // Update DOM cache array to make the search filter function work
      dynamicCards = Array.from(document.querySelectorAll(".record"));
      emptyState.textContent = "No students match the selected section or search.";
      applyFilters();
    }
  } catch (error) {
    console.error("Error loading student records:", error);
  }
});

// --- Edit Profile Logic ---
const editModal = document.getElementById("editStudentModal");
const editForm = document.getElementById("editStudentForm");
const idInput = document.getElementById("editStudentId");
const nameInput = document.getElementById("editFullName");
const emailInput = document.getElementById("editEmail");
const saveBtn = document.getElementById("saveEditBtn");

document.getElementById("cancelEditBtn").addEventListener("click", () => editModal.classList.remove("open"));

// Use event delegation so it works on dynamically generated cards
recordsContainer.addEventListener("click", (e) => {
  const btn = e.target.closest(".edit-student-btn");
  if (!btn) return;
  
  idInput.value = btn.dataset.id;
  nameInput.value = btn.dataset.name;
  emailInput.value = btn.dataset.email;
  editModal.classList.add("open");
});

editForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  saveBtn.disabled = true;
  saveBtn.textContent = "Saving...";

  try {
    const studentRef = doc(db, "users", idInput.value);
    await updateDoc(studentRef, {
      displayName: nameInput.value.trim(),
      fullName: nameInput.value.trim(),
      email: emailInput.value.trim().toLowerCase(),
      providedEmail: emailInput.value.trim().toLowerCase()
    });
    
    editModal.classList.remove("open");
    // Reload the page to reflect the fresh data in the UI
    window.location.reload();
  } catch (err) {
    console.error("Error updating student:", err);
    alert("Failed to update student profile.");
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Save Changes";
  }
});