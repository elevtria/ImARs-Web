import { getApps, initializeApp } from "./firebase-auth.js";
import { getAuth, onAuthStateChanged, signOut } from "./firebase-auth.js";
import { collection, getDocs, getFirestore, query, where } from "./firebase-data.js";
import { initWebSession } from "./web-session.js";

const nameElement = document.querySelector(".side-user .user-meta strong");
const avatarElement = document.querySelector(".side-user .user-avatar");

document.addEventListener("click", async event => {
  const link = event.target.closest("a[href]");
  if (!link || new URL(link.href, window.location.href).pathname.replace(/\.html$/, "") !== "/login") return;
  event.preventDefault();
  try {
    const app = getApps().find(candidate => candidate.name === "[DEFAULT]");
    if (app) await signOut(getAuth(app));
    else {
      const { closeWebSession } = await import("./web-login.js");
      await closeWebSession();
    }
    window.location.href = link.href;
  } catch (error) { window.alert(error.message); }
});

if (nameElement && avatarElement) {

  const app = getApps().find((candidate) => candidate.name === "[DEFAULT]") || initializeApp();
  const auth = getAuth(app);
  initWebSession(auth);
  const db = getFirestore(app);

  onAuthStateChanged(auth, async (user) => {
    if (!user) return;

    try {
      const userQuery = query(collection(db, "users"), where("uid", "==", user.uid));
      const userSnapshot = await getDocs(userQuery);
      const userData = userSnapshot.empty ? {} : userSnapshot.docs[0].data();
      const teacherName = userData.displayName || user.displayName || "Teacher";

      nameElement.textContent = teacherName;

      const nameParts = teacherName.trim().split(/\s+/).filter(Boolean);
      avatarElement.textContent = nameParts.length > 1
        ? (nameParts[0][0] + nameParts[nameParts.length - 1][0]).toUpperCase()
        : (nameParts[0] || "T").slice(0, 2).toUpperCase();
    } catch (error) {
      console.error("Unable to load the signed-in teacher name:", error);
    }
  });
}
