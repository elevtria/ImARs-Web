import { initializeApp, getAuth, onAuthStateChanged } from "./firebase-auth.js";
import { showAdminView } from "./admin-view.js";
import { escapeHtml } from "./teacher-view.js";
import { webRequest } from "./web-login.js";
import { confirmAdminAction } from "./admin-account-action.js";

const app = initializeApp(), auth = getAuth(app);
const account = document.getElementById("securityAccount"), status = document.getElementById("securityStatus");
const table = document.getElementById("securityAudit"), auditStatus = document.getElementById("auditStatus");
const more = document.getElementById("moreAudit"), refresh = document.getElementById("refreshAudit");
let ready = false, cursor = null, loading = false;
const actionLabels = { "school-year-closed": "School year archived", "teacher-created": "Teacher created", "teacher-activated": "Teacher activated", "teacher-deactivated": "Teacher deactivated", "teacher-removed": "Teacher removed", "school-year-updated": "School year updated", "section-transferred": "Section transferred", "password-reset-requested": "Recovery requested", "password-reset-sent": "Recovery email accepted", "password-reset-failed": "Recovery delivery failed", "portal-sessions-requested": "Session termination requested", "portal-sessions-ended": "Portal sessions ended" };
async function loadAudit(append = false) {
  if (loading || !ready) return;
  loading = true; more.disabled = refresh.disabled = true;
  auditStatus.textContent = "Checking activity…";
  try {
    const uid = auth.currentUser?.uid;
    const result = await webRequest("/api/admin-security/action", { action: "audit", ...(append && cursor ? { cursor } : {}) });
    if (auth.currentUser?.uid !== uid) return;
    const html = result.entries.map(row => `<tr><td>${escapeHtml(new Date(row.at).toLocaleString("en-PH", { timeZone: "Asia/Manila" }))}</td><td>${escapeHtml(row.actorId)}</td><td>${escapeHtml(actionLabels[row.action] || row.action)}</td><td>${escapeHtml(row.targetId)}</td><td>${escapeHtml(row.details || "—")}</td></tr>`).join("");
    if (append) table.insertAdjacentHTML("beforeend", html);
    else table.innerHTML = html || '<tr><td colspan="5">No administrative actions have been recorded yet.</td></tr>';
    cursor = result.cursor; more.hidden = !cursor; auditStatus.textContent = "Latest recorded administrative actions.";
  } catch (error) { auditStatus.textContent = error.message; }
  finally { loading = false; more.disabled = refresh.disabled = false; }
}
onAuthStateChanged(auth, async user => {
  ready = false;
  if (!user) return;
  await showAdminView({ app, user, page: "admin:security-directory-v1",
    load: () => webRequest("/api/admin-security/action", { action: "directory" }),
    render: directory => {
      const selected = account.value;
      account.innerHTML = directory.teachers.map(row => `<option value="${escapeHtml(row.id)}">${escapeHtml(row.name)} · ${escapeHtml(row.id)}${row.active ? "" : " (inactive)"}</option>`).join("") || '<option value="">No teacher accounts available</option>';
      account.disabled = directory.teachers.length === 0;
      if ([...account.options].some(option => option.value === selected)) account.value = selected;
      ready = true;
    } });
  if (ready) await loadAudit();
});
document.getElementById("accountSecurityForm").addEventListener("submit", async event => {
  event.preventDefault(); if (!ready || !account.value || auth.currentUser?.role !== "admin") return;
  const action = document.getElementById("securityAction").value;
  const result = await confirmAdminAction({ action, targetId: account.value }, action === "reset-password" ? "Send recovery email?" : "End portal sessions?",
    `${account.selectedOptions[0].textContent}. ${action === "reset-password" ? "A reset link will be sent to the account’s verified Firebase email. This does not change its password immediately." : "Existing portal access will end on the next protected request. Saved learning records are preserved."}`);
  if (result) { status.textContent = result.message; await loadAudit(); }
});
refresh.addEventListener("click", () => loadAudit());
more.addEventListener("click", () => loadAudit(true));
