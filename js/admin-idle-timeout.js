import { signOut } from "./firebase-auth.js";
import { initWebSession } from "./web-session.js";

const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes in milliseconds
const STORAGE_KEY = "imars_admin_last_active";

const initialized = new WeakSet();
export async function initAdminIdleTimeout(auth) {
  if (initialized.has(auth)) return;
  initialized.add(auth);
  // Protected sessions use the same server deadline in both portals. Keep the
  // original admin timer for static development / disabled protection only.
  if (await initWebSession(auth)) return;
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

  // Check immediately on page load in case the tab was asleep.
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
