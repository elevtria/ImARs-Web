import { getDocs as getBackgroundDocs } from "./firebase-data.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { initAdminIdleTimeout } from "./admin-idle-timeout.js";
import { 
  getFirestore, 
  collection, 
  query, 
  where, 
  getDocsWithLoading as getDocs,
  doc, 
  updateDoc, 
  deleteDoc, 
  addDoc, 
  setDoc,
  serverTimestamp 
} from "./firebase-data.js";

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

// Drawer Navigation Logic
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

// UI Elements
const list = document.getElementById("teacherList");
const search = document.getElementById("teacherSearch");
const noTeachers = document.getElementById("noTeachers");
const dialog = document.getElementById("teacherDialog");
const form = document.getElementById("teacherForm");

let teachers = [];

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[char]));

const initials = (name) => {
  if (!name) return "TR";
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part[0] || "").join("").toUpperCase();
};

function render() {
  const queryText = (search?.value || "").trim().toLowerCase();
  const visible = teachers.filter((teacher) => {
    const searchable = [
      teacher.schoolId, // <-- Can now search by "TEACH1000"
      teacher.name, 
      teacher.email, 
      teacher.subject, 
      ...(teacher.sections || [])
    ].join(" ").toLowerCase();
    return searchable.includes(queryText);
  });

  const activeCount = teachers.filter((t) => t.active).length;
  const inactiveCount = teachers.filter((t) => !t.active).length;
  const totalStudents = teachers.reduce((sum, t) => sum + (t.students || 0), 0);
  const totalSections = new Set(teachers.flatMap((t) => t.sections || [])).size;

  const activeCountEl = document.getElementById("activeCount");
  const inactiveCountEl = document.getElementById("inactiveCount");
  const teacherSummaryEl = document.getElementById("teacherSummary");
  const sectionCountEl = document.getElementById("sectionCount");
  const studentCountEl = document.getElementById("studentCount");

  if (activeCountEl) activeCountEl.textContent = activeCount;
  if (inactiveCountEl) inactiveCountEl.textContent = inactiveCount;
  if (teacherSummaryEl) teacherSummaryEl.textContent = `${activeCount} active · ${teachers.length} total`;
  if (sectionCountEl) sectionCountEl.textContent = totalSections;
  if (studentCountEl) studentCountEl.textContent = totalStudents;

  if (!list) return;

  list.innerHTML = visible.map((teacher) => `
    <article class="teacher-record" data-teacher-id="${teacher.id}">
      <div class="teacher-record-top">
        <div class="teacher-profile">
          <span class="record-avatar ${teacher.active ? "" : "inactive"}">${escapeHtml(initials(teacher.name))}</span>
          <div class="teacher-info">
            <div class="teacher-name-line" style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
              <strong>${escapeHtml(teacher.name)}</strong>
              <span class="teacher-status ${teacher.active ? "" : "inactive"}">${teacher.active ? "active" : "inactive"}</span>
              <span class="teacher-id-badge" style="background: #eef2ff; color: #4f46e5; font-size: 0.75rem; font-weight: 700; padding: 2px 8px; border-radius: 6px; letter-spacing: 0.03em;">ID: ${escapeHtml(teacher.schoolId || teacher.id)}</span>
            </div>
            <small class="teacher-contact">${escapeHtml(teacher.email)} · ${escapeHtml(teacher.subject)} · Joined ${escapeHtml(teacher.joined)}</small>
            <div class="section-chips">
              ${(teacher.sections || []).map((sec) => `<span class="section-chip">${escapeHtml(sec)}</span>`).join("")}
            </div>
          </div>
        </div>
        <div class="teacher-stats" aria-label="${escapeHtml(teacher.name)} performance">
          <div class="teacher-stat"><small>Students</small><strong>${teacher.students}</strong></div>
          <div class="teacher-stat"><small>Pre-Test</small><strong>${teacher.pre}%</strong></div>
          <div class="teacher-stat"><small>Post-Test</small><strong>${teacher.post}%</strong></div>
          <div class="teacher-stat"><small>AR hrs</small><strong>${teacher.hours}</strong></div>
          <div class="teacher-actions">
            <button class="record-action ${teacher.active ? "deactivate" : "activate"}" type="button" data-toggle-id="${teacher.id}" aria-label="${teacher.active ? "Deactivate" : "Activate"} ${escapeHtml(teacher.name)}" title="${teacher.active ? "Deactivate" : "Activate"}">
              ${teacher.active
                ? `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="m6 18 12-12"/></svg>`
                : `<svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg>`}
            </button>
            <button class="record-action delete" type="button" data-delete-id="${teacher.id}" aria-label="Remove ${escapeHtml(teacher.name)}" title="Remove teacher">
              <svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3m3 0-.8 13H6.8L6 7m4 4v5m4-5v5"/></svg>
            </button>
          </div>
        </div>
      </div>
      <div class="teacher-progress">
        <div class="teacher-progress-item">
          <div class="progress-label"><span>Avg Pre-Test</span><strong>${teacher.pre}%</strong></div>
          <div class="progress-track"><i style="width:${Math.max(0, Math.min(100, teacher.pre))}%"></i></div>
        </div>
        <div class="teacher-progress-item post">
          <div class="progress-label"><span>Avg Post-Test</span><strong>${teacher.post}%</strong></div>
          <div class="progress-track"><i style="width:${Math.max(0, Math.min(100, teacher.post))}%"></i></div>
        </div>
      </div>
    </article>
  `).join("");

  if (noTeachers) noTeachers.hidden = visible.length !== 0;
}

