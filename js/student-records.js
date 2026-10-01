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

const recordsContainer = document.getElementById("recordsContainer");
const emptyState = document.getElementById("emptyState");
const searchInput = document.getElementById("studentSearch");

let dynamicCards = [];

// Client-Side Searching for dynamically loaded cards
searchInput.addEventListener("input", (e) => {
  const q = e.target.value.trim().toLowerCase();
  let shown = 0;
  
  dynamicCards.forEach((card) => {
    const visible = card.dataset.name.includes(q);
    card.classList.toggle("hidden", !visible);
    if (visible) shown += 1;
  });
  
  emptyState.hidden = shown > 0;
});

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
      
      if (classSnap.empty) return;
      
      recordsContainer.innerHTML = "";

      for (const classDoc of classSnap.docs) {
          const classCode = classDoc.id;
          const sectionName = classDoc.data().SectionName || classCode;
          
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
              
              const lessonsRef = collection(db, "users", studentDoc.id, "test_results", "term_01", "lessons");
              const lessonsSnap = await getDocs(lessonsRef);
              
              let studentPreSum = 0;
              let studentPostSum = 0;
              let testCount = 0;
              let totalArTime = 0;
              let lastActiveDate = new Date(0);

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
                  
                  if (tData.arTimeMinutes) {
                      totalArTime += tData.arTimeMinutes;
                  }
                  
                  if (tData.timestamp) {
                      const testDate = tData.timestamp.toDate ? tData.timestamp.toDate() : new Date(testData.timestamp);
                      if (testDate > lastActiveDate) lastActiveDate = testDate;
                  }
              });
              
              // Formatting data strings
              const avgPreStr = testCount > 0 ? `${Math.round(studentPreSum / testCount)}%` : "N/A";
              const avgPostNum = testCount > 0 ? Math.round(studentPostSum / testCount) : 0;
              const avgPostStr = testCount > 0 ? `${avgPostNum}%` : "N/A";
              const overallPercent = avgPostNum; // Using Post-Test Average for overall performance bar
              
              const arTimeStr = totalArTime > 0 ? `${totalArTime} min` : "-- min";
              const dateStr = lastActiveDate.getTime() > 0 
                ? `Last active ${lastActiveDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` 
                : "No activity recorded";

              // Building the actual HTML Card
              const card = document.createElement("article");
              card.className = "record";
              card.dataset.name = sName.toLowerCase();
              
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
                  <div class="stat"><span>Module Time</span><b class="c-cyan">-- min</b></div>
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
      if (dynamicCards.length === 0) {
        emptyState.hidden = false;
      }
    }
  } catch (error) {
    console.error("Error loading student records:", error);
  }
});