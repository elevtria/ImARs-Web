import { getDocs as quietDocs } from "./firebase-data.js";
import { prepareTeacherCache, watchVisibleData } from "./teacher-view.js";
import { encodeView, decodeView } from "./view-cache.js";
import { initializeApp } from "./firebase-auth.js";
import { getAuth, onAuthStateChanged } from "./firebase-auth.js";
import { getFirestore, collection, doc, updateDoc, deleteDoc, writeBatch, getStudentPage } from "./firebase-data.js";

const app = initializeApp();
const auth = getAuth(app);
const db = getFirestore(app);

const recordsContainer = document.getElementById("recordsContainer");
const emptyState = document.getElementById("emptyState");
const searchInput = document.getElementById("studentSearch");
const sectionFilter = document.getElementById("sectionFilter");
const termFilter = document.getElementById("recordsTerm");
const archiveSectionButton = document.getElementById("archiveSectionBtn");

let dynamicCards = [];
let recordStatus = "active";
let recordData = null;
let recordOwnerUid = null;
const previousPage = document.getElementById("previousRecordsPage");
const nextPage = document.getElementById("nextRecordsPage");
const pageStatus = document.getElementById("recordsPageStatus");
let pageIndex = 0, cursors = [null], pageGeneration = 0, pageBusy = false, pageError = false, searchTimer, pageAbort, stopUpdates;
let pageFilter = { sectionId: "", status: "active", search: "", termId: "term_01" };
let pageCacheKey = "", counts = [], nextCursor = null;
const reportRequests = new Map();
const observedCards = typeof IntersectionObserver === "function" ? new IntersectionObserver(entries => {
  for (const entry of entries) if (entry.isIntersecting && !entry.target.classList.contains("hidden")) {
    observedCards.unobserve(entry.target);
    void loadStudentPerformance(entry.target.dataset.studentId);
  }
}, { rootMargin: "120px" }) : null;

function encodeRecords(data) {
  return encodeView({ ...data, sections: data.sections.map(section => ({ ...section,
    students: section.students.map(student => ({ ...student, resultsLoading: false }))
  })) });
}

function cacheCurrentPage() {
  const user = auth.currentUser;
  if (recordData && user?.uid === recordOwnerUid && pageCacheKey) {
    prepareTeacherCache(app, user).put(user.uid, pageCacheKey, encodeRecords(recordData));
  }
}

function updateStudentRows(ids, values, remove = false, classId = null) {
  const user = auth.currentUser;
  if (!recordData || !user || user.uid !== recordOwnerUid) return;
  const changed = new Set(ids);
  const cards = new Map(dynamicCards.map(card => [card.dataset.studentId, card]));
  if (classId) {
    const totals = counts.find(item => item.classId === classId);
    if (totals) { totals.active -= ids.length; totals.archived += ids.length; }
  }
  for (const section of recordData.sections) {
    section.students = section.students.flatMap(student => {
      if (!changed.has(student.studentDoc.id)) return [student];
      const old = cards.get(student.studentDoc.id);
      if (!classId) {
        const totals = counts.find(item => item.classId === section.classDoc.id);
        if (totals) {
          const wasArchived = student.studentDoc.data().active === false;
          if (remove) totals[wasArchived ? "archived" : "active"]--;
          else if (typeof values.active === "boolean" && wasArchived !== !values.active) {
            totals[wasArchived ? "archived" : "active"]--;
            totals[values.active ? "active" : "archived"]++;
          }
        }
      }
      if (remove) { old?.remove(); return []; }
      const data = { ...student.studentDoc.data(), ...values };
      const updated = { ...student, studentDoc: { ...student.studentDoc, data: () => data } };
      old?.replaceWith(studentCard(section.classDoc, updated));
      return [updated];
    });
  }
  dynamicCards = Array.from(recordsContainer.querySelectorAll(".record"));
  applyFilters();
  cacheCurrentPage();
}
const escapeHTML = value => String(value).replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[character]);

