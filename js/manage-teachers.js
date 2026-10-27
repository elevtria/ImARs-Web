import { loadStaffDirectory } from "./admin-report-data.js";
import { showAdminView } from "./admin-view.js";
import { initializeApp, getAuth, onAuthStateChanged } from "./firebase-auth.js";
import { getFirestore, doc, updateDoc, deleteDoc, createTeacher } from "./firebase-data.js";
import { webRequest, webProtectionEnabled } from "./web-login.js";
import { invalidateTeacherViews } from "./view-cache.js";
import { initAdminIdleTimeout } from "./admin-idle-timeout.js";

const app = initializeApp(), auth = getAuth(app), db = getFirestore(app);
const menu = document.getElementById("adminMenuButton"), drawer = document.getElementById("adminNavigation");
const setDrawer = open => { drawer.classList.toggle("open", open); drawer.setAttribute("aria-hidden", String(!open)); menu.setAttribute("aria-expanded", String(open)); };
menu.addEventListener("click", () => setDrawer(!drawer.classList.contains("open")));
document.getElementById("adminDrawerClose").addEventListener("click", () => setDrawer(false));
drawer.addEventListener("click", event => { if (event.target === drawer) setDrawer(false); });
document.addEventListener("keydown", event => { if (event.key === "Escape") setDrawer(false); });

