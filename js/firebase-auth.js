import { closeWebSession, protectedWebLogin, webRequest } from "./web-login.js";
import { invalidateTeacherViews } from "./view-cache.js";

const VISIT = "imars-web-visit-v1";
const SIGN_OUT = "imars-web-sign-out-v1";
const MAX_VISIT_MS = 12 * 60 * 60_000;
const app = Object.freeze({ name: "[DEFAULT]" });
const states = new WeakMap();
let instance;
export const initializeApp = () => app;
export const getApps = () => [app];
const loginPage = () => /^\/(?:admin-)?login(?:\.html)?\/?$/.test(window.location.pathname);
const adminLoginPage = () => /^\/admin-login(?:\.html)?\/?$/.test(window.location.pathname);
const portalRole = () => /^\/(?:admin-dashboard|admin-profile|admin-manual|manage-teachers|school-analytics)(?:\.html)?\/?$/.test(window.location.pathname) ? "admin" : "teacher";
const sharedPage = () => /^\/teacher-manual(?:\.html)?\/?$/.test(window.location.pathname);
const hidePortal = () => {
  if (loginPage()) return;
  document.body.setAttribute("data-auth-pending", "");
  const main = document.querySelector("main");
  if (main) main.inert = true;
};
function visit() {
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(VISIT));
    if (saved?.uid && typeof saved.tabId === "string" && saved.tabId.startsWith("imars-web:") && saved.tabId === window.name &&
        ["teacher", "admin"].includes(saved.role) && Number.isFinite(saved.startedAt) &&
        Date.now() >= saved.startedAt && Date.now() < saved.startedAt + MAX_VISIT_MS) return saved;
  } catch {}
  return null;
}
function clearVisit() {
  try { window.sessionStorage.removeItem(VISIT); } catch {}
  if (window.name.startsWith("imars-web:")) window.name = "";
  invalidateTeacherViews();
  hidePortal();
}
function continuingVisit() {
  const navigation = window.performance.getEntriesByType("navigation")[0];
  if (navigation?.type === "reload") return true;
  if (!["navigate", "back_forward"].includes(navigation?.type)) return false;
  try { return new URL(document.referrer).origin === window.location.origin; }
  catch { return false; }
}

function samePortalLocation(first, second) {
  const page = url => url.pathname.replace(/\/$/, "").replace(/\.html$/, "") || "/index";
  return first.origin === second.origin && page(first) === page(second) && first.search === second.search && first.hash === second.hash;
}

function reuseVisitedPage(event, auth, state) {
  const navigation = window.navigation;
  if (!navigation?.currentEntry || !auth.currentUser || state.denied || state.suspended || !state.visitId || visit()?.tabId !== state.visitId ||
      event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  const link = event.target.closest?.(".side-nav a[href]");
  if (!link || link.hasAttribute("download") || (link.target && link.target !== "_self")) return;
  try {
    const current = navigation.currentEntry;
    const destination = new URL(link.href, window.location.href);
    if (destination.origin !== window.location.origin) return;
    if (samePortalLocation(new URL(current.url), destination)) { event.preventDefault(); return; }
    // Only reuse history entries that were verified during this same sign-in.
    const previous = navigation.entries().filter(entry => entry.key !== current.key && entry.url &&
      entry.getState()?.imarsVisit === state.visitId && samePortalLocation(new URL(entry.url), destination))
      .sort((a, b) => Math.abs(a.index - current.index) - Math.abs(b.index - current.index) || a.index - b.index)[0];
    if (!previous) return;
    const traversal = navigation.traverseTo(previous.key);
    event.preventDefault();
    void Promise.all([traversal.committed, traversal.finished]).catch(error => {
      if (error.name !== "AbortError" && navigation.currentEntry?.key === current.key) window.location.assign(destination.href);
    });
  } catch { /* Browsers without a usable history entry follow the ordinary link. */ }
}

function denyAccess(auth, state, reason = "web-session") {
  if (state.denied) return;
  state.denied = true;
  auth.currentUser = null;
  clearVisit();
  document.querySelector("main")?.replaceChildren();
  const loginPath = portalRole() === "admin" ? "/admin-login" : "/login";
  window.location.replace(`${loginPath}?reason=${reason}`);
}
async function identity(auth, state) {
  const saved = visit();
  if (!saved || saved.tabId !== state.visitId) throw new Error("A fresh sign-in is required.");
  const { user, session } = await webRequest("/api/web-auth/identity", {});
  if (!user?.uid || user.uid !== saved.uid || user.role !== saved.role || (!sharedPage() && !adminLoginPage() && user.role !== portalRole())) throw Object.assign(new Error("This account cannot access this portal."), { status: 403 });
  if (!state.denied) {
    auth.currentUser = Object.freeze(user);
    state.session = { timing: session, receivedAt: Date.now() };
    try {
      const navigation = window.navigation;
      navigation?.updateCurrentEntry({ state: { ...navigation.currentEntry.getState(), imarsVisit: state.visitId } });
    } catch { /* Browser history reuse is optional. */ }
  }
}
export function getSessionTiming(auth) {
  const saved = states.get(auth)?.session;
  if (!auth.currentUser || !saved?.timing) return null;
  const elapsed = Math.max(0, Date.now() - saved.receivedAt);
  return { ...saved.timing, remainingMs: saved.timing.remainingMs - elapsed, checkInMs: saved.timing.checkInMs - elapsed };
}
export function getAuth(application = app) {
  if (instance) return instance;
  const auth = instance = { app: application, currentUser: null };
  const state = { listeners: new Set(), denied: false, suspended: false, restored: false };
  states.set(auth, state);
  const resume = !loginPage() && continuingVisit() && visit();
  state.visitId = resume ? resume.tabId : null;
  if (!resume) clearVisit();
  state.ready = resume ? identity(auth, state) : Promise.resolve();
  state.ready.catch(error => { if (!loginPage()) denyAccess(auth, state, error.status === 403 ? "access-denied" : "access-unavailable"); });
  window.addEventListener("pagehide", () => {
    if (!loginPage()) document.body.setAttribute("data-history-hidden", "");
    hidePortal(); state.suspended = true;
  });
  window.addEventListener("pageshow", event => {
    if (!event.persisted) return;
    state.suspended = false;
    state.restored = true;
    hidePortal();
    state.ready = identity(auth, state);
    for (const listener of state.listeners) void listener();
  });
  window.addEventListener("storage", event => {
    if (event.key !== SIGN_OUT || !auth.currentUser) return;
    try { if (JSON.parse(event.newValue)?.uid === auth.currentUser.uid) denyAccess(auth, state); } catch {}
  });
  window.addEventListener("imars-session-ended", () => { if (!loginPage()) denyAccess(auth, state); });
  window.addEventListener("click", event => reuseVisitedPage(event, auth, state));
  return auth;
}
export function onAuthStateChanged(auth, next, error) {
  const state = states.get(auth);
  const callback = typeof next === "function" ? next : user => next?.next?.(user);
  let generation = 0, stopped = false;
  const deliver = async () => {
    const current = ++generation;
    try {
      await state.ready;
      if (stopped || current !== generation || state.suspended || state.denied) return;
      if (loginPage()) { callback(null); return; }
      const currentVisit = visit();
      if (!auth.currentUser || currentVisit?.uid !== auth.currentUser.uid || currentVisit.tabId !== state.visitId) { denyAccess(auth, state); return; }
      document.body.removeAttribute("data-auth-pending");
      document.body.removeAttribute("data-history-hidden");
      const main = document.querySelector("main");
      if (main) main.inert = false;
      callback(auth.currentUser, { restored: state.restored });
    } catch (failure) {
      if (stopped || current !== generation || state.suspended) return;
      denyAccess(auth, state, failure.status === 403 ? "access-denied" : "access-unavailable");
      (error || next?.error)?.(failure);
    }
  };
  state.listeners.add(deliver);
  void deliver();
  return () => { stopped = true; generation++; state.listeners.delete(deliver); };
}
export async function signInWithEmailAndPassword(auth, identifier, password, role) {
  const state = states.get(auth);
  await state.ready;
  if (!loginPage() || !["teacher", "admin"].includes(role)) throw new Error("Use the website login form to sign in.");
  const user = await protectedWebLogin(identifier, password, role);
  const tabId = `imars-web:${crypto.randomUUID()}`;
  try {
    window.name = tabId;
    window.sessionStorage.setItem(VISIT, JSON.stringify({ uid: user.uid, role, startedAt: Date.now(), tabId }));
    auth.currentUser = Object.freeze(user);
    state.denied = false;
    return { user: auth.currentUser };
  } catch (error) {
    await closeWebSession().catch(() => {});
    clearVisit();
    throw error;
  }
}
export async function signOut(auth) {
  const uid = auth.currentUser?.uid;
  // Send the expected UID before removing the visit marker, since cookies are
  // shared with other tabs while the visit marker belongs to this tab alone.
  const closing = closeWebSession();
  auth.currentUser = null;
  clearVisit();
  try { if (uid) window.localStorage.setItem(SIGN_OUT, JSON.stringify({ uid, at: Date.now() })); } catch {}
  for (const listener of states.get(auth).listeners) void listener();
  await closing;
}
