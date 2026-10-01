import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBwH8D-mJSpjqu_C7Y7e7ljCjSZiO7FTm0",
  authDomain: "imars-db-a733b.firebaseapp.com",
  projectId: "imars-db-a733b",
  storageBucket: "imars-db-a733b.firebasestorage.app",
  messagingSenderId: "539058786779",
  appId: "1:539058786779:web:201076a476a471a0bdd7fe",
  measurementId: "G-TEERTREQF3"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const passwordInput = document.getElementById("password");
const togglePassword = document.getElementById("togglePassword");
const eyeOpen = document.getElementById("eyeOpen");
const eyeOff = document.getElementById("eyeOff");

togglePassword.addEventListener("click", () => {
  const hidden = passwordInput.type === "password";
  passwordInput.type = hidden ? "text" : "password";
  eyeOpen.classList.toggle("hidden", hidden);
  eyeOff.classList.toggle("hidden", !hidden);
  togglePassword.setAttribute("aria-label", hidden ? "Hide password" : "Show password");
});

document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();

  const rawId = document.getElementById("teacherId").value.trim().toUpperCase();
  const password = passwordInput.value.trim();
  const error = document.getElementById("error");

  const showError = (message) => {
    error.classList.remove("hidden");
    error.style.display = "block";
    error.innerText = message;
  };

  if (!rawId || !password) {
    showError("Please enter your ID and password.");
    return;
  }

  try {
    const userDocRef = doc(db, "users", rawId);
    const userDocSnap = await getDoc(userDocRef);

    let authEmail = "";

    if (userDocSnap.exists()) {
      const userData = userDocSnap.data();
      if (userData.providedEmail) {
        authEmail = userData.providedEmail;
      } else {
        authEmail = rawId + "@imars.edu";
      }
    } else {
      showError("Teacher ID not found in database.");
      return;
    }

    await signInWithEmailAndPassword(auth, authEmail, password);
    window.location.href = "index.html";
  } catch (err) {
    showError("Invalid ID or password. Please try again.");
    console.error("Firebase Login Error:", err.message);
  }
});
