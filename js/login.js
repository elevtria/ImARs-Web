import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { webProtectionEnabled, protectedWebLogin, closeWebSession } from "./web-login.js";
import { getAuth, signInWithEmailAndPassword, signOut } from "./firebase-auth.js";
import { getFirestore, doc, getDoc } from "./firebase-data.js";

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

function setSigningIn(button, pending, idleLabel) {
  button.disabled = pending;
  button.setAttribute("aria-busy", String(pending));
  button.querySelector("[data-login-label]").textContent = pending ? "Signing in…" : idleLabel;
}

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

const teacherSubmitBtn = document.getElementById("teacherSubmitBtn");
document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (teacherSubmitBtn.disabled) return;

  const rawId = document.getElementById("teacherId").value.trim().toUpperCase();
  const password = passwordInput.value.trim();
  const error = document.getElementById("error");
  error.classList.add("hidden");
  error.style.display = "none";

  const showError = (message) => {
    error.classList.remove("hidden");
    error.style.display = "block";
    error.innerText = message;
  };

  if (!rawId || !password) {
    showError("Please enter your ID and password.");
    return;
  }

  setSigningIn(teacherSubmitBtn, true, "Log in");
  let redirecting = false;
  try {
    if (await webProtectionEnabled()) {
      const email = await protectedWebLogin(rawId, password, "teacher");
      try { await signInWithEmailAndPassword(auth, email, password, "teacher"); }
      catch (error) { await closeWebSession(); throw error; }
      window.location.href = "index.html";
      redirecting = true;
      return;
    }
    const userDocRef = doc(db, "users", rawId);
    const userDocSnap = await getDoc(userDocRef);

    if (!userDocSnap.exists()) {
      showError("Teacher ID not found in database.");
      return;
    }

    const userData = userDocSnap.data();
    const userRole = String(userData.role || "").toLowerCase();

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

    await signInWithEmailAndPassword(auth, authEmail, password, "teacher");

    window.location.href = "index.html";
    redirecting = true;
  } catch (err) {
    showError(err.userMessage || "Invalid ID or password. Please try again.");
    console.error("Firebase Login Error:", err.message);
  } finally {
    if (!redirecting) setSigningIn(teacherSubmitBtn, false, "Log in");
  }
});

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

if (adminModal) {
  adminModal.addEventListener("click", (e) => {
    if (e.target === adminModal) adminModal.close();
  });
}

if (adminForm) {
  adminForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (adminSubmitBtn.disabled) return;
    if (adminError) adminError.classList.add("hidden");

    const rawInput = document.getElementById("adminIdentifier").value.trim();
    const password = document.getElementById("adminPassword").value.trim();

    if (!rawInput || !password) {
      showAdminError("Please enter your admin email/ID and password.");
      return;
    }

    setSigningIn(adminSubmitBtn, true, "Sign in as Admin");
    let redirecting = false;
    try {
      if (await webProtectionEnabled()) {
        const email = await protectedWebLogin(rawInput, password, "admin");
        try { await signInWithEmailAndPassword(auth, email, password, "admin"); }
        catch (error) { await closeWebSession(); throw error; }
        localStorage.setItem("imars_admin_last_active", String(Date.now()));
        window.location.href = "admin-dashboard.html";
        redirecting = true;
        return;
      }
      let authEmail = rawInput;

      // Resolve an admin ID to its registered sign-in email.
      if (!rawInput.includes("@")) {
        const adminId = rawInput.toUpperCase();
        const adminDocSnap = await getDoc(doc(db, "users", adminId));

        if (adminDocSnap.exists()) {
          const data = adminDocSnap.data();
          const role = String(data.role || "").toLowerCase();
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

      await signInWithEmailAndPassword(auth, authEmail, password, "admin");

      localStorage.setItem("imars_admin_last_active", String(Date.now()));

      window.location.href = "admin-dashboard.html";
      redirecting = true;
    } catch (err) {
      console.error("Admin Login Error:", err.message);
      showAdminError(err.userMessage || "Invalid Admin credentials. Please try again.");
    } finally {
      if (!redirecting) setSigningIn(adminSubmitBtn, false, "Sign in as Admin");
    }
  });
}

const urlParams = new URLSearchParams(window.location.search);
if (["access-denied", "access-unavailable"].includes(urlParams.get("reason"))) {
  const message = document.getElementById("error");
  message.classList.remove("hidden");
  message.textContent = urlParams.get("reason") === "access-denied"
    ? "This account does not have access to this portal. Please contact your administrator."
    : "We could not verify access. Check your connection and sign in again.";
  message.style.display = "block";
}
if (urlParams.get("reason") === "web-session") {
  const message = document.getElementById("error");
  if (message) {
    message.classList.remove("hidden");
    message.innerText = "Your website session ended. Please sign in again to continue.";
    message.style.display = "block";
  }
}
if (urlParams.get("reason") === "timeout") {
  if (adminModal) {
    adminModal.showModal();
    showAdminError("Your session expired due to 10 minutes of inactivity. Please sign in again.");
  }
  window.history.replaceState({}, document.title, window.location.pathname);
}
