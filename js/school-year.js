import { getApps, initializeApp } from "./firebase-auth.js";
import { getAuth, onAuthStateChanged } from "./firebase-auth.js";
import { collection, doc, getDocs, getFirestore, limit, onSnapshot, query, serverTimestamp, setDoc, where } from "./firebase-data.js";

const app = getApps().find(candidate => candidate.name === "[DEFAULT]") || initializeApp();
const auth = getAuth(app);
const db = getFirestore(app);
const reference = doc(db, "webSettings", "schoolYear");
const labels = document.querySelectorAll("[data-school-year]");
const select = document.getElementById("schoolYearSelect");
const status = document.getElementById("schoolYearStatus");
let confirmedYear = 2026;
let loaded = false;
let canEdit = false;
let saving = false;
let generation = 0;
let stopListening;

const validYear = year => Number.isInteger(year) && year >= 2000 && year <= 2100;
const label = year => `SY ${year}–${String(year + 1).slice(-2)}`;
function showStatus(message = "", error = false) {
  if (!status) return;
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
  const current = new Date().getFullYear();
  const from = Math.max(2000, Math.min(current - 3, year));
  const through = Math.min(2100, Math.max(current + 10, year));
  select.replaceChildren(...Array.from({ length: through - from + 1 }, (_, index) => {
    const option = document.createElement("option");
    option.value = String(from + index);
    option.textContent = label(from + index);
    return option;
  }));
  select.value = String(year);
}
async function isAdministrator(user) {
  const profiles = await getDocs(query(collection(db, "users"), where("uid", "==", user.uid), limit(2)));
  if (profiles.size !== 1) return false;
  const profile = profiles.docs[0].data();
  return profile.uid === user.uid && profile.role === "admin" && profile.active !== false &&
    !["inactive", "disabled"].includes(profile.status);
}

displayYear(confirmedYear);
onAuthStateChanged(auth, async user => {
  const currentGeneration = ++generation;
  stopListening?.();
  loaded = false;
  canEdit = false;
  refreshControl();
  if (!user && select) { showStatus("Sign in as an administrator to change the school year."); return; }
  if (!user && !/\/login(?:\.html)?\/?$/.test(window.location.pathname)) return;

  stopListening = onSnapshot(reference, { includeMetadataChanges: true }, snapshot => {
    if (currentGeneration !== generation || snapshot.metadata.hasPendingWrites) return;
    const year = snapshot.exists() ? snapshot.data().startYear : 2026;
    if (!validYear(year)) { loaded = true; refreshControl(); showStatus("Choose a school year to replace the invalid saved setting.", true); return; }
    loaded = true;
    displayYear(year);
    refreshControl();
  }, () => {
    if (currentGeneration !== generation) return;
    showStatus("Unable to load the school year. Refresh to try again.", true);
    refreshControl();
  });

  if (select) {
    try {
      const allowed = await isAdministrator(user);
      if (currentGeneration !== generation) return;
      canEdit = allowed;
      showStatus(allowed ? "" : "Only administrators can change the school year.", !allowed);
      refreshControl();
    } catch {
      if (currentGeneration === generation) showStatus("Unable to verify administrator access. Refresh to try again.", true);
    }
  }
});

select?.addEventListener("change", async () => {
  const year = Number(select.value);
  if (!canEdit || !loaded || saving || !validYear(year)) { select.value = String(confirmedYear); return; }
  const currentGeneration = generation;
  const user = auth.currentUser;
  saving = true;
  refreshControl();
  showStatus("Saving…");
  try {
    if (!user || !await isAdministrator(user) || auth.currentUser?.uid !== user.uid || currentGeneration !== generation) {
      throw new Error("Administrator access required");
    }
    await setDoc(reference, { startYear: year, endYear: year + 1, updatedBy: user.uid, updatedAt: serverTimestamp() }, { merge: true });
    if (currentGeneration !== generation) return;
    displayYear(year);
    showStatus("Saved for all teachers");
  } catch {
    if (currentGeneration !== generation) return;
    select.value = String(confirmedYear);
    showStatus("Could not save the school year. Please try again.", true);
  } finally {
    saving = false;
    refreshControl();
  }
});
