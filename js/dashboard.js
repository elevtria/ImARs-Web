import { getDocs as quietDocs, getDoc as quietDoc } from "./firebase-data.js";
import { showTeacherView, escapeHtml } from "./teacher-view.js";
import { initializeApp, getAuth, onAuthStateChanged } from "./firebase-auth.js";
import { getFirestore, getDocsWithLoading as getDocs, getDocWithLoading as getDoc } from "./firebase-data.js";
import { createPagePerformance } from "./page-performance.js";
import { loadTeacherDashboard } from "./teacher-report-data.js";

const app = initializeApp();
const auth = getAuth(app);
const db = getFirestore(app);

// --- EXISTING UI LOGIC ---
const drawer = document.getElementById("drawer");
const openDrawer = () => { drawer.classList.add("open"); drawer.setAttribute("aria-hidden", "false"); };
const closeDrawer = () => { drawer.classList.remove("open"); drawer.setAttribute("aria-hidden", "true"); };
document.getElementById("menuBtn").onclick = openDrawer;
drawer.onclick = (e) => { if (e.target === drawer) closeDrawer(); };

const accountBtn = document.getElementById("accountBtn");
const accountMenu = document.getElementById("accountMenu");
accountBtn.onclick = (e) => {
  e.stopPropagation();
  accountMenu.hidden = !accountMenu.hidden;
};
document.addEventListener("click", (e) => {
  if (!e.target.closest(".account")) accountMenu.hidden = true;
});

document.getElementById("helpBtn").onclick = () => {
  window.location.href = "teacher-manual.html";
};

// --- FIREBASE AUTH & FIRESTORE LOGIC ---
const hour = new Date().getHours();
const part = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";


