import { escapeHtml, showTeacherView } from "./teacher-view.js";
import { initializeApp, getAuth, onAuthStateChanged } from "./firebase-auth.js";
import { createTeacherReport } from "./teacher-report-data.js";
import { setLoadingState, revealContent } from "./loading.js";
import { getTeacherTopicOverview, getDashboardSummary } from "./firebase-data.js";
import { currentScheduledTerm, schoolTodayISO, sectionSchedule, topicAvailability } from "./topic-availability.js";

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
let topicOverview, topicTimer, topicOwnerUid, summaryTimer;
function renderCurrentTopics(data = topicOverview) {
  if (!data || topicOwnerUid !== auth.currentUser?.uid) return;
  topicOverview = data;
  const today = schoolTodayISO(), termId = currentScheduledTerm(data.terms, data.sectionIds, today);
  const term = data.terms.find(row => row.id === termId);
  document.getElementById("currentTermHeader").textContent = `Current Term — Term ${Number(termId.slice(-2))}`;
  const modules = document.getElementById("modulesContainer");
  if (!modules) return;
  revealContent("dashboard-topics");
  clearTimeout(topicTimer);
  modules.innerHTML = "";
  if (!data.sectionIds.length) { modules.textContent = "No sections assigned yet."; return; }
  for (const [index, lesson] of (term?.lessons || []).entries()) {
    const available = data.sectionIds.some(sectionId => {
      const schedule = sectionSchedule(lesson, sectionId);
      return !topicAvailability({ locked: schedule.isLocked, date: schedule.scheduledDate }, today).locked;
    });
    modules.insertAdjacentHTML("beforeend", `<article class="module"><div class="badge ${available ? "done" : "next"}">${index + 1}</div><div><h3>${escapeHtml(lesson.title)}</h3><span>${available ? "Available" : "Upcoming"}</span></div></article>`);
  }
  const midnight = Date.parse(today + "T00:00:00+08:00") + 86400000;
  topicTimer = setTimeout(() => renderCurrentTopics(), Math.max(1000, midnight - Date.now()));
}
window.addEventListener("focus", () => renderCurrentTopics());
window.addEventListener("pagehide", () => { clearTimeout(topicTimer); clearTimeout(summaryTimer); });

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

function renderDashboard({ teacherName, sectionNames, total, sums, recent }) {
    const hour = new Date().getHours(), part = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
    document.getElementById("greeting").textContent = `Good ${part}, ${teacherName} !`;
    document.getElementById("classInfo").textContent = sectionNames.length > 1 ? "Grade 6 – All assigned sections" : sectionNames.length ? "Grade 6 – " + sectionNames[0] : "No classes assigned yet.";
    document.getElementById("studentCountVal").textContent = total ?? "—";
    document.getElementById("avgPreTestVal").textContent = scoreLabel(sums.preSum, sums.preCount, 5);
    document.getElementById("avgPostTestVal").textContent = scoreLabel(sums.postSum, sums.postCount, 10);
    document.getElementById("avgArTimeVal").textContent = `${total ? Math.round(sums.arMinutes / total) : 0} min`;

    const table = document.getElementById("studentTableBody"); table.innerHTML = "";
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
    revealContent("dashboard-summary");
}

const report = createTeacherReport({ app,
  failed: error => {
    console.error("Dashboard update failed:", error);
    setLoadingState(document.getElementById("dashboardReportStatus"), false);
    document.getElementById("dashboardReportStatus").textContent = "Could not update results. Retrying automatically.";
  },
  progress: ({ loaded, total, complete }) => {
    const status = document.getElementById("dashboardReportStatus");
    setLoadingState(status, !complete, total === null ? "Updating class averages" : `Class averages: ${loaded} of ${total} students`);
    status.textContent = "";
  },
  render: ({ teacherName, sections, total }) => {
    const students = sections.flatMap(({classDoc, students}) => students.filter(student => student.studentDoc.data().active !== false).map(student => studentSummary(classDoc, student)));
    const sums = students.reduce((sum, row) => ({ preSum:sum.preSum+row.preSum, preCount:sum.preCount+row.preCount,
      postSum:sum.postSum+row.postSum, postCount:sum.postCount+row.postCount, arMinutes:sum.arMinutes+row.arMinutes }), {preSum:0,preCount:0,postSum:0,postCount:0,arMinutes:0});
    renderDashboard({ teacherName, sectionNames: sections.map(({classDoc}) => classDoc.data().SectionName || classDoc.id), total, sums,
      recent: students.filter(row => row.hasActivity).sort((a,b) => b.lastActive-a.lastActive || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)).slice(0,25) });

  }
});
onAuthStateChanged(auth, async user => {
  if (!user) { topicOverview = null; topicOwnerUid = null; clearTimeout(topicTimer); clearTimeout(summaryTimer); window.location.href = "login.html"; return; }
  topicOwnerUid = user.uid;
  const topics = showTeacherView({ app, user, page: "dashboard-topics-v1", load: () => getTeacherTopicOverview(), render: renderCurrentTopics })
    .catch(error => {
      console.error("Topic overview update failed:", error);
      const modules = document.getElementById("modulesContainer");
      if (auth.currentUser?.uid === user.uid && modules) {
        modules.textContent = "Could not update topics. Retrying automatically.";
        revealContent("dashboard-topics");
      }
    });
  const summaryOptions = { app, user, page: "dashboard-summary-v1", load: async () => {
    let result = await getDashboardSummary();
    if (!result.enabled) return { legacy: true };
    // Only the first preparation waits. Subsequent visits get the durable
    // summary immediately; no student report pages are downloaded here.
    for (let attempt = 0; !result.ready && attempt < 150; attempt++) {
      if (auth.currentUser?.uid !== user.uid) throw new Error("Sign-in changed.");
      await new Promise(resolve => setTimeout(resolve, 2000));
      if (auth.currentUser?.uid !== user.uid) throw new Error("Sign-in changed.");
      if (document.visibilityState === "hidden") continue;
      result = await getDashboardSummary();
    }
    if (!result.ready) throw new Error("Results are still being prepared.");
    return result;
  }, render: result => {
    if (result.legacy) { void report.open({ user, sectionId:"", allTerms:true, includeCurriculum:false }); return; }
    const { summary, teacherName } = result;
    renderDashboard({ teacherName, sectionNames: summary.sectionNames, total: summary.total, sums: summary, recent: summary.recent });
    setLoadingState(document.getElementById("dashboardReportStatus"), false);
    document.getElementById("dashboardReportStatus").textContent = "";
    clearTimeout(summaryTimer);
    if (result.pending) summaryTimer = setTimeout(() => {
      if (auth.currentUser?.uid === user.uid && document.visibilityState !== "hidden") void showTeacherView({ ...summaryOptions, refreshOnly: true }).catch(() => {});
    }, 4000);
  } };
  const summary = showTeacherView(summaryOptions).catch(error => {
    console.error("Dashboard update failed:", error);
    if (auth.currentUser?.uid === user.uid) document.getElementById("dashboardReportStatus").textContent = "Could not update results. Retrying automatically.";
  });
  await Promise.all([summary, topics]);
});
