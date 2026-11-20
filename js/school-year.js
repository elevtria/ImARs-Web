import { getApps, initializeApp } from "./firebase-auth.js";
import { getAuth, onAuthStateChanged } from "./firebase-auth.js";
import { doc, getDoc, getFirestore } from "./firebase-data.js";
import { setLoadingState } from "./loading.js";

const app = getApps().find(candidate => candidate.name === "[DEFAULT]") || initializeApp();
const auth = getAuth(app);
const db = getFirestore(app);
const reference = doc(db, "webSettings", "schoolYear");
const labels = document.querySelectorAll("[data-school-year]");
const select = document.getElementById("schoolYearSelect");
const status = document.getElementById("schoolYearStatus");
const CACHE_KEY = "imars-school-year-v1";
const FRESH_FOR_MS = 24 * 60 * 60_000;
const EDITOR_FRESH_FOR_MS = 5 * 60_000;
let confirmedYear = 2026;
let loaded = false;
let canEdit = false;
let saving = false;
let generation = 0;
let cachedYear;
let pendingRead;

const validYear = year => Number.isInteger(year) && year >= 2000 && year <= 2100;
const label = year => `SY ${year}–${String(year + 1).slice(-2)}`;
function savedYear() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(CACHE_KEY));
    if (validYear(saved?.startYear) && Number.isFinite(saved.checkedAt) && saved.checkedAt <= Date.now()) return saved;
  } catch {}
  return cachedYear;
}
function rememberYear(year) {
  // This public label is independent of staff/student caches and contains no account data.
  cachedYear = { startYear: year, checkedAt: Date.now() };
  try { window.localStorage.setItem(CACHE_KEY, JSON.stringify(cachedYear)); } catch {}
}
function showStatus(message = "", error = false) {
  if (!status) return;
  setLoadingState(status, saving && !message, "Saving school year");
  status.textContent = message;
  status.classList.toggle("error", error);
}
function refreshControl() {
  if (select) select.disabled = !loaded || !canEdit || saving;
}
function displayYear(year) {
  confirmedYear = year;
  labels.forEach(element => { element.textContent = label(year); });
  if (!select) return;
  select.replaceChildren(...[year, year + 1].map((value, index) => {
    const option = document.createElement("option");
    option.value = String(value);
    option.textContent = index ? "Manage school year & history…" : label(year);
    return option;
  }));
  select.value = String(year);
}

displayYear(savedYear()?.startYear ?? confirmedYear);
window.addEventListener("storage", event => {
  if (event.key !== CACHE_KEY) return;
  const saved = savedYear();
  if (saved && !saving) displayYear(saved.startYear);
});
onAuthStateChanged(auth, async user => {
  const currentGeneration = ++generation;
  loaded = false;
  canEdit = false;
  refreshControl();
  if (!user && select) { showStatus("Sign in as an administrator to change the school year."); return; }
  if (!user && !/\/login(?:\.html)?\/?$/.test(window.location.pathname)) return;

  const saved = savedYear();
  if (saved) displayYear(saved.startYear);
  if (select) {
    canEdit = user.role === "admin";
    if (!canEdit) { showStatus("Only administrators can manage school-year history.", true); return; }
    if (saved && Date.now() - saved.checkedAt < EDITOR_FRESH_FOR_MS) {
      loaded = true;
      refreshControl();
      return;
    }
  }
  if (!select && saved && Date.now() - saved.checkedAt < FRESH_FOR_MS) return;
  try {
    const startedAt = Date.now();
    pendingRead ||= getDoc(reference).finally(() => { pendingRead = undefined; });
    const snapshot = await pendingRead;
    if (currentGeneration !== generation) return;
    const newer = savedYear();
    const year = newer?.checkedAt > startedAt ? newer.startYear : snapshot.exists() ? snapshot.data().startYear : 2026;
    loaded = true;
    if (validYear(year)) {
      rememberYear(year);
      displayYear(year);
      showStatus();
    } else showStatus("Choose a school year to replace the invalid saved setting.", true);
  } catch {
    if (currentGeneration === generation) showStatus("Unable to load the school year. Refresh to try again.", true);
  } finally {
    if (currentGeneration === generation) refreshControl();
  }
});

select?.addEventListener("change", () => {
  if (!canEdit || !loaded || saving) { select.value = String(confirmedYear); return; }
  select.value = String(confirmedYear);
  window.location.href = "admin-school-years.html";
});
