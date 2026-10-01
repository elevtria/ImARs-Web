import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { getFirestore, collection, query, where, getDocs, orderBy, limit, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

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

// --- TAB & CAMERA LOGIC ---
const hint = document.getElementById("finderHint");
let currentMode = "qr";

document.querySelectorAll(".tabs button").forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentMode = btn.dataset.mode;
    hint.textContent = currentMode === "ar" ? "Point camera at AR marker" : "Point camera at QR code";
  };
});

const camBtn = document.getElementById("camBtn");
const arContainer = document.getElementById("ar-container");
const viewfinder = document.getElementById("viewfinder");
const status = document.getElementById("camStatus");
const finderCopy = document.getElementById("finderCopy");
const lessonMarker = document.getElementById("lesson-marker");

let isCameraOpen = false;
let hasSavedScan = false; // Prevents saving the same scan 100 times a second

camBtn.onclick = () => {
  isCameraOpen = !isCameraOpen;
  
  if (isCameraOpen) {
    arContainer.style.display = "block";
    finderCopy.style.display = "none";
    viewfinder.classList.add("live");
    camBtn.textContent = "Stop Camera";
    status.textContent = "Camera is on. Find the 'Hiro' AR marker.";
    hasSavedScan = false;
  } else {
    arContainer.style.display = "none";
    finderCopy.style.display = "block";
    viewfinder.classList.remove("live");
    camBtn.textContent = "Place Camera / Open Device Camera";
    status.textContent = "";
  }
};

// Listen for when the camera spots the marker
if (lessonMarker) {
  lessonMarker.addEventListener("markerFound", () => {
    console.log("Marker detected!");
    status.textContent = "Marker found! Launching 3D Model...";
    
    // Only save to Firebase once per scan session
    if (!hasSavedScan) {
      saveScanToDatabase("Lesson 1: Cell Structure", "ar");
      hasSavedScan = true;
    }
  });

  lessonMarker.addEventListener("markerLost", () => {
    status.textContent = "Marker lost. Point camera back at the marker.";
  });
}

// --- FIREBASE RECENT SCANS LOGIC ---
let activeTeacherId = null;
const recentScansList = document.getElementById("recentScansList");

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = "login.html";
    return;
  }

  try {
    const userQ = query(collection(db, "users"), where("uid", "==", user.uid));
    const userSnap = await getDocs(userQ);

    if (!userSnap.empty) {
      activeTeacherId = userSnap.docs[0].id;
      loadRecentScans();
    }
  } catch (error) {
    console.error("Error loading teacher auth:", error);
  }
});

async function loadRecentScans() {
    if (!activeTeacherId) return;
    
    try {
        // Look for a subcollection of history specifically for this teacher
        const scansRef = collection(db, "users", activeTeacherId, "recent_scans");
        const scansQuery = query(scansRef, orderBy("timestamp", "desc"), limit(5));
        const scansSnap = await getDocs(scansQuery);
        
        recentScansList.innerHTML = "";
        
        if (scansSnap.empty) {
            recentScansList.innerHTML = '<p class="muted center" style="margin-top: 20px;">No recent scans found.</p>';
            return;
        }
        
        scansSnap.forEach((doc) => {
            const data = doc.data();
            const moduleName = data.moduleName || "Unknown Module";
            const scanType = data.scanType || "ar"; // 'ar' or 'qr'
            
            let timeString = "Recently";
            if (data.timestamp) {
                const date = data.timestamp.toDate();
                timeString = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
            }
            
            const rowHTML = `
              <div class="scan-row">
                <div>
                  <strong>${moduleName}</strong>
                  <small>${timeString}</small>
                </div>
                <span class="tag tag-${scanType}">${scanType.toUpperCase()}</span>
              </div>
            `;
            recentScansList.insertAdjacentHTML("beforeend", rowHTML);
        });
        
    } catch (error) {
        console.error("Error fetching recent scans:", error);
        recentScansList.innerHTML = '<p class="muted center" style="margin-top: 20px;">Could not load recent scans.</p>';
    }
}

// --- HELPER FUNCTION FOR THE FUTURE ---
// Call this function from your AR tracking script the moment a marker is recognized
export async function saveScanToDatabase(moduleName, type = "ar") {
    if (!activeTeacherId) return;
    
    try {
        const scansRef = collection(db, "users", activeTeacherId, "recent_scans");
        await addDoc(scansRef, {
            moduleName: moduleName,
            scanType: type,
            timestamp: serverTimestamp()
        });
        
        // Reload the list so the new scan appears instantly
        loadRecentScans();
    } catch (error) {
        console.error("Error saving scan to database:", error);
    }
}

// Optional: Make the helper globally accessible for external AR scripts
window.saveScanToDatabase = saveScanToDatabase;