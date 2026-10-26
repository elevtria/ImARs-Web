import { getApps, initializeApp } from "./firebase-auth.js";
import { getAuth, onAuthStateChanged } from "./firebase-auth.js";
import {
  collection,
  doc,
  getFirestore,
  onSnapshotWithLoading as onSnapshot,
  onSnapshot as quietSnapshot,
  updateDoc,
  writeBatch
} from "./firebase-data.js";
import { todayISO, topicAvailability, termAvailability, manualAccessUpdate, scheduledAccessUpdate } from "./topic-availability.js";
import { prepareTeacherCache } from "./teacher-view.js";
import { encodeView, decodeView } from "./view-cache.js";

const THEMES = ["yellow", "green", "blue"];
const FILLS = ["fill-yellow", "fill-green", "fill-blue"];
const TERM_IDS = ["term_01", "term_02", "term_03"];

const DEFAULT_TERMS = [
  {
    name: "Term 1",
    open: false,
    topics: [
      { title: "Diagrams and Flowcharts, Processes of Changes of State", date: "", locked: false },
      { title: "Physical and Chemical Change", date: "", locked: false },
      { title: "Mixtures and Separation Techniques", date: "", locked: false },
      { title: "The Circulatory System", date: "", locked: false }
    ]
  },
  {
    name: "Term 2",
    open: true,
    topics: [
      { title: "Food Webs", date: "", locked: false },
      { title: "Simple Machines", date: "", locked: false },
      { title: "Properties of Water and Sound Waves", date: "", locked: false },
      { title: "Longitudinal and Transverse Waves", date: "", locked: false }
    ]
  },
  {
    name: "Term 3",
    open: false,
    topics: [
      { title: "Longitudinal and Transverse Waves", date: "", locked: false },
      { title: "Volcanic Activity and Safety", date: "", locked: false },
      { title: "Motions of the Earth", date: "", locked: false },
      { title: "Constellations", date: "", locked: false }
    ]
  }
];

const key = "imars-topic-scheduler-v2";
const readOpenStates = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    return Array.isArray(saved) ? saved.map((term) => Boolean(term?.open)) : [];
  } catch {
    return [];
  }
};

const savedOpenStates = readOpenStates();
let terms = JSON.parse(JSON.stringify(DEFAULT_TERMS));
terms.forEach((term, index) => {
  if (savedOpenStates[index] !== undefined) term.open = savedOpenStates[index];
});

let isReady = false;
let isSaving = false;
let dateTarget = null;
const syncStatus = document.getElementById("syncStatus");
const activityStatus = document.getElementById("activityScheduleStatus");
const activityList = document.getElementById("activityScheduleList");
let activityMessage = "";
const activityOpenTerms = [false, false, false];
const setSyncStatus = (message, state = "") => {
  syncStatus.textContent = message;
  syncStatus.dataset.state = state;
};
const saveUiState = () => {
  localStorage.setItem(key, JSON.stringify(terms.map(({ open }) => ({ open }))));
};

const isTopicLocked = (topic) => topicAvailability(topic).locked;
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

