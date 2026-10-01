import { getApps, initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  collection,
  doc,
  getDocs,
  getFirestore,
  updateDoc,
  writeBatch
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const THEMES = ["yellow", "green", "blue"];
const FILLS = ["fill-yellow", "fill-green", "fill-blue"];
const TERM_IDS = ["term_01", "term_02", "term_03"];

const DEFAULT_TERMS = [
  {
    name: "Term 1",
    open: false,
    topics: [
      { title: "Diagrams and Flowcharts, Processes of Changes of State", date: "", done: false, locked: false },
      { title: "Physical and Chemical Change", date: "", done: false, locked: false },
      { title: "Mixtures and Separation Techniques", date: "", done: false, locked: false },
      { title: "The Circulatory System", date: "", done: false, locked: false }
    ]
  },
  {
    name: "Term 2",
    open: true,
    topics: [
      { title: "Food Webs", date: "", done: false, locked: false },
      { title: "Simple Machines", date: "", done: false, locked: false },
      { title: "Properties of Water and Sound Waves", date: "", done: false, locked: false },
      { title: "Longitudinal and Transverse Waves", date: "", done: false, locked: false }
    ]
  },
  {
    name: "Term 3",
    open: false,
    topics: [
      { title: "Longitudinal and Transverse Waves", date: "", done: false, locked: false },
      { title: "Volcanic Activity and Safety", date: "", done: false, locked: false },
      { title: "Motions of the Earth", date: "", done: false, locked: false },
      { title: "Constellations", date: "", done: false, locked: false }
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
const setSyncStatus = (message, state = "") => {
  syncStatus.textContent = message;
  syncStatus.dataset.state = state;
};
const saveUiState = () => {
  localStorage.setItem(key, JSON.stringify(terms.map(({ open }) => ({ open }))));
};

const doneCount = (term) => term.topics.filter((topic) => topic.done).length;
const isTopicLocked = (topic) => topic.locked && !(topic.date && topic.date <= todayISO());
const lockedCount = (term) => term.topics.filter(isTopicLocked).length;

const termStatus = (index) => {
  const done = doneCount(terms[index]);
  if (done === terms[index].topics.length) return { label: "Completed", cls: "st-completed" };
  return { label: "Active", cls: "st-active" };
};

const formatDate = (iso) => {
  if (!iso) return "Set date";
  const date = new Date(`${iso}T00:00:00`);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

const lockIcon = (locked) => locked
  ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M17 9h-1V7a4 4 0 1 0-8 0v2H7a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2zm-7-2a2 2 0 1 1 4 0v2h-4V7z"/></svg>`
  : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.5-2"/></svg>`;

const calIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3.5" y="5" width="17" height="16" rx="2"/><path d="M8 3v4M16 3v4M3.5 10h17"/></svg>`;

function render() {
  const root = document.getElementById("terms");
  root.innerHTML = terms.map((term, ti) => {
    const done = doneCount(term);
    const locked = lockedCount(term);
    const status = termStatus(ti);
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
            <span>${done}/${term.topics.length} done</span>
            <svg class="chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
          </div>
        </button>
        <div class="term-body">
          ${term.topics.map((topic, ki) => `
            <div class="topic-row">
              <div class="topic-left">
                <div class="topic-num">${ki + 1}</div>
                <div>
                  <h3>${topic.title}</h3>
                  <small>AR Module · Pre &amp; Post Test</small>
                </div>
              </div>
              <div class="topic-actions">
                <button class="date-btn ${topic.date ? "has-date" : ""}" type="button" data-date="${ti}-${ki}" ${!isReady || isSaving ? "disabled" : ""}>
                  ${calIcon} ${formatDate(topic.date)}
                </button>
                <span class="pill ${topic.done ? "pill-done" : "pill-pending"}">${topic.done ? "Done" : "Pending"}</span>
                <button class="lock-btn ${isTopicLocked(topic) ? "locked" : ""}" type="button" data-lock="${ti}-${ki}" aria-label="${isTopicLocked(topic) ? "Unlock" : "Lock"} topic" ${!isReady || isSaving ? "disabled" : ""}>
                  ${lockIcon(isTopicLocked(topic))}
                </button>
              </div>
            </div>
          `).join("")}
          <div class="term-foot">
            <span>${done}/${term.topics.length} topics completed · ${locked} locked</span>
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
    const pct = Math.round((doneCount(term) / term.topics.length) * 100);
    return `
      <div class="year-col">
        <div class="year-meta">
          <span>${term.name}</span>
          <span>${pct}%</span>
        </div>
        <div class="bar"><i class="${FILLS[ti]}" style="width:${pct}%"></i></div>
      </div>
    `;
  }).join("");
}

const firebaseConfig = {
  apiKey: "AIzaSyBwH8D-mJSpjqu_C7Y7e7ljCjSZiO7FTm0",
  authDomain: "imars-db-a733b.firebaseapp.com",
  projectId: "imars-db-a733b",
  storageBucket: "imars-db-a733b.firebasestorage.app",
  messagingSenderId: "539058786779",
  appId: "1:539058786779:web:201076a476a471a0bdd7fe",
  measurementId: "G-TEERTREQF3"
};

const app = getApps().find((candidate) => candidate.name === "[DEFAULT]") || initializeApp(firebaseConfig);
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

async function loadScheduleFromFirestore() {
  setSyncStatus("Loading lesson schedule from Firebase…");
  const loadedTerms = await Promise.all(TERM_IDS.map(async (termId, termIndex) => {
    const lessonsRef = collection(db, "terms", termId, "lessons");
    const snapshot = await getDocs(lessonsRef);
    const lessonDocs = sortLessons(snapshot.docs);

    if (lessonDocs.length !== DEFAULT_TERMS[termIndex].topics.length) {
      throw new Error(`${DEFAULT_TERMS[termIndex].name} needs 4 lesson documents in terms/${termId}/lessons; found ${lessonDocs.length}.`);
    }

    return {
      ...terms[termIndex],
      topics: DEFAULT_TERMS[termIndex].topics.map((topic, topicIndex) => {
        const lessonDoc = lessonDocs[topicIndex];
        const data = lessonDoc.data();
        const date = typeof data.scheduledDate === "string" ? data.scheduledDate : "";
        return {
          ...topic,
          docId: lessonDoc.id,
          date,
          done: Boolean(date),
          locked: data.isLocked === true
        };
      })
    };
  }));

  terms = loadedTerms;
  isReady = true;
  saveUiState();
  render();
  setSyncStatus("Connected · changes save to Firebase", "success");
}

function lessonRef(termIndex, topicIndex) {
  const lessonId = terms[termIndex].topics[topicIndex].docId;
  if (!lessonId) throw new Error("This lesson has not been linked to a Firestore document.");
  return doc(db, "terms", TERM_IDS[termIndex], "lessons", lessonId);
}

onAuthStateChanged(auth, async (user) => {
  isReady = false;
  render();
  if (!user) {
    setSyncStatus("Sign in to load and edit the lesson schedule.", "error");
    return;
  }

  try {
    await loadScheduleFromFirestore();
  } catch (error) {
    console.error("Unable to load Topic Scheduler from Firebase:", error);
    setSyncStatus(error.code === "permission-denied"
      ? "Firebase denied access. Check the teacher Firestore rules."
      : `Could not load schedule: ${error.message}`, "error");
  }
});

function todayISO() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

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
      const lockUpdate = { isLocked: nextLocked };
      // A manual lock cancels an old scheduled release so it stays locked until unlocked again.
      if (nextLocked) lockUpdate.scheduledDate = "";
      await updateDoc(lessonRef(termIndex, topicIndex), lockUpdate);
      topic.locked = nextLocked;
      if (nextLocked) {
        topic.date = "";
        topic.done = false;
      }
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
        batch.update(lessonRef(termIndex, topicIndex), nextLocked
          ? { isLocked: true, scheduledDate: "" }
          : { isLocked: false });
      });
      await batch.commit();
      term.topics.forEach((topic) => {
        topic.locked = nextLocked;
        if (nextLocked) {
          topic.date = "";
          topic.done = false;
        }
      });
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
  const wasAvailable = !isTopicLocked(topic);
  isSaving = true;
  render();
  setSyncStatus("Saving lesson date…");
  try {
    const dateUpdate = { scheduledDate };
    // Scheduling an already available lesson must not make it unavailable again.
    if (wasAvailable) dateUpdate.isLocked = false;
    await updateDoc(lessonRef(termIndex, topicIndex), dateUpdate);
    topic.date = scheduledDate;
    if (wasAvailable) topic.locked = false;
    topic.done = Boolean(scheduledDate);
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