const list = document.getElementById("teacherList"), search = document.getElementById("teacherSearch"), dialog = document.getElementById("teacherDialog"), form = document.getElementById("teacherForm");
const add = document.getElementById("addTeacherButton"), choices = document.getElementById("teacherSections"), status = document.getElementById("teacherFormStatus");
let teachers = [], sections = [], totalStudents = 0, ready = false, locks = false, editing = null, submitting = false;
const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
webProtectionEnabled().then(value => { locks = value; render(); }).catch(() => {});
function render() {
  const active = teachers.filter(row => row.active).length;
  document.getElementById("activeCount").textContent = active;
  document.getElementById("inactiveCount").textContent = teachers.length - active;
  document.getElementById("teacherSummary").textContent = `${active} active · ${teachers.length} total`;
  document.getElementById("sectionCount").textContent = sections.length;
  document.getElementById("studentCount").textContent = totalStudents;
  const query = search.value.trim().toLowerCase();
  const visible = teachers.filter(row => [row.id,row.name,row.email,row.subject,...row.sections].join(" ").toLowerCase().includes(query));
  list.innerHTML = visible.map(row => `<article class="teacher-record"><div class="teacher-record-top"><div class="teacher-profile">
    <span class="record-avatar ${row.active ? "" : "inactive"}">${escape(row.name.trim().split(/\s+/).slice(0,2).map(part=>part[0]).join(""))}</span>
    <div class="teacher-info"><div class="teacher-name-line"><strong>${escape(row.name)}</strong><span class="teacher-status ${row.active ? "" : "inactive"}">${row.active ? "Active" : "Inactive"}</span><span class="teacher-id-badge">${escape(row.id)}</span></div>
    <small class="teacher-contact">${escape(row.email)} · ${escape(row.subject)}</small><div class="section-chips">${row.sections.length ? row.sections.map(name=>`<span class="section-chip">${escape(name)}</span>`).join("") : "No sections assigned"}</div></div></div>
    <div class="teacher-actions"><button type="button" class="record-action" data-edit="${escape(row.id)}" ${ready ? "" : "disabled"}>Edit</button>
    ${locks ? `<button type="button" class="record-action" data-unlock="${escape(row.id)}" ${ready ? "" : "disabled"}>Unlock login</button>` : ""}
    <button type="button" class="record-action" data-toggle="${escape(row.id)}" ${ready ? "" : "disabled"}>${row.active ? "Deactivate" : "Activate"}</button>
    <button type="button" class="record-action delete" data-delete="${escape(row.id)}" ${ready ? "" : "disabled"}>Remove</button></div></div></article>`).join("");
  document.getElementById("noTeachers").hidden = visible.length !== 0;
}
async function load(fresh = false) {
  const user = auth.currentUser; if (!user) return;
  await showAdminView({ app, user, page:"staff-directory:v1", freshForMs:fresh ? 0 : 60000,
    verified: () => { ready = true; add.disabled = false; }, load: loadStaffDirectory,
    render: data => {
      sections = data.sections; totalStudents = data.totalStudents;
      teachers = data.teachers.map(({id,data})=>({id,name:data.fullName || data.displayName || data.name || "Teacher",email:data.providedEmail || data.email || "",subject:data.subject || "Science",
        active:data.active !== false && !["inactive","disabled"].includes(data.status),sections:sections.filter(row=>row.data.teacherId===id).map(row=>row.data.SectionName)}));
      render();
    } });
}
add.disabled = true;
onAuthStateChanged(auth, async user => {
  ready = false; add.disabled = true;
  if (!user) { window.location.href="login.html"; return; }
  initAdminIdleTimeout(auth);
  try { await load(); } catch(error) { console.error("Teacher directory unavailable:",error); }
});
search.addEventListener("input",render);
function edit(id = null) {
  editing = id; form.reset(); status.textContent = "";
  const teacher = teachers.find(row=>row.id===id);
  form.elements.name.value = teacher?.name || ""; form.elements.email.value = teacher?.email || "";
  form.elements.email.readOnly = Boolean(id); form.elements.subject.value = teacher?.subject || "Science";
  document.getElementById("dialogTitle").textContent = id ? "Edit Teacher" : "Add Teacher";
  document.getElementById("teacherDialogHint").textContent = id ? "Update account details and assigned sections. Email changes require account maintenance." : "Add a teacher account and assign its sections.";
  form.querySelector('[type="submit"]').textContent = id ? "Save changes" : "Add Teacher";
  choices.replaceChildren(...sections.filter(row=>!row.data.teacherId || row.data.teacherId===id).map(row=>{
    const option=document.createElement("option"); option.value=row.id; option.textContent=row.data.SectionName; option.selected=row.data.teacherId===id; return option;
  }));
  dialog.showModal();
}
add.addEventListener("click",()=>edit());
for (const id of ["closeTeacherDialog","cancelTeacherDialog"]) document.getElementById(id).addEventListener("click",()=>dialog.close());
list.addEventListener("click",async event=>{
  const button=event.target.closest("button"); if (!button || !ready || !auth.currentUser) return;
  if (button.dataset.edit) { edit(button.dataset.edit); return; }
  const id=button.dataset.toggle || button.dataset.delete || button.dataset.unlock, teacher=teachers.find(row=>row.id===id); if (!teacher) return;
  const userId=auth.currentUser.uid; button.disabled=true;
  try {
    if (button.dataset.unlock) {
      if (!confirm(`Restore web login for ${teacher.name}? This clears failed-attempt history.`)) return;
      await webRequest("/api/web-auth/unlock",{identifier:id}); alert("Web login restored.");
    } else if (button.dataset.toggle) {
      await updateDoc(doc(db,"users",id),{active:!teacher.active,status:teacher.active ? "inactive" : "active"});
      if (auth.currentUser?.uid===userId) { teacher.active=!teacher.active; render(); }
    } else if (confirm(`Remove ${teacher.name}? Assigned sections must be removed first. Deactivation keeps the account and records.`)) {
      await deleteDoc(doc(db,"users",id));
      if (auth.currentUser?.uid===userId) { teachers=teachers.filter(row=>row.id!==id); render(); }
    }
  } catch(error) { alert(error.message); } finally { button.disabled=false; }
});
form.addEventListener("submit",async event=>{
  event.preventDefault(); if (!ready || !auth.currentUser || submitting) return;
  const data=new FormData(form), sectionIds=[...choices.selectedOptions].map(option=>option.value);
  const profile={name:String(data.get("name") || "").trim(),subject:String(data.get("subject") || "").trim(),sectionIds,
    newSections:String(data.get("newSections") || "").split(",").map(name=>name.trim()).filter(Boolean)};
  const userId=auth.currentUser.uid; submitting=true; status.textContent="Saving…";
  const submit=form.querySelector('[type="submit"]'); submit.disabled=true;
  try {
    let id=editing;
    if (id) { await webRequest("/api/web-data",{action:"save-teacher",id,profile}); invalidateTeacherViews(); }
    else { ({id}=await createTeacher({...profile,email:String(data.get("email") || "").trim().toLowerCase()})); }
    if (auth.currentUser?.uid!==userId) return;
    dialog.close(); await load(true);
    if (!editing) alert(`Teacher added. Teacher ID: ${id}`);
  } catch(error) { status.textContent=error.message; } finally { submitting=false; submit.disabled=false; }
});
