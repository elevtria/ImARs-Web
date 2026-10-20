import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "./firebase-auth.js";
import { 
  getFirestore, 
  collection, 
  query, 
  where, 
  getDocsWithLoading as getDocs,
  getDocs as quietDocs,
  doc, 
  setDoc, 
  updateDoc, 
  arrayUnion, 
  serverTimestamp 
} from "./firebase-data.js";
import { showTeacherView } from "./teacher-view.js";

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

// DOM Elements
const sectionSelect = document.getElementById("sectionSelect");
const sectionNameEl = document.getElementById("sectionName");
const existingCountEl = document.getElementById("existingCount");
const sectionModal = document.getElementById("sectionModal");
const sectionForm = document.getElementById("sectionForm");
const newSectionName = document.getElementById("newSectionName");
const saveSectionBtn = document.getElementById("saveSectionBtn");
const importModal = document.getElementById("importModal");
const importSummary = document.getElementById("importSummary");
const importPreviewNote = document.getElementById("importPreviewNote");
const confirmImportBtn = document.getElementById("confirmImport");
const uploadStatus = document.getElementById("uploadStatus");
const fileInput = document.getElementById("fileInput");
const dropZone = document.getElementById("dropZone");
const browseBtn = document.getElementById("browseBtn");
const importBtn = document.getElementById("importBtn");

let currentTeacherId = null;
let sections = []; // [{ classCode, label, rawName, count }]
let selectedFile = null;
let parsedStudents = [];

function formatSectionLabel(rawName) {
  const clean = String(rawName || "").trim().replace(/\s*[-–—]\s*/g, " – ");
  if (!clean) return "Grade 6 – Section A";
  if (/^grade\s+\d+/i.test(clean)) return clean;
  return `Grade 6 – ${clean}`;
}

function renderSections(selectedCode = sectionSelect.value) {
  if (sections.length === 0) {
    sectionSelect.innerHTML = `<option value="">No sections available</option>`;
    sectionNameEl.textContent = "No section selected";
    existingCountEl.textContent = "(0 existing students)";
    return;
  }

  sectionSelect.replaceChildren(
    ...sections.map((sec) => {
      const option = document.createElement("option");
      option.value = sec.classCode;
      option.textContent = sec.label;
      return option;
    })
  );

  const match = sections.find((s) => s.classCode === selectedCode || s.label === selectedCode);
  sectionSelect.value = match ? match.classCode : sections[0].classCode;
  updateSelectedSection();
}

function updateSelectedSection() {
  const sec = sections.find((item) => item.classCode === sectionSelect.value);
  sectionNameEl.textContent = sec ? sec.label : "No section";
  const count = sec ? sec.count : 0;
  existingCountEl.textContent = `(${count} existing ${count === 1 ? "student" : "students"})`;
}

sectionSelect.addEventListener("change", updateSelectedSection);

