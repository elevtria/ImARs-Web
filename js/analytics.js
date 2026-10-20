import { getDocs as quietDocs, getDoc as quietDoc } from "./firebase-data.js";
import { showTeacherView } from "./teacher-view.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getFirestore,
  collection,
  query,
  where,
  getDocsWithLoading as getDocs
} from "./firebase-data.js";
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

const empty = document.getElementById("emptyState");
const search = document.getElementById("studentSearch");
const sectionFilter = document.getElementById("sectionFilter");
const sectionSummary = document.getElementById("sectionSummary");
const studentCount = document.getElementById("studentCount");
const studentGrid = document.querySelector("#studentGrid tbody");
const topicsContainer = document.getElementById("topicsContainer");

let dynamicRows = [];
let allTopicStats = []; // Store fetched topics globally for term filtering
let currentTermFilter = "all";

// Term label map
const termLabels = {
  term_01: "Term 1",
  term_02: "Term 2",
  term_03: "Term 3"
};

// Filtering logic for students
const filterStudents = () => {
  const queryText = (search?.value || "").trim().toLowerCase();
  const selectedSection = sectionFilter?.value || "all";
  let shown = 0;

  dynamicRows.forEach((row) => {
    const matchesName = row.dataset.name.includes(queryText);
    const matchesSection = selectedSection === "all" || row.dataset.section === selectedSection;
    const visible = matchesName && matchesSection;

    if (visible) {
      row.style.display = "";
      shown += 1;
    } else {
      row.style.display = "none";
    }
  });

  if (studentCount) studentCount.textContent = shown;
  const selectedText = sectionFilter?.options[sectionFilter.selectedIndex]?.textContent || "All Sections";
  if (sectionSummary) sectionSummary.textContent = selectedSection === "all" ? "All Sections" : selectedText;

  if (empty) {
    empty.hidden = shown > 0;
    if (shown === 0 && studentGrid) studentGrid.appendChild(empty);
  }
};

if (search) search.addEventListener("input", filterStudents);
if (sectionFilter) sectionFilter.addEventListener("change", filterStudents);

// Topic rendering by term filter
function renderTopics(baseStudents) {
  if (!topicsContainer) return;
  topicsContainer.innerHTML = "";

  const filteredTopics = allTopicStats.filter((t) =>
    currentTermFilter === "all" || t.termId === currentTermFilter
  );

  if (filteredTopics.length === 0) {
    topicsContainer.innerHTML = `<p style="grid-column: 1 / -1; text-align: center; color: #64748b; padding: 20px;">No lessons found for this term.</p>`;
    return;
  }

  filteredTopics.forEach((stat) => {
    const completionRate = Math.min(100, Math.round((stat.completedCount / baseStudents) * 100));
    const fillDash = ((completionRate / 100) * 289.03).toFixed(1);
    const termTag = termLabels[stat.termId] || stat.termId;

    const topicEl = document.createElement("div");
    topicEl.className = "topic";
    topicEl.style.textAlign = "center";
    topicEl.innerHTML = `
      <div class="mini-wrap" style="width:120px;height:120px;margin:0 auto 10px;position:relative;">
        <svg viewBox="0 0 120 120" style="width:100%;height:100%;transform:rotate(-90deg);">
          <circle class="track" cx="60" cy="60" r="46" fill="none" stroke="#eef1f6" stroke-width="12" />
          ${completionRate > 0 ? `
            <circle cx="60" cy="60" r="46" fill="none" stroke="#81A2C1" stroke-width="12" stroke-linecap="round" stroke-dasharray="${fillDash} 289.03" />
          ` : ""}
        </svg>
      </div>
      <strong style="font-size: 1.25rem; display: block;">${completionRate}%</strong>
      <span style="display:inline-block; font-size: 0.72rem; font-weight: 700; color: #4f46e5; background: #eef2ff; padding: 2px 8px; border-radius: 9999px; margin-bottom: 4px;">${termTag}</span>
      <span style="display:block; max-width: 150px; margin: 0 auto; line-height: 1.25; font-size: 0.85rem; font-weight: 600; color: #374151;">${stat.name}</span>
    `;
    topicsContainer.appendChild(topicEl);
  });
}

