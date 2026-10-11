import { signOut } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";

const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes in milliseconds
const STORAGE_KEY = "imars_admin_last_active";

export function initAdminIdleTimeout(auth) {
  let idleTimer = null;

  const performAutoLogout = async () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
      await signOut(auth);
    } catch (err) {
      console.error("Auto-logout error:", err);
    }
    // Redirect to login page with a timeout flag so login.html can notify the admin
    window.location.href = "login.html?reason=timeout";
  };

  const resetTimer = () => {
    const now = Date.now();
    localStorage.setItem(STORAGE_KEY, String(now));

    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(checkInactivity, IDLE_TIMEOUT_MS);
  };

  const checkInactivity = () => {
    const lastActive = parseInt(localStorage.getItem(STORAGE_KEY) || "0", 10);
    const elapsed = Date.now() - lastActive;

    if (elapsed >= IDLE_TIMEOUT_MS) {
      performAutoLogout();
    } else {
      // If another tab was active recently, wait the remaining time
      idleTimer = setTimeout(checkInactivity, IDLE_TIMEOUT_MS - elapsed);
    }
  };

  // Check immediately on page load in case 30 mins passed while tab was asleep
  const initialLastActive = parseInt(localStorage.getItem(STORAGE_KEY) || "0", 10);
  if (initialLastActive && Date.now() - initialLastActive >= IDLE_TIMEOUT_MS) {
    performAutoLogout();
    return;
  }

  // Listen for user activity
  const activityEvents = ["mousemove", "mousedown", "keydown", "scroll", "touchstart", "click"];
  activityEvents.forEach((eventType) => {
    window.addEventListener(eventType, resetTimer, { passive: true });
  });

  // Start the timer
  resetTimer();
}