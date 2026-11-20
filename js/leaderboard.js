import { initializeApp, getAuth, onAuthStateChanged } from "./firebase-auth.js";
import { getStudentPage } from "./firebase-data.js";
import { escapeHtml, watchVisibleData, prepareTeacherCache } from "./teacher-view.js";
import { rankStudents } from "./leaderboard-ranking.js";

const app = initializeApp();
const auth = getAuth(app);
const tabs = [...document.querySelectorAll("[data-scope]")];
const sectionControl = document.getElementById("leaderboardSectionControl");
const sectionSelect = document.getElementById("leaderboardSection");
const panel = document.getElementById("leaderboardPanel");
const podium = document.getElementById("leaderboardPodium");
const list = document.getElementById("leaderboardList");
const status = document.getElementById("leaderboardStatus");
const refresh = document.getElementById("refreshLeaderboard");
const number = new Intl.NumberFormat("en");
let scope = "overall";
let students = [];
let sections = [];
let complete = false;
let generation = 0;
let controller;
let stopWatching;
let ownerId;
let cache;
let rendered;
const cacheKey = "leaderboard:app-points:v1";

function render() {
  if (complete) panel.setAttribute("data-ready", "");
  else panel.removeAttribute("data-ready");
  const sectionId = scope === "section" ? sectionSelect.value : "";
  const signature = JSON.stringify([complete, sectionId, students, sections]);
  if (signature === rendered) return;
  rendered = signature;
  const scrollTop = list.parentElement.scrollTop;
  const section = sections.find(row => row.id === sectionId);
  const ranked = rankStudents(students, sectionId);
  document.getElementById("podiumScope").textContent = section?.name || "All assigned sections";
  document.getElementById("rankingsCount").textContent = complete ? number.format(ranked.length) + " students" : "Loading students…";
  const winners = ranked.filter(row => row.points > 0).slice(0, 3);
  podium.innerHTML = winners.map((student, index) => {
    const position = index + 1;
    return `<article class="podium-place podium-place-${position}" data-rank="${student.rank}" aria-label="Rank ${student.rank}: ${escapeHtml(student.name)}, ${student.points} points">
      <div class="podium-award" aria-hidden="true"><span><svg viewBox="0 0 48 48"><path d="M14 8h20v12a10 10 0 0 1-20 0Z"/><path d="M14 12H8v5a8 8 0 0 0 8 8m18-13h6v5a8 8 0 0 1-8 8M24 30v8m-8 3h16m-13-3h10"/><path class="award-star" d="m24 12 2.1 4.4 4.9.7-3.5 3.5.8 4.8-4.3-2.3-4.3 2.3.8-4.8-3.5-3.5 4.9-.7Z"/></svg></span><b>RANK ${student.rank}</b></div>
      <div class="podium-name"><strong>${escapeHtml(student.name)}</strong><span>${escapeHtml(student.sectionName)}</span><b>${number.format(student.points)} <small>pts</small></b></div>
      <div class="podium-column"><span class="podium-medal" aria-hidden="true">${position === 1 ? "★" : "✦"}</span><span class="podium-rank">${student.rank}</span></div>
    </article>`;
  }).join("");
  const highestPoints = ranked[0]?.points || 1;
  list.innerHTML = ranked.map(student => `<li class="leaderboard-row${student.rank <= 3 && student.points > 0 ? " leaderboard-row-top" : ""}" data-rank="${student.rank}">
    <span class="leaderboard-rank" aria-label="Rank ${student.rank}">${student.rank}</span>
    <div class="leaderboard-student"><strong>${escapeHtml(student.name)}</strong><span>${escapeHtml(student.sectionName)}</span><div class="leaderboard-score-track" aria-hidden="true"><i style="width:${Math.round(student.points / highestPoints * 100)}%"></i></div></div>
    <b class="leaderboard-points">${number.format(student.points)} <small>pts</small></b>
  </li>`).join("");
  document.getElementById("podiumEmpty").hidden = !complete || winners.length > 0;
  document.getElementById("leaderboardEmpty").hidden = !complete || ranked.length > 0;
  list.parentElement.scrollTop = scrollTop;
}

function chooseScope(value) {
  scope = value;
  for (const tab of tabs) {
    const selected = tab.dataset.scope === value;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected) panel.setAttribute("aria-labelledby", tab.id);
  }
  sectionControl.hidden = value !== "section";
  render();
}
for (const tab of tabs) {
  tab.addEventListener("click", () => chooseScope(tab.dataset.scope));
  tab.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const target = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[1] : tabs.find(item => item !== tab);
    target.focus();
    chooseScope(target.dataset.scope);
  });
}
sectionSelect.addEventListener("change", render);

