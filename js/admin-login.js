import { initializeApp } from "./firebase-auth.js";
import { getAuth, signInWithEmailAndPassword } from "./firebase-auth.js";

const app = initializeApp();
const auth = getAuth(app);

const LOCKOUT_KEY = "imars_admin_lockout_until";
const ATTEMPTS_KEY = "imars_admin_failed_attempts";
const MAX_ATTEMPTS = 3;
const LOCKOUT_DURATION_MS = 60000; // 60 seconds

function getLockoutRemaining() {
  const until = parseInt(localStorage.getItem(LOCKOUT_KEY) || "0", 10);
  const now = Date.now();
  if (until > now) {
    return Math.ceil((until - now) / 1000);
  }
  return 0;
}

function recordFailedAttempt() {
  let attempts = parseInt(localStorage.getItem(ATTEMPTS_KEY) || "0", 10) + 1;
  localStorage.setItem(ATTEMPTS_KEY, String(attempts));
  if (attempts >= MAX_ATTEMPTS) {
    const lockoutUntil = Date.now() + LOCKOUT_DURATION_MS;
    localStorage.setItem(LOCKOUT_KEY, String(lockoutUntil));
    localStorage.setItem(ATTEMPTS_KEY, "0");
  }
}

function resetAttempts() {
  localStorage.removeItem(ATTEMPTS_KEY);
  localStorage.removeItem(LOCKOUT_KEY);
}

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

// Check initial lockout state on load
const remaining = getLockoutRemaining();
if (remaining > 0) {
  adminSubmitBtn.disabled = true;
  showAdminError(`Too many failed login attempts. Please wait ${remaining} seconds.`);
  setTimeout(() => {
    adminSubmitBtn.disabled = false;
    adminError.classList.add("hidden");
  }, remaining * 1000);
}

toggleAdminPassword.addEventListener("click", () => {
  const hidden = adminPasswordInput.type === "password";
  adminPasswordInput.type = hidden ? "text" : "password";
  toggleAdminPassword.setAttribute("aria-label", hidden ? "Hide password" : "Show password");
  toggleAdminPassword.setAttribute("aria-pressed", String(hidden));
  toggleAdminPassword.querySelector(".admin-eye-open").classList.toggle("hidden", hidden);
  toggleAdminPassword.querySelector(".admin-eye-off").classList.toggle("hidden", !hidden);
});

adminForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const currentLock = getLockoutRemaining();
  if (currentLock > 0) {
    showAdminError(`Portal locked due to security policy. Retry in ${currentLock}s.`);
    return;
  }
  if (adminSubmitBtn.disabled) return;
  if (adminError) adminError.classList.add("hidden");

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
    if (!redirecting) setSigningIn(adminSubmitBtn, false, "Sign in as Admin");
  }
});