const applyFilters = () => {
  const searchTerm = searchInput.value.trim().toLowerCase();
  const selectedSection = sectionFilter.value;
  let shown = 0;

  dynamicCards.forEach((card) => {
    const matchesName = card.dataset.name.includes(searchTerm);
    const matchesSection = !selectedSection || card.dataset.section === selectedSection;
    const visible = matchesName && matchesSection && (recordStatus === "archived" ? card.dataset.archived === "true" : card.dataset.archived !== "true");
    card.classList.toggle("hidden", !visible);
    if (visible) shown += 1;
  });

  archiveSectionButton.disabled = pageBusy || pageError || !selectedSection || recordStatus !== "active" || !counts.some(item => item.classId === selectedSection && item.active > 0);
  archiveSectionButton.title = !selectedSection ? "Select a section first" : "Archive all active students in this section, including those hidden by search";
  emptyState.hidden = shown > 0 || pageBusy || pageError;
  emptyState.textContent = "No " + recordStatus + " students match your filters.";
  document.getElementById("activeStudentsCount").textContent = recordData ? counts.reduce((sum, item) => sum + item.active, 0) : "—";
  document.getElementById("archivedStudentsCount").textContent = recordData ? counts.reduce((sum, item) => sum + item.archived, 0) : "—";
  previousPage.disabled = pageBusy || pageIndex === 0;
  nextPage.disabled = pageBusy || !nextCursor;
  for (const card of dynamicCards) if (!card.classList.contains("hidden") && card.dataset.autoLoad === "true") observedCards?.observe(card);
};

for (const status of ["active", "archived"]) document.getElementById(status + "StudentsTab").addEventListener("click", () => {
  recordStatus = status;
  for (const value of ["active", "archived"]) document.getElementById(value + "StudentsTab").setAttribute("aria-pressed", String(status === value));
  applyFilters();
  resetPages();
});
searchInput.addEventListener("input", () => { clearTimeout(searchTimer); applyFilters(); searchTimer = setTimeout(resetPages, 300); });
sectionFilter.addEventListener("change", () => { applyFilters(); return resetPages(); });
termFilter.addEventListener("change", () => { pageFilter.termId = termFilter.value; reportRequests.clear(); return loadRecordsPage(); });
previousPage.addEventListener("click", () => { if (pageIndex > 0 && !pageBusy) { pageIndex--; return loadRecordsPage({ scroll: true }); } });
nextPage.addEventListener("click", () => { if (nextCursor && !pageBusy) { cursors[++pageIndex] = nextCursor; return loadRecordsPage({ scroll: true }); } });

function resetPages() {
  pageIndex = 0; cursors = [null];
  pageFilter = { sectionId: sectionFilter.value, status: recordStatus, search: searchInput.value.trim(), termId: termFilter.value || "term_01" };
  return loadRecordsPage();
}

function renderRecords(data, key) {
  if (![data.classes, data.sections, data.counts].every(Array.isArray)) throw new Error("Invalid saved student page.");
  pageError = false; pageCacheKey = key;
  recordData = data; recordOwnerUid = auth.currentUser.uid;
  counts = data.counts || []; nextCursor = data.cursor;
  const selected = pageFilter.sectionId;
  sectionFilter.innerHTML = '<option value="">All Sections</option>';
  for (const classDoc of data.classes) {
    const option = document.createElement("option"); option.value = classDoc.id;
    option.textContent = "Grade 6 – " + (classDoc.data().SectionName || classDoc.id);
    sectionFilter.appendChild(option);
  }
  sectionFilter.value = selected;
  observedCards?.disconnect();
  const cards = document.createDocumentFragment();
  for (const section of data.sections) for (const student of section.students) cards.appendChild(studentCard(section.classDoc, student));
  recordsContainer.replaceChildren(cards);
  dynamicCards = Array.from(recordsContainer.querySelectorAll(".record"));
  pageStatus.textContent = `Page ${pageIndex + 1} · ${dynamicCards.length} students shown`;
  applyFilters();
}