onAuthStateChanged(auth, async user => {
  if (!user) { window.location.href = "login.html"; return; }
  const timing = createPagePerformance("Dashboard");
  try {
    await showTeacherView({ app, user, page: "dashboard", freshForMs: 10000,
      load: async ({ background }) => {
        const readDocs = background ? quietDocs : getDocs;
        const readDoc = background ? quietDoc : getDoc;
        return timing.data(() => loadTeacherDashboard(db, user, readDocs, readDoc));
      },
      render: ({ teacherName, noClass, sectionName, studentSnap, reports, termSnap, curriculumSnap }) => timing.render(() => {
        document.getElementById("greeting").textContent = "Good " + part + ", " + teacherName + " !";
        if (noClass) {
          document.getElementById("classInfo").textContent = "No classes assigned yet.";
          document.getElementById("studentTableBody").replaceChildren();
          document.getElementById("modulesContainer").replaceChildren();
          document.getElementById("studentCountVal").textContent = "0";
          document.getElementById("avgPreTestVal").textContent = "0/5";
          document.getElementById("avgPostTestVal").textContent = "0/10";
          document.getElementById("avgArTimeVal").textContent = "0 min";
          return;
        }
        document.getElementById("classInfo").textContent = "Grade 6 – " + sectionName;
            document.getElementById("studentCountVal").textContent = studentSnap.size;

            let totalPreTestSum = 0;
            let preTestCount = 0;
            let totalPostTestSum = 0;
            let postTestCount = 0;

            // ADDED: Class-wide AR trackers
            let totalClassArTime = 0;
            let studentsWithArTime = 0;

            const activeLessons = new Set();

            // 2. Clear the table body to inject dynamic rows
            const studentTableBody = document.getElementById("studentTableBody");
            studentTableBody.innerHTML = "";

            const rows = document.createDocumentFragment();
            for (const { studentDoc, lessonsSnap } of reports) {
                const sData = studentDoc.data();

                // Generate Initials (e.g., Ana Cruz -> AC)
                const sName = sData.displayName || "Unknown Student";
                const nameParts = sName.split(" ");
                let initials = nameParts[0] ? nameParts[0][0] : "?";
                if (nameParts.length > 1) initials += nameParts[nameParts.length - 1][0];
                initials = initials.toUpperCase();

                // Variables to track stats specific to this one student
                let sPreSum = 0, sPreCount = 0;
                let sPostSum = 0, sPostCount = 0;
                let lastActiveDate = new Date(0); // Epoch start

                // ADDED: Track individual student AR time
                let studentTotalArTime = 0;

                lessonsSnap.forEach((lessonDoc) => {
                    const testData = lessonDoc.data();

                    if (testData.isPreTestCompleted || testData.isPostTestCompleted) {
                        activeLessons.add(lessonDoc.id);
                    }

                    if (testData.isPreTestCompleted && testData.preTestTotalQuestions > 0) {
                        totalPreTestSum += testData.preTestScore;
                        preTestCount++;
                        sPreSum += testData.preTestScore;
                        sPreCount++;
                    }

                    if (testData.isPostTestCompleted && testData.postTestTotalQuestions > 0) {
                        const postScore = testData.postTestScore !== undefined
                            ? testData.postTestScore
                            : (testData.postTestHeatmap || []).filter(Boolean).length;

                        const normalizedPost = (postScore / testData.postTestTotalQuestions) * 10;
                        totalPostTestSum += normalizedPost;
                        postTestCount++;
                        sPostSum += normalizedPost;
                        sPostCount++;
                    }

                    // ADDED: Fetch AR Time from Firebase
                    if (testData.arTimeMinutes) {
                        studentTotalArTime += testData.arTimeMinutes;
                    }

                    // Parse timestamp to find the most recent activity
                    if (testData.timestamp) {
                        const testDate = testData.timestamp.toDate ? testData.timestamp.toDate() : new Date(testData.timestamp);
                        if (testDate > lastActiveDate) lastActiveDate = testDate;
                    }
                });

                // ADDED: Update class-wide AR totals if this student had any AR time
                if (studentTotalArTime > 0) {
                    totalClassArTime += studentTotalArTime;
                    studentsWithArTime++;
                }

                // Format row data for this student as whole numbers (integers)
                const sPreStr = sPreCount > 0 ? `${Math.round(sPreSum / sPreCount)}/5` : "N/A";
                const sPostStr = sPostCount > 0 ? `${Math.round(sPostSum / sPostCount)}/10` : "N/A";
                const sPostStyle = sPostCount > 0 ? "score-up" : "muted-cell"; // Make it green if they have a score

                // ADDED: Format AR Time string for the table
                const sArTimeStr = studentTotalArTime > 0 ? `${studentTotalArTime} min` : "-- min";

                let dateStr = "No activity";
                if (lastActiveDate.getTime() > 0) {
                    dateStr = lastActiveDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                }

                // Inject the row into the table
                const tr = document.createElement("tr");
                tr.innerHTML = `
                  <td>
                    <div class="student">
                      <div class="avatar">${escapeHtml(initials)}</div>
                      <div>
                        <strong>${escapeHtml(sName)}</strong>
                        <small>Grade 6 – ${escapeHtml(sectionName)}</small>
                      </div>
                    </div>
                  </td>
                  <td class="muted-cell">${sPreStr}</td>
                  <td class="${sPostStyle}">${sPostStr}</td>
                  <td class="muted-cell">${sArTimeStr}</td>
                  <td class="muted-cell">${dateStr}</td>
                `;
                rows.appendChild(tr);
            }
            studentTableBody.appendChild(rows);

            // Finalize Global Class Averages as whole numbers (integers)
            const avgPre = preTestCount > 0 ? Math.round(totalPreTestSum / preTestCount) : 0;
            const avgPost = postTestCount > 0 ? Math.round(totalPostTestSum / postTestCount) : 0;

            // ADDED: Calculate overall average AR Time
            const avgArTime = studentsWithArTime > 0 ? Math.round(totalClassArTime / studentsWithArTime) : 0;

            document.getElementById("avgPreTestVal").textContent = `${avgPre}/5`;
            document.getElementById("avgPostTestVal").textContent = `${avgPost}/10`;

            // ADDED: Push calculated AR time to the top stat card
            const avgArEl = document.getElementById("avgArTimeVal");
            if (avgArEl) avgArEl.textContent = `${avgArTime} min`;

            // --- FETCH & RENDER CURRICULUM MODULES ---
            if (termSnap.exists()) {
                const termTitle = termSnap.data().title || "Term 1";
                document.getElementById("currentTermHeader").textContent = `Current Term — ${termTitle}`;
            }

            const modulesContainer = document.getElementById("modulesContainer");
            modulesContainer.innerHTML = "";

            const sortedLessons = curriculumSnap.docs.sort((a, b) => a.id.localeCompare(b.id));

            let lessonCounter = 1;
            sortedLessons.forEach((lessonDoc) => {
                const lessonData = lessonDoc.data();
                const lessonTitle = lessonData.title || `Lesson ${lessonCounter}`;

                const isStarted = activeLessons.has(lessonDoc.id);
                const badgeClass = isStarted ? "done" : "next";
                const statusText = isStarted ? "Active/Completed" : "Upcoming";

                const moduleHTML = `
                  <article class="module">
                    <div class="badge ${badgeClass}">${lessonCounter}</div>
                    <div>
                      <h3>${escapeHtml(lessonTitle)}</h3>
                      <span>${statusText}</span>
                    </div>
                  </article>
                `;
                modulesContainer.insertAdjacentHTML('beforeend', moduleHTML);

                lessonCounter++;
            });
      }),
      painted: cacheHit => timing.finish("loaded", { cacheHit })
    });
  } catch (error) {
    console.error("Error fetching teacher data:", error);
    const info = document.getElementById("classInfo");
    if (info) info.textContent = "Could not load your class data. Please refresh to try again.";
    timing.finish("error");
  }
});