// Term tab switcher events
const termButtons = document.querySelectorAll(".term-tab-btn");
termButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    termButtons.forEach((b) => {
      b.style.background = "#fff";
      b.style.color = "#374151";
    });
    btn.style.background = "#4f46e5";
    btn.style.color = "#fff";
    currentTermFilter = btn.dataset.term;
    renderTopics(window.totalStudentsBase || 1);
  });
});


onAuthStateChanged(auth, async user => {
  if (!user) { window.location.href = "login.html"; return; }
  const timing = createPagePerformance("Analytics");
  const terms = ["term_01", "term_02", "term_03"];
  try {
    await showTeacherView({ app, user, page: "analytics",
      load: ({ background }) => timing.data(async () => {
        const readDocs = background ? quietDocs : getDocs;
        const [profile, curriculum] = await Promise.all([
          readDocs(query(collection(db, "users"), where("uid", "==", user.uid))),
          Promise.all(terms.map(termId => readDocs(collection(db, "terms", termId, "lessons"))))
        ]);
        const teacherId = profile.docs[0]?.id;
        if (!teacherId || String(profile.docs[0].data().role || "").toLowerCase() !== "teacher") throw Object.assign(new Error("No teacher profile was found for your account."), { code: "permission-denied" });
        const classes = await readDocs(query(collection(db, "classes"), where("teacherId", "==", teacherId)));
        return { curriculum, sections: await loadClassReports(db, classes.docs, terms, readDocs) };
      }),
      render: ({ curriculum, sections }) => timing.render(() => {
        const topicStatsMap = new Map();
        for (const [index, termLessonsSnap] of curriculum.entries()) {
        const termId = terms[index];
        termLessonsSnap.forEach((lDoc) => {
          const lData = lDoc.data();
          const title = lData.title || lData.name || lDoc.id;

          // COMPOSITE KEY prevents term_03 from overwriting term_01 & term_02
          const compositeKey = `${termId}_${lDoc.id}`;

          topicStatsMap.set(compositeKey, {
            key: compositeKey,
            lessonId: lDoc.id,
            termId: termId,
            name: title,
            completedCount: 0
          });
        });
    }
      let totalClassPrePercentageSum = 0;
      let totalClassPostPercentageSum = 0;
      let totalStudentTestsCount = 0;
      let totalEnrolledStudents = 0;

      const selectedSection = sectionFilter?.value;
      if (sectionFilter) sectionFilter.innerHTML = '<option value="all">All Sections</option>';
      if (studentGrid) {
        studentGrid.innerHTML = "";
        if (empty) studentGrid.appendChild(empty);
      }

      // 4. Process Classes and Students
      const rows = document.createDocumentFragment();
      for (const { classDoc, students } of sections) {
        const classCode = classDoc.id;
        const cData = classDoc.data();
        const sectionName = cData.SectionName || cData.sectionName || cData.name || classCode;

        if (sectionFilter) {
          const opt = document.createElement("option");
          opt.value = classCode;
          opt.textContent = `Grade 6 – ${sectionName}`;
          sectionFilter.appendChild(opt);
        }

        for (const { studentDoc, results } of students) {
          totalEnrolledStudents++;
          const sData = studentDoc.data();
          const sName = sData.displayName || sData.fullName || "Student";

          const nameParts = sName.split(" ");
          let initials = nameParts[0] ? nameParts[0][0] : "?";
          if (nameParts.length > 1) initials += nameParts[nameParts.length - 1][0];

          let studentPreSum = 0;
          let studentPostSum = 0;
          let testCount = 0;

          // Check tests across all active terms
          for (const { termId, lessonsSnap } of results) {
            lessonsSnap.forEach((lessonDoc) => {
              const tData = lessonDoc.data();
              const compositeKey = `${termId}_${lessonDoc.id}`;

              // Check completion for the matching term & lesson
              if (topicStatsMap.has(compositeKey)) {
                if (tData.isPostTestCompleted || tData.completed) {
                  topicStatsMap.get(compositeKey).completedCount++;
                }
              } else if (tData.isPostTestCompleted || tData.completed) {
                // Fallback if document has customized title
                const fallbackTitle = tData.topicTitle || tData.title || lessonDoc.id;
                topicStatsMap.set(compositeKey, {
                  key: compositeKey,
                  lessonId: lessonDoc.id,
                  termId: termId,
                  name: fallbackTitle,
                  completedCount: 1
                });
              }

              // Aggregate test scores
              if (tData.isPreTestCompleted && tData.preTestTotalQuestions > 0 && tData.isPostTestCompleted && tData.postTestTotalQuestions > 0) {
                const prePercent = (tData.preTestScore / tData.preTestTotalQuestions) * 100;
                const rawPostScore = tData.postTestScore !== undefined ? tData.postTestScore : (tData.postTestHeatmap ? tData.postTestHeatmap.filter(Boolean).length : 0);
                const postPercent = (rawPostScore / tData.postTestTotalQuestions) * 100;

                studentPreSum += prePercent;
                studentPostSum += postPercent;
                testCount++;
              }
            });
          }

          if (testCount > 0) {
            const avgPre = Math.round(studentPreSum / testCount);
            const avgPost = Math.round(studentPostSum / testCount);
            const improvement = avgPost - avgPre;

            totalClassPrePercentageSum += avgPre;
            totalClassPostPercentageSum += avgPost;
            totalStudentTestsCount++;

            const tr = document.createElement("tr");
            tr.className = "student-row";
            tr.dataset.name = sName.toLowerCase();
            tr.dataset.section = classCode;

            const impClass = improvement > 0 ? "c-green" : improvement < 0 ? "c-danger" : "";
            const impSign = improvement > 0 ? "+" : "";

            tr.innerHTML = `
              <th scope="row"><span class="table-avatar">${initials.toUpperCase()}</span>${sName}</th>
              <td>Grade 6 – ${sectionName}</td>
              <td>${avgPre}%</td>
              <td>${avgPost}%</td>
              <td><span class="improvement-value ${impClass}">${impSign}${improvement}%</span></td>
            `;

            rows.appendChild(tr);
          }
        }
      }

      if (studentGrid) {
        studentGrid.appendChild(rows);
        dynamicRows = Array.from(studentGrid.querySelectorAll(".student-row"));
      }
      if (sectionFilter && Array.from(sectionFilter.options).some(option => option.value === selectedSection)) sectionFilter.value = selectedSection;
      filterStudents();

      // 5. Update Overall Class Averages
      {
        const finalPre = totalStudentTestsCount ? Math.round(totalClassPrePercentageSum / totalStudentTestsCount) : 0;
        const finalPost = totalStudentTestsCount ? Math.round(totalClassPostPercentageSum / totalStudentTestsCount) : 0;
        const finalImp = finalPost - finalPre;

        const preVal = document.getElementById("overallPreVal");
        const preFill = document.getElementById("overallPreFill");
        if (preVal) preVal.textContent = `${finalPre}%`;
        if (preFill) preFill.style.width = `${finalPre}%`;

        const postVal = document.getElementById("overallPostVal");
        const postFill = document.getElementById("overallPostFill");
        if (postVal) postVal.textContent = `${finalPost}%`;
        if (postFill) postFill.style.width = `${finalPost}%`;

        const impVal = document.getElementById("overallImpVal");
        const impFill = document.getElementById("overallImpFill");
        if (impVal) impVal.textContent = `${finalImp >= 0 ? "+" : ""}${finalImp}%`;
        if (impFill) impFill.style.width = `${Math.min(100, Math.abs(finalImp))}%`;

        const donutLabel = document.getElementById("donutValue");
        if (donutLabel) donutLabel.textContent = `${finalPost}%`;

        const donutRing = document.getElementById("donutRing");
        if (donutRing) {
          const donutFillAmount = (finalPost / 100) * 289.03;
          donutRing.setAttribute("stroke-dasharray", `${donutFillAmount} 289.03`);
        }
      }

      // 6. Store topics globally and render
      allTopicStats = Array.from(topicStatsMap.values());
      window.totalStudentsBase = Math.max(1, totalEnrolledStudents);
      renderTopics(window.totalStudentsBase);
      }),
      painted: cacheHit => timing.finish("loaded", { cacheHit })
    });
  } catch (error) {
    console.error("Error loading analytics:", error);
    if (topicsContainer) topicsContainer.innerHTML = '<p style="grid-column: 1 / -1; text-align: center; color: #ef4444; padding: 20px;">Error loading topic rates.</p>';
    timing.finish("error");
  }
});