// --- LOAD TEACHER SECTIONS & STUDENT COUNTS FROM FIRESTORE ---
async function loadSectionsFromDB(user, { background = false } = {}) {
  const read = background ? quietDocs : getDocs;
  try {
    const userQ = query(collection(db, "users"), where("uid", "==", user.uid));
    const userSnap = await read(userQ);

    const teacher = userSnap.docs.find(entry => String(entry.data().role || "").toLowerCase() === "teacher");
    if (!teacher) throw Object.assign(new Error("No teacher profile was found for your account."), { code: "permission-denied" });
    const teacherId = teacher.id;
    const teacherData = teacher.data();

    const classQ = query(collection(db, "classes"), where("teacherId", "==", teacherId));
    const classSnap = await read(classQ);

    const loadedSections = [];

    for (const classDoc of classSnap.docs) {
      const cData = classDoc.data();
      const rawName = cData.SectionName || cData.sectionName || cData.name || classDoc.id;
      const label = formatSectionLabel(rawName);

      const stuQ = query(
        collection(db, "users"),
        where("role", "==", "student"),
        where("classCode", "==", classDoc.id)
      );
      const stuSnap = await read(stuQ);

      loadedSections.push({
        classCode: classDoc.id,
        rawName: rawName,
        label: label,
        count: stuSnap.size
      });
    }

    const teacherSections = Array.isArray(teacherData.sections)
      ? teacherData.sections
      : (teacherData.section ? [teacherData.section] : []);

  for (const secStr of teacherSections) {
    const label = formatSectionLabel(secStr);
    const rawSection = secStr.replace(/^Grade\s+\d+\s*[-–—]\s*/i, "").trim() || secStr;

    const alreadyExists = loadedSections.some(
      (s) =>
        s.label.toLowerCase() === label.toLowerCase() ||
        s.rawName.toLowerCase() === rawSection.toLowerCase()
    );

    if (!alreadyExists) {
      const suffix = rawSection.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(-4) || "SEC1";
      const newClassCode = `SCIG6_${suffix}`;

      await setDoc(doc(db, "classes", newClassCode), {
        SectionName: rawSection,
        teacherId,
        gradeLevel: "Grade 6",
        createdAt: serverTimestamp()
      }, { merge: true });

      loadedSections.push({
        classCode: newClassCode,
        rawName: rawSection,
        label: label,
        count: 0
      });
    }
  }

    return { teacherId, sections: loadedSections };
  } catch (err) {
    console.error("Error loading sections from DB:", err);
    throw err;
  }
}

onAuthStateChanged(auth, (user) => {
  if (!user) {
    window.location.href = "login.html";
    return;
  }
  showTeacherView({ app, user, page: "batch-upload", load: options => loadSectionsFromDB(user, options),
    render: data => { currentTeacherId = data.teacherId; sections = data.sections; renderSections(); }
  }).catch(error => { uploadStatus.hidden = false; uploadStatus.textContent = "Could not load your sections. Please refresh to try again."; console.error(error); });
});

// --- OFFICIAL TEMPLATE DOWNLOADS (First Name, Last Name, Student ID, Email) ---
const templateRows = [
  ["First Name", "Last Name", "Student ID", "Email"],
  ["Test", "Student", "0026271000", "name@email.com"],
  ["John", "Doe", "0026271001", "name@email.com"]
];

document.getElementById("dlCsv").onclick = () => {
  const csvContent = templateRows.map((r) => r.join(",")).join("\n") + "\n";
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "ImArs_Student_Template.csv";
  a.click();
  URL.revokeObjectURL(url);
};

document.getElementById("dlXlsx").onclick = () => {
  if (window.XLSX) {
    const ws = window.XLSX.utils.aoa_to_sheet(templateRows);
    const wb = window.XLSX.utils.book_new();
    // Matches the exact sheet tab name "ImArs_Student_Template"
    window.XLSX.utils.book_append_sheet(wb, ws, "ImArs_Student_Template");
    window.XLSX.writeFile(wb, "ImArs_Student_Template.xlsx");
  }
};

// --- ADD NEW SECTION MODAL ---
const openSectionModal = () => {
  newSectionName.value = "";
  newSectionName.setCustomValidity("");
  sectionModal.classList.add("open");
  newSectionName.focus();
};
const closeSectionModal = () => sectionModal.classList.remove("open");

document.getElementById("addSectionBtn").addEventListener("click", openSectionModal);
document.getElementById("cancelAddSection").addEventListener("click", closeSectionModal);
sectionModal.addEventListener("click", (event) => {
  if (event.target === sectionModal) closeSectionModal();
});
newSectionName.addEventListener("input", () => newSectionName.setCustomValidity(""));

sectionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const rawInput = newSectionName.value.trim();
  if (!rawInput) {
    newSectionName.setCustomValidity("Enter a section name.");
    newSectionName.reportValidity();
    return;
  }

  const formattedLabel = formatSectionLabel(rawInput);
  const rawSectionOnly = rawInput.replace(/^Grade\s+\d+\s*[–-]\s*/i, "").trim() || rawInput;

  const duplicate = sections.some((s) => s.label.toLowerCase() === formattedLabel.toLowerCase());
  if (duplicate) {
    newSectionName.setCustomValidity("That section already exists.");
    newSectionName.reportValidity();
    return;
  }

  if (saveSectionBtn) {
    saveSectionBtn.disabled = true;
    saveSectionBtn.textContent = "Adding...";
  }

  try {
    const cleanCode = rawSectionOnly.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 6) || "SEC";
    const classCode = `SCIG6${cleanCode}${Math.floor(10 + Math.random() * 89)}`;

    await setDoc(doc(db, "classes", classCode), {
      SectionName: rawSectionOnly,
      teacherId: currentTeacherId,
      gradeLevel: "Grade 6",
      createdAt: serverTimestamp()
    });

    if (currentTeacherId) {
      await updateDoc(doc(db, "users", currentTeacherId), {
        sections: arrayUnion(formattedLabel)
      });
    }

    sections.push({
      classCode,
      rawName: rawSectionOnly,
      label: formattedLabel,
      count: 0
    });
    renderSections(classCode);
    closeSectionModal();
  } catch (err) {
    console.error("Error creating section:", err);
    alert("Failed to create section: " + err.message);
  } finally {
    if (saveSectionBtn) {
      saveSectionBtn.disabled = false;
      saveSectionBtn.textContent = "Add Section";
    }
  }
});

// --- FILE DRAG & DROP + PARSING ---
const openPicker = () => fileInput.click();
browseBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  openPicker();
});
dropZone.addEventListener("click", openPicker);
dropZone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    openPicker();
  }
});

["dragenter", "dragover"].forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("drag");
  });
});
["dragleave", "drop"].forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("drag");
  });
});
dropZone.addEventListener("drop", (event) => {
  const file = event.dataTransfer.files[0];
  if (file) handleFileSelected(file);
});
fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) handleFileSelected(fileInput.files[0]);
});

let existingStudentIds = new Set();
let previewData = [];

async function handleFileSelected(file) {
  selectedFile = file;
  parsedStudents = [];
  previewData = [];
  uploadStatus.hidden = true;
  document.getElementById("previewSection").hidden = true;
  importBtn.hidden = true;

  // 1. FILE SAFETY: Enforce 5 MB limit mandated by the expert report
  const MAX_FILE_SIZE_MB = 5;
  if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
    document.getElementById("dropTitle").textContent = "File is too large";
    document.getElementById("dropHint").textContent = `Please limit your upload to ${MAX_FILE_SIZE_MB}MB to ensure safe processing.`;
    return;
  }

  try {
    document.getElementById("dropTitle").textContent = "Validating data...";
    document.getElementById("dropHint").textContent = "Checking against database records...";

    const studentsSnap = await getDocs(query(collection(db, "users"), where("role", "==", "student")));
    existingStudentIds.clear();
    studentsSnap.forEach(doc => existingStudentIds.add(doc.id));

    const data = await file.arrayBuffer();
    const workbook = window.XLSX.read(data, { type: "array", raw: false });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = window.XLSX.utils.sheet_to_json(firstSheet, { header: 1, defval: "" });

    // 2. FILE SAFETY: Cap row counts to prevent browser/Cloudflare timeouts
    const MAX_ROWS = 100;
    if (rows.length > MAX_ROWS + 1) { // +1 accounts for the header row
      document.getElementById("dropTitle").textContent = "Too many records";
      document.getElementById("dropHint").textContent = `Please batch your uploads to a maximum of ${MAX_ROWS} students at a time.`;
      return;
    }

    let validCount = 0;
    let errorCount = 0;

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.join("").trim() === "") continue;

      const firstName = String(row[0] ?? "").trim();
      const lastName = String(row[1] ?? "").trim();
      let studentId = String(row[2] ?? "").trim();
      const email = String(row[3] ?? "").trim().toLowerCase();

      if (studentId && /^\d{8}$/.test(studentId)) {
        studentId = "00" + studentId;
      }

      let rowErrors = [];

      if (!firstName) rowErrors.push("Missing First Name");
      if (!lastName) rowErrors.push("Missing Last Name");
      
      if (!studentId) {
         rowErrors.push("Missing Student ID");
      } else if (!/^\d+$/.test(studentId)) {
         rowErrors.push("Invalid format (Letters found)");
      } else if (studentId.length < 9) {
         rowErrors.push("ID too short");
      } else if (existingStudentIds.has(studentId)) {
         rowErrors.push("Duplicate in database");
      }

      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
         rowErrors.push("Invalid email");
      }

      const isValid = rowErrors.length === 0;
      if (isValid) validCount++; else errorCount++;

      const fullName = `${firstName} ${lastName}`.trim();
      
      previewData.push({
        rowNum: i + 1,
        firstName, lastName, fullName, studentId, email,
        isValid,
        errors: rowErrors
      });

      if (isValid) {
        parsedStudents.push({ firstName, lastName, fullName, studentId, email });
      }
    }

    renderPreviewTable(validCount, errorCount);
    
  } catch (err) {
    console.error("Failed to parse file:", err);
    document.getElementById("dropTitle").textContent = "Error reading file";
    document.getElementById("dropHint").textContent = "Please upload a valid .xlsx or .csv file.";
  }
}

