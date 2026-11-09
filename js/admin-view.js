import { getAuth, signOut } from "./firebase-auth.js";
import { showTeacherView } from "./teacher-view.js";
import { teacherViewCache } from "./view-cache.js";
import { revealContent } from "./loading.js";

const reportIntervalMs = 5 * 60_000;

export async function showAdminView({ app, user, load, render, verified = () => {}, painted }) {
  const auth = getAuth(app);
  if (auth.currentUser?.uid !== user.uid) return;
  try {
    // The shared sign-in flow verifies the live staff profile before this callback.
    if (auth.currentUser.role !== "admin") throw Object.assign(new Error("Administrator access is required."), { code: "permission-denied" });
    verified();
    await showTeacherView({ app, user, page: "admin:reports", load, painted,
      freshForMs: reportIntervalMs, refreshIntervalMs: reportIntervalMs,
      render: report => { render(report); revealContent("admin-report"); }
    });
  } catch (error) {
    if (auth.currentUser?.uid !== user.uid) return;
    if (["permission-denied", "unauthenticated"].includes(error.code)) {
      teacherViewCache().invalidate();
      document.querySelector("main")?.replaceChildren();
      try { await signOut(auth); } finally { window.location.href = "admin-login.html"; }
      return;
    }
    let status = document.getElementById("viewDataStatus");
    if (!status) {
      status = document.createElement("p");
      status.id = "viewDataStatus";
      status.className = "view-data-status";
      status.setAttribute("role", "status");
      document.querySelector("main")?.prepend(status);
    }
    status.hidden = false;
    status.textContent = "Unable to load admin data. Check your connection and refresh to try again.";
    throw error;
  }
}
