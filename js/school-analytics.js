import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { initAdminIdleTimeout } from "./admin-idle-timeout.js";
import { 
  getFirestore, 
  collection, 
  query, 
  where, 
  getDocs 
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

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

// --- DRAWER UI LOGIC ---
const menuButton = document.getElementById("adminMenuButton");
const drawer = document.getElementById("adminNavigation");
const closeButton = document.getElementById("adminDrawerClose");

function setDrawerOpen(open) {
  if (!drawer || !menuButton) return;
  drawer.classList.toggle("open", open);
  drawer.setAttribute("aria-hidden", String(!open));
  menuButton.setAttribute("aria-expanded", String(open));
}

if (menuButton) menuButton.addEventListener("click", () => setDrawerOpen(!drawer.classList.contains("open")));
if (closeButton) closeButton.addEventListener("click", () => setDrawerOpen(false));
if (drawer) {
  drawer.addEventListener("click", (event) => {
    if (event.target === drawer) setDrawerOpen(false);
  });
}
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setDrawerOpen(false);
});

// --- VIEW TOGGLE ---
const teacherContainer = document.getElementById("teacherAnalytics");
const sectionContainer = document.getElementById("sectionAnalytics");
const viewButtons = [...document.querySelectorAll("[data-view]")];

function setAnalyticsView(view) {
  const showTeachers = view === "teachers";

  viewButtons.forEach((button) => {
    const selected = button.dataset.view === view;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });

  if (teacherContainer && sectionContainer) {
    teacherContainer.hidden = !showTeachers;
    sectionContainer.hidden = showTeachers;
    teacherContainer.style.display = showTeachers ? "grid" : "none";
    sectionContainer.style.display = showTeachers ? "none" : "grid";
  }
}

viewButtons.forEach((button) => {
  button.addEventListener("click", () => setAnalyticsView(button.dataset.view));
});

// --- HELPERS ---
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[char]));

const getInitials = (name) => {
  if (!name) return "TR";
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0] || "").join("").toUpperCase();
};

const cardColors = ["#7048ff", "#ec168d", "#12a8df", "#10b981"];