const formatDate = (iso) => {
  if (!iso) return "Set date";
  const date = new Date(`${iso}T00:00:00`);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

const lockIcon = (locked) => locked
  ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M17 9h-1V7a4 4 0 1 0-8 0v2H7a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2zm-7-2a2 2 0 1 1 4 0v2h-4V7z"/></svg>`
  : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.5-2"/></svg>`;

const calIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3.5" y="5" width="17" height="16" rx="2"/><path d="M8 3v4M16 3v4M3.5 10h17"/></svg>`;

function renderActivitySchedule() {
  const activityCount = terms.reduce((total, term) => total + term.topics.length, 0);
  activityStatus.textContent = activityMessage || (isReady ? `${activityCount} lesson activities in your schedule` : "Waiting for lesson availability…");
  if (!isReady) {
    activityList.innerHTML = '<p class="quiz-schedule-empty">Lesson activities will appear when the topic schedule loads.</p>';
    return;
  }
  activityList.innerHTML = terms.map((term, termIndex) => {
    const open = activityOpenTerms[termIndex];
    const rows = term.topics.map((topic, topicIndex) => {
    const state = topicAvailability(topic);
    const mode = state.label === "Scheduled" ? "scheduled" : state.locked ? "locked" : "now";
    return `<article class="quiz-schedule-card" data-activity="${termIndex}-${topicIndex}">
      <div class="quiz-schedule-info"><span class="quiz-schedule-section">${escapeHtml(term.name)}</span><h3>${escapeHtml(topic.title)}</h3><p>${escapeHtml(state.label)}${mode === "scheduled" ? ` · Opens ${formatDate(topic.date)}` : ""}</p></div>
      <div class="quiz-schedule-controls">
        <label class="quiz-schedule-access">Access <select class="activity-schedule-mode" aria-label="Access for ${escapeHtml(topic.title)}" ${isSaving ? "disabled" : ""}>
          <option value="locked" ${mode === "locked" ? "selected" : ""}>Locked</option>
          <option value="now" ${mode === "now" ? "selected" : ""}>Available now</option>
          <option value="scheduled" ${mode === "scheduled" ? "selected" : ""}>Scheduled release</option>
        </select></label>
        <label class="quiz-schedule-date" ${mode === "scheduled" ? "" : "hidden"}>Release date <input type="date" min="${todayISO()}" value="${mode === "scheduled" ? escapeHtml(topic.date) : ""}" aria-label="Release date for ${escapeHtml(topic.title)}" ${isSaving ? "disabled" : ""}></label>
        <button class="primary-btn activity-schedule-save" type="button" ${isSaving ? "disabled" : ""}>Save access</button>
      </div>
    </article>`;
    }).join("");
    return `<section class="activity-term ${open ? "open" : ""}">
      <button class="activity-term-toggle" type="button" data-activity-term="${termIndex}" aria-expanded="${open}" aria-controls="activityTermRows${termIndex}">
        <span class="activity-term-name">${escapeHtml(term.name)}</span>
        <span class="activity-term-summary">${term.topics.length} activities <svg class="chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></span>
      </button>
      <div class="activity-term-rows" id="activityTermRows${termIndex}"${open ? "" : " hidden"}>${rows}</div>
    </section>`;
  }).join("");
}

function render() {
  const root = document.getElementById("terms");
  root.innerHTML = terms.map((term, ti) => {
    const availability = termAvailability(term);
    const { unlocked, locked, total } = availability;
    const status = isReady ? availability : { label: "Waiting for data", cls: "st-upcoming" };
    const theme = THEMES[ti];
    const allLocked = locked === term.topics.length;
    return `
      <article class="term-card theme-${theme} ${term.open ? "open" : ""}" data-term="${ti}">
        <button class="term-head" type="button" data-toggle="${ti}">
          <div class="term-head-left">
            <div class="term-num">${ti + 1}</div>
            <div>
              <div class="term-name">${term.name}</div>
              <span class="term-status ${status.cls}">${status.label}</span>
            </div>
          </div>
          <div class="term-head-right">
            <span>${isReady ? unlocked : "—"}/${total} unlocked</span>
            <svg class="chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
          </div>
        </button>
        <div class="term-body">
          ${term.topics.map((topic, ki) => {
            const state = isReady ? topicAvailability(topic) : { label: "Waiting", cls: "pill-pending" };
            return `
            <div class="topic-row">
              <div class="topic-left">
                <div class="topic-num">${ki + 1}</div>
                <div>
                  <h3>${escapeHtml(topic.title)}</h3>
                  <small>AR Module · Pre &amp; Post Test</small>
                </div>
              </div>
              <div class="topic-actions">
                <button class="date-btn ${topic.date ? "has-date" : ""}" type="button" data-date="${ti}-${ki}" ${!isReady || isSaving ? "disabled" : ""}>
                  ${calIcon} ${formatDate(topic.date)}
                </button>
                <span class="pill ${state.cls}">${state.label}</span>
                <button class="lock-btn ${isTopicLocked(topic) ? "locked" : ""}" type="button" data-lock="${ti}-${ki}" aria-label="${isTopicLocked(topic) ? "Unlock" : "Lock"} topic" ${!isReady || isSaving ? "disabled" : ""}>
                  ${lockIcon(isTopicLocked(topic))}
                </button>
              </div>
            </div>
          `; }).join("")}
          <div class="term-foot">
            <span>${isReady ? `${unlocked}/${total} topics unlocked · ${locked} locked` : "Waiting for lesson availability"}</span>
            <button class="lock-all" type="button" data-lockall="${ti}" ${!isReady || isSaving ? "disabled" : ""}>
              ${lockIcon(!allLocked)}
              ${allLocked ? "Unlock All" : "Lock All"}
            </button>
          </div>
        </div>
      </article>
    `;
  }).join("");

  document.getElementById("yearProgress").innerHTML = terms.map((term, ti) => {
    const availability = termAvailability(term);
    const pct = isReady ? availability.percent : 0;
    return `
      <div class="year-col">
        <div class="year-meta">
          <span>${term.name}</span>
          <span>${isReady ? `${pct}%` : "—"}</span>
        </div>
        <div class="bar" role="progressbar" aria-label="${term.name} unlocked topics" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-valuetext="${isReady ? `${availability.unlocked} of ${availability.total} topics unlocked` : "Waiting for data"}"><i class="${FILLS[ti]}" style="width:${pct}%"></i></div>
      </div>
    `;
  }).join("");
  renderActivitySchedule();
}

const app = getApps().find((candidate) => candidate.name === "[DEFAULT]") || initializeApp();
const auth = getAuth(app);
const db = getFirestore(app);

function sortLessons(docs) {
  return [...docs].sort((a, b) => {
    const aOrder = Number(a.data().lessonOrder);
    const bOrder = Number(b.data().lessonOrder);
    const aHasOrder = Number.isFinite(aOrder);
    const bHasOrder = Number.isFinite(bOrder);
    if (aHasOrder && bHasOrder && aOrder !== bOrder) return aOrder - bOrder;
    if (aHasOrder !== bHasOrder) return aHasOrder ? -1 : 1;
    return a.id.localeCompare(b.id, undefined, { numeric: true });
  });
}

let stopScheduleListeners = [];
let scheduleGeneration = 0;

function watchScheduleFromFirestore(generation, user) {
  const cache = prepareTeacherCache(app, user);
  const stored = cache.get(user.uid, "schedule");
  let saved = null;
  try { if (stored) saved = decodeView(stored); } catch {}
  if (!Array.isArray(saved) || saved.length !== TERM_IDS.length || saved.some(snapshot => snapshot.docs?.length !== 4)) saved = null;
  setSyncStatus("Loading lesson schedule from Firebase…");
  const snapshots = Array(TERM_IDS.length).fill(null);
  const showLoadError = (error, termIndex) => {
    if (generation !== scheduleGeneration) return;
    snapshots[termIndex] = null;
    isReady = false;
    render();
    console.error("Unable to load Topic Scheduler from Firebase:", error);
    setSyncStatus(error.code === "permission-denied"
      ? "Firebase denied access. Check the teacher Firestore rules."
      : `Could not load schedule: ${error.message}`, "error");
  };

  stopScheduleListeners = TERM_IDS.map((termId, termIndex) => {
    const lessonsRef = collection(db, "terms", termId, "lessons");
    const receive = (snapshot) => {
      if (generation !== scheduleGeneration) return;
      try {
        const lessonDocs = sortLessons(snapshot.docs);
        if (lessonDocs.length !== DEFAULT_TERMS[termIndex].topics.length) {
          throw new Error(`${DEFAULT_TERMS[termIndex].name} needs 4 lesson documents in terms/${termId}/lessons; found ${lessonDocs.length}.`);
        }
        snapshots[termIndex] = snapshot;
        terms[termIndex].topics = DEFAULT_TERMS[termIndex].topics.map((topic, topicIndex) => {
          const lessonDoc = lessonDocs[topicIndex];
          const data = lessonDoc.data();
          return {
            ...topic,
            title: typeof data.title === "string" && data.title.trim() ? data.title : topic.title,
            docId: lessonDoc.id,
            date: typeof data.scheduledDate === "string" ? data.scheduledDate : "",
            locked: data.isLocked === true
          };
        });
        isReady = snapshots.every(Boolean);
        render();
        if (isReady && !isSaving) {
          const cached = snapshots.some((item) => item.metadata.fromCache);
          setSyncStatus(cached ? "Showing cached schedule · waiting for Firebase" : "Connected · changes save to Firebase", cached ? "" : "success");
          if (!snapshots.some(item => item.metadata.hasPendingWrites || item.metadata.fromCache)) cache.put(user.uid, "schedule", encodeView(snapshots));
        }
      } catch (error) {
        showLoadError(error, termIndex);
      }
    };
    if (saved) receive(saved[termIndex]);
    return (saved ? quietSnapshot : onSnapshot)(lessonsRef, { includeMetadataChanges: true }, receive, (error) => {
      if (error.code === "permission-denied" || error.code === "unauthenticated") cache.invalidate();
      showLoadError(error, termIndex);
    });
  });
}

function lessonRef(termIndex, topicIndex) {
  const lessonId = terms[termIndex].topics[topicIndex].docId;
  if (!lessonId) throw new Error("This lesson has not been linked to a Firestore document.");
  return doc(db, "terms", TERM_IDS[termIndex], "lessons", lessonId);
}

onAuthStateChanged(auth, (user) => {
  const generation = ++scheduleGeneration;
  stopScheduleListeners.forEach((stop) => stop());
  stopScheduleListeners = [];
  isReady = false;
  activityMessage = "";
  render();
  if (!user) {
    setSyncStatus("Sign in to load and edit the lesson schedule.", "error");
    return;
  }

  watchScheduleFromFirestore(generation, user);
});

activityList.addEventListener("change", event => {
  if (!event.target.matches(".activity-schedule-mode")) return;
  const card = event.target.closest("[data-activity]");
  card.querySelector(".quiz-schedule-date").hidden = event.target.value !== "scheduled";
});

activityList.addEventListener("click", async event => {
  const termToggle = event.target.closest("[data-activity-term]");
  if (termToggle) {
    const termIndex = Number(termToggle.dataset.activityTerm);
    activityOpenTerms[termIndex] = !activityOpenTerms[termIndex];
    renderActivitySchedule();
    return;
  }
  const button = event.target.closest(".activity-schedule-save");
  if (!button || !isReady || isSaving) return;
  const card = button.closest("[data-activity]");
  const [termIndex, topicIndex] = card.dataset.activity.split("-").map(Number);
  const topic = terms[termIndex]?.topics[topicIndex];
  if (!topic) return;
  const mode = card.querySelector(".activity-schedule-mode").value;
  const dateInput = card.querySelector(".quiz-schedule-date input");
  if (mode === "scheduled" && (!dateInput.value || dateInput.value <= todayISO() || !dateInput.checkValidity())) {
    activityMessage = "Choose a future release date for this activity.";
    activityStatus.textContent = activityMessage;
    dateInput.focus();
    return;
  }
  const update = mode === "scheduled" ? scheduledAccessUpdate(dateInput.value, topic) : manualAccessUpdate(mode === "locked");
  isSaving = true;
  activityMessage = `Saving access for ${topic.title}…`;
  render();
  try {
    await updateDoc(lessonRef(termIndex, topicIndex), update);
    activityMessage = `Saved access for ${topic.title}.`;
    setSyncStatus("Connected · changes save to Firebase", "success");
  } catch (error) {
    console.error("Unable to save activity access:", error);
    activityMessage = `Could not save activity access: ${error.message}`;
    setSyncStatus(activityMessage, "error");
  } finally {
    isSaving = false;
    render();
  }
});

document.getElementById("terms").addEventListener("click", async (event) => {
  const toggle = event.target.closest("[data-toggle]");
  if (toggle) {
    const index = Number(toggle.dataset.toggle);
    terms[index].open = !terms[index].open;
    saveUiState();
    render();
    return;
  }

  if (!isReady || isSaving) return;

  const lock = event.target.closest("[data-lock]");
  if (lock) {
    const [termIndex, topicIndex] = lock.dataset.lock.split("-").map(Number);
    const topic = terms[termIndex].topics[topicIndex];
    const nextLocked = !isTopicLocked(topic);
    isSaving = true;
    render();
    setSyncStatus("Saving lesson access setting…");
    try {
      await updateDoc(lessonRef(termIndex, topicIndex), manualAccessUpdate(nextLocked));
      setSyncStatus("Connected · changes save to Firebase", "success");
    } catch (error) {
      console.error("Unable to save lesson lock:", error);
      setSyncStatus(`Could not save lock: ${error.message}`, "error");
    } finally {
      isSaving = false;
      render();
    }
    return;
  }

  const lockAll = event.target.closest("[data-lockall]");
  if (lockAll) {
    const termIndex = Number(lockAll.dataset.lockall);
    const term = terms[termIndex];
    const nextLocked = !term.topics.every(isTopicLocked);
    isSaving = true;
    render();
    setSyncStatus(`${nextLocked ? "Locking" : "Unlocking"} all ${term.name} lessons…`);
    try {
      const batch = writeBatch(db);
      term.topics.forEach((_, topicIndex) => {
        batch.update(lessonRef(termIndex, topicIndex), manualAccessUpdate(nextLocked));
      });
      await batch.commit();
      setSyncStatus("Connected · changes save to Firebase", "success");
    } catch (error) {
      console.error("Unable to update all lesson locks:", error);
      setSyncStatus(`Could not update lesson locks: ${error.message}`, "error");
    } finally {
      isSaving = false;
      render();
    }
    return;
  }

  const dateButton = event.target.closest("[data-date]");
  if (dateButton && !dateButton.disabled) {
    const [termIndex, topicIndex] = dateButton.dataset.date.split("-").map(Number);
    dateTarget = { termIndex, topicIndex };
    const topic = terms[termIndex].topics[topicIndex];
    const dateInput = document.getElementById("dateInput");
    dateInput.min = todayISO();
    document.getElementById("dateTitle").textContent = `Set date · ${topic.title}`;
    dateInput.value = topic.date || "";
    document.getElementById("dateModal").classList.add("open");
  }
});

const dateModal = document.getElementById("dateModal");
const closeDate = () => { dateModal.classList.remove("open"); dateTarget = null; };
document.getElementById("dateCancel").onclick = closeDate;
dateModal.onclick = (event) => { if (event.target === dateModal) closeDate(); };
document.getElementById("dateSave").onclick = async () => {
  if (!dateTarget || !isReady || isSaving) return;
  const dateInput = document.getElementById("dateInput");
  dateInput.min = todayISO();
  if (!dateInput.checkValidity()) {
    dateInput.reportValidity();
    return;
  }

  const { termIndex, topicIndex } = dateTarget;
  const topic = terms[termIndex].topics[topicIndex];
  const scheduledDate = dateInput.value;
  isSaving = true;
  render();
  setSyncStatus("Saving lesson date…");
  try {
    const dateUpdate = scheduledAccessUpdate(scheduledDate, topic);
    await updateDoc(lessonRef(termIndex, topicIndex), dateUpdate);
    closeDate();
    setSyncStatus("Connected · changes save to Firebase", "success");
  } catch (error) {
    console.error("Unable to save lesson date:", error);
    setSyncStatus(`Could not save date: ${error.message}`, "error");
  } finally {
    isSaving = false;
    render();
  }
};

render();

// Refresh the scheduler's displayed access state at the next local calendar day.
function scheduleMidnightRefresh() {
  const nextMidnight = new Date();
  nextMidnight.setHours(24, 0, 0, 50);
  window.setTimeout(() => {
    render();
    scheduleMidnightRefresh();
  }, Math.max(1000, nextMidnight.getTime() - Date.now()));
}
scheduleMidnightRefresh();

// Refresh overdue releases when returning to a tab that was suspended overnight.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) render();
});
