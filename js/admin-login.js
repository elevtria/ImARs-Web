import { initializeApp } from "./firebase-auth.js";
import { getAuth, signInWithEmailAndPassword } from "./firebase-auth.js";

const app = initializeApp();
const auth = getAuth(app);

function setSigningIn(button, pending, idleLabel) {
  button.disabled = pending;
  button.setAttribute("aria-busy", String(pending));
  button.querySelector("[data-login-label]").textContent = pending ? "Authenticating…" : idleLabel;
}

const adminForm = document.getElementById("adminLoginForm");
const adminError = document.getElementById("adminError");
const adminSubmitBtn = document.getElementById("adminSubmitBtn");
const adminIdentifierInput = document.getElementById("adminIdentifier");
const adminPasswordInput = document.getElementById("adminPassword");
const toggleAdminPassword = document.getElementById("toggleAdminPassword");

const showAdminError = (msg) => {
  if (!adminError) return;

  adminError.textContent = msg;
  adminError.classList.remove("hidden");
};

toggleAdminPassword.addEventListener("click", () => {
  const hidden = adminPasswordInput.type === "password";

  adminPasswordInput.type = hidden ? "text" : "password";

  toggleAdminPassword.setAttribute(
    "aria-label",
    hidden ? "Hide password" : "Show password"
  );

  toggleAdminPassword.setAttribute("aria-pressed", String(hidden));

  toggleAdminPassword.querySelector(".admin-eye-open")
    .classList.toggle("hidden", hidden);

  toggleAdminPassword.querySelector(".admin-eye-off")
    .classList.toggle("hidden", !hidden);
});

adminForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const currentLock = getLockoutRemaining();
  if (currentLock > 0) {
    showAdminError(`Portal locked due to security policy. Retry in ${currentLock}s.`);
    return;
  }
  if (adminSubmitBtn.disabled) return;

  if (adminError) {
    adminError.classList.add("hidden");
  }

  const rawInput = adminIdentifierInput.value.trim();
  const password = adminPasswordInput.value;

  if (!rawInput || !password) {
    showAdminError("Please enter your admin credentials.");
    return;
  }

  setSigningIn(adminSubmitBtn, true, "Sign in as Admin");

  let redirecting = false;

  try {
    // Explicitly enforce admin role constraint
    await signInWithEmailAndPassword(auth, rawInput, password, "admin");
    resetAttempts();
    window.location.href = "admin-dashboard.html";
    redirecting = true;

  } catch (err) {
    console.error("Admin Login Error:", err.message);
    recordFailedAttempt();
    
    const lockoutNow = getLockoutRemaining();
    if (lockoutNow > 0) {
      showAdminError(`Too many failed attempts. Security lockout engaged for ${lockoutNow}s.`);
      adminSubmitBtn.disabled = true;
      setTimeout(() => {
        adminSubmitBtn.disabled = false;
        adminError.classList.add("hidden");
      }, lockoutNow * 1000);
    } else {
      showAdminError(err.userMessage || "Invalid Administrator credentials. Please try again.");
    }
  } finally {
    if (!redirecting) {
      setSigningIn(adminSubmitBtn, false, "Sign in as Admin");
    }
  }
});
