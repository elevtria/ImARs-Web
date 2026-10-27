import { initializeApp } from "./firebase-auth.js";
import { getAuth, signInWithEmailAndPassword } from "./firebase-auth.js";

const app = initializeApp();
const auth = getAuth(app);


async function saveBrowserPassword(optionId, identifier, password) {
  if (!document.getElementById(optionId)?.checked || typeof window.PasswordCredential !== "function") return;
  try {
    if (window.navigator?.credentials?.store) {
      const credential = new window.PasswordCredential({ id: identifier, password });
      // Saving is optional and must never prevent a successful sign-in.
      await Promise.race([
        window.navigator.credentials.store(credential),
        new Promise(resolve => setTimeout(resolve, 1500))
      ]);
    }
  } catch { /* The browser owns password-manager consent and availability. */ }
}

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
  const password = passwordInput.value;
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
    await signInWithEmailAndPassword(auth, rawId, password, "teacher");
    void saveBrowserPassword("saveTeacherPassword", rawId, password);

    window.location.href = "index.html";
    redirecting = true;
  } catch (err) {
    showError(err.userMessage || "Invalid ID or password. Please try again.");
    console.error("Sign-in error:", err.message);
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
  adminPasswordInput.type = "password";
  toggleAdminPassword.setAttribute("aria-label", "Show password");
  toggleAdminPassword.setAttribute("aria-pressed", "false");
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
    const password = document.getElementById("adminPassword").value;

    if (!rawInput || !password) {
      showAdminError("Please enter your admin email/ID and password.");
      return;
    }

    setSigningIn(adminSubmitBtn, true, "Sign in as Admin");
    let redirecting = false;
    try {
      await signInWithEmailAndPassword(auth, rawInput, password, "admin");
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

const adminPasswordInput = document.getElementById("adminPassword");
const toggleAdminPassword = document.getElementById("toggleAdminPassword");
toggleAdminPassword.addEventListener("click", () => {
  const hidden = adminPasswordInput.type === "password";
  adminPasswordInput.type = hidden ? "text" : "password";
  toggleAdminPassword.setAttribute("aria-label", hidden ? "Hide password" : "Show password");
  toggleAdminPassword.setAttribute("aria-pressed", String(hidden));
});
