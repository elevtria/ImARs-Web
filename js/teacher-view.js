import { getAuth, onAuthStateChanged } from "./firebase-auth.js";
import { decodeView, encodeView, teacherViewCache } from "./view-cache.js";

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[character]));
}

const watched = new WeakSet();
export function prepareTeacherCache(app, user) {
  const auth = getAuth(app);
  const cache = teacherViewCache();
  cache.setOwner(user?.uid || null);
  if (!watched.has(auth)) {
    watched.add(auth);
    onAuthStateChanged(auth, current => cache.setOwner(current?.uid || null));
  }
  return cache;
}

function showState(state, message = "") {
  const main = document.querySelector("main");
  if (!main) return;
  main.dataset.viewState = state;
  let status = document.getElementById("viewDataStatus");
  if (!status && message) {
    status = document.createElement("p");
    status.id = "viewDataStatus";
    status.className = "view-data-status";
    status.setAttribute("role", "status");
    main.prepend(status);
  }
  if (status) { status.textContent = message; status.hidden = !message; }
}

export async function showTeacherView({ app, user, page, load, render, painted = () => {}, freshForMs = 0 }) {
  if (getAuth(app).currentUser?.uid !== user.uid) return;
  const cache = prepareTeacherCache(app, user);
  let version = cache.version();
  let saved = cache.get(user.uid, page);
  if (saved) {
    try { render(decodeView(saved)); showState("saved"); painted(true); }
    catch { saved = null; }
  }
  if (saved && freshForMs > 0 && cache.get(user.uid, page, freshForMs)) { showState("fresh"); return; }
  try {
    let data;
    for (let attempt = 0; attempt < 3; attempt++) {
      data = await load({ background: Boolean(saved) || attempt > 0 });
      if (getAuth(app).currentUser?.uid !== user.uid) return;
      if (cache.version() === version) break;
      // A confirmed local change has already updated the current page and cache.
      if (cache.get(user.uid, page)) { showState("fresh"); painted(true); return; }
      if (attempt === 2) throw new Error("The records changed during refresh. Please try again.");
      version = cache.version();
    }
    let encoded = null;
    try { encoded = encodeView(data); } catch {}
    // Avoid re-rendering unchanged data and resetting the teacher's current filters.
    if (!saved || !encoded || JSON.stringify(saved) !== JSON.stringify(encoded)) render(data);
    if (!encoded || !cache.put(user.uid, page, encoded, version)) cache.remove(page);
    showState("fresh");
    painted(Boolean(saved));
  } catch (error) {
    if (!saved) throw error;
    if (getAuth(app).currentUser?.uid !== user.uid) return;
    if (["permission-denied", "unauthenticated"].includes(error.code)) {
      cache.invalidate();
      document.querySelector("main")?.replaceChildren?.();
      showState("error", "Data access was denied. Refresh or sign in again.");
      throw error;
    }
    showState("saved", "Showing saved data. Updates could not load; check your connection.");
    console.warn("Could not refresh the saved page:", error);
  }
}