async function loadRecordsPage({ background = false, scroll = false } = {}) {
  const user = auth.currentUser;
  if (!user) return;
  if (background && pageBusy) return;
  const generation = ++pageGeneration, filter = { ...pageFilter }, cursor = cursors[pageIndex];
  pageAbort?.abort();
  pageAbort = typeof AbortController === "function" ? new AbortController() : null;
  const signal = pageAbort?.signal;
  const cache = prepareTeacherCache(app, user);
  const key = "records:page:" + JSON.stringify({ filter, cursor });
  pageBusy = false;
  cache.put(user.uid, "records:state", { filter, pageIndex, cursors });
  const version = cache.version();
  const saved = cache.get(user.uid, key);
  if (saved && !background) {
    let restored = false;
    try { renderRecords(decodeView(saved), key); restored = true; } catch {}
    if (restored && cache.get(user.uid, key, 60000)) { if (scroll) recordsContainer.scrollIntoView?.({ block: "start" }); return; }
  }
  pageBusy = true;
  const finish = background ? () => {} : startRecordLoading(generation);
  if (!background) pageStatus.textContent = filter.search ? "Searching students…" : "Loading students…";
  applyFilters();
  try {
    const rows = []; let result, after = cursor, totals;
    do {
      result = await getStudentPage({ ...filter, cursor: after, limit: 25 - rows.length, includeCounts: totals === undefined }, signal ? { signal } : {});
      if (generation !== pageGeneration || auth.currentUser?.uid !== user.uid) return;
      totals ??= result.counts;
      rows.push(...result.students); after = result.cursor;
      if (!filter.search && totals?.reduce((sum, item) => sum + item[filter.status], 0) === 0) after = null;
    } while (after && rows.length < 25);
    if (cache.version() !== version) return;
    const sections = result.classes.map(classDoc => ({ classDoc, students: rows.filter(row => row.classId === classDoc.id).map(row => {
      const previous = recordData?.sections.flatMap(section => section.students).find(student => student.studentDoc.id === row.studentDoc.id);
      const remembered = cache.get(user.uid, "records:results:" + filter.termId + ":" + row.studentDoc.id, 60000);
      const sameTerm = previous?.results[0]?.termId === filter.termId;
      const results = sameTerm && previous?.resultsLoaded ? previous.results : remembered ? decodeView(remembered) : null;
      return { studentDoc: row.studentDoc, results: results || [], resultsLoaded: Boolean(results),
        resultsAt: sameTerm ? previous?.resultsAt : 0,
        resultsLoading: sameTerm && previous?.resultsLoading || false, resultsError: sameTerm && previous?.resultsError || false };
    }) }));
    const data = { classes: result.classes, sections, counts: totals || [], cursor: after };
    const encoded = encodeRecords(data);
    if (pageCacheKey !== key || !saved || JSON.stringify(saved) !== JSON.stringify(encoded)) renderRecords(data, key);
    if (scroll) recordsContainer.scrollIntoView?.({ block: "start" });
    cache.put(user.uid, key, encoded, version);
    if (background) for (const card of dynamicCards) {
      const bounds = card.getBoundingClientRect?.();
      if (bounds && bounds.bottom >= 0 && bounds.top <= window.innerHeight && !card.classList.contains("hidden")) void loadStudentPerformance(card.dataset.studentId, { background: true });
    }
  } catch (error) {
    if (generation !== pageGeneration || auth.currentUser?.uid !== user.uid || error.name === "AbortError") return;
    pageError = true;
    if (["permission-denied", "unauthenticated"].includes(error.code)) { recordsContainer.replaceChildren(); cache.invalidate(); }
    pageStatus.textContent = "Could not update this student page. Check your connection; it will retry automatically.";
    console.error("Student page update failed:", error);
  } finally {
    finish();
    if (generation === pageGeneration) { pageBusy = false; applyFilters(); }
  }
}

function startRecordLoading(generation) {
  recordsContainer.setAttribute("aria-busy", "true");
  return () => { if (generation === pageGeneration) recordsContainer.removeAttribute("aria-busy"); };
}