function renderPreviewTable(validCount, errorCount) {
  const tbody = document.getElementById("previewTableBody");
  tbody.innerHTML = "";
  
  previewData.forEach(item => {
    const tr = document.createElement("tr");
    tr.style.borderBottom = "1px solid #f1f5f9";
    // Highlight rejected rows as requested by the expert
    if (!item.isValid) tr.style.backgroundColor = "#fef2f2"; 
    
    const idHasError = item.errors.some(e => e.includes('ID') || e.includes('Duplicate'));
    const emailHasError = item.errors.some(e => e.includes('email'));

    tr.innerHTML = `
      <td style="padding: 10px 8px; color: #64748b;">${item.rowNum}</td>
      <td style="padding: 10px 8px;">${item.firstName || '<em style="color:red">Missing</em>'}</td>
      <td style="padding: 10px 8px;">${item.lastName || '<em style="color:red">Missing</em>'}</td>
      <td style="padding: 10px 8px; ${idHasError ? 'color: #dc2626; font-weight: bold;' : ''}">${item.studentId || '<em style="color:red">Missing</em>'}</td>
      <td style="padding: 10px 8px; ${emailHasError ? 'color: #dc2626; font-weight: bold;' : ''}">${item.email}</td>
      <td style="padding: 10px 8px; color: ${item.isValid ? '#16a34a' : '#dc2626'}; font-size: 0.85rem; font-weight: 500;">
        ${item.isValid ? '✓ Ready' : '⚠️ ' + item.errors.join(", ")}
      </td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById("previewSection").hidden = false;
  document.getElementById("previewSummary").textContent = `Found ${validCount} valid records and ${errorCount} errors.`;
  
  const confirmBtn = document.getElementById("confirmPreviewBtn");
  if (validCount > 0) {
    confirmBtn.disabled = false;
    confirmBtn.textContent = `Import ${validCount} Valid Records`;
  } else {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "No valid records to import";
  }
  
  document.getElementById("dropTitle").textContent = selectedFile.name;
  document.getElementById("dropHint").textContent = "Review the table below before importing.";
}

// --- IMPORT CONFIRMATION & FIRESTORE BATCH UPLOAD ---
const closeImportModal = () => importModal.classList.remove("open");

document.getElementById("confirmPreviewBtn").addEventListener("click", (event) => {
  event.stopPropagation();
  if (!selectedFile || parsedStudents.length === 0) return;

  const targetSec = sections.find((s) => s.classCode === sectionSelect.value);
  const secLabel = targetSec ? targetSec.label : sectionSelect.value;

  importSummary.textContent = `You are about to securely import ${parsedStudents.length} VALID student(s) from “${selectedFile.name}” into ${secLabel}. Invalid rows will be skipped.`;
  
  if (importPreviewNote) {
    const sampleNames = parsedStudents.slice(0, 3).map((s) => `${s.fullName} (${s.studentId})`).join(", ");
    importPreviewNote.textContent = `Preview: ${sampleNames}${parsedStudents.length > 3 ? ` and ${parsedStudents.length - 3} more...` : ""}`;
  }
  importModal.classList.add("open");
});

document.getElementById("cancelImport").addEventListener("click", closeImportModal);
importModal.addEventListener("click", (event) => {
  if (event.target === importModal) closeImportModal();
});

confirmImportBtn.addEventListener("click", async () => {
  if (!selectedFile || parsedStudents.length === 0) return;

  const targetSec = sections.find((s) => s.classCode === sectionSelect.value);
  if (!targetSec) {
    alert("Please select or create a valid section first.");
    return;
  }

  confirmImportBtn.disabled = true;
  confirmImportBtn.textContent = "Importing...";

  try {
    const studentsSnap = await getDocs(query(collection(db, "users"), where("role", "==", "student")));
    let highestSeq = 999;
    const existingIds = new Set();

    studentsSnap.forEach((docSnap) => {
      const id = docSnap.id;
      existingIds.add(id);

      if (id.startsWith("002627") && id.length >= 10) {
        const seq = parseInt(id.substring(6), 10);
        if (!isNaN(seq) && seq > highestSeq) highestSeq = seq;
      }
    });

    let importedCount = 0;
    const savedList = [];

    for (const stu of parsedStudents) {
      let finalStudentId = stu.studentId;

      const isNewStudent = !existingIds.has(finalStudentId);

      const studentDocData = {
        schoolId: finalStudentId,
        firstName: stu.firstName,
        lastName: stu.lastName,
        displayName: stu.fullName,
        fullName: stu.fullName,
        role: "student",
        classCode: targetSec.classCode,
        section: targetSec.label,
        teacherId: currentTeacherId || "",
        providedEmail: stu.email || `${finalStudentId}@imars.edu`,
        email: stu.email || `${finalStudentId}@imars.edu`,
        avatarId: "scientist_01",
        active: true,
        updatedAt: serverTimestamp()
      };

      if (isNewStudent) {
        studentDocData.completedQuizzes = {};
        studentDocData.gamification = {
          badgeCounts: {
            AccuracyBadgeCount: 0,
            OnFireBadgeCount: 0
          }
        };
        studentDocData.createdAt = serverTimestamp();
      }

      await setDoc(doc(db, "users", finalStudentId), studentDocData, { merge: true });
      
      if (isNewStudent) {
        existingIds.add(finalStudentId);
        targetSec.count++;
      }
      importedCount++;
      savedList.push(`${stu.fullName} (${finalStudentId})`);
    }

    updateSelectedSection();
    closeImportModal();

    uploadStatus.textContent = `Successfully imported ${importedCount} student(s) to ${targetSec.label}! Students: ${savedList.slice(0, 4).join(", ")}${savedList.length > 4 ? "..." : ""}`;
    uploadStatus.hidden = false;

    // Reset dropzone
    importBtn.hidden = true;
    fileInput.value = "";
    document.getElementById("dropTitle").textContent = "Drag & drop your Excel file here";
    document.getElementById("dropHint").textContent = "or click to browse · .xlsx, .csv supported";
  } catch (err) {
    console.error("Batch import error:", err);
    alert("Error importing students: " + err.message);
  } finally {
    confirmImportBtn.disabled = false;
    confirmImportBtn.textContent = "Confirm Import";
  }
});
