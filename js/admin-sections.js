import { initializeApp, getAuth } from "./firebase-auth.js";
import { webRequest } from "./web-login.js";
import { escapeHtml } from "./teacher-view.js";
import { confirmAdminAction } from "./admin-account-action.js";

const auth = getAuth(initializeApp()), table = document.getElementById("adminSections"), status = document.getElementById("sectionDirectoryStatus");
const tabs = [document.getElementById("teachersTab"), document.getElementById("sectionsTab")];
let directory, loading = false;
async function load() {
  if (loading || auth.currentUser?.role !== "admin") return;
  loading = true; status.textContent = "Loading section assignments…";
  try {
    const uid = auth.currentUser.uid;
    const result = await webRequest("/api/admin-security/action", { action: "directory" });
    if (auth.currentUser?.uid !== uid) return;
    directory = result;
    table.innerHTML = result.sections.map(section => {
      const owner = result.teachers.find(teacher => teacher.id === section.teacherId);
      return `<tr><th scope="row">${escapeHtml(section.name)}<small>${escapeHtml(section.id)}</small></th><td>${escapeHtml(owner?.name || "Unassigned")}<small>${escapeHtml(section.teacherId)}</small></td><td>${section.students}</td><td><div class="admin-actions"><select class="admin-transfer-select" aria-label="New teacher for ${escapeHtml(section.name)}"><option value="">Choose teacher</option>${result.teachers.filter(teacher => teacher.active && teacher.id !== section.teacherId).map(teacher => `<option value="${escapeHtml(teacher.id)}">${escapeHtml(teacher.name)}</option>`).join("")}</select><button class="ghost-btn" type="button" data-transfer-section="${escapeHtml(section.id)}">Transfer</button></div></td></tr>`;
    }).join("") || '<tr><td colspan="4">No active sections found.</td></tr>';
    status.textContent = "Assignments use the current class roster. A transfer does not move quizzes authored by the previous teacher.";
  } catch (error) { status.textContent = error.message; }
  finally { loading = false; }
}
function select(index) {
  tabs.forEach((tab, i) => { tab.setAttribute("aria-selected", String(i === index)); tab.tabIndex = i === index ? 0 : -1; document.getElementById(tab.getAttribute("aria-controls")).hidden = i !== index; });
  document.querySelector(".manage-tools").hidden = index === 1;
  if (index === 1) void load();
}
tabs.forEach((tab, index) => {
  tab.addEventListener("click", () => select(index));
  tab.addEventListener("keydown", event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? 1 : 1 - index; select(next); tabs[next].focus(); } });
});
table.addEventListener("click", async event => {
  const button = event.target.closest("[data-transfer-section]");
  if (!button || auth.currentUser?.role !== "admin") return;
  const section = directory?.sections.find(row => row.id === button.dataset.transferSection);
  const teacherId = button.closest("tr").querySelector("select").value;
  const teacher = directory?.teachers.find(row => row.id === teacherId);
  if (!section || !teacher) { status.textContent = "Choose a destination teacher first."; return; }
  const result = await confirmAdminAction({ action: "transfer-section", sectionId: section.id, previousTeacherId: section.teacherId, teacherId }, "Transfer section?",
    `Move ${section.name} (${section.students} active students) to ${teacher.name}? Existing scores and student account status will be preserved.`);
  if (result) { await load(); status.textContent = result.message; }
});
