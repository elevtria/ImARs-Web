const markerPacks = [
  { term: 1, topic: "Circulatory system", file: "term-1-circulatory-system.zip", markers: 3, bytes: 3774599 },
  { term: 1, topic: "Mixture and separation", file: "term-1-mixture-and-separation.zip", markers: 4, bytes: 3095183 },
  { term: 1, topic: "Changes of state", file: "term-1-changes-of-state.zip", markers: 3, bytes: 2681021 },
  { term: 1, topic: "Physical and Chemical changes", file: "term-1-physical-and-chemical-changes.zip", markers: 4, bytes: 3095183 },
  { term: 2, topic: "Longitudinal and transverse waves", file: "term-2-longitudinal-and-transverse-waves.zip", markers: 3, bytes: 2594598 },
  { term: 2, topic: "Properties of water and sound", file: "term-2-properties-of-water-and-sound.zip", markers: 2, bytes: 2284498 },
  { term: 2, topic: "Simple machine", file: "term-2-simple-machine.zip", markers: 6, bytes: 1635345 },
  { term: 2, topic: "Food web", file: "term-2-food-web.zip", markers: 1, bytes: 1220753 },
  { term: 3, topic: "Longitudinal and transverse waves", file: "term-3-longitudinal-and-transverse-waves.zip", markers: 3, bytes: 2594598 },
  { term: 3, topic: "Constellation", file: "term-3-constellation.zip", markers: 1, bytes: 734038 },
  { term: 3, topic: "Motion of the Earth", file: "term-3-motion-of-the-earth.zip", markers: 2, bytes: 767022 },
  { term: 3, topic: "Volcanic", file: "term-3-volcanic.zip", markers: 1, bytes: 458043 }
];

const storageKey = "imars-marker-downloads-v1";
const migrationKey = `${storageKey}:legacy-migrated`;
const validFiles = new Set(markerPacks.map((pack) => pack.file));

const readProgress = (key) => {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "[]");
    return new Set(Array.isArray(saved) ? saved.filter((file) => validFiles.has(file)) : []);
  } catch {
    return new Set();
  }
};

let activeStorageKey = storageKey;
const downloaded = readProgress(storageKey);
const legacyProgress = new Set(downloaded);
let progressRef = null;
let stopProgressListener = null;
let cloudSyncQueue = Promise.resolve();
let cloudBooting = false;

const escapeHtml = (value) => value.replace(/[&<>"']/g, (char) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&#39;"
}[char]));

const formatSize = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const rowsRoot = document.getElementById("markerRows");
const cloudStatus = document.getElementById("cloudSyncStatus");

const setCloudStatus = (message) => {
  if (cloudStatus) cloudStatus.textContent = message;
};

markerPacks.forEach((pack) => {
  const wasDownloaded = downloaded.has(pack.file);
  const row = document.createElement("div");
  row.className = "file-row";
  row.dataset.topic = pack.topic;
  row.dataset.term = `Term ${pack.term}`;
  row.dataset.size = formatSize(pack.bytes);
  row.dataset.markers = String(pack.markers);
  row.dataset.file = pack.file;
  row.innerHTML = `
    <div class="topic"><strong>${escapeHtml(pack.topic)}</strong><small>${pack.markers} marker image${pack.markers === 1 ? "" : "s"} · ZIP archive</small></div>
    <span class="chip term-${pack.term}">Term ${pack.term}</span>
    <span class="size">${formatSize(pack.bytes)}</span>
    <span class="chip ready" data-status>${wasDownloaded ? "Download requested" : "Ready"}</span>
    <span class="action"><a class="btn-green" href="assets/markers/${pack.file}" download data-download>Download ZIP</a></span>
  `;
  rowsRoot.appendChild(row);
});

const rows = [...rowsRoot.querySelectorAll(".file-row")];

const saveProgress = () => {
  try {
    localStorage.setItem(activeStorageKey, JSON.stringify([...downloaded]));
  } catch {}
};