async function loadStudentPerformance(id, { background = false } = {}) {
  const user = auth.currentUser;
  const termId = pageFilter.termId || "term_01", requestKey = termId + ":" + id;
  const find = () => recordData?.sections.flatMap(section => section.students.map(student => ({ section, student }))).find(item => item.student.studentDoc.id === id);
  let row = find();
  if (!user || !row || (row.student.resultsLoaded && (!background || Date.now() - (row.student.resultsAt || 0) < 60000)) || reportRequests.has(requestKey)) return;
  const current = row.student;
  if (!background) { current.resultsLoading = true; current.resultsError = false; }
  const replace = () => {
    row = find();
    if (auth.currentUser?.uid !== user.uid || recordOwnerUid !== user.uid || pageFilter.termId !== termId || !row) return;
    dynamicCards.find(card => card.dataset.studentId === id)?.replaceWith(studentCard(row.section.classDoc, row.student));
    dynamicCards = Array.from(recordsContainer.querySelectorAll(".record")); applyFilters();
  };
  if (!background) replace();
  const request = Promise.all([termId].map(async termId => ({
    termId, lessonsSnap: await quietDocs(collection(db, "users", id, "test_results", termId, "lessons"))
  })));
  reportRequests.set(requestKey, request);
  let changed = false;
  try {
    const results = await request;
    if (auth.currentUser?.uid !== user.uid || recordOwnerUid !== user.uid || pageFilter.termId !== termId) return;
    const latest = find();
    changed = !latest?.student.resultsLoaded || JSON.stringify(encodeView(latest.student.results)) !== JSON.stringify(encodeView(results));
    if (latest) Object.assign(latest.student, { results, resultsLoaded: true, resultsAt: Date.now() });
    if (background && !changed) return;
    prepareTeacherCache(app, user).put(user.uid, "records:results:" + termId + ":" + id, encodeView(results));
  } catch (error) {
    const latest = find();
    if (latest && !background && auth.currentUser?.uid === user.uid && pageFilter.termId === termId) latest.student.resultsError = true;
    console.error("Could not load this student's performance:", error);
  } finally {
    if (reportRequests.get(requestKey) === request) reportRequests.delete(requestKey);
    const latest = find(); if (latest && pageFilter.termId === termId) latest.student.resultsLoading = false;
    if (!background || changed) replace();
    cacheCurrentPage();
  }
}

recordsContainer.addEventListener("student-record-open", event => { void loadStudentPerformance(event.detail.studentId); });
recordsContainer.addEventListener("click", event => {
  const button = event.target.closest(".load-student-results");
  if (button) { event.stopPropagation(); void loadStudentPerformance(button.dataset.id); }
});

// Helper to format minutes nicely
function formatMinutes(totalMinutes) {
  if (!totalMinutes || totalMinutes <= 0) return "-- min";
  if (totalMinutes < 1) return "< 1 min";
  return `${Math.round(totalMinutes)} min`;
}


function studentCard(classDoc, { studentDoc, results, resultsLoaded = true, resultsLoading = false, resultsError = false }) {
  const classCode = classDoc.id;
  const sectionName = classDoc.data().SectionName || classCode;
  const sData = studentDoc.data();

  const sName = sData.displayName || "Unknown Student";

  // Generate Initials
  const nameParts = sName.split(" ");
  let initials = nameParts[0] ? nameParts[0][0] : "?";
  if (nameParts.length > 1) initials += nameParts[nameParts.length - 1][0];
  initials = initials.toUpperCase();

  let studentPreSum = 0;
  let studentPostSum = 0;
  let testCount = 0;
  let totalArTime = 0;
  let totalModuleTime = 0;
  let lastActiveDate = new Date(0);

  // Only the selected term is loaded.
  for (const { lessonsSnap } of results) {
    lessonsSnap.forEach((lessonDoc) => {
      const tData = lessonDoc.data();

      // Pre-Test and Post-Test scores
      if (tData.isPreTestCompleted && tData.isPostTestCompleted && tData.preTestTotalQuestions > 0 && tData.postTestTotalQuestions > 0) {
        const prePercent = (tData.preTestScore / tData.preTestTotalQuestions) * 100;
        const rawPostScore = tData.postTestScore !== undefined ? tData.postTestScore : (tData.postTestHeatmap ? tData.postTestHeatmap.filter(Boolean).length : 0);
        const postPercent = (rawPostScore / tData.postTestTotalQuestions) * 100;

        studentPreSum += prePercent;
        studentPostSum += postPercent;
        testCount++;
      }

      // 1. AR Time (arTimeMinutes + arNavigationTimeMinutes)
      if (typeof tData.arTimeMinutes === "number") {
        totalArTime += tData.arTimeMinutes;
      }
      if (typeof tData.arNavigationTimeMinutes === "number" && !tData.arTimeMinutes) {
        totalArTime += tData.arNavigationTimeMinutes;
      }

      // 2. Module Time (lessonTimeMinutes)
      if (typeof tData.lessonTimeMinutes === "number") {
        totalModuleTime += tData.lessonTimeMinutes;
      } else if (tData.learningTimeByDevice && typeof tData.learningTimeByDevice === "object") {
        // Fallback: sum lessonSeconds across devices if lessonTimeMinutes isn't top-level
        Object.values(tData.learningTimeByDevice).forEach((dev) => {
          if (dev && typeof dev.lessonSeconds === "number") {
            totalModuleTime += dev.lessonSeconds / 60;
          }
        });
      }

      // Last Active Timestamp
      const ts = tData.timestamp || tData.lastUpdated || tData.completedAt;
      if (ts) {
        const testDate = ts.toDate ? ts.toDate() : new Date(ts);
        if (!isNaN(testDate.getTime()) && testDate > lastActiveDate) {
          lastActiveDate = testDate;
        }
      }
    });
  }

  // Formatting data strings
  const avgPreStr = testCount > 0 ? `${Math.round(studentPreSum / testCount)}%` : "N/A";
  const avgPostNum = testCount > 0 ? Math.round(studentPostSum / testCount) : 0;
  const avgPostStr = testCount > 0 ? `${avgPostNum}%` : "N/A";
  const overallPercent = avgPostNum;

  const arTimeStr = formatMinutes(totalArTime);
  const moduleTimeStr = formatMinutes(totalModuleTime);

  const dateStr = lastActiveDate.getTime() > 0
    ? `Last active ${lastActiveDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
    : "No activity recorded";

  // Building the actual HTML Card
  const card = document.createElement("article");
  card.className = "record";
  card.dataset.studentId = studentDoc.id;
  card.dataset.archived = String(sData.active === false);
  card.dataset.name = sName.toLowerCase();
  card.dataset.section = classCode;
  card.dataset.autoLoad = String(!resultsLoaded && !resultsLoading && !resultsError);
  card.setAttribute("aria-busy", String(resultsLoading));

  card.innerHTML = `
    <div class="record-head">
      <div class="student">
        <div class="avatar">${escapeHTML(initials)}</div>
        <div>
          <div style="display: flex; align-items: center; gap: 0.5rem;">
            <strong>${escapeHTML(sName)}</strong>
            ${sData.active === false ? '<span class="student-archive-badge">' + (sData.archiveReason === "graduated" ? "Graduated" : sData.archiveReason === "dropped-out" ? "Dropped out" : "Archived") + '</span><button type="button" class="unarchive-student-btn">Unarchive</button><button type="button" class="remove-student-btn">Delete</button>' : '<button type="button" class="archive-student-btn">Archive</button>'}
          </div>
          <small>Grade 6 – ${escapeHTML(sectionName)}${resultsLoaded ? ` · ${dateStr}` : ""}</small>
        </div>
      </div>
      <span class="overall">${resultsLoaded ? `${overallPercent}%` : "—"} · Term ${pageFilter.termId?.slice(-1) || "1"}</span>
    </div>
    <div class="stats">
      <div class="stat"><span>AR Time</span><b class="c-pink">${resultsLoaded ? arTimeStr : "—"}</b></div>
      <div class="stat"><span>Module Time</span><b class="c-cyan">${resultsLoaded ? moduleTimeStr : "—"}</b></div>
      <div class="stat"><span>Pre-Test</span><b class="c-amber">${resultsLoaded ? avgPreStr : "—"}</b></div>
      <div class="stat"><span>Post-Test</span><b class="c-green">${resultsLoaded ? avgPostStr : "—"}</b></div>
    </div>
    ${resultsLoaded ? `<div class="record-progress-tile">
      <span class="record-progress-title">Term performance</span>
      <div class="bar" role="progressbar" aria-label="Term performance" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${overallPercent}"><i style="width:${overallPercent}%"></i></div>
      <strong class="record-progress-value">${overallPercent}%</strong>
    </div>` : `<p class="view-data-status" role="status">${resultsLoading ? "Loading performance…" : resultsError ? "Performance could not load." : "Performance loads when viewed."}</p>${resultsLoading ? "" : `<button type="button" class="load-student-results ghost-btn" data-id="${escapeHTML(studentDoc.id)}">${resultsError ? "Retry performance" : "Load performance"}</button>`}`}
  `;
  for (const selector of [".archive-student-btn", ".unarchive-student-btn", ".remove-student-btn"]) {
  const button = card.querySelector(selector);
  if (button) {
    button.dataset.id = studentDoc.id;
    button.dataset.name = sName;
    button.setAttribute("aria-label", (selector === ".archive-student-btn" ? "Archive " : selector === ".unarchive-student-btn" ? "Unarchive " : "Delete ") + sName);
  }

  }
  return card;
}

onAuthStateChanged(auth, async user => {
  stopUpdates?.(); pageAbort?.abort(); reportRequests.clear(); observedCards?.disconnect();
  if (!user) { window.location.href = "login.html"; return; }
  if (recordOwnerUid !== user.uid) { recordData = null; counts = []; dynamicCards = []; recordsContainer.replaceChildren(); }
  recordOwnerUid = user.uid;
  prepareTeacherCache(app, user);
  const saved = prepareTeacherCache(app, user).get(user.uid, "records:state");
  if (saved && ["active", "archived"].includes(saved.filter?.status) && typeof saved.filter.search === "string" &&
      Number.isInteger(saved.pageIndex) && saved.pageIndex >= 0 && saved.pageIndex < 5000 && Array.isArray(saved.cursors) && saved.cursors[saved.pageIndex] !== undefined) {
    pageFilter = { ...saved.filter, termId: /^term_0[1-3]$/.test(saved.filter.termId) ? saved.filter.termId : "term_01" }; pageIndex = saved.pageIndex; cursors = saved.cursors;
    recordStatus = pageFilter.status; searchInput.value = pageFilter.search;
    for (const status of ["active", "archived"]) document.getElementById(status + "StudentsTab").setAttribute("aria-pressed", String(recordStatus === status));
  }
  termFilter.value = pageFilter.termId;
  await loadRecordsPage();
  stopUpdates = watchVisibleData(app, user, () => loadRecordsPage({ background: true }));
});


const archiveModal = document.getElementById("archiveStudentModal");
const archiveForm = document.getElementById("archiveStudentForm");
const archiveReason = document.getElementById("archiveReason");
const archiveSave = document.getElementById("confirmArchiveStudent");
const archiveError = document.getElementById("archiveStudentError");
archiveForm.addEventListener("change", event => {
  if (event.target.name === "archiveReasonChoice") archiveReason.value = event.target.value;
});
function resetArchiveReason() {
  archiveReason.value = "";
  archiveForm.querySelectorAll('input[name="archiveReasonChoice"]').forEach(input => { input.checked = false; });
}
let archiveTarget;
let archiveSectionTargets = null;
let archiveSectionCode = null;
document.getElementById("cancelArchiveStudent").addEventListener("click", () => {
  if (!archiveSave.disabled) archiveModal.classList.remove("open");
});
recordsContainer.addEventListener("click", event => {
  const button = event.target.closest(".archive-student-btn");
  if (!button) return;
  archiveSectionTargets = null;
  archiveSectionCode = null;
  archiveTarget = { id: button.dataset.id, name: button.dataset.name };
  document.getElementById("archiveStudentTitle").textContent = "Archive student";
  archiveSave.textContent = "Archive student";
  resetArchiveReason();
  archiveError.textContent = "";
  document.getElementById("archiveStudentName").textContent = archiveTarget.name;
  archiveModal.classList.add("open");
  archiveForm.querySelector('input[name="archiveReasonChoice"]')?.focus();
});
archiveSectionButton.addEventListener("click", () => {
  if (archiveSectionButton.disabled) return;
  const total = counts.find(item => item.classId === sectionFilter.value)?.active || 0;
  if (!total) return;
  archiveSectionCode = sectionFilter.value;
  archiveSectionTargets = null;
  archiveTarget = null;
  const label = Array.from(sectionFilter.options).find(option => option.value === sectionFilter.value)?.textContent || sectionFilter.value;
  document.getElementById("archiveStudentTitle").textContent = "Archive section";
  document.getElementById("archiveStudentName").textContent = label + " — " + total + " active students. This includes students on other pages and those hidden by search.";
  archiveSave.textContent = "Archive " + total + " students";
  resetArchiveReason();
  archiveError.textContent = "";
  archiveModal.classList.add("open");
  archiveForm.querySelector('input[name="archiveReasonChoice"]')?.focus();
});
archiveForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (archiveSave.disabled || (!archiveTarget && !archiveSectionCode) || !["graduated", "dropped-out"].includes(archiveReason.value)) return;
  archiveSave.disabled = true;
  archiveSave.textContent = "Archiving…";
  archiveError.textContent = "";
  let savedCount = 0;
  try {
    const data = { active: false, deletedAt: new Date(), archiveReason: archiveReason.value };
    if (archiveSectionCode && archiveSectionTargets === null) {
      const ids = []; let cursor = null;
      do {
        const page = await getStudentPage({ sectionId: archiveSectionCode, status: "active", cursor, includeCounts: false });
        ids.push(...page.students.map(row => row.studentDoc.id)); cursor = page.cursor;
      } while (cursor);
      archiveSectionTargets = [...new Set(ids)];
    }
    if (archiveSectionTargets) {
      // The server accepts at most 100 writes per atomic batch.
      while (archiveSectionTargets.length) {
        const group = archiveSectionTargets.slice(0, 100);
        const batch = writeBatch(db);
        for (const id of group) batch.update(doc(db, "users", id), data);
        await batch.commit();
        updateStudentRows(group, data, false, archiveSectionCode);
        archiveSectionTargets.splice(0, group.length);
        savedCount += group.length;
      }
    } else {
      await updateDoc(doc(db, "users", archiveTarget.id), data);
      updateStudentRows([archiveTarget.id], data);
    }
    archiveModal.classList.remove("open");
  } catch (error) {
    console.error("Error archiving student:", error);
    archiveError.textContent = savedCount ? savedCount + " students archived. Retry to finish the remaining students." : "Could not archive the selected students. Please try again.";
  } finally {
    archiveSave.disabled = false;
    archiveSave.textContent = archiveSectionTargets?.length ? "Retry remaining students" : "Archive student";
  }
});

recordsContainer.addEventListener("click", async event => {
  const restore = event.target.closest(".unarchive-student-btn");
  const remove = event.target.closest(".remove-student-btn");
  const button = restore || remove;
  if (!button || button.disabled) return;
  const message = restore
    ? "Return " + button.dataset.name + " to the Active students list?"
    : "Delete the archived student profile for " + button.dataset.name + "? This cannot be undone. Existing lesson results and their sign-in account are not erased.";
  if (!window.confirm(message)) return;
  button.disabled = true;
  try {
    const reference = doc(db, "users", button.dataset.id);
    if (restore) {
      const data = { active: true, archiveReason: null, deletedAt: null };
      await updateDoc(reference, data);
      updateStudentRows([button.dataset.id], data);
    } else {
      await deleteDoc(reference);
      updateStudentRows([button.dataset.id], {}, true);
    }
  } catch (error) {
    console.error("Student action failed:", error);
    window.alert(restore ? "Could not unarchive this student. Please try again." : "Could not delete this student. Please try again.");
    button.disabled = false;
  }
});
