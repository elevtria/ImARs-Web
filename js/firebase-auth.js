export * from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { browserSessionPersistence, getAuth as firebaseGetAuth, setPersistence, onAuthStateChanged as firebaseAuthChanged, signInWithEmailAndPassword as firebaseSignIn, signOut as firebaseSignOut } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { getFirestore, collection, query, where, limit, getDocsFromServer } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { closeWebSession } from "./web-login.js";
import { invalidateTeacherViews } from "./view-cache.js";

const VISIT = "imars-web-visit-v1";
const SIGN_OUT = "imars-web-sign-out-v1";
const MAX_VISIT_MS = 12 * 60 * 60_000;
const states = new WeakMap();
const applications = new WeakMap();
const loginPage = () => /^\/login(?:\.html)?\/?$/.test(window.location.pathname);
const portalRole = () => /^\/(?:admin-dashboard|admin-profile|manage-teachers|school-analytics)(?:\.html)?\/?$/.test(window.location.pathname) ? "admin" : "teacher";
const sharedPage = () => /^\/teacher-manual(?:\.html)?\/?$/.test(window.location.pathname);
const hidePortal = () => { if (!loginPage()) document.body.setAttribute("data-auth-pending", ""); };

function visit() {
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(VISIT));
    if (saved?.uid && ["teacher", "admin"].includes(saved.role) && Number.isFinite(saved.startedAt) &&
        Date.now() >= saved.startedAt && Date.now() < saved.startedAt + MAX_VISIT_MS) return saved;
  } catch {}
  return null;
}

function clearVisit() {
  try { window.sessionStorage.removeItem(VISIT); } catch {}
  invalidateTeacherViews();
  hidePortal();
}

// A bookmark, address-bar visit, new tab, or browser restoration starts at login.
// Only navigation from this website, or a reload in the current visit, resumes it.
function continuingVisit() {
  const navigation = window.performance.getEntriesByType("navigation")[0];
  if (navigation?.type === "reload") return true;
  if (navigation?.type !== "navigate") return false;
  try { return new URL(document.referrer).origin === window.location.origin; }
  catch { return false; }
}

async function staffProfile(auth, user, role) {
  const profiles = await getDocsFromServer(query(collection(getFirestore(auth.app), "users"), where("uid", "==", user.uid), limit(2)));
  const profile = profiles.size === 1 ? profiles.docs[0].data() : null;
  if (!profile || profile.uid !== user.uid || String(profile.role || "").toLowerCase() !== role ||
      profile.active === false || ["inactive", "disabled"].includes(String(profile.status || "").toLowerCase())) {
    throw Object.assign(new Error("This account does not have access to this portal."), { code: "permission-denied" });
  }
}

async function denyAccess(auth, state, reason = "web-session") {
  if (state.denied) return;
  state.denied = true;
  clearVisit();
  try { await firebaseSignOut(auth); } catch {}
  finally {
    document.querySelector("main")?.replaceChildren();
    window.location.replace(`/login?reason=${reason}`);
  }
}

export function getAuth(app) {
  if (applications.has(app)) return applications.get(app);
  const auth = firebaseGetAuth(app);
  // Let the SDK migrate and remove an older LOCAL login before clearing it.
  // Initializing with SESSION alone would leave that old persistent copy behind.
  const persistence = setPersistence(auth, browserSessionPersistence);
  const state = { listeners: new Set(), denied: false, suspended: false, access: null };
  applications.set(app, auth);
  states.set(auth, state);
  const resume = !loginPage() && continuingVisit() && visit();
  if (!resume) clearVisit();
  state.ready = (async () => {
    await persistence;
    await auth.authStateReady();
    if (!resume || auth.currentUser?.uid !== resume.uid) {
      clearVisit();
      await firebaseSignOut(auth);
    }
  })();
  // Observers and sign-in await the same initialization; no restored account
  // reaches a page's data callbacks while an old login is being cleared.
  state.ready.catch(() => { if (!loginPage()) void denyAccess(auth, state, "access-unavailable"); });
  window.addEventListener("pagehide", () => { hidePortal(); state.suspended = true; state.access = null; });
  window.addEventListener("pageshow", event => {
    if (event.persisted) {
      state.suspended = false;
      for (const listener of state.listeners) listener(auth.currentUser);
    }
  });
  window.addEventListener("storage", event => {
    if (event.key !== SIGN_OUT || !auth.currentUser) return;
    try {
      if (JSON.parse(event.newValue)?.uid === auth.currentUser.uid) void denyAccess(auth, state);
    } catch {}
  });
  return auth;
}

export function onAuthStateChanged(auth, next, error, completed) {
  const state = states.get(auth);
  const callback = typeof next === "function" ? next : user => next?.next?.(user);
  let generation = 0, stopped = false;
  const deliver = async user => {
    const current = ++generation;
    try {
      await state.ready;
      if (stopped || current !== generation || state.suspended) return;
      if (loginPage()) { callback(null); return; }
      const saved = visit();
      const role = saved?.role;
      if (!user || auth.currentUser?.uid !== user.uid || saved?.uid !== user.uid || (!sharedPage() && role !== portalRole())) {
        await denyAccess(auth, state);
        return;
      }
      state.access ||= staffProfile(auth, user, role);
      await state.access;
      if (stopped || current !== generation || state.suspended || auth.currentUser?.uid !== user.uid || visit()?.uid !== user.uid || state.denied) return;
      document.body.removeAttribute("data-auth-pending");
      callback(user);
    } catch (failure) {
      if (stopped || current !== generation || state.suspended) return;
      await denyAccess(auth, state, failure.code === "permission-denied" ? "access-denied" : "access-unavailable");
      (error || next?.error)?.(failure);
    }
  };
  state.listeners.add(deliver);
  const stop = firebaseAuthChanged(auth, deliver, error, completed);
  return () => { stopped = true; generation++; state.listeners.delete(deliver); stop(); };
}

export async function signInWithEmailAndPassword(auth, email, password, role) {
  const state = states.get(auth);
  await state.ready;
  if (!loginPage() || !["teacher", "admin"].includes(role)) throw new Error("Use the website login form to sign in.");
  try {
    const credential = await firebaseSignIn(auth, email, password);
    await staffProfile(auth, credential.user, role);
    window.sessionStorage.setItem(VISIT, JSON.stringify({ uid: credential.user.uid, role, startedAt: Date.now() }));
    return credential;
  } catch (failure) {
    clearVisit();
    await firebaseSignOut(auth);
    if (failure.code === "permission-denied") failure.userMessage = failure.message;
    throw failure;
  }
}

export async function signOut(auth) {
  const uid = auth.currentUser?.uid;
  clearVisit();
  try { if (uid) window.localStorage.setItem(SIGN_OUT, JSON.stringify({ uid, at: Date.now() })); } catch {}
  const results = await Promise.allSettled([closeWebSession(), firebaseSignOut(auth)]);
  const failed = results.find(result => result.status === "rejected");
  if (failed) throw failed.reason;
}
