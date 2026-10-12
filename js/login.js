import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { getFirestore, doc, getDoc, collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

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

// --- TEACHER PASSWORD TOGGLE ---
const passwordInput = document.getElementById("password");
const togglePassword = document.getElementById("togglePassword");
const eyeOpen = document.getElementById("eyeOpen");
const eyeOff = document.getElementById("eyeOff");

togglePassword.addEventListener("click", () => {
  const hidden = passwordInput.type === "password";
  passwordInput.type = hidden ? "text" : "password";
  eyeOpen.classList.toggle("hidden", hidden);
  eyeOff.classList.toggle("hidden", !hidden);
  togglePassword.setAttribute("aria-label", hidden ? "Hide password" : "Show password");
});

// --- TEACHER LOGIN SUBMIT ---
document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();

  const rawId = document.getElementById("teacherId").value.trim().toUpperCase();
  const password = passwordInput.value.trim();
  const error = document.getElementById("error");

  const showError = (message) => {
    error.classList.remove("hidden");
    error.style.display = "block";
    error.innerText = message;
  };

  if (!rawId || !password) {
    showError("Please enter your ID and password.");
    return;
  }

  try {
    const userDocRef = doc(db, "users", rawId);
    const userDocSnap = await getDoc(userDocRef);

    if (!userDocSnap.exists()) {
      showError("Teacher ID not found in database.");
      return;
    }

    const userData = userDocSnap.data();
    const userRole = String(userData.role || "").toLowerCase();

    // STRICT ROLE CHECK: Block Admins and Students from Teacher Sign-In
    if (userRole === "admin") {
      await signOut(auth);
      showError("Access denied: Administrator accounts cannot sign in here. Please use the Admin Login.");
      return;
    }
    if (userRole !== "teacher") {
      await signOut(auth);
      showError("Access denied: Only Teacher accounts can sign in here.");
      return;
    }

    const authEmail = userData.providedEmail || userData.email || `${rawId}@imars.edu`;

    const userCred = await signInWithEmailAndPassword(auth, authEmail, password);

    // Double-check role by UID after authentication just in case
    const uidQuery = query(collection(db, "users"), where("uid", "==", userCred.user.uid));
    const uidSnap = await getDocs(uidQuery);
    if (!uidSnap.empty) {
      const verifiedRole = String(uidSnap.docs[0].data().role || "").toLowerCase();
      if (verifiedRole !== "teacher") {
        await signOut(auth);
        showError("Access denied: This account is not a Teacher account.");
        return;
      }
    }

    window.location.href = "index.html";
  } catch (err) {
    showError("Invalid ID or password. Please try again.");
    console.error("Firebase Login Error:", err.message);
  }
});

// --- ADMIN MODAL POP-UP LOGIC ---
const adminModal = document.getElementById("adminLoginModal");
const openAdminBtn = document.getElementById("openAdminModalBtn");
const closeAdminBtn = document.getElementById("closeAdminModalBtn");
const cancelAdminBtn = document.getElementById("cancelAdminModalBtn");
const adminForm = document.getElementById("adminLoginForm");
const adminError = document.getElementById("adminError");
const adminSubmitBtn = document.getElementById("adminSubmitBtn");

const showAdminError = (msg) => {
  if (!adminError) return;
  adminError.textContent = msg;
  adminError.classList.remove("hidden");
};

const clearAdminModal = () => {
  if (adminError) adminError.classList.add("hidden");
  if (adminForm) adminForm.reset();
};

if (openAdminBtn && adminModal) {
  openAdminBtn.addEventListener("click", () => {
    clearAdminModal();
    adminModal.showModal();
  });
}

if (closeAdminBtn && adminModal) {
  closeAdminBtn.addEventListener("click", () => adminModal.close());
}

if (cancelAdminBtn && adminModal) {
  cancelAdminBtn.addEventListener("click", () => adminModal.close());
}

// Close modal when clicking backdrop outside the box
if (adminModal) {
  adminModal.addEventListener("click", (e) => {
    if (e.target === adminModal) adminModal.close();
  });
}

// --- ADMIN LOGIN SUBMIT ---
if (adminForm) {
  adminForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (adminError) adminError.classList.add("hidden");

    const rawInput = document.getElementById("adminIdentifier").value.trim();
    const password = document.getElementById("adminPassword").value.trim();

    if (!rawInput || !password) {
      showAdminError("Please enter your admin email/ID and password.");
      return;
    }

    if (adminSubmitBtn) {
      adminSubmitBtn.disabled = true;
      adminSubmitBtn.textContent = "Signing in...";
    }

    try {
      let authEmail = rawInput;

      // If the admin typed an ID (no '@' symbol), look it up in Firestore
      if (!rawInput.includes("@")) {
        const adminId = rawInput.toUpperCase();
        const adminDocSnap = await getDoc(doc(db, "users", adminId));

        if (adminDocSnap.exists()) {
          const data = adminDocSnap.data();
          const role = String(data.role || "").toLowerCase();
          // STRICT ROLE CHECK: Only allow "admin" role
          if (role !== "admin") {
            await signOut(auth);
            showAdminError("Unauthorized: Only Administrator accounts can access the Admin Portal.");
            return;
          }
          authEmail = data.providedEmail || data.email || `${adminId}@imars.edu`;
        } else {
          showAdminError("Admin ID not found.");
          return;
        }
      }

      // Sign in with Firebase Auth
      const userCred = await signInWithEmailAndPassword(auth, authEmail, password);

      // Verify by UID that the signed-in user is strictly an admin
      const uidQuery = query(collection(db, "users"), where("uid", "==", userCred.user.uid));
      const uidSnap = await getDocs(uidQuery);
      if (!uidSnap.empty) {
        const userData = uidSnap.docs[0].data();
        const role = String(userData.role || "").toLowerCase();
        if (role !== "admin") {
          await signOut(auth);
          showAdminError("Access denied: Only Administrator accounts can access the Admin Portal.");
          return;
        }
      }

      // Set fresh activity timestamp on login
      localStorage.setItem("imars_admin_last_active", String(Date.now()));

      // Redirect to Admin Dashboard!
      window.location.href = "admin-dashboard.html";
    } catch (err) {
      console.error("Admin Login Error:", err.message);
      showAdminError("Invalid Admin credentials. Please try again.");
    } finally {
      if (adminSubmitBtn) {
        adminSubmitBtn.disabled = false;
        adminSubmitBtn.textContent = "Sign in as Admin";
      }
    }
  });
}

// --- HANDLE AUTO-LOGOUT REDIRECT & TIMESTAMP RESET ---
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get("reason") === "timeout") {
  if (adminModal) {
    adminModal.showModal();
    showAdminError("Your session expired due to 10 minutes of inactivity. Please sign in again.");
  }
  // Clean up URL bar
  window.history.replaceState({}, document.title, window.location.pathname);
}