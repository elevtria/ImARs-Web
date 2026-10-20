import { getDocs as quietDocs, getDoc as quietDoc } from "./firebase-data.js";
import { showTeacherView } from "./teacher-view.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { getFirestore, collection, query, where, getDocsWithLoading as getDocs } from "./firebase-data.js";
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
                  <div class="avatar">${initials}</div>
                  <div>
                    <strong>${sName}</strong>
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
