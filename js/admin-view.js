import { getAuth, signOut } from "./firebase-auth.js";
import { showTeacherView } from "./teacher-view.js";
import { teacherViewCache } from "./view-cache.js";
import { revealContent } from "./loading.js";

const reportIntervalMs = 5 * 60_000;
export const formatAdminPercent = value => Number.isFinite(value) ? `${value}%` : "—";
export const formatAdminGain = value => Number.isFinite(value) ? `${value > 0 ? "+" : ""}${value} pp` : "—";

globalThis.document?.querySelector(".help-button")?.addEventListener("click", () => {
  let help = document.getElementById("adminHelp");
  if (!help) {
    help = document.createElement("dialog");
    help.id = "adminHelp";
    help.setAttribute("aria-labelledby", "adminHelpTitle");
    help.innerHTML = `<h2 id="adminHelpTitle">Admin help</h2>
      <p><a href="/admin-dashboard">Overview</a> shows school totals and teacher performance.</p>
      <p><a href="/manage-teachers">Manage Teachers</a> lets you manage teacher accounts and section assignments.</p>
      <p><a href="/school-analytics">School Analytics</a> compares results by teacher and section.</p>
      <p><a href="/admin-manual">Admin Manual</a> walks through the portal’s tools.</p>
      <form method="dialog"><button autofocus type="submit">Close</button></form>`;
    document.body.append(help);
  }
  help.showModal();
});

export async function showAdminView({ app, user, load, render, verified = () => {}, painted }) {
  const auth = getAuth(app);
  if (auth.currentUser?.uid !== user.uid) return;
  try {
    // The shared sign-in flow verifies the live staff profile before this callback.
    if (auth.currentUser.role !== "admin") throw Object.assign(new Error("Administrator access is required."), { code: "permission-denied" });
    verified();
    await showTeacherView({ app, user, page: "admin:reports-v2", load, painted,
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
