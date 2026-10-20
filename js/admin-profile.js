import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "./firebase-auth.js";
import { showAdminView } from "./admin-view.js";
import { createPagePerformance } from "./page-performance.js";
import { initAdminIdleTimeout } from "./admin-idle-timeout.js";
import { 
  getFirestore, 
  doc, 
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

// --- DRAWER NAVIGATION LOGIC ---
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

// --- PROFILE UI ELEMENTS ---
const profileDialog = document.getElementById("profileDialog");
const profileForm = document.getElementById("profileForm");
const saveProfileBtn = document.getElementById("saveProfileBtn");
const logoutButton = document.getElementById("logoutButton");

let activeAdminDocId = null;
const editProfileButton = document.getElementById("editProfileButton");
if (editProfileButton) editProfileButton.disabled = true;

const getInitials = (name) => {
  if (!name) return "AD";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const filtered = parts.filter((p) => !/^(dr\.|mr\.|ms\.|mrs\.|sir|ma'am)$/i.test(p));
  const target = filtered.length > 0 ? filtered : parts;
  return target.slice(0, 2).map((part) => part[0] || "").join("").toUpperCase();
};

function updateProfileUI(data) {
  const name = data.displayName || data.fullName || data.name || "Dr. Maria Santos";
  const email = data.providedEmail || data.email || auth.currentUser?.email || "admin@imars.edu";
  const school = data.school || "Pintong Gubat Elementary School";
  const roleLabel = data.roleLabel || "School Administrator";
  const department = data.department || "Science & Technology";
  const phone = data.phone || "+63 912 345 6789";
  const initials = getInitials(name);

let joinedText = "Admin since recently";

  if (data.adminSince) {
    // 1. Uses custom string if set in Firestore (e.g. "October 10, 2026")
    joinedText = `Admin since ${data.adminSince}`;
  } else if (data.createdAt && typeof data.createdAt.toDate === "function") {
    // 2. Uses Firestore Timestamp if present
    joinedText = "Admin since " + data.createdAt.toDate().toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric"
    });
  } else if (data.createdAt instanceof Date) {
    joinedText = "Admin since " + data.createdAt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  } else if (data.createdAt && typeof data.createdAt === "string") {
    // 3. Uses string date if createdAt was typed as a string in Firestore
    joinedText = `Admin since ${data.createdAt}`;
  } else if (auth.currentUser?.metadata?.creationTime) {
    // 4. Automatically pulls the real creation date from Firebase Authentication!
    const creationDate = new Date(auth.currentUser.metadata.creationTime);
    joinedText = "Admin since " + creationDate.toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric"
    });
  }

  // Main Card & Account Info
  document.getElementById("profileInitials").textContent = initials;
  document.getElementById("profileName").textContent = name;
  document.getElementById("profileRole").textContent = roleLabel;
  document.getElementById("profileSchool").textContent = school;
  document.getElementById("profileJoined").textContent = joinedText;

  document.getElementById("infoName").textContent = name;
  document.getElementById("infoEmail").textContent = email;
  document.getElementById("infoSchool").textContent = school;
  document.getElementById("infoRole").textContent = roleLabel;
  document.getElementById("infoDepartment").textContent = department;
  document.getElementById("infoPhone").textContent = phone || "Not provided";

  // Drawer Sidebar
  const drawerInitials = document.getElementById("drawerInitials");
  const drawerName = document.getElementById("drawerName");
  const drawerRole = document.getElementById("drawerRole");
  if (drawerInitials) drawerInitials.textContent = initials;
  if (drawerName) drawerName.textContent = name;
  if (drawerRole) drawerRole.textContent = roleLabel;

  // A quiet refresh must not overwrite an edit already in progress.
  if (profileDialog?.open) return;
  // Pre-fill Edit Form Inputs
  document.getElementById("inputName").value = name;
  document.getElementById("inputEmail").value = email;
  document.getElementById("inputSchool").value = school;
  document.getElementById("inputDepartment").value = department;
  document.getElementById("inputPhone").value = phone;
}

onAuthStateChanged(auth, async user => {
  activeAdminDocId = null;
  if (editProfileButton) editProfileButton.disabled = true;
  if (!user) { window.location.href = "login.html"; return; }
  initAdminIdleTimeout(auth);
  const timing = createPagePerformance("Admin Profile");
  try {
    await showAdminView({ app, user, page: "profile",
      verified: id => { activeAdminDocId = id; if (editProfileButton) editProfileButton.disabled = false; },
      render: (_, profile) => timing.render(() => updateProfileUI(profile)),
      painted: cacheHit => timing.finish("loaded", { cacheHit })
    });
  } catch (error) { timing.finish("error"); console.error("Error loading admin profile:", error); }
});

// --- DIALOG CONTROLS ---
document.getElementById("editProfileButton")?.addEventListener("click", () => profileDialog?.showModal());
document.getElementById("closeProfileDialog")?.addEventListener("click", () => profileDialog?.close());
document.getElementById("cancelProfileEdit")?.addEventListener("click", () => profileDialog?.close());
if (profileDialog) {
  profileDialog.addEventListener("click", (e) => {
    if (e.target === profileDialog) profileDialog.close();
  });
}

// --- SAVE PROFILE CHANGES TO FIRESTORE ---
if (profileForm) {
  profileForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!activeAdminDocId || !auth.currentUser) return;
    const values = new FormData(profileForm);
    const name = String(values.get("name") || "").trim();
    const email = String(values.get("email") || "").trim();
    const school = String(values.get("school") || "").trim();
    const department = String(values.get("department") || "").trim();
    const phone = String(values.get("phone") || "").trim();

    if (saveProfileBtn) {
      saveProfileBtn.disabled = true;
      saveProfileBtn.textContent = "Saving...";
    }

    try {
      const updatedData = {
        uid: auth.currentUser?.uid || "",
        schoolId: activeAdminDocId,
        role: "admin",
        roleLabel: "School Administrator",
        displayName: name,
        fullName: name,
        providedEmail: email,
        email: email,
        school: school,
        department: department,
        phone: phone,
        updatedAt: serverTimestamp()
      };

      // Merge into Firestore so existing fields (like createdAt) are preserved
      await setDoc(doc(db, "users", activeAdminDocId), updatedData, { merge: true });

      updateProfileUI(updatedData);
      profileDialog.close();
    } catch (err) {
      console.error("Failed to save admin profile:", err);
      alert("Error saving profile: " + err.message);
    } finally {
      if (saveProfileBtn) {
        saveProfileBtn.disabled = false;
        saveProfileBtn.textContent = "Save Changes";
      }
    }
  });
}

// --- LOG OUT ---
if (logoutButton) {
  logoutButton.addEventListener("click", async (e) => {
    e.preventDefault();
    try {
      await signOut(auth);
    } catch (err) {
      console.error("Sign out error:", err);
    }
    window.location.href = "login.html";
  });
}
