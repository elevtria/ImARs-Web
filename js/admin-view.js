import { getAuth, signOut } from "./firebase-auth.js";
import { collection, getFirestore, getDocs, getDocsWithLoading, limit, query, where } from "./firebase-data.js";
import { showTeacherView as showCachedView } from "./teacher-view.js";
import { decodeView, teacherViewCache } from "./view-cache.js";

// Keep desktop navigation visible; the same menu button controls its label rail.
if (typeof window.matchMedia === "function" && typeof MutationObserver === "function") {
  const navigation = document.getElementById("adminNavigation"), menu = document.getElementById("adminMenuButton");
  if (navigation && menu) {
    const desktop = window.matchMedia("(min-width:1000px)");
    let expanded = true;
    try { expanded = sessionStorage.getItem("imars-admin-navigation-expanded") !== "false"; } catch {}
    const sync = () => {
      const hidden = String(!desktop.matches && !navigation.classList.contains("open"));
      if (navigation.getAttribute("aria-hidden") !== hidden) navigation.setAttribute("aria-hidden", hidden);
      if (desktop.matches) { expanded = navigation.classList.contains("open"); try { sessionStorage.setItem("imars-admin-navigation-expanded", String(expanded)); } catch {} }
    };
    navigation.classList.toggle("open", desktop.matches && expanded); menu.setAttribute("aria-expanded", String(desktop.matches && expanded));
    desktop.addEventListener("change", () => { navigation.classList.toggle("open", desktop.matches && expanded); sync(); });
    new MutationObserver(sync).observe(navigation, {attributes:true,attributeFilter:["class","aria-hidden"]});
    for (const link of navigation.querySelectorAll(".admin-nav-link")) {
      const label = link.textContent.trim(), span = document.createElement("span"); span.className = "admin-nav-label"; span.textContent = label;
      for (const child of [...link.childNodes]) if (child.nodeType === Node.TEXT_NODE) child.remove();
      link.append(span); link.title = label; link.setAttribute("aria-label", label);
    }
    sync();
  }
}

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
export async function showAdminView({ app, user, page, load = async () => null, render, verified = () => {}, painted, freshForMs = 60000, watchKey }) {
  const auth = getAuth(app);
  try {
    await showCachedView({ app, user, page: `admin:${page}`, watchKey, painted, freshForMs: 0,
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
