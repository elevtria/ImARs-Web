import { getAuth, signOut } from "./firebase-auth.js";
import { collection, getFirestore, getDocs, getDocsWithLoading, limit, query, where } from "./firebase-data.js";
import { showTeacherView as showCachedView } from "./teacher-view.js";
import { decodeView, teacherViewCache } from "./view-cache.js";

export async function readAdminProfile(db, user, read = getDocs) {
  const profiles = await read(query(collection(db, "users"), where("uid", "==", user.uid), limit(2)));
  const profile = profiles.size === 1 ? profiles.docs[0] : null;
  const data = profile?.data();
  if (!data || data.uid !== user.uid || String(data.role || "").toLowerCase() !== "admin" ||
      data.active === false || ["inactive", "disabled"].includes(data.status)) {
    throw Object.assign(new Error("Administrator access is required."), { code: "permission-denied", adminRoleDenied: true });
  }
  const fields = ["displayName", "fullName", "name", "providedEmail", "email", "school", "roleLabel", "department", "phone", "adminSince", "createdAt"];
  return { id: profile.id, display: Object.fromEntries(fields.filter(key => data[key] !== undefined).map(key => [key, data[key]])) };
}

function renderSidebar(data) {
  const name = data.displayName || data.fullName || data.name || "Admin";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const filtered = parts.filter(part => !/^(dr\.|mr\.|ms\.|mrs\.|sir|ma'am)$/i.test(part));
  const initials = (filtered.length ? filtered : parts).slice(0, 2).map(part => part[0] || "").join("").toUpperCase() || "AD";
  const values = [[".admin-side-avatar", initials], [".admin-side-user strong", name], [".admin-side-user small", data.roleLabel || "School Administrator"]];
  for (const [selector, value] of values) {
    const element = document.querySelector(selector);
    if (element) element.textContent = value;
  }
}

// Reuse the same session cache and background refresh behavior as teacher views.
// A cached display never supplies authorization or the document ID used to edit.
export async function showAdminView({ app, user, page, load = async () => null, render, verified = () => {}, painted, freshForMs = 60000 }) {
  const auth = getAuth(app);
  try {
    await showCachedView({ app, user, page: `admin:${page}`, painted, freshForMs: 0,
      load: async ({ background, refresh }) => {
        const read = background ? getDocs : getDocsWithLoading;
        const profile = await readAdminProfile(getFirestore(app), user, read);
        if (auth.currentUser?.uid !== user.uid) return null;
        verified(profile.id);
        const saved = !refresh && freshForMs > 0 ? teacherViewCache().get(user.uid, `admin:${page}`) : null;
        const previous = saved ? decodeView(saved) : null;
        const recent = previous && Date.now() - previous.reportsAt < freshForMs;
        const data = recent ? previous.data : await load({ read, background });
        return { profile: profile.display, data, reportsAt: recent ? previous.reportsAt : Date.now() };
      },
      render: payload => { renderSidebar(payload.profile); render(payload.data, payload.profile); }
    });
  } catch (error) {
    if (auth.currentUser?.uid !== user.uid) return;
    if (error.adminRoleDenied) {
      teacherViewCache().invalidate();
      try { await signOut(auth); } finally { window.location.href = "login.html"; }
      return;
    }
    let status = document.getElementById("viewDataStatus");
    if (!status) {
      status = document.createElement("p");
      status.id = "viewDataStatus";
      status.className = "view-data-status";
      status.setAttribute("role", "status");
      document.querySelector("main")?.prepend(status);
    }
    status.hidden = false;
    status.textContent = "Unable to load admin data. Check your connection and refresh to try again.";
    throw error;
  }
}
