import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
      import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
      import { getFirestore, collection, query, where, getDocs, doc, getDoc } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

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

    onAuthStateChanged(auth, async (user) => {
      if (user) {
        try {
          const userQ = query(collection(db, "users"), where("uid", "==", user.uid));
          const userSnap = await getDocs(userQ);

          if (!userSnap.empty) {
            const teacherDoc = userSnap.docs[0];
            const userData = teacherDoc.data();
            const teacherId = teacherDoc.id; 

            const teacherName = userData.displayName || "Teacher";
            document.getElementById("greeting").textContent = `Good ${part}, ${teacherName} 👋`;

            const classQ = query(collection(db, "classes"), where("teacherId", "==", teacherId));
            const classSnap = await getDocs(classQ);

            if (!classSnap.empty) {
                const classData = classSnap.docs[0].data();
                const classCode = classSnap.docs[0].id;
                const sectionName = classData.SectionName || classCode;
                
                document.getElementById("classInfo").textContent = `Grade 6 – ${sectionName}`;

                // --- STUDENT COUNT & TEST AVERAGES LOGIC ---
                const studentQ = query(collection(db, "users"), where("role", "==", "student"), where("classCode", "==", classCode));
                const studentSnap = await getDocs(studentQ);

                document.getElementById("studentCountVal").textContent = studentSnap.size;

                let totalPreTestSum = 0;
                let preTestCount = 0;
                let totalPostTestSum = 0;
                let postTestCount = 0;
                
                const activeLessons = new Set();
                
                // 2. Clear the table body to inject dynamic rows
                const studentTableBody = document.getElementById("studentTableBody");
                studentTableBody.innerHTML = "";

                for (const studentDoc of studentSnap.docs) {
                    const studentDataId = studentDoc.id;
                    const sData = studentDoc.data();
                    
                    // Generate Initials (e.g., Ana Cruz -> AC)
                    const sName = sData.displayName || "Unknown Student";
                    const nameParts = sName.split(" ");
                    let initials = nameParts[0] ? nameParts[0][0] : "?";
                    if (nameParts.length > 1) initials += nameParts[nameParts.length - 1][0];
                    initials = initials.toUpperCase();

                    const lessonsRef = collection(db, "users", studentDataId, "test_results", "term_01", "lessons");
                    const lessonsSnap = await getDocs(lessonsRef);

                    // Variables to track stats specific to this one student
                    let sPreSum = 0, sPreCount = 0;
                    let sPostSum = 0, sPostCount = 0;
                    let lastActiveDate = new Date(0); // Epoch start

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
                                : testData.postTestHeatmap.filter(Boolean).length;
                            
                            const normalizedPost = (postScore / testData.postTestTotalQuestions) * 10;
                            totalPostTestSum += normalizedPost;
                            postTestCount++;
                            sPostSum += normalizedPost;
                            sPostCount++;
                        }
                        
                        // Parse timestamp to find the most recent activity
                        if (testData.timestamp) {
                            const testDate = testData.timestamp.toDate ? testData.timestamp.toDate() : new Date(testData.timestamp);
                            if (testDate > lastActiveDate) lastActiveDate = testDate;
                        }
                    });
                    
                    // Format row data for this student
                    const sPreStr = sPreCount > 0 ? `${(sPreSum / sPreCount).toFixed(1)}/5` : "N/A";
                    const sPostStr = sPostCount > 0 ? `${(sPostSum / sPostCount).toFixed(1)}/10` : "N/A";
                    const sPostStyle = sPostCount > 0 ? "score-up" : "muted-cell"; // Make it green if they have a score
                    
                    let dateStr = "No activity";
                    if (lastActiveDate.getTime() > 0) {
                        dateStr = lastActiveDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                    }

                    // Inject the row into the table
                    const tr = document.createElement("tr");
                    tr.innerHTML = `
                      <td>
                        <div class="student">
                          <div class="avatar">${initials}</div>
                          <div>
                            <strong>${sName}</strong>
                            <small>Grade 6 – ${sectionName}</small>
                          </div>
                        </div>
                      </td>
                      <td class="muted-cell">${sPreStr}</td>
                      <td class="${sPostStyle}">${sPostStr}</td>
                      <td class="muted-cell">-- min</td>
                      <td class="muted-cell">${dateStr}</td>
                    `;
                    studentTableBody.appendChild(tr);
                }

                // Finalize Global Class Averages
                const avgPre = preTestCount > 0 ? (totalPreTestSum / preTestCount).toFixed(1) : "0.0";
                const avgPost = postTestCount > 0 ? (totalPostTestSum / postTestCount).toFixed(1) : "0.0";

                document.getElementById("avgPreTestVal").textContent = `${avgPre}/5`;
                document.getElementById("avgPostTestVal").textContent = `${avgPost}/10`;
                
                // --- FETCH & RENDER CURRICULUM MODULES ---
                const termRef = doc(db, "terms", "term_01");
                const termSnap = await getDoc(termRef);
                if (termSnap.exists()) {
                    const termTitle = termSnap.data().title || "Term 1";
                    document.getElementById("currentTermHeader").textContent = `Current Term — ${termTitle}`;
                }
                
                const curriculumRef = collection(db, "terms", "term_01", "lessons");
                const curriculumSnap = await getDocs(curriculumRef);
                
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
                          <h3>${lessonTitle}</h3>
                          <span>${statusText}</span>
                        </div>
                      </article>
                    `;
                    modulesContainer.insertAdjacentHTML('beforeend', moduleHTML);
                    
                    lessonCounter++;
                });

            } else {
                document.getElementById("classInfo").textContent = "No classes assigned yet.";
            }
          }
        } catch (error) {
          console.error("Error fetching teacher data:", error);
        }
      } else {
        window.location.href = "login.html";
      }
    });