async function loadLeaderboard() {
  const user = auth.currentUser;
  if (!user) return;
  controller?.abort();
  controller = new AbortController();
  const token = ++generation;
  const version = cache.version();
  const current = () => token === generation && auth.currentUser?.uid === user.uid;
  refresh.disabled = true;
  panel.setAttribute("aria-busy", "true");
  status.textContent = complete ? "Updating student points…" : "Loading student points…";
  try {
    const loaded = new Map();
    let cursor = null;
    let classes = [];
    do {
      const page = await getStudentPage({ status: "active", limit: 100, cursor, includePoints: true, includeCounts: false },
        { signal: controller.signal });
      if (!current()) return;
      classes = page.classes;
      for (const row of page.students) {
        const profile = row.studentDoc.data();
        const name = profile.displayName || profile.fullName ||
          [profile.firstName, profile.middleName || profile.middleInitial, profile.lastName].filter(Boolean).join(" ") ||
          profile.schoolId || row.studentDoc.id;
        const section = classes.find(item => item.id === row.classId)?.data() || {};
        loaded.set(row.studentDoc.id, { id: row.studentDoc.id, classId: row.classId, name,
          sectionName: section.SectionName || section.sectionName || section.name || row.classId,
          points: Number.isSafeInteger(profile.totalPoints) && profile.totalPoints >= 0 ? profile.totalPoints : 0 });
      }
      cursor = page.cursor;
      if (!complete) status.textContent = "Loading student points… " + number.format(loaded.size) + " students";
    } while (cursor);
    students = [...loaded.values()];
    sections = classes.map(row => {
      const data = row.data();
      return { id: row.id, name: data.SectionName || data.sectionName || data.name || row.id };
    });
    const selected = sectionSelect.value;
    sectionSelect.innerHTML = sections.map(section =>
      `<option value="${escapeHtml(section.id)}">${escapeHtml(section.name)}</option>`).join("");
    if (sections.some(section => section.id === selected)) sectionSelect.value = selected;
    sectionSelect.disabled = sections.length === 0;
    complete = true;
    render();
    cache.put(user.uid, cacheKey, { students, sections }, version);
    status.textContent = sections.length ? "Latest synced app points · Updated " +
      new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Manila" }).format(new Date()) :
      "No sections are assigned to your account yet.";
  } catch (error) {
    if (!current() || error.name === "AbortError") return;
    if (["permission-denied", "unauthenticated"].includes(error.code)) {
      cache.remove(cacheKey);
      students = [];
      sections = [];
      complete = false;
      sectionSelect.replaceChildren();
      sectionSelect.disabled = true;
      render();
    }
    status.textContent = complete ? "Could not update points. Showing the last loaded rankings. Select Refresh to try again." :
      "Could not load student points. Select Refresh to try again.";
  } finally {
    if (current()) {
      refresh.disabled = false;
      panel.setAttribute("aria-busy", "false");
    }
  }
}
refresh.addEventListener("click", () => { void loadLeaderboard(); });
onAuthStateChanged(auth, user => {
  stopWatching?.();
  controller?.abort();
  if (!user) {
    generation++;
    ownerId = null;
    students = [];
    sections = [];
    sectionSelect.replaceChildren();
    sectionSelect.disabled = true;
    complete = false;
    render();
    return;
  }
  cache = prepareTeacherCache(app, user);
  if (ownerId !== user.uid) {
    ownerId = user.uid;
    students = [];
    sections = [];
    complete = false;
    sectionSelect.replaceChildren();
    sectionSelect.disabled = true;
    render();
  }
  if (!complete) {
    const saved = cache.get(user.uid, cacheKey);
    if (Array.isArray(saved?.students) && Array.isArray(saved.sections)) {
      students = saved.students;
      sections = saved.sections;
      sectionSelect.innerHTML = sections.map(section =>
        `<option value="${escapeHtml(section.id)}">${escapeHtml(section.name)}</option>`).join("");
      sectionSelect.disabled = sections.length === 0;
      complete = true;
      render();
    }
  }
  void loadLeaderboard();
  stopWatching = watchVisibleData(app, user, loadLeaderboard, 60000, true);
});
window.addEventListener("pagehide", () => {
  generation++;
  controller?.abort();
  stopWatching?.();
});
