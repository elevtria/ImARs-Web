import { getApps, initializeApp } from "./firebase-auth.js";
import { getAuth, onAuthStateChanged, signOut } from "./firebase-auth.js";
import { initWebSession } from "./web-session.js";
import { initTeacherNotifications } from "./teacher-notifications.js";

const nameElement = document.querySelector(".side-user .user-meta strong");
const avatarElement = document.querySelector(".side-user .user-avatar");
const adminPortal = document.body.classList.contains("admin-portal");

document.addEventListener("click", async event => {
  const link = event.target.closest(".account-menu a[href]");
  if (!link) return;
  const url = new URL(link.href, window.location.href);
  const loginPath = adminPortal ? "/admin-login" : "/login";
  if (url.origin !== window.location.origin || url.pathname.replace(/\.html$/, "") !== loginPath) return;
  event.preventDefault();
  try {
    const app = getApps().find(candidate => candidate.name === "[DEFAULT]");
    if (app) await signOut(getAuth(app));
    else {
      const { closeWebSession } = await import("./web-login.js");
      await closeWebSession();
    }
    window.location.href = link.href;
  } catch (error) { window.alert(error.message); }
});

if (nameElement && avatarElement) {

  const app = getApps().find((candidate) => candidate.name === "[DEFAULT]") || initializeApp();
  const auth = getAuth(app);
  initWebSession(auth);
  if (!adminPortal) initTeacherNotifications(app, auth);

  onAuthStateChanged(auth, (user) => {
    if (!user) return;

    try {
      const name = user.displayName || (adminPortal ? "Admin" : "Teacher");
      nameElement.textContent = name;
      const nameParts = name.trim().split(/\s+/).filter(Boolean);
      avatarElement.textContent = nameParts.length > 1
        ? (nameParts[0][0] + nameParts[nameParts.length - 1][0]).toUpperCase()
        : (nameParts[0] || (adminPortal ? "A" : "T")).slice(0, 2).toUpperCase();
    } catch (error) {
      console.error("Unable to display the signed-in account name:", error);
    }
  });
}
