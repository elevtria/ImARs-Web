import { getApps, initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
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
