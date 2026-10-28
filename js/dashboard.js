import { escapeHtml } from "./teacher-view.js";
import { initializeApp, getAuth, onAuthStateChanged } from "./firebase-auth.js";
import { createTeacherReport } from "./teacher-report-data.js";

const app = initializeApp();
const auth = getAuth(app);

// --- EXISTING UI LOGIC ---
const drawer = document.getElementById("drawer");
const openDrawer = () => { drawer.classList.add("open"); drawer.setAttribute("aria-hidden", "false"); };
const closeDrawer = () => { drawer.classList.remove("open"); drawer.setAttribute("aria-hidden", "true"); };
document.getElementById("menuBtn").onclick = openDrawer;
drawer.onclick = (e) => { if (e.target === drawer) closeDrawer(); };

const accountBtn = document.getElementById("accountBtn");
const accountMenu = document.getElementById("accountMenu");
accountBtn.onclick = (e) => {
  e.stopPropagation();
  accountMenu.hidden = !accountMenu.hidden;
};
document.addEventListener("click", (e) => {
  if (!e.target.closest(".account")) accountMenu.hidden = true;
});

document.getElementById("helpBtn").onclick = () => {
  window.location.href = "teacher-manual.html";
};

function assessmentPoints(result, kind, maximum) {
  const prefix = kind === "pre" ? "preTest" : "postTest";
  if (result[kind === "pre" ? "isPreTestCompleted" : "isPostTestCompleted"] !== true) return null;
  const total = result[prefix + "TotalQuestions"];
  const score = result[prefix + "Score"] ?? (kind === "post" && Array.isArray(result.postTestHeatmap) ? result.postTestHeatmap.filter(value => value === true).length : null);
  return typeof score === "number" && typeof total === "number" && Number.isFinite(score) && Number.isFinite(total) && total > 0 && score >= 0 && score <= total ? score / total * maximum : null;
}

function activityTime(value) {
  try {
    const date = value?.toDate ? value.toDate() : value instanceof Date ? value : new Date(value || 0);
    return Number.isFinite(date.getTime()) && date.getTime() > 0 ? date.getTime() : 0;
  } catch { return 0; }
}
const minutes = value => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
const scoreLabel = (sum, count, maximum) => count ? `${Math.round(sum / count)}/${maximum}` : "N/A";

function studentSummary(classDoc, student) {
  let preSum = 0, preCount = 0, postSum = 0, postCount = 0, arMinutes = 0, lastActive = 0, hasActivity = false;
  for (const result of student.results) for (const lesson of result.lessonsSnap.docs) {
    const data = lesson.data(), pre = assessmentPoints(data, "pre", 5), post = assessmentPoints(data, "post", 10);
    if (pre !== null) { preSum += pre; preCount++; }
    if (post !== null) { postSum += post; postCount++; }
    const ar = minutes(data.arTimeMinutes) || minutes(data.arNavigationTimeMinutes);
    arMinutes += ar;
    const time = Math.max(activityTime(data.timestamp), activityTime(data.lastUpdated), activityTime(data.completedAt));
    lastActive = Math.max(lastActive, time);
    const deviceTime = Object.values(data.learningTimeByDevice || {}).some(device => minutes(device?.lessonSeconds) > 0 || minutes(device?.arSeconds) > 0);
    hasActivity ||= time > 0 || pre !== null || post !== null || ar > 0 || minutes(data.lessonTimeMinutes) > 0 || deviceTime ||
      data.isLessonCompleted === true || data.isARCompleted === true || data.completed === true ||
      (typeof data.activityScore === "number" && data.activityScore >= 0 && (data.activityTotalQuestions > 0 || data.activityTotalPoints > 0));
  }
  const profile = student.studentDoc.data();
  return { id: student.studentDoc.id, name: profile.displayName || profile.fullName || "Student", section: classDoc.data().SectionName || classDoc.id,
    preSum, preCount, postSum, postCount, arMinutes, lastActive, hasActivity };
}

