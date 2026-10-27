import { escapeHtml } from "./teacher-view.js";
import { initializeApp, getAuth, onAuthStateChanged } from "./firebase-auth.js";
import { createTeacherReport, reportContext } from "./teacher-report-data.js";
import { summarizeAssessments, percentLabel } from "./activity-score.js";

const app = initializeApp(), auth = getAuth(app);
const termFilter = document.getElementById("dashboardTerm"), sectionFilter = document.getElementById("dashboardSection");
let selection = { termId: "term_01", sectionId: "first" };
const report = createTeacherReport({ app,
  failed: error => { console.error("Dashboard update failed:", error); document.getElementById("dashboardReportStatus").textContent = "Could not update results. Retrying automatically."; },
  progress: ({ loaded, total, complete }) => { document.getElementById("dashboardReportStatus").textContent = complete ? "" : `Results so far · ${loaded} of ${total} students`; },
  render: ({ teacherName, sections, classes = sections.map(row => row.classDoc), counts, termSnap, curriculumSnap, total }) => {
    const hour = new Date().getHours(), part = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
    document.getElementById("greeting").textContent = `Good ${part}, ${teacherName}`;
    const options = [{id:"",name:"All sections"},...classes.map(row=>({id:row.id,name:row.data().SectionName || row.id}))];
    const signature = JSON.stringify(options);
    if (sectionFilter.dataset.options !== signature) {
      sectionFilter.innerHTML = "";
      for (const row of options) { const option = document.createElement("option"); option.value=row.id; option.textContent=row.name; sectionFilter.appendChild(option); }
      sectionFilter.dataset.options = signature;
    }
    sectionFilter.value = selection.sectionId === "first" ? counts[0]?.classId || "" : selection.sectionId;
    if (selection.sectionId === "first" && counts.length) { selection.sectionId = sectionFilter.value; reportContext(app, auth.currentUser, selection); }
    document.getElementById("classInfo").textContent = !classes.length ? "No sections assigned yet" : selection.sectionId === "" ? "All assigned sections" : "Grade 6 – " + (classes.find(row => row.id === sectionFilter.value)?.data().SectionName || sectionFilter.value);
    const rows = sections.flatMap(section => section.students.map(row => ({ ...row, classDoc: section.classDoc })));
    const records = row => row.results.flatMap(result => result.lessonsSnap.docs.map(lesson => lesson.data()));
    const scores = summarizeAssessments(rows.flatMap(records));
    document.getElementById("studentCountVal").textContent = total;
    document.getElementById("avgPreTestVal").textContent = percentLabel(scores.pre);
    document.getElementById("avgPostTestVal").textContent = percentLabel(scores.post);
    const minutes = rows.map(row => records(row).reduce((sum, lesson) => sum + (lesson.arTimeMinutes || lesson.arNavigationTimeMinutes || 0), 0)).filter(value => value > 0);
    document.getElementById("avgArTimeVal").textContent = minutes.length ? `${Math.round(minutes.reduce((sum, value) => sum + value, 0) / minutes.length)} min` : "—";
    const table = document.getElementById("studentTableBody"); table.innerHTML = "";
    const fragment = document.createDocumentFragment();
    for (const row of rows.slice(0, 10)) {
      const name = row.studentDoc.data().displayName || "Student", lessons = records(row);
      const summary = summarizeAssessments(lessons), initials = name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase();
      const time = lessons.reduce((sum, record) => sum + (record.arTimeMinutes || record.arNavigationTimeMinutes || 0), 0);
      const last = lessons.reduce((latest, record) => { const value = record.timestamp?.toDate?.() || new Date(record.timestamp || record.lastUpdated || 0); return value > latest ? value : latest; }, new Date(0));
      const tr = document.createElement("tr");
      tr.innerHTML = `<td><div class="student"><div class="avatar">${escapeHtml(initials)}</div><div><strong>${escapeHtml(name)}</strong><small>Grade 6 – ${escapeHtml(row.classDoc.data().SectionName || row.classDoc.id)}</small></div></div></td><td>${percentLabel(summary.pre)}</td><td>${percentLabel(summary.post)}</td><td>${time > 0 ? `${Math.round(time)} min` : "—"}</td><td>${last.getTime() ? last.toLocaleDateString("en-US", {month:"short",day:"numeric",year:"numeric"}) : "No activity"}</td>`;
      fragment.appendChild(tr);
    }
    table.appendChild(fragment);
    const termTitle = termSnap?.exists() ? termSnap.data().title : "Term " + selection.termId.slice(-1);
    document.getElementById("currentTermHeader").textContent = "Lessons — " + termTitle;
    const modules = document.getElementById("modulesContainer"); modules.innerHTML = "";
    if (!classes.length) return;
    const active = new Set(rows.flatMap(row => row.results.flatMap(result => result.lessonsSnap.docs.filter(lesson => lesson.data().isPreTestCompleted || lesson.data().isPostTestCompleted).map(lesson => lesson.id))));
    [...(curriculumSnap?.docs || [])].sort((a,b) => a.id.localeCompare(b.id)).forEach((lesson, index) => {
      modules.insertAdjacentHTML("beforeend", `<article class="module"><div class="badge ${active.has(lesson.id) ? "done" : "next"}">${index + 1}</div><div><h3>${escapeHtml(lesson.data().title || "Lesson " + (index + 1))}</h3><span>${active.has(lesson.id) ? "Results recorded" : "No results yet"}</span></div></article>`);
    });
  }
});
function openReport() {
  const user = auth.currentUser; if (!user) return;
  reportContext(app, user, selection);
  return report.open({ user, ...selection });
}
termFilter.addEventListener("change", () => { selection.termId = termFilter.value; void openReport(); });
sectionFilter.addEventListener("change", () => { selection.sectionId = sectionFilter.value; void openReport(); });
onAuthStateChanged(auth, async user => {
  if (!user) { window.location.href = "login.html"; return; }
  selection = reportContext(app, user); termFilter.value = selection.termId;
  document.getElementById("greeting").textContent = "Welcome back, " + (user.displayName || "Teacher");
  await openReport();
});
