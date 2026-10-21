import { loadAdminReports } from "./admin-report-data.js";
import { showAdminView } from "./admin-view.js";
import { createPagePerformance } from "./page-performance.js";
import { webProtectionEnabled } from "./web-login.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "./firebase-auth.js";
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
let adminReady = false;
let webLocksEnabled = false;
webProtectionEnabled().then(value => { webLocksEnabled = value; render(); }).catch(() => {});

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
    <article class="teacher-record" data-teacher-id="${escapeHtml(teacher.id)}">
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
            ${webLocksEnabled ? `<button class="record-action activate" type="button" ${adminReady ? "" : "disabled"} data-unlock-web-id="${escapeHtml(teacher.schoolId || teacher.id)}" aria-label="Unlock web login for ${escapeHtml(teacher.name)}" title="Unlock web login"><svg viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M9 10V7a4 4 0 0 1 8 0m-5 8v2"/></svg></button>` : ""}
            <button class="record-action ${teacher.active ? "deactivate" : "activate"}" type="button" ${adminReady ? "" : "disabled"} data-toggle-id="${escapeHtml(teacher.id)}" aria-label="${teacher.active ? "Deactivate" : "Activate"} ${escapeHtml(teacher.name)}" title="${teacher.active ? "Deactivate" : "Activate"}">
              ${teacher.active
                ? `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="m6 18 12-12"/></svg>`
                : `<svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg>`}
            </button>
            <button class="record-action delete" type="button" ${adminReady ? "" : "disabled"} data-delete-id="${escapeHtml(teacher.id)}" aria-label="Remove ${escapeHtml(teacher.name)}" title="Remove teacher">
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

// Reuse the shared school report when moving between admin pages.
const addTeacherButton = document.getElementById("addTeacherButton");
if (addTeacherButton) addTeacherButton.disabled = true;
onAuthStateChanged(auth, async user => {
  adminReady = false;
  if (!user) { window.location.href = "login.html"; return; }
  initAdminIdleTimeout(auth);
  const timing = createPagePerformance("Manage Teachers");
  try {
    await showAdminView({ app, user, page: "reports",
      verified: () => { adminReady = true; if (addTeacherButton) addTeacherButton.disabled = false; render(); },
      load: ({ read }) => timing.data(() => loadAdminReports(db, read)),
      render: report => timing.render(() => { teachers = report.teachers; render(); }),
      painted: cacheHit => timing.finish("loaded", { cacheHit })
    });
  } catch (error) { timing.finish("error"); console.error("Error fetching teachers:", error); }
});

// Search input
if (search) search.addEventListener("input", render);

// Toggle & Delete actions
if (list) {
  list.addEventListener("click", async (event) => {
    if (!adminReady || !auth.currentUser) return;
    const unlock = event.target.closest("[data-unlock-web-id]");
    if (unlock) {
      const identifier = unlock.dataset.unlockWebId;
      if (!window.confirm(`Restore web login for ${identifier}? This clears their failed-attempt history. Mobile access is unchanged.`)) return;
      unlock.disabled = true;
      try {
        const response = await fetch("/api/web-auth/unlock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identifier }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Unable to restore web login.");
        alert(`Web login restored for ${identifier}.`);
      } catch (error) { alert(error.message); }
      finally { unlock.disabled = false; }
      return;
    }
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
    if (!adminReady || !auth.currentUser) return;
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
