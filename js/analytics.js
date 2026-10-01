import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { getFirestore, collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

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

// Array to store dynamically loaded rows
let dynamicRows = [];

// Filtering logic modified to handle dynamic rows
const filterStudents = () => {
  const queryText = search.value.trim().toLowerCase();
  const selectedSection = sectionFilter.value;
  let shown = 0;

  dynamicRows.forEach((row) => {
    const matchesName = row.dataset.name.includes(queryText);
    const matchesSection = selectedSection === "all" || row.dataset.section === selectedSection;
    const visible = matchesName && matchesSection;
    
    if (visible) {
      row.style.display = ""; // Show
      shown += 1;
    } else {
      row.style.display = "none"; // Hide
    }
  });

  studentCount.textContent = shown;
  const selectedText = sectionFilter.options[sectionFilter.selectedIndex]?.textContent || "All Sections";
  sectionSummary.textContent = selectedSection === "all" ? "All Sections" : selectedText;
  
  if (empty) {
    empty.hidden = shown > 0;
    if (shown === 0 && studentGrid) studentGrid.appendChild(empty);
  }
};

search.addEventListener("input", filterStudents);
sectionFilter.addEventListener("change", filterStudents);

// Main Firebase Logic
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
      
      if (classSnap.empty) return;
      
      let totalClassPrePercentageSum = 0;
      let totalClassPostPercentageSum = 0;
      let totalStudentTestsCount = 0;
      
      // Reset UI to clear static HTML data
      sectionFilter.innerHTML = '<option value="all">All Sections</option>';
      if (studentGrid) {
        studentGrid.innerHTML = "";
        if (empty) studentGrid.appendChild(empty);
      }

      // Process Classes and Students
      for (const classDoc of classSnap.docs) {
          const classCode = classDoc.id;
          const sectionName = classDoc.data().SectionName || classCode;
          
          const opt = document.createElement("option");
          opt.value = classCode;
          opt.textContent = `Grade 6 – ${sectionName}`;
          sectionFilter.appendChild(opt);
          
          const studentQ = query(collection(db, "users"), where("role", "==", "student"), where("classCode", "==", classCode));
          const studentSnap = await getDocs(studentQ);
          
          for (const studentDoc of studentSnap.docs) {
              const sData = studentDoc.data();
              const sName = sData.displayName || "Unknown";
              
              // Generate Initials
              const nameParts = sName.split(" ");
              let initials = nameParts[0] ? nameParts[0][0] : "?";
              if (nameParts.length > 1) initials += nameParts[nameParts.length - 1][0];
              
              const lessonsRef = collection(db, "users", studentDoc.id, "test_results", "term_01", "lessons");
              const lessonsSnap = await getDocs(lessonsRef);
              
              let studentPreSum = 0;
              let studentPostSum = 0;
              let testCount = 0;

              lessonsSnap.forEach((lessonDoc) => {
                  const tData = lessonDoc.data();
                  if (tData.isPreTestCompleted && tData.isPostTestCompleted && tData.preTestTotalQuestions > 0 && tData.postTestTotalQuestions > 0) {
                      const prePercent = (tData.preTestScore / tData.preTestTotalQuestions) * 100;
                      
                      const rawPostScore = tData.postTestScore !== undefined ? tData.postTestScore : tData.postTestHeatmap.filter(Boolean).length;
                      const postPercent = (rawPostScore / tData.postTestTotalQuestions) * 100;
                      
                      studentPreSum += prePercent;
                      studentPostSum += postPercent;
                      testCount++;
                  }
              });
              
              if (testCount > 0) {
                  const avgPre = Math.round(studentPreSum / testCount);
                  const avgPost = Math.round(studentPostSum / testCount);
                  const improvement = avgPost - avgPre;
                  
                  totalClassPrePercentageSum += avgPre;
                  totalClassPostPercentageSum += avgPost;
                  totalStudentTestsCount++;
                  
                  // Inject dynamic row into table
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
                  
                  if (studentGrid) studentGrid.appendChild(tr);
              }
          }
      }
      
      // Rebuild the query list with the new DOM elements and filter immediately
      if (studentGrid) {
        dynamicRows = Array.from(studentGrid.querySelectorAll(".student-row"));
      }
      filterStudents(); 

      // Apply overall class math to Top UI Cards
      if (totalStudentTestsCount > 0) {
          const finalPre = Math.round(totalClassPrePercentageSum / totalStudentTestsCount);
          const finalPost = Math.round(totalClassPostPercentageSum / totalStudentTestsCount);
          const finalImp = finalPost - finalPre;
          
          // Pre-Test Meter
          const preVal = document.querySelector(".meters .meter-row:nth-child(1) b");
          const preFill = document.querySelector(".meters .meter-row:nth-child(1) .fill");
          if(preVal) preVal.textContent = `${finalPre}%`;
          if(preFill) preFill.style.width = `${finalPre}%`;
          
          // Post-Test Meter
          const postVal = document.querySelector(".meters .meter-row:nth-child(2) b");
          const postFill = document.querySelector(".meters .meter-row:nth-child(2) .fill");
          if(postVal) postVal.textContent = `${finalPost}%`;
          if(postFill) postFill.style.width = `${finalPost}%`;
          
          // Improvement Meter
          const impVal = document.querySelector(".meters .meter-row:nth-child(3) b");
          const impFill = document.querySelector(".meters .meter-row:nth-child(3) .fill");
          if(impVal) impVal.textContent = `${finalImp}%`;
          // Prevent the width visually overflowing backwards by turning a negative string into absolute percent
          if(impFill) impFill.style.width = `${Math.abs(finalImp)}%`; 
          
          // SVG Donut Chart logic
          const donutLabel = document.querySelector(".donut-label strong");
          if(donutLabel) donutLabel.textContent = `${finalPost}%`;
          
          const donutRing = document.querySelector(".donut .bar");
          if(donutRing) {
            // Converts the percentage into the dasharray layout size required by the SVG
            const donutFillAmount = (finalPost / 100) * 289.03;
            donutRing.setAttribute("stroke-dasharray", `${donutFillAmount} 289.03`);
          }
      }
    }
  } catch (error) {
    console.error("Error loading analytics:", error);
  }
});