const report = createTeacherReport({ app,
  failed: error => {
    console.error("Dashboard update failed:", error);
    document.getElementById("dashboardReportStatus").textContent = "Could not update results. Retrying automatically.";
  },
  progress: ({ loaded, total, complete }) => {
    document.getElementById("dashboardReportStatus").textContent = complete ? "" : `Class averages so far · ${loaded} of ${total} students`;
  },
  render: ({ teacherName, sections, termSnap, curriculumSnap, total }) => {
    const hour = new Date().getHours(), part = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
    document.getElementById("greeting").textContent = `Good ${part}, ${teacherName} !`;
    document.getElementById("classInfo").textContent = sections.length > 1 ? "Grade 6 – All assigned sections" : sections.length ? "Grade 6 – " + (sections[0].classDoc.data().SectionName || sections[0].classDoc.id) : "No classes assigned yet.";
    const students = sections.flatMap(({classDoc, students}) => students.filter(student => student.studentDoc.data().active !== false).map(student => studentSummary(classDoc, student)));
    const sums = students.reduce((sum, row) => ({ preSum:sum.preSum+row.preSum, preCount:sum.preCount+row.preCount,
      postSum:sum.postSum+row.postSum, postCount:sum.postCount+row.postCount, arMinutes:sum.arMinutes+row.arMinutes }), {preSum:0,preCount:0,postSum:0,postCount:0,arMinutes:0});
    document.getElementById("studentCountVal").textContent = total;
    document.getElementById("avgPreTestVal").textContent = scoreLabel(sums.preSum, sums.preCount, 5);
    document.getElementById("avgPostTestVal").textContent = scoreLabel(sums.postSum, sums.postCount, 10);
    document.getElementById("avgArTimeVal").textContent = `${students.length ? Math.round(sums.arMinutes / students.length) : 0} min`;

    const table = document.getElementById("studentTableBody"); table.innerHTML = "";
    const recent = students.filter(row => row.hasActivity).sort((a,b) => b.lastActive-a.lastActive || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)).slice(0,25);
    const rows = document.createDocumentFragment();
    for (const student of recent) {
      const initials = student.name.trim().split(/\s+/).slice(0,2).map(part => part[0] || "").join("").toUpperCase();
      const lastActive = student.lastActive ? new Date(student.lastActive).toLocaleString("en-US", {month:"short",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit"}) : "Not recorded";
      const row = document.createElement("tr");
      row.innerHTML = `<td><div class="student"><div class="avatar">${escapeHtml(initials)}</div><div><strong>${escapeHtml(student.name)}</strong><small>Grade 6 – ${escapeHtml(student.section)}</small></div></div></td>
        <td class="muted-cell">${scoreLabel(student.preSum,student.preCount,5)}</td><td class="${student.postCount ? "score-up" : "muted-cell"}">${scoreLabel(student.postSum,student.postCount,10)}</td>
        <td class="muted-cell">${Math.round(student.arMinutes)} min</td><td class="muted-cell">${lastActive}</td>`;
      rows.appendChild(row);
    }
    if (!recent.length) { const row=document.createElement("tr"); row.innerHTML='<td colspan="5" class="muted-cell">No saved app activity yet.</td>'; rows.appendChild(row); }
    table.appendChild(rows);

    const termTitle = termSnap?.exists() ? termSnap.data().title || "Term 1" : "Term 1";
    document.getElementById("currentTermHeader").textContent = `Current Term — ${termTitle}`;
    const modules = document.getElementById("modulesContainer"); modules.innerHTML = "";
    if (!sections.length) return;
    const activeLessons = new Set(sections.flatMap(section => section.students.flatMap(student => student.results.filter(result => result.termId === "term_01" || !result.termId).flatMap(result => result.lessonsSnap.docs.filter(lesson => lesson.data().isPreTestCompleted || lesson.data().isPostTestCompleted).map(lesson => lesson.id)))));
    [...(curriculumSnap?.docs || [])].sort((a,b)=>a.id.localeCompare(b.id)).forEach((lesson,index)=>{
      const active = activeLessons.has(lesson.id);
      modules.insertAdjacentHTML("beforeend",`<article class="module"><div class="badge ${active ? "done" : "next"}">${index+1}</div><div><h3>${escapeHtml(lesson.data().title || "Lesson "+(index+1))}</h3><span>${active ? "Active/Completed" : "Upcoming"}</span></div></article>`);
    });
  }
});
onAuthStateChanged(auth, async user => {
  if (!user) { window.location.href = "login.html"; return; }
  await report.open({ user, sectionId:"", allTerms:true });
});