// --- MAIN ANALYTICS LOADER ---
async function loadSchoolAnalytics() {
  if (teacherContainer) {
    teacherContainer.innerHTML = `<p style="grid-column: 1 / -1; text-align: center; color: #64748b; padding: 32px;">Loading teacher analytics...</p>`;
  }
  if (sectionContainer) {
    sectionContainer.innerHTML = `<p style="text-align: center; color: #64748b; padding: 32px;">Loading section analytics...</p>`;
  }

  try {
    // 1. Fetch Teachers
    const teacherQ = query(collection(db, "users"), where("role", "==", "teacher"));
    const teacherSnap = await getDocs(teacherQ);

    const teacherMap = new Map();
    let teacherColorIdx = 0;

    teacherSnap.forEach((docSnap) => {
      const data = docSnap.data();
      const teacherName = data.displayName || data.fullName || data.name || "Teacher";

      let sectionsText = "General Science";
      if (Array.isArray(data.sections) && data.sections.length > 0) {
        sectionsText = data.sections.join(", ");
      } else if (data.section) {
        sectionsText = data.section;
      }

      teacherMap.set(docSnap.id, {
        id: docSnap.id,
        schoolId: data.schoolId || docSnap.id,
        name: teacherName,
        initials: getInitials(teacherName),
        sections: sectionsText,
        color: cardColors[teacherColorIdx % cardColors.length],
        prePctSum: 0,
        preCount: 0,
        postPctSum: 0,
        postCount: 0
      });
      teacherColorIdx++;
    });

    // 2. Fetch Students & Aggregate by Teacher and by Section
    const studentQ = query(collection(db, "users"), where("role", "==", "student"));
    const studentSnap = await getDocs(studentQ);

    const sectionMap = new Map();
    let sectionColorIdx = 0;

for (const studentDoc of studentSnap.docs) {
      const sData = studentDoc.data();

      // 1. Check for assigned teacher
      const assignedTeacherId = sData.teacherId || sData.adviserId || sData.teacher;
      let teacherObj = null;
      if (assignedTeacherId && teacherMap.has(assignedTeacherId)) {
        teacherObj = teacherMap.get(assignedTeacherId);
      } else if (teacherMap.size > 0) {
        teacherObj = teacherMap.values().next().value;
      }

      // 2. Resolve section name from student document or fallback to teacher's section
      let sectionName = sData.section || sData.gradeSection || sData.sectionName || sData.className;

      if (!sectionName && sData.grade && sData.section) {
        sectionName = `Grade ${sData.grade} – ${sData.section}`;
      } else if (!sectionName && teacherObj && teacherObj.sections && teacherObj.sections !== "General Science") {
        sectionName = teacherObj.sections.split(",")[0].trim();
      } else if (!sectionName) {
        sectionName = "Grade 6 – Section A";
      }

      // 3. Register section if seen for the first time
      if (!sectionMap.has(sectionName)) {
        sectionMap.set(sectionName, {
          name: sectionName,
          students: 0,
          color: cardColors[sectionColorIdx % cardColors.length],
          prePctSum: 0,
          preCount: 0,
          postPctSum: 0,
          postCount: 0
        });
        sectionColorIdx++;
      }

      const secObj = sectionMap.get(sectionName);
      secObj.students++;

      // 4. Query student lessons
      const lessonsRef = collection(db, "users", studentDoc.id, "test_results", "term_01", "lessons");
      const lessonsSnap = await getDocs(lessonsRef);

      lessonsSnap.forEach((lDoc) => {
        const tData = lDoc.data();

        // Pre-test
        if (tData.isPreTestCompleted && tData.preTestTotalQuestions > 0) {
          const prePct = (tData.preTestScore / tData.preTestTotalQuestions) * 100;
          if (teacherObj) {
            teacherObj.prePctSum += prePct;
            teacherObj.preCount++;
          }
          secObj.prePctSum += prePct;
          secObj.preCount++;
        }

        // Post-test
        if (tData.isPostTestCompleted && tData.postTestTotalQuestions > 0) {
          const score = tData.postTestScore !== undefined 
            ? tData.postTestScore 
            : (tData.postTestHeatmap ? tData.postTestHeatmap.filter(Boolean).length : 0);
          
          const postPct = (score / tData.postTestTotalQuestions) * 100;
          if (teacherObj) {
            teacherObj.postPctSum += postPct;
            teacherObj.postCount++;
          }
          secObj.postPctSum += postPct;
          secObj.postCount++;
        }
      });
    }

    // 3. Render Teachers Analytics Cards
    if (teacherContainer) {
      if (teacherMap.size === 0) {
        teacherContainer.innerHTML = `<p style="grid-column: 1 / -1; text-align: center; color: #64748b; padding: 32px;">No teachers found in the database.</p>`;
      } else {
        teacherContainer.innerHTML = Array.from(teacherMap.values()).map((teacher) => {
          const avgPre = teacher.preCount > 0 ? Math.round(teacher.prePctSum / teacher.preCount) : 0;
          const avgPost = teacher.postCount > 0 ? Math.round(teacher.postPctSum / teacher.postCount) : 0;
          const gain = avgPost - avgPre;
          const gainText = gain >= 0 ? `+${gain}% gain` : `${gain}% gain`;

          return `
            <article class="teacher-analytics-card" style="--teacher-color:${teacher.color};--score:${avgPost}%">
              <span class="analytics-avatar">${escapeHtml(teacher.initials)}</span>
              <h2 class="analytics-teacher-name">${escapeHtml(teacher.name)}</h2>
              <p class="analytics-teacher-sections">${escapeHtml(teacher.sections)}</p>
              <div class="analytics-donut" role="img" aria-label="${avgPost} percent average post-test">
                <div class="analytics-donut-inner" aria-hidden="true"></div>
              </div>
              <strong class="analytics-post-score">${avgPost}%</strong>
              <span class="analytics-post-label">avg post-test</span>
              <div class="analytics-card-footer">
                <span>Pre: <strong>${avgPre}%</strong></span>
                <span class="teacher-gain">${gainText}</span>
              </div>
            </article>
          `;
        }).join("");
      }
    }

    // 4. Render Sections Analytics Cards
    if (sectionContainer) {
      if (sectionMap.size === 0) {
        sectionContainer.innerHTML = `<p style="text-align: center; color: #64748b; padding: 32px;">No student sections found.</p>`;
      } else {
        sectionContainer.innerHTML = Array.from(sectionMap.values()).map((section) => {
          const avgPre = section.preCount > 0 ? Math.round(section.prePctSum / section.preCount) : 0;
          const avgPost = section.postCount > 0 ? Math.round(section.postPctSum / section.postCount) : 0;
          const gain = avgPost - avgPre;
          const gainText = gain >= 0 ? `+${gain}% improvement` : `${gain}% improvement`;

          return `
            <article class="section-analytics-card" style="--section-color:${section.color}">
              <div class="section-title-row">
                <span class="section-color-dot" aria-hidden="true"></span>
                <h2>${escapeHtml(section.name)}</h2>
                <span class="section-student-count">${section.students} ${section.students === 1 ? "student" : "students"}</span>
                <span class="section-improvement">${gainText}</span>
              </div>
              <div class="section-meter">
                <div class="section-meter-head"><span>Pre-Test Average</span><strong>${avgPre}%</strong></div>
                <div class="section-meter-track"><i style="width:${Math.max(0, Math.min(100, avgPre))}%"></i></div>
              </div>
              <div class="section-meter post">
                <div class="section-meter-head"><span>Post-Test Average</span><strong>${avgPost}%</strong></div>
                <div class="section-meter-track"><i style="width:${Math.max(0, Math.min(100, avgPost))}%"></i></div>
              </div>
            </article>
          `;
        }).join("");
      }
    }

  } catch (error) {
    console.error("Error loading analytics data:", error);
    if (teacherContainer) teacherContainer.innerHTML = `<p style="grid-column: 1 / -1; text-align: center; color: #ef4444; padding: 32px;">Failed to load analytics data.</p>`;
    if (sectionContainer) sectionContainer.innerHTML = `<p style="text-align: center; color: #ef4444; padding: 32px;">Failed to load section data.</p>`;
  }
}

// Helper: Load Admin Info into the Sidebar Drawer
async function updateAdminSidebar(user) {
  const avatarEl = document.querySelector(".admin-side-avatar");
  const nameEl = document.querySelector(".admin-side-user strong");
  const roleEl = document.querySelector(".admin-side-user small");

  if (!avatarEl && !nameEl) return;

  try {
    let adminData = null;

    // 1. Try matching by Auth UID
    const uidSnap = await getDocs(query(collection(db, "users"), where("uid", "==", user.uid)));
    if (!uidSnap.empty) {
      adminData = uidSnap.docs[0].data();
    } else {
      // 2. Fallback: Query any user with role == "admin" (like ADMIN1)
      const roleSnap = await getDocs(query(collection(db, "users"), where("role", "==", "admin")));
      if (!roleSnap.empty) {
        adminData = roleSnap.docs[0].data();
      }
    }

    if (adminData) {
      const name = adminData.displayName || adminData.fullName || adminData.name || "Admin";
      const role = adminData.roleLabel || "School Administrator";
      
      const parts = name.trim().split(/\s+/).filter(Boolean);
      const filtered = parts.filter((p) => !/^(dr\.|mr\.|ms\.|mrs\.|sir|ma'am)$/i.test(p));
      const target = filtered.length > 0 ? filtered : parts;
      const initials = target.slice(0, 2).map((part) => part[0] || "").join("").toUpperCase() || "AD";

      if (avatarEl) avatarEl.textContent = initials;
      if (nameEl) nameEl.textContent = name;
      if (roleEl) roleEl.textContent = role;
    }
  } catch (err) {
    console.error("Error updating sidebar admin profile:", err);
  }
}

// Authentication Check
onAuthStateChanged(auth, (user) => {
  if (!user) {
    window.location.href = "login.html";
    return;
  }
  initAdminIdleTimeout(auth);
  loadSchoolAnalytics();
  updateAdminSidebar(user);
});

setAnalyticsView("teachers");