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
const loginPage = () => /^\/login(?:\.html)?\/?$/.test(window.location.pathname);
const portalRole = () => /^\/(?:admin-dashboard|admin-profile|manage-teachers|school-analytics)(?:\.html)?\/?$/.test(window.location.pathname) ? "admin" : "teacher";
const sharedPage = () => /^\/teacher-manual(?:\.html)?\/?$/.test(window.location.pathname);
const hidePortal = () => { if (!loginPage()) document.body.setAttribute("data-auth-pending", ""); };
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
  if (navigation?.type !== "navigate") return false;
  try { return new URL(document.referrer).origin === window.location.origin; }
  catch { return false; }
}
function denyAccess(auth, state, reason = "web-session") {
  if (state.denied) return;
  state.denied = true;
  auth.currentUser = null;
  clearVisit();
  document.querySelector("main")?.replaceChildren();
  window.location.replace(`/login?reason=${reason}`);
}
async function identity(auth, state) {
  const saved = visit();
  if (!saved) throw new Error("A fresh sign-in is required.");
  const { user } = await webRequest("/api/web-auth/identity", {});
  if (!user?.uid || user.uid !== saved.uid || user.role !== saved.role || (!sharedPage() && user.role !== portalRole())) throw Object.assign(new Error("This account cannot access this portal."), { status: 403 });
  if (!state.denied) auth.currentUser = Object.freeze(user);
}
export function getAuth(application = app) {
  if (instance) return instance;
  const auth = instance = { app: application, currentUser: null };
  const state = { listeners: new Set(), denied: false, suspended: false };
  states.set(auth, state);
  const resume = !loginPage() && continuingVisit() && visit();
  if (!resume) clearVisit();
  state.ready = resume ? identity(auth, state) : Promise.resolve();
  state.ready.catch(error => { if (!loginPage()) denyAccess(auth, state, error.status === 403 ? "access-denied" : "access-unavailable"); });
  window.addEventListener("pagehide", () => { hidePortal(); state.suspended = true; });
  window.addEventListener("pageshow", event => {
    if (!event.persisted) return;
    state.suspended = false;
    hidePortal();
    state.ready = identity(auth, state);
    for (const listener of state.listeners) void listener();
  });
  window.addEventListener("storage", event => {
    if (event.key !== SIGN_OUT || !auth.currentUser) return;
    try { if (JSON.parse(event.newValue)?.uid === auth.currentUser.uid) denyAccess(auth, state); } catch {}
  });
  window.addEventListener("imars-session-ended", () => { if (!loginPage()) denyAccess(auth, state); });
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
      if (!auth.currentUser || visit()?.uid !== auth.currentUser.uid) { denyAccess(auth, state); return; }
      document.body.removeAttribute("data-auth-pending");
      callback(auth.currentUser);
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