// Fetch Teachers & Student Metrics from Firestore
async function loadTeachersFromDB() {
  try {
    if (list) list.innerHTML = `<p style="padding: 24px; color: #64748b; text-align: center;">Loading teachers...</p>`;

    // 1. Fetch Teachers
    const teacherQ = query(collection(db, "users"), where("role", "==", "teacher"));
    const teacherSnap = await getDocs(teacherQ);

    const teacherMap = new Map();

    teacherSnap.forEach((docSnap) => {
      const data = docSnap.data();
      let joinedDate = "Recently";
      if (data.createdAt && typeof data.createdAt.toDate === "function") {
        joinedDate = data.createdAt.toDate().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      } else if (data.joined) {
        joinedDate = data.joined;
      }

      let parsedSections = [];
      if (Array.isArray(data.sections)) {
        parsedSections = data.sections;
      } else if (data.section) {
        parsedSections = [data.section];
      }

      teacherMap.set(docSnap.id, {
        id: docSnap.id,
        schoolId: data.schoolId || docSnap.id, // Stores TEACH1000, etc.
        name: data.fullName || data.name || data.displayName || "Teacher",
        email: data.providedEmail || data.email || "No email",
        subject: data.subject || "Science",
        joined: joinedDate,
        sections: parsedSections,
        active: data.active !== false && data.status !== "inactive",
        students: 0,
        prePctSum: 0,
        preCount: 0,
        postPctSum: 0,
        postCount: 0,
        arMinutes: 0
      });
    });

    // 2. Fetch Students & Associate Performance
    const studentQ = query(collection(db, "users"), where("role", "==", "student"));
    const studentSnap = await getDocs(studentQ);

    for (const studentDoc of studentSnap.docs) {
      const studentId = studentDoc.id;
      const sData = studentDoc.data();
      const assignedTeacherId = sData.teacherId || sData.adviserId || sData.teacher;

      let teacherObj = null;
      if (assignedTeacherId && teacherMap.has(assignedTeacherId)) {
        teacherObj = teacherMap.get(assignedTeacherId);
      } else if (teacherMap.size > 0) {
        // Fallback for demo/testing if students aren't explicitly assigned
        teacherObj = teacherMap.values().next().value;
      }

      if (teacherObj) {
        teacherObj.students++;
      }

      const lessonsRef = collection(db, "users", studentId, "test_results", "term_01", "lessons");
      const lessonsSnap = await getDocs(lessonsRef);

      lessonsSnap.forEach((lDoc) => {
        const tData = lDoc.data();
        if (tData.isPreTestCompleted && tData.preTestTotalQuestions > 0 && teacherObj) {
          teacherObj.prePctSum += (tData.preTestScore / tData.preTestTotalQuestions) * 100;
          teacherObj.preCount++;
        }
        if (tData.isPostTestCompleted && tData.postTestTotalQuestions > 0 && teacherObj) {
          const score = tData.postTestScore !== undefined 
            ? tData.postTestScore 
            : (tData.postTestHeatmap ? tData.postTestHeatmap.filter(Boolean).length : 0);
          teacherObj.postPctSum += (score / tData.postTestTotalQuestions) * 100;
          teacherObj.postCount++;
        }
        if (tData.arTimeMinutes && teacherObj) {
          teacherObj.arMinutes += tData.arTimeMinutes;
        }
      });
    }

    // 3. Compute final metrics
    teachers = Array.from(teacherMap.values()).map((t) => {
      const pre = t.preCount > 0 ? Math.round(t.prePctSum / t.preCount) : 0;
      const post = t.postCount > 0 ? Math.round(t.postPctSum / t.postCount) : 0;
      const hours = t.arMinutes >= 60 ? `${Math.round(t.arMinutes / 60)}h` : `${t.arMinutes}m`;
      return { ...t, pre, post, hours };
    });

    render();
  } catch (err) {
    console.error("Error fetching teachers:", err);
    if (list) list.innerHTML = `<p style="padding: 24px; color: #ef4444; text-align: center;">Error loading teachers. Check console.</p>`;
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
    const uidSnap = await getBackgroundDocs(query(collection(db, "users"), where("uid", "==", user.uid)));
    if (!uidSnap.empty) {
      adminData = uidSnap.docs[0].data();
    } else {
      // 2. Fallback: Query any user with role == "admin" (like ADMIN1)
      const roleSnap = await getBackgroundDocs(query(collection(db, "users"), where("role", "==", "admin")));
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
  updateAdminSidebar(user);
  initAdminIdleTimeout(auth);
  loadTeachersFromDB();
});

// Search input
if (search) search.addEventListener("input", render);

// Toggle & Delete actions
if (list) {
  list.addEventListener("click", async (event) => {
    // 1. Toggle Active / Inactive
    const toggleButton = event.target.closest("[data-toggle-id]");
    if (toggleButton) {
      const teacherId = toggleButton.dataset.toggleId;
      const teacher = teachers.find((t) => t.id === teacherId);
      if (!teacher) return;

      const nextStatus = !teacher.active;
      try {
        await updateDoc(doc(db, "users", teacherId), {
          active: nextStatus,
          status: nextStatus ? "active" : "inactive"
        });
        teacher.active = nextStatus;
        render();
      } catch (err) {
        console.error("Failed to update status:", err);
        alert("Error updating teacher status.");
      }
      return;
    }

    // 2. Delete Teacher
    const deleteButton = event.target.closest("[data-delete-id]");
    if (deleteButton) {
      const teacherId = deleteButton.dataset.deleteId;
      const teacher = teachers.find((t) => t.id === teacherId);
      if (!teacher) return;

      if (window.confirm(`Are you sure you want to remove ${teacher.name} from Firebase?`)) {
        try {
          await deleteDoc(doc(db, "users", teacherId));
          teachers = teachers.filter((t) => t.id !== teacherId);
          render();
        } catch (err) {
          console.error("Failed to delete teacher:", err);
          alert("Error deleting teacher.");
        }
      }
    }
  });
}

// Dialog & Add Teacher
document.getElementById("addTeacherButton")?.addEventListener("click", () => dialog?.showModal());
document.getElementById("closeTeacherDialog")?.addEventListener("click", () => dialog?.close());
document.getElementById("cancelTeacherDialog")?.addEventListener("click", () => dialog?.close());
if (dialog) {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
}

if (form) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const name = String(formData.get("name") || "").trim();
    const email = String(formData.get("email") || "").trim().toLowerCase();
    const subject = String(formData.get("subject") || "").trim();
    const sections = String(formData.get("sections") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (!name || !email || !subject) return;

    try {
      // 1. Calculate the next sequential Teacher ID (e.g. TEACH1001)
      const teachersSnap = await getDocs(query(collection(db, "users"), where("role", "==", "teacher")));
      let highestNum = 999;

      teachersSnap.forEach((docSnap) => {
        const id = docSnap.id;
        if (id.startsWith("TEACH") && id.length >= 9) {
          const num = parseInt(id.substring(5), 10);
          if (!isNaN(num) && num > highestNum) highestNum = num;
        }
      });
      const nextTeacherId = `TEACH${highestNum + 1}`;

      // 2. Create the pre-approved profile doc using the Teacher ID as key
      const newTeacherDoc = {
        schoolId: nextTeacherId,
        displayName: name,
        fullName: name,
        providedEmail: email,
        email: email,
        subject: subject,
        sections: sections,
        role: "teacher",
        active: true,
        status: "invited",
        isRegistered: false, // Flag indicating the teacher hasn't completed sign-up in the app yet
        createdAt: serverTimestamp()
      };

      // Set the document directly with the custom ID
      await setDoc(doc(db, "users", nextTeacherId), newTeacherDoc);

      teachers.unshift({
        id: nextTeacherId,
        schoolId: nextTeacherId, // <-- Include this
        name,
        email,
        subject,
        joined: "Just now",
        sections,
        students: 0,
        pre: 0,
        post: 0,
        hours: "0m",
        active: true
      });

      form.reset();
      dialog.close();
      if (search) search.value = "";
      render();

      alert(`Teacher registered! Give the Teacher ID to the teacher:\n\nID: ${nextTeacherId}\nEmail: ${email}`);
    } catch (err) {
      console.error("Failed to add teacher to Firestore:", err);
      alert("Error adding teacher: " + err.message);
    }
  });
}