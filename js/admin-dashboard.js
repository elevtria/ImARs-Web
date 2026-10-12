import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { getFirestore, collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { initAdminIdleTimeout } from "./admin-idle-timeout.js";

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

// Helper: Extract Initials from Teacher Name
function getInitials(name) {
  if (!name) return "TR";
  const parts = name.trim().split(" ");
  if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
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

// --- DATA AGGREGATION & FIRESTORE LOGIC ---
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = "login.html";
    return;
  }

  try {
    // STRICT ROLE GUARD: Verify the logged-in user is actually an Admin
    const currentUserSnap = await getDocs(query(collection(db, "users"), where("uid", "==", user.uid)));
    if (currentUserSnap.empty) {
      await signOut(auth);
      window.location.href = "login.html";
      return;
    }

    const currentUserData = currentUserSnap.docs[0].data();
    const currentUserRole = String(currentUserData.role || "").toLowerCase();

    if (currentUserRole !== "admin") {
      // If a Teacher or Student tries to open admin-dashboard.html, sign them out immediately
      await signOut(auth);
      window.location.href = "login.html";
      return;
    }

    updateAdminSidebar(user);
    initAdminIdleTimeout(auth);

    // 1. Fetch Teachers
    const teacherQ = query(collection(db, "users"), where("role", "==", "teacher"));
    const teacherSnap = await getDocs(teacherQ);
    const totalTeachers = teacherSnap.size;

    const teacherValEl = document.getElementById("totalTeachersVal");
    const teacherNoteEl = document.getElementById("totalTeachersNote");
    const tableTeacherCountEl = document.getElementById("tableTeacherCount");

    if (teacherValEl) teacherValEl.textContent = totalTeachers;
    if (teacherNoteEl) teacherNoteEl.textContent = `${totalTeachers} registered`;
    if (tableTeacherCountEl) tableTeacherCountEl.textContent = `${totalTeachers} teachers`;

    // Initialize teacher tracking map
    const teachersMap = new Map();
    teacherSnap.forEach((doc) => {
      const data = doc.data();
      const teacherName = data.fullName || data.name || data.displayName || "Teacher";
      const subjectSection = data.section 
        ? `${data.subject || "Science"} · ${data.section}` 
        : (data.subject || "Science / AR");

      teachersMap.set(doc.id, {
        id: doc.id,
        name: teacherName,
        meta: subjectSection,
        initials: getInitials(teacherName),
        studentCount: 0,
        prePctSum: 0,
        preCount: 0,
        postPctSum: 0,
        postCount: 0,
        arMinutes: 0
      });
    });

    // 2. Fetch Students
    const studentQ = query(collection(db, "users"), where("role", "==", "student"));
    const studentSnap = await getDocs(studentQ);
    const totalStudents = studentSnap.size;

    const studentValEl = document.getElementById("totalStudentsVal");
    if (studentValEl) studentValEl.textContent = totalStudents;

    // School-wide aggregation variables
    let totalPrePctSum = 0;
    let preTestCount = 0;
    let totalPostPctSum = 0;
    let postTestCount = 0;
    let totalArMinutes = 0;

    // 3. Process All Student Records & Assign to Teachers
    for (const studentDoc of studentSnap.docs) {
      const studentId = studentDoc.id;
      const studentData = studentDoc.data();
      
      // Match student to teacher (by teacherId, advisoryTeacher, or fallback to first teacher)
      const assignedTeacherId = studentData.teacherId || studentData.adviserId || studentData.teacher || null;
      let teacherObj = null;

      if (assignedTeacherId && teachersMap.has(assignedTeacherId)) {
        teacherObj = teachersMap.get(assignedTeacherId);
      } else if (teachersMap.size > 0) {
        // Fallback: If no explicit teacherId is tagged on the student, attribute to the primary teacher
        teacherObj = teachersMap.values().next().value;
      }

      if (teacherObj) {
        teacherObj.studentCount++;
      }

      // Fetch student lesson results
      const lessonsRef = collection(db, "users", studentId, "test_results", "term_01", "lessons");
      const lessonsSnap = await getDocs(lessonsRef);

      lessonsSnap.forEach((lessonDoc) => {
        const testData = lessonDoc.data();

        // Pre-Test Calculation
        if (testData.isPreTestCompleted && testData.preTestTotalQuestions > 0) {
          const prePct = (testData.preTestScore / testData.preTestTotalQuestions) * 100;
          totalPrePctSum += prePct;
          preTestCount++;

          if (teacherObj) {
            teacherObj.prePctSum += prePct;
            teacherObj.preCount++;
          }
        }

        // Post-Test Calculation
        if (testData.isPostTestCompleted && testData.postTestTotalQuestions > 0) {
          const postScore = testData.postTestScore !== undefined 
            ? testData.postTestScore 
            : (testData.postTestHeatmap ? testData.postTestHeatmap.filter(Boolean).length : 0);
          
          const postPct = (postScore / testData.postTestTotalQuestions) * 100;
          totalPostPctSum += postPct;
          postTestCount++;

          if (teacherObj) {
            teacherObj.postPctSum += postPct;
            teacherObj.postCount++;
          }
        }

        // AR Time
        if (testData.arTimeMinutes) {
          totalArMinutes += testData.arTimeMinutes;
          if (teacherObj) {
            teacherObj.arMinutes += testData.arTimeMinutes;
          }
        }
      });
    }

    // 4. Update Overview Stat Cards & Learning Gain (Whole Integers)
    const avgPrePct = preTestCount > 0 ? Math.round(totalPrePctSum / preTestCount) : 0;
    const avgPostPct = postTestCount > 0 ? Math.round(totalPostPctSum / postTestCount) : 0;
    const gainPct = Math.max(0, avgPostPct - avgPrePct);

    const totalArHours = totalArMinutes >= 60 
      ? `${Math.round(totalArMinutes / 60)}h` 
      : `${totalArMinutes}m`;

    const schoolAvgPostEl = document.getElementById("schoolAvgPostVal");
    const schoolAvgPreNoteEl = document.getElementById("schoolAvgPreNote");
    const totalArHoursEl = document.getElementById("totalArHoursVal");

    if (schoolAvgPostEl) schoolAvgPostEl.textContent = `${avgPostPct}%`;
    if (schoolAvgPreNoteEl) schoolAvgPreNoteEl.textContent = `Up from ${avgPrePct}% pre-test`;
    if (totalArHoursEl) totalArHoursEl.textContent = totalArHours;

    const ringPostEl = document.getElementById("ringPostScore");
    const meterPreVal = document.getElementById("meterPreVal");
    const meterPostVal = document.getElementById("meterPostVal");
    const meterGainVal = document.getElementById("meterGainVal");

    const meterPreBar = document.getElementById("meterPreBar");
    const meterPostBar = document.getElementById("meterPostBar");
    const meterGainBar = document.getElementById("meterGainBar");

    if (ringPostEl) ringPostEl.textContent = `${avgPostPct}%`;
    if (meterPreVal) meterPreVal.textContent = `${avgPrePct}%`;
    if (meterPostVal) meterPostVal.textContent = `${avgPostPct}%`;
    if (meterGainVal) meterGainVal.textContent = `${gainPct}%`;

    if (meterPreBar) meterPreBar.style.width = `${avgPrePct}%`;
    if (meterPostBar) meterPostBar.style.width = `${avgPostPct}%`;
    if (meterGainBar) meterGainBar.style.width = `${gainPct}%`;

    const ringEl = document.getElementById("learningRing");
    if (ringEl) {
      ringEl.style.background = `conic-gradient(#6c5ce7 ${avgPostPct}%, #e2e8f0 0%)`;
    }

    // 5. Populate Teacher Performance Snapshot Table
    const tableBody = document.getElementById("teacherTableBody");
    if (tableBody) {
      tableBody.innerHTML = "";

      if (teachersMap.size === 0) {
        tableBody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding: 20px;">No teachers registered yet.</td></tr>`;
        return;
      }

      teachersMap.forEach((teacher) => {
        const tAvgPre = teacher.preCount > 0 ? Math.round(teacher.prePctSum / teacher.preCount) : 0;
        const tAvgPost = teacher.postCount > 0 ? Math.round(teacher.postPctSum / teacher.postCount) : 0;
        const tGain = tAvgPost - tAvgPre;
        const gainSign = tGain >= 0 ? `+${tGain}%` : `${tGain}%`;

        const tHours = teacher.arMinutes >= 60 
          ? `${Math.round(teacher.arMinutes / 60)}h` 
          : `${teacher.arMinutes}m`;

        const row = document.createElement("tr");
        row.innerHTML = `
          <td>
            <div class="teacher-cell">
              <span class="teacher-avatar">${teacher.initials}</span>
              <span>
                <strong>${teacher.name}</strong>
                <small>${teacher.meta}</small>
              </span>
            </div>
          </td>
          <td>${teacher.studentCount}</td>
          <td>${tAvgPre}%</td>
          <td class="post-score">${tAvgPost}%</td>
          <td>${tHours}</td>
          <td><span class="gain-chip">${gainSign}</span></td>
        `;
        tableBody.appendChild(row);
      });
    }

  } catch (error) {
    console.error("Error loading admin dashboard metrics:", error);
  }
});