const updateProgress = () => {
  const count = rows.filter((row) => downloaded.has(row.dataset.file)).length;
  const pct = Math.round((count / rows.length) * 100);
  document.getElementById("progressLabel").textContent = `${count} of ${rows.length} topic ZIP requests saved`;
  document.getElementById("progressFill").style.width = `${pct}%`;
  document.getElementById("progressPct").textContent = `${pct}% complete`;
  rows.forEach((row) => {
    row.querySelector("[data-status]").textContent = downloaded.has(row.dataset.file) ? "Download requested" : "Ready";
  });
};

const saveBlob = (name, type, content) => {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const markDownloaded = (files) => {
  files.filter((file) => validFiles.has(file)).forEach((file) => downloaded.add(file));
  saveProgress();
  updateProgress();
  void syncProgressToCloud(files);
};

const syncProgressToCloud = (files = [...downloaded]) => {
  const targetRef = progressRef;
  if (!targetRef || !navigator.onLine) return Promise.resolve();
  const filesToSync = [...new Set(files)].filter((file) => validFiles.has(file));
  if (!filesToSync.length) return Promise.resolve();

  cloudSyncQueue = cloudSyncQueue.then(async () => {
    if (!targetRef || !navigator.onLine) return;
    const { setDoc, arrayUnion, serverTimestamp } = window.imarsFirestore;
    setCloudStatus("Syncing progress to your teacher account…");
    await setDoc(targetRef, {
      requestedFiles: arrayUnion(...filesToSync),
      updatedAt: serverTimestamp()
    }, { merge: true });
    setCloudStatus("Progress synced to your teacher account.");
  }).catch((error) => {
    console.error("Unable to sync marker download progress:", error);
    setCloudStatus("Cloud sync failed. Progress is saved on this browser; check Firestore rules or connection.");
  });
  return cloudSyncQueue;
};

const useTeacherCache = (teacherId) => {
  const teacherStorageKey = `${storageKey}:${teacherId}`;
  const teacherProgress = readProgress(teacherStorageKey);
  const browserLocalProgress = activeStorageKey === storageKey ? new Set(downloaded) : legacyProgress;
  downloaded.clear();
  teacherProgress.forEach((file) => downloaded.add(file));

  try {
    if (localStorage.getItem(migrationKey) !== "true") {
      browserLocalProgress.forEach((file) => downloaded.add(file));
      localStorage.setItem(migrationKey, "true");
      localStorage.removeItem(storageKey);
    }
  } catch {}

  activeStorageKey = teacherStorageKey;
  saveProgress();
  updateProgress();
};

const attachCloudProgress = async (user, firestore) => {
  const { collection, query, where, getDocs, doc, onSnapshot } = firestore;
  const teachers = await getDocs(query(collection(firestore.db, "users"), where("uid", "==", user.uid)));
  const teacherDoc = teachers.docs.find((candidate) => candidate.data().role === "teacher");
  if (!teacherDoc) {
    progressRef = null;
    setCloudStatus("No teacher account was found for this sign-in. Progress stays on this browser.");
    return;
  }

  useTeacherCache(teacherDoc.id);
  progressRef = doc(firestore.db, "users", teacherDoc.id, "offlineSync", "markerDownloads");

  if (stopProgressListener) stopProgressListener();
  stopProgressListener = onSnapshot(progressRef, (snapshot) => {
    if (!snapshot.exists()) {
      setCloudStatus("Connected. Saving this browser’s existing progress…");
      if (downloaded.size) void syncProgressToCloud();
      else setCloudStatus("Connected. Progress will sync after a ZIP is requested.");
      return;
    }

    const cloudFiles = snapshot.data().requestedFiles;
    const remoteProgress = new Set(Array.isArray(cloudFiles) ? cloudFiles.filter((file) => validFiles.has(file)) : []);
    const localOnly = [...downloaded].filter((file) => !remoteProgress.has(file));
    remoteProgress.forEach((file) => downloaded.add(file));
    saveProgress();
    updateProgress();
    setCloudStatus(snapshot.metadata.hasPendingWrites
      ? "Syncing progress to your teacher account…"
      : "Progress synced to your teacher account.");
    if (localOnly.length) void syncProgressToCloud(localOnly);
  }, (error) => {
    console.error("Unable to read marker download progress:", error);
    setCloudStatus("Cloud sync failed. Progress is saved on this browser; check Firestore rules or connection.");
  });
};

const startCloudSync = async () => {
  if (cloudBooting) return;
  if (!navigator.onLine) {
    setCloudStatus("Offline. Progress is saved on this browser and will sync when you reconnect.");
    return;
  }

  cloudBooting = true;
  try {
    const [appSdk, authSdk, firestoreSdk] = await Promise.all([
      import("https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js"),
      import("https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js"),
      import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js")
    ]);
    const firebaseConfig = {
      apiKey: "AIzaSyBwH8D-mJSpjqu_C7Y7e7ljCjSZiO7FTm0",
      authDomain: "imars-db-a733b.firebaseapp.com",
      projectId: "imars-db-a733b",
      storageBucket: "imars-db-a733b.firebasestorage.app",
      messagingSenderId: "539058786779",
      appId: "1:539058786779:web:201076a476a471a0bdd7fe",
      measurementId: "G-TEERTREQF3"
    };
    const app = appSdk.getApps().find((candidate) => candidate.name === "[DEFAULT]") || appSdk.initializeApp(firebaseConfig);
    const auth = authSdk.getAuth(app);
    const db = firestoreSdk.getFirestore(app);
    const firestore = { ...firestoreSdk, db };
    window.imarsFirestore = firestore;

    authSdk.onAuthStateChanged(auth, async (user) => {
      if (stopProgressListener) {
        stopProgressListener();
        stopProgressListener = null;
      }
      progressRef = null;
      if (!user) {
        setCloudStatus("Sign in as a teacher to sync progress across browsers. This browser keeps a local copy.");
        return;
      }

      setCloudStatus("Connecting to your teacher account…");
      try {
        await attachCloudProgress(user, firestore);
      } catch (error) {
        console.error("Unable to connect marker download progress:", error);
        setCloudStatus("Cloud sync failed. Progress is saved on this browser; check Firestore rules or connection.");
      }
    }, (error) => {
      console.error("Unable to read sign-in state:", error);
      setCloudStatus("Could not check sign-in. Progress is saved on this browser.");
    });
  } catch (error) {
    console.error("Unable to load Firebase for marker progress sync:", error);
    setCloudStatus("Cloud sync is unavailable. Progress is saved on this browser.");
  } finally {
    cloudBooting = false;
  }
};

rowsRoot.addEventListener("click", (event) => {
  const downloadLink = event.target.closest("[data-download]");
  if (downloadLink) markDownloaded([downloadLink.closest(".file-row").dataset.file]);
});

document.getElementById("downloadAll").addEventListener("click", () => {
  markDownloaded(markerPacks.map((pack) => pack.file));
  const link = document.createElement("a");
  link.href = "assets/markers/all-3d-markers.zip";
  link.download = "all-3d-markers.zip";
  link.click();
});

document.getElementById("exportReport").addEventListener("click", () => {
  const csvValue = (value) => `"${String(value).replace(/"/g, '""')}"`;
  const lines = [["Topic", "Term", "Marker images", "ZIP size", "Download status"]];
  rows.forEach((row) => {
    lines.push([
      row.dataset.topic,
      row.dataset.term,
      row.dataset.markers,
      row.dataset.size,
      downloaded.has(row.dataset.file) ? "Download requested" : "Ready"
    ]);
  });
  saveBlob("offline-marker-downloads.csv", "text/csv;charset=utf-8", lines.map((line) => line.map(csvValue).join(",")).join("\n"));
});

window.addEventListener("online", () => {
  if (!window.imarsFirestore) {
    void startCloudSync();
    return;
  }
  if (!progressRef) {
    setCloudStatus("Sign in as a teacher to sync progress across browsers. This browser keeps a local copy.");
    return;
  }
  setCloudStatus("Back online. Syncing saved progress…");
  void syncProgressToCloud();
});

window.addEventListener("offline", () => {
  setCloudStatus("Offline. Progress is saved on this browser and will sync when you reconnect.");
});

updateProgress();
void startCloudSync();
