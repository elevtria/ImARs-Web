import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { 
  getFirestore, 
  collection, 
  query, 
  where, 
  getDocs, 
  doc, 
  getDoc, 
  setDoc, 
  orderBy, 
  limit, 
  addDoc, 
  serverTimestamp 
} from "./firebase-data.js";

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

// --- DOM ELEMENTS ---
const camBtn = document.getElementById("camBtn");
const qrReaderEl = document.getElementById("qr-reader");
const qrFileInput = document.getElementById("qrFileInput");
const viewfinder = document.getElementById("viewfinder");
const status = document.getElementById("camStatus");
const finderCopy = document.getElementById("finderCopy");
const recentScansList = document.getElementById("recentScansList");

// Modal Elements
const qrResultModal = document.getElementById("qrResultModal");
const closeQrModalBtn = document.getElementById("closeQrModalBtn");
const scanAnotherBtn = document.getElementById("scanAnotherBtn");
const modalStudentInitials = document.getElementById("modalStudentInitials");
const modalStudentName = document.getElementById("modalStudentName");
const modalStudentId = document.getElementById("modalStudentId");
const modalSyncText = document.getElementById("modalSyncText");
const modalPreScore = document.getElementById("modalPreScore");
const modalPostScore = document.getElementById("modalPostScore");
const modalGainScore = document.getElementById("modalGainScore");
const modalLessonsNote = document.getElementById("modalLessonsNote");

let isCameraOpen = false;
let html5QrCode = null;
let lastScannedCode = "";
let activeTeacherId = null;
let activeTeacherClassCode = "SCIG6A01";

// --- MODAL CONTROLS ---
const closeResultModal = () => {
  if (qrResultModal) qrResultModal.close();
  lastScannedCode = ""; // Allow scanning again after closing modal
};

if (closeQrModalBtn) closeQrModalBtn.addEventListener("click", closeResultModal);
if (scanAnotherBtn) scanAnotherBtn.addEventListener("click", closeResultModal);
if (qrResultModal) {
  qrResultModal.addEventListener("click", (e) => {
    if (e.target === qrResultModal) closeResultModal();
  });
}

// --- PARSE UNITY STUDENT GRADE QR CODE ---
function parseStudentGradeQR(rawText) {
  const parts = String(rawText || "").split("|").map((p) => p.trim());
  if (parts.length < 2) return null;

  const studentId = parts[0];
  const studentName = parts[1] || "Student";
  const lessonBreakdown = [];

  // Match the exact parsing loop from Unity Admin_Scanning.cs
  parts.slice(2).forEach((token) => {
    if (token.includes("term_") && token.includes("lesson_")) {
      const termIdx = token.indexOf("term_");
      const lessonIdx = token.indexOf("lesson_");

      const termId = token.substring(termIdx, termIdx + 7);
      const lessonId = token.substring(lessonIdx, lessonIdx + 9);

      let prePct = -1;
      let postPct = -1;

      if (token.includes("Pre:")) {
        const preStart = token.indexOf("Pre:") + 4;
        let preEnd = token.indexOf("%", preStart);
        if (preEnd === -1) preEnd = token.indexOf("_", preStart);
        if (preEnd === -1) preEnd = token.length;
        prePct = parseInt(token.substring(preStart, preEnd).replace(/\D/g, ''), 10) || 0;
      }

      if (token.includes("Post:")) {
        const postStart = token.indexOf("Post:") + 5;
        let postEnd = token.indexOf("%", postStart);
        if (postEnd === -1) postEnd = token.length;
        postPct = parseInt(token.substring(postStart, postEnd).replace(/\D/g, ''), 10) || 0;
      }

      lessonBreakdown.push({ termId, lessonId, prePct, postPct });
    }
  });

  return { studentId, studentName, lessonBreakdown };
}

function getInitials(name) {
  const parts = String(name || "S").trim().split(/\s+/);
  if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// --- SYNC SCANNED STUDENT GRADES TO FIRESTORE & SHOW MODAL ---
async function processScannedQR(decodedText) {
  status.textContent = `QR Detected! Processing...`;

  const parsed = parseStudentGradeQR(decodedText);

  if (!parsed || parsed.lessonBreakdown.length === 0) {
    status.textContent = `QR Scanned: ${decodedText}`;
    await saveScanToDatabase(decodedText, "qr");
    return;
  }

  const { studentId, studentName, lessonBreakdown } = parsed;
  const lessonsCount = lessonBreakdown.length;

  // Calculate Averages exactly like Unity does
  let preSum = 0, postSum = 0;
  let preCount = 0, postCount = 0;
  let detailedHtml = "";

  lessonBreakdown.forEach((entry) => {
    if (entry.prePct >= 0) { preSum += entry.prePct; preCount++; }
    if (entry.postPct >= 0) { postSum += entry.postPct; postCount++; }

    // Build the Detailed Scroll List text
    const tLabel = entry.termId.replace("term_0", "Term ").replace("term_", "Term ");
    const lLabel = entry.lessonId.replace("lesson_0", "Lesson ").replace("lesson_", "Lesson ");
    const pScore = entry.prePct >= 0 ? `${entry.prePct}%` : "--";
    const poScore = entry.postPct >= 0 ? `${entry.postPct}%` : "--";

    detailedHtml += `
      <div class="mb-2 last:mb-0">
        <strong>${tLabel}, ${lLabel}</strong><br>
        Pre-Test: <span class="text-amber-500 font-bold">${pScore}</span> | 
        Post-Test: <span class="text-emerald-600 font-bold">${poScore}</span>
      </div>`;
  });

  const avgPre = preCount > 0 ? Math.round(preSum / preCount) : 0;
  const avgPost = postCount > 0 ? Math.round(postSum / postCount) : 0;
  const gain = avgPost - avgPre;
  const gainStr = gain >= 0 ? `+${gain}%` : `${gain}%`;

  // 1. Show Pop-up Modal
  if (modalStudentInitials) modalStudentInitials.textContent = getInitials(studentName);
  if (modalStudentName) modalStudentName.textContent = studentName;
  if (modalStudentId) modalStudentId.textContent = `ID: ${studentId}`;
  if (modalPreScore) modalPreScore.textContent = `${avgPre}%`;
  if (modalPostScore) modalPostScore.textContent = `${avgPost}%`;
  if (modalGainScore) modalGainScore.textContent = gainStr;
  if (modalSyncText) modalSyncText.textContent = "Syncing all terms & lessons...";
  if (modalLessonsNote) modalLessonsNote.textContent = `Master Report · ${lessonsCount} Lessons Synced`;
  
  const detailedListContainer = document.getElementById("modalDetailedScoresList");
  if (detailedListContainer) detailedListContainer.innerHTML = detailedHtml;

  if (qrResultModal && !qrResultModal.open) {
    qrResultModal.showModal();
  }

  try {
    // 2. Update Student Profile
    const studentRef = doc(db, "users", studentId);
    const studentSnap = await getDoc(studentRef);

    const studentUpdate = {
      schoolId: studentId,
      displayName: studentName,
      fullName: studentName,
      role: "student",
      lastQrSyncAt: serverTimestamp(),
      classCode: activeTeacherClassCode
    };

    await setDoc(studentRef, studentUpdate, { merge: true });

    // 3. Loop and Sync Every Lesson (Math matches Unity's RoundToInt)
    for (const item of lessonBreakdown) {
      const lessonRef = doc(db, "users", studentId, "test_results", item.termId, "lessons", item.lessonId);
      
      const lessonUpdate = {
        lessonId: item.lessonId,
        timestamp: serverTimestamp()
      };

      if (item.prePct >= 0) {
        lessonUpdate.isPreTestCompleted = true;
        lessonUpdate.preTestScore = Math.round((item.prePct / 100) * 5);
        lessonUpdate.preTestTotalQuestions = 5;
      }

      if (item.postPct >= 0) {
        lessonUpdate.isPostTestCompleted = true;
        lessonUpdate.isLessonCompleted = true;
        lessonUpdate.postTestScore = Math.round((item.postPct / 100) * 10);
        lessonUpdate.postTestTotalQuestions = 10;
      }

      await setDoc(lessonRef, lessonUpdate, { merge: true });
    }

    // 4. Record Scan & Update UI
    await saveScanToDatabase(`${studentName} (${studentId}) · Master Report Synced`, "qr");
    if (modalSyncText) modalSyncText.textContent = `✓ All Terms & Lessons Synced!`;
    status.textContent = `Successfully scanned and synced ${studentName}'s records.`;
    
  } catch (err) {
    console.error("Error syncing QR grade data:", err);
    if (modalSyncText) modalSyncText.textContent = "Displayed from QR (Offline Mode)";
  }
}

// --- QR CAMERA LOGIC ---
async function stopQrCamera() {
  if (html5QrCode && isCameraOpen) {
    try {
      await html5QrCode.stop();
      html5QrCode.clear();
    } catch (err) {
      console.warn("Error stopping QR scanner:", err);
    }
  }
  isCameraOpen = false;
  qrReaderEl.style.display = "none";
  finderCopy.style.display = "block";
  viewfinder.classList.remove("live");
  camBtn.textContent = "Place Camera / Open Device Camera";
}

camBtn.onclick = async () => {
  if (isCameraOpen) {
    await stopQrCamera();
    status.textContent = "";
    return;
  }

  qrReaderEl.style.display = "block";
  finderCopy.style.display = "none";
  viewfinder.classList.add("live");
  camBtn.textContent = "Stop Camera";
  status.textContent = "Starting camera... Point at a student's Grade QR code.";
  lastScannedCode = "";

  try {
    if (!html5QrCode && window.Html5Qrcode) {
      html5QrCode = new window.Html5Qrcode("qr-reader");
    }

    if (!html5QrCode) {
      status.textContent = "QR scanner library failed to load.";
      return;
    }

    isCameraOpen = true;

    await html5QrCode.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 220, height: 220 } },
      async (decodedText) => {
        if (decodedText === lastScannedCode) return;
        lastScannedCode = decodedText;

        // Pause/stop camera once scanned so the modal pops up cleanly
        await stopQrCamera();
        await processScannedQR(decodedText);
      },
      () => {
        // Ignore frame-by-frame scan misses
      }
    );
  } catch (err) {
    console.error("Camera error:", err);
    await stopQrCamera();
    status.textContent = "Could not access camera. You can also upload a QR image below.";
  }
};

// Read a QR code from an uploaded image when the camera is unavailable.
if (qrFileInput) {
  qrFileInput.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (isCameraOpen) {
      await stopQrCamera();
    }

    status.textContent = "Reading uploaded QR code image...";
    try {
      if (!html5QrCode && window.Html5Qrcode) {
        html5QrCode = new window.Html5Qrcode("qr-reader");
      }
      const decodedText = await html5QrCode.scanFile(file, true);
      await processScannedQR(decodedText);
    } catch (err) {
      console.error("QR file scan error:", err);
      status.textContent = "Could not detect a valid QR code in that image. Try cropping closer to the QR code.";
    } finally {
      qrFileInput.value = "";
    }
  });
}

// --- FIREBASE RECENT SCANS LOGIC ---
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
    } else {
      const fallbackSnap = await getDocs(query(collection(db, "users"), where("role", "==", "teacher")));
      if (!fallbackSnap.empty) {
        activeTeacherId = fallbackSnap.docs[0].id;
      }
    }

    if (activeTeacherId) {
      // Find teacher's primary classCode in case a new student is scanned
      const classSnap = await getDocs(query(collection(db, "classes"), where("teacherId", "==", activeTeacherId)));
      if (!classSnap.empty) {
        activeTeacherClassCode = classSnap.docs[0].id;
      }
      loadRecentScans();
    }
  } catch (error) {
    console.error("Error loading teacher auth:", error);
  }
});

async function loadRecentScans() {
  if (!activeTeacherId) return;

  try {
    const scansRef = collection(db, "users", activeTeacherId, "recent_scans");
    const scansQuery = query(scansRef, orderBy("timestamp", "desc"), limit(5));
    const scansSnap = await getDocs(scansQuery);

    recentScansList.innerHTML = "";

    if (scansSnap.empty) {
      recentScansList.innerHTML = '<p class="muted center" style="margin-top: 20px;">No recent QR scans found.</p>';
      return;
    }

    scansSnap.forEach((docSnap) => {
      const data = docSnap.data();
      if (data.scanType && data.scanType.toLowerCase() === "ar") return;

      const moduleName = data.moduleName || "Scanned QR Code";

      let timeString = "Recently";
      if (data.timestamp && typeof data.timestamp.toDate === "function") {
        const date = data.timestamp.toDate();
        timeString = date.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit"
        });
      }

      const rowHTML = `
        <div class="scan-row">
          <div>
            <strong>${moduleName}</strong>
            <small>${timeString}</small>
          </div>
          <span class="tag tag-qr">QR</span>
        </div>
      `;
      recentScansList.insertAdjacentHTML("beforeend", rowHTML);
    });

    if (recentScansList.innerHTML.trim() === "") {
      recentScansList.innerHTML = '<p class="muted center" style="margin-top: 20px;">No recent QR scans found.</p>';
    }
  } catch (error) {
    console.error("Error fetching recent scans:", error);
    recentScansList.innerHTML = '<p class="muted center" style="margin-top: 20px;">Could not load recent scans.</p>';
  }
}

export async function saveScanToDatabase(moduleName, type = "qr") {
  if (!activeTeacherId) return;

  try {
    const scansRef = collection(db, "users", activeTeacherId, "recent_scans");
    await addDoc(scansRef, {
      moduleName: moduleName,
      scanType: "qr",
      timestamp: serverTimestamp()
    });

    loadRecentScans();
  } catch (error) {
    console.error("Error saving scan to database:", error);
  }
}

window.saveScanToDatabase = saveScanToDatabase;
