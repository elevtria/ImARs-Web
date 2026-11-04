import { initializeApp } from "./firebase-auth.js";
import { getAuth, onAuthStateChanged } from "./firebase-auth.js";
import { 
  getFirestore, 
  collection, 
  query, 
  where, 
  getDocs,
  getStudentPage,
  doc, 
  setDoc, 
  updateDoc, 
  arrayUnion, 
  checkStudentIds,
  serverTimestamp 
} from "./firebase-data.js";
import { showTeacherView, prepareTeacherCache } from "./teacher-view.js";
import { encodeView } from "./view-cache.js";
import { setLoadingState } from "./loading.js";

const app = initializeApp();
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
let sections = []; 
let selectedFile = null;
let parsedStudents = [];
let previewData = [];
let existingStudentIds = new Set();
let dbExistingStudentClassCodes = {};
let dbExistingNameOwners = {};  // normalized fullName -> Set of studentIds
let dbExistingEmailOwners = {}; // normalized email -> Set of studentIds
let dbExistingClaimedIds = new Set(); // studentIds that already claimed their account
const pendingCounts = new Map();

function formatSectionLabel(rawName) {
  const clean = String(rawName || "").trim().replace(/\s*[-–—]\s*/g, " – ");
  if (!clean) return "";
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
  renderSelectedCount();
  if (previewData.length > 0) {
    validateAllRows();
  }
  if (auth.currentUser) void refreshSelectedCount(auth.currentUser);
}

sectionSelect.addEventListener("change", updateSelectedSection);

function renderSelectedCount() {
  const count = sections.find(item => item.classCode === sectionSelect.value)?.count;
  existingCountEl.textContent = Number.isSafeInteger(count) ? `(${count} existing ${count === 1 ? "student" : "students"})` : "";
}

async function refreshSelectedCount(user) {
  const selected = sections.find(item => item.classCode === sectionSelect.value);
  if (!selected || (selected.countCheckedAt && Date.now() - selected.countCheckedAt < 60000)) return;
  const cache = prepareTeacherCache(app, user), version = cache.version();
  const key = user.uid + ":" + version + ":" + selected.classCode;
  if (pendingCounts.has(key)) return pendingCounts.get(key);
  const pending = (async () => {
    try {
      const result = await getStudentPage({ sectionId: selected.classCode, includeStudents: false });
      if (auth.currentUser?.uid !== user.uid || cache.version() !== version) return;
      const section = sections.find(item => item.classCode === selected.classCode);
      const count = result.counts?.find(item => item.classId === selected.classCode);
      if (!section || !count) return;
      section.count = count.active + count.archived;
      section.countCheckedAt = Date.now();
      cache.put(user.uid, "batch-upload", encodeView({ teacherId: currentTeacherId, sections }), version);
      if (sectionSelect.value === section.classCode) renderSelectedCount();
    } catch (error) {
      if (auth.currentUser?.uid !== user.uid || cache.version() !== version) return;
      if ([401, 403].includes(error.status) || ["permission-denied", "unauthenticated"].includes(error.code)) {
        cache.invalidate(); sections = []; renderSections();
      }
      console.error("Could not update section total:", error);
    } finally { pendingCounts.delete(key); }
  })();
  pendingCounts.set(key, pending);
  return pending;
}

// --- LOAD TEACHER SECTIONS & STUDENT COUNTS FROM FIRESTORE ---
async function loadSectionsFromDB(user, { background = false } = {}) {
  try {
    const page = await getStudentPage({ includeStudents: false, includeCounts: "cached", includeTeacher: true });
    const teacher = page.teacherDoc;
    if (!teacher) throw Object.assign(new Error("No teacher profile was found for your account."), { code: "permission-denied" });
    const teacherId = teacher.id;
    const teacherData = teacher.data();

    const loadedSections = [];

    const teacherSections = Array.isArray(teacherData.sections)
      ? teacherData.sections.map(s => formatSectionLabel(s).toLowerCase()).filter(Boolean)
      : (teacherData.section ? [formatSectionLabel(teacherData.section).toLowerCase()] : []);

    for (const classDoc of page.classes) {
      const cData = classDoc.data();
      const rawName = cData.SectionName || cData.sectionName || cData.name || classDoc.id;
      const label = formatSectionLabel(rawName);
      if (!label) continue;

      if (teacherSections.length > 0 && !teacherSections.includes(label.toLowerCase())) {
        continue;
      }
      const count = page.counts?.find(item => item.classId === classDoc.id);
      const previous = currentTeacherId === teacherId ? sections.find(item => item.classCode === classDoc.id) : null;

      loadedSections.push({
        classCode: classDoc.id,
        rawName: rawName,
        label: label,
        count: count ? count.active + count.archived : previous?.count ?? null,
        countCheckedAt: count ? Date.now() : previous?.countCheckedAt || 0
      });
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
    render: data => {
      const sameOptions = JSON.stringify(sections.map(row => [row.classCode, row.label])) === JSON.stringify(data.sections.map(row => [row.classCode, row.label]));
      currentTeacherId = data.teacherId; sections = data.sections;
      if (sameOptions) { renderSelectedCount(); void refreshSelectedCount(user); }
      else renderSections();
    }
  }).catch(error => { 
    sectionNameEl.textContent = "Error loading data!";
    sectionSelect.innerHTML = `<option>Failed to load</option>`;
    alert("Script Error: " + error.message + "\n\nPlease clear your browser cache and refresh.");
    console.error(error); 
  });
});

// --- OFFICIAL TEMPLATE DOWNLOADS ---
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
    saveSectionBtn.setAttribute("aria-busy", "true");
  }

  try {
    let maxNum = 0;
    sections.forEach(s => {
      if (s.classCode) {
        const match = s.classCode.match(/^SCIG6A(\d+)$/);
        if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10));
      }
    });
    const classCode = `SCIG6A${(maxNum + 1).toString().padStart(2, '0')}`;

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
      count: 0,
      countCheckedAt: Date.now()
    });
    renderSections(classCode);
    closeSectionModal();
  } catch (err) {
    console.error("Error creating section:", err);
    alert("Failed to create section: " + err.message);
  } finally {
    if (saveSectionBtn) {
      saveSectionBtn.disabled = false;
      saveSectionBtn.setAttribute("aria-busy", "false");
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

function indexStudentRecord(docId, sData, fallbackClassCode = "") {
  if (!docId || !sData) return;
  const role = String(sData.role || "student").toLowerCase();
  if (role === "teacher" || role === "admin") return;

  const cleanId = String(docId).trim();
  existingStudentIds.add(cleanId);

  const cCode = String(sData.classCode || fallbackClassCode || "").trim();
  if (cCode) dbExistingStudentClassCodes[cleanId] = cCode;

  if (sData.isClaimed === true || sData.uid) {
    dbExistingClaimedIds.add(cleanId);
  }

  const possibleNames = [
    sData.fullName,
    sData.displayName,
    `${sData.firstName || ""} ${sData.lastName || ""}`
  ];
  for (const rawName of possibleNames) {
    const cleanName = String(rawName || "").trim().toLowerCase().replace(/\s+/g, " ");
    if (cleanName) {
      if (!dbExistingNameOwners[cleanName]) dbExistingNameOwners[cleanName] = new Set();
      dbExistingNameOwners[cleanName].add(cleanId);
    }
  }

  const possibleEmails = [sData.email, sData.providedEmail, sData.authEmail];
  for (const rawMail of possibleEmails) {
    const cleanEmail = String(rawMail || "").trim().toLowerCase();
    if (cleanEmail) {
      if (!dbExistingEmailOwners[cleanEmail]) dbExistingEmailOwners[cleanEmail] = new Set();
      dbExistingEmailOwners[cleanEmail].add(cleanId);
    }
  }
}

// Fetch ALL existing students across active and archived pages via getStudentPage
async function loadAllExistingStudentsForValidation(candidateIds) {
  existingStudentIds.clear();
  dbExistingStudentClassCodes = {};
  dbExistingNameOwners = {};
  dbExistingEmailOwners = {};
  dbExistingClaimedIds.clear();

  // 1. Check global ID existence via checkStudentIds
  if (candidateIds.length > 0) {
    try {
      const verifiedExisting = await checkStudentIds(candidateIds);
      for (const id of verifiedExisting) {
        existingStudentIds.add(String(id).trim());
      }
    } catch (err) {
      console.warn("checkStudentIds warning:", err);
    }
  }

  // 2. Paginate through getStudentPage with termId: "term_01" (required by /api/web-data!)
  for (const status of ["active", "archived"]) {
    let cursor = null;
    let safetyCounter = 0;
    let includeCounts = true;
    do {
      try {
        const page = await getStudentPage({
          sectionId: "",
          status,
          search: "",
          termId: "term_01",
          cursor,
          limit: 25,
          includeCounts
        });
        includeCounts = false;
        if (page && Array.isArray(page.students)) {
          for (const row of page.students) {
            if (row?.studentDoc) {
              indexStudentRecord(row.studentDoc.id, row.studentDoc.data(), row.classId);
            }
          }
        }
        cursor = page?.cursor || null;
        safetyCounter++;
      } catch (err) {
        console.warn(`getStudentPage (${status}) warning:`, err);
        break;
      }
    } while (cursor && safetyCounter < 40);
  }

  // 3. Also run the teacherId roster query as backup
  try {
    const teacherIdToQuery = currentTeacherId || "TEACH1000";
    const rosterQ = query(collection(db, "users"), where("teacherId", "==", teacherIdToQuery));
    const rosterSnap = await getDocs(rosterQ);
    rosterSnap.forEach(docSnap => indexStudentRecord(docSnap.id, docSnap.data()));
  } catch (err) {
    console.warn("Teacher roster backup query warning:", err);
  }

  console.log(
    `[Batch Upload Validator] Indexed ${existingStudentIds.size} IDs, ` +
    `${Object.keys(dbExistingNameOwners).length} unique names, ` +
    `${Object.keys(dbExistingEmailOwners).length} unique emails.`
  );
}

function validateTemplateHeaders(headerRow) {
  if (!Array.isArray(headerRow) || headerRow.length < 3) {
    return "Invalid template: Missing required columns (First Name, Last Name, Student ID, Email).";
  }
  const h0 = String(headerRow[0] ?? "").trim().toLowerCase();
  const h1 = String(headerRow[1] ?? "").trim().toLowerCase();
  const h2 = String(headerRow[2] ?? "").trim().toLowerCase();
  const h3 = String(headerRow[3] ?? "").trim().toLowerCase();

  const validFirst = h0.includes("first") || h0 === "firstname";
  const validLast = h1.includes("last") || h1 === "lastname";
  const validId = h2.includes("id") || h2.includes("student");
  const validEmail = !h3 || h3.includes("email") || h3.includes("mail");

  if (!validFirst || !validLast || !validId || !validEmail) {
    return `Unknown column header(s): [${headerRow.slice(0, 4).join(", ")}]. Expected: First Name, Last Name, Student ID, Email.`;
  }
  return null;
}

async function handleFileSelected(file) {
  selectedFile = file;
  previewData = [];
  uploadStatus.hidden = true;
  document.getElementById("previewSection").hidden = true;
  importBtn.hidden = true;

  const fileName = String(file.name || "").toLowerCase();
  if (!fileName.endsWith(".xlsx") && !fileName.endsWith(".xls") && !fileName.endsWith(".csv")) {
    document.getElementById("dropTitle").textContent = "Unsupported file format";
    document.getElementById("dropHint").textContent = "Please upload a valid .xlsx or .csv template file.";
    return;
  }

  const MAX_FILE_SIZE_MB = 5;
  if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
    document.getElementById("dropTitle").textContent = "File is too large";
    document.getElementById("dropHint").textContent = `Please limit your upload to ${MAX_FILE_SIZE_MB}MB.`;
    return;
  }

  let rows = [];
  try {
    document.getElementById("dropTitle").textContent = file.name;
    setLoadingState(document.getElementById("dropHint"), true, "Validating students");

    const data = await file.arrayBuffer();
    const workbook = window.XLSX.read(data, { type: "array", raw: false });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    rows = window.XLSX.utils.sheet_to_json(firstSheet, { header: 1, defval: "" });
  } catch (err) {
    console.error("Failed to parse file:", err);
    document.getElementById("dropTitle").textContent = "Error reading file";
    document.getElementById("dropHint").textContent = "Please upload a valid .xlsx or .csv file.";
    return;
  } finally { setLoadingState(document.getElementById("dropHint"), false); }

  if (!rows || rows.length <= 1) {
    document.getElementById("dropTitle").textContent = "Empty template file";
    document.getElementById("dropHint").textContent = "No student records were found in the uploaded file.";
    return;
  }

  const headerError = validateTemplateHeaders(rows[0]);
  if (headerError) {
    document.getElementById("dropTitle").textContent = "Invalid template columns";
    document.getElementById("dropHint").textContent = headerError;
    alert(headerError);
    return;
  }

  const MAX_ROWS = 100;
  if (rows.length > MAX_ROWS + 1) { 
    document.getElementById("dropTitle").textContent = "Too many records";
    document.getElementById("dropHint").textContent = `Limit uploads to ${MAX_ROWS} students at a time.`;
    return;
  }

  const normalizeUploadedId = (rawVal) => {
    const raw = String(rawVal ?? "").trim();
    if (/^\d{9}$/.test(raw)) return "0" + raw;
    return raw;
  };

  const candidateIds = rows.slice(1)
    .map(row => normalizeUploadedId(row[2]))
    .filter(id => /^[A-Za-z0-9_-]{1,128}$/.test(id));
  
  const uniqueCandidateIds = [...new Set(candidateIds)];
  await loadAllExistingStudentsForValidation(uniqueCandidateIds);

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.join("").trim() === "") continue;

    const firstName = String(row[0] ?? "").trim();
    const lastName = String(row[1] ?? "").trim();
    const studentId = normalizeUploadedId(row[2]);
    const email = String(row[3] ?? "").trim().toLowerCase();
    const fullName = `${firstName} ${lastName}`.trim();
    
    previewData.push({
      rowNum: i + 1,
      firstName,
      lastName,
      fullName,
      studentId,
      email,
      allowUpdate: false,
      isValid: false, 
      isExisting: false, 
      errors: []
    });
  }

  validateAllRows();
}

// --- GLOBAL TABLE VALIDATION ENGINE ---
function validateAllRows() {
  const idCounts = {};
  const nameCounts = {};
  const emailCounts = {};

  // 1. Scan the entire table to count in-file frequencies
  previewData.forEach(row => {
    const idKey = String(row.studentId || "").trim();
    if (idKey) idCounts[idKey] = (idCounts[idKey] || 0) + 1;
    if (row.fullName) {
      const nameKey = row.fullName.toLowerCase().replace(/\s+/g, " "); 
      nameCounts[nameKey] = (nameCounts[nameKey] || 0) + 1;
    }
    if (row.email) {
      const mailKey = row.email.trim().toLowerCase();
      emailCounts[mailKey] = (emailCounts[mailKey] || 0) + 1;
    }
  });

  const targetSecCode = String(sectionSelect.value).trim();

  // 2. Apply both in-file and database duplicate errors globally
  previewData.forEach(row => {
    let rowErrors = [];
    const cleanId = String(row.studentId || "").trim();
    const nameKey = row.fullName ? row.fullName.toLowerCase().replace(/\s+/g, " ") : "";
    const cleanEmail = row.email ? row.email.trim().toLowerCase() : "";
    
    const existsInDb = existingStudentIds.has(cleanId);
    const existingClassCode = dbExistingStudentClassCodes[cleanId] || "";
    const belongsToAnotherSection = existsInDb && existingClassCode !== "" && existingClassCode !== targetSecCode;

    row.isExisting = existsInDb && !belongsToAnotherSection;

    if (!row.firstName) rowErrors.push("Missing First Name");
    if (!row.lastName) rowErrors.push("Missing Last Name");
    
    // Student ID Checks
    if (!cleanId) {
      rowErrors.push("Missing Student ID");
    } else if (!/^\d+$/.test(cleanId)) {
      rowErrors.push("Invalid ID format (numbers only)");
    } else if (cleanId.length < 9 || cleanId.length > 10) {
      rowErrors.push("ID must be 9–10 digits");
    } else if (idCounts[cleanId] > 1) {
      rowErrors.push("Duplicate ID in file");
    } else if (belongsToAnotherSection) {
      rowErrors.push("Duplicate ID (belongs to another section)");
    } else if (existsInDb && !row.allowUpdate) {
      rowErrors.push("Duplicate ID (already in database)");
    }
    
    // Name Checks (In-file + Firestore Database)
    if (nameKey) {
      const ownerSet = dbExistingNameOwners[nameKey];
      if (nameCounts[nameKey] > 1) {
        rowErrors.push("Duplicate Name in file");
      } else if (ownerSet && ownerSet.size > 0) {
        const otherOwner = [...ownerSet].find(id => id !== cleanId);
        if (otherOwner) {
          rowErrors.push(`Duplicate Name (belongs to ID ${otherOwner})`);
        } else if (!row.allowUpdate) {
          rowErrors.push("Duplicate Name (already in database)");
        }
      }
    }
    
    // Email Checks (In-file + Firestore Database)
    if (!cleanEmail) {
      rowErrors.push("Missing Email");
    } else {
      const ownerSet = dbExistingEmailOwners[cleanEmail];
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
        rowErrors.push("Invalid email format");
      } else if (emailCounts[cleanEmail] > 1) {
        rowErrors.push("Duplicate Email in file");
      } else if (ownerSet && ownerSet.size > 0) {
        const otherOwner = [...ownerSet].find(id => id !== cleanId);
        if (otherOwner) {
          rowErrors.push(`Duplicate Email (belongs to ID ${otherOwner})`);
        } else if (!row.allowUpdate) {
          rowErrors.push("Duplicate Email (already in database)");
        }
      }
    }

    row.errors = [...new Set(rowErrors)];
    row.isValid = row.errors.length === 0;
  });

  renderPreviewTable();
}

function updateRowData(index, field, value) {
  const item = previewData[index];
  if (!item) return;
  if (field === "email") {
    item.email = value.trim().toLowerCase();
  } else if (field === "studentId") {
    const raw = value.trim();
    item.studentId = /^\d{9}$/.test(raw) ? "0" + raw : raw;
  } else if (field === "allowUpdate") {
    item.allowUpdate = Boolean(value);
  } else {
    item[field] = value.trim();
  }
  
  item.fullName = `${item.firstName} ${item.lastName}`.trim();
  validateAllRows(); 
}

function renderPreviewTable() {
  const tbody = document.getElementById("previewTableBody");
  tbody.innerHTML = "";
  
  let validCount = 0;
  let errorCount = 0;
  let duplicateCount = 0;
  let updateCount = 0;

  previewData.forEach((item, index) => {
    const hasDuplicateError = item.errors.some(e => e.toLowerCase().includes("duplicate"));
    if (hasDuplicateError) duplicateCount++;

    if (item.isValid) {
      validCount++;
      if (item.isExisting && item.allowUpdate) updateCount++;
    } else {
      errorCount++;
    }

    const tr = document.createElement("tr");
    tr.style.borderBottom = "1px solid #f1f5f9";
    
    let statusBadge = "";
    let statusColor = "";
    
    if (!item.isValid) {
      tr.style.backgroundColor = "#fef2f2"; 
      statusBadge = "⚠️ " + item.errors.join(" · ");
      statusColor = "#dc2626"; 
    } else if (item.isExisting && item.allowUpdate) {
      tr.style.backgroundColor = "#f0f9ff"; 
      statusBadge = "🔄 Approved Update";
      statusColor = "#0284c7"; 
    } else {
      statusBadge = "✓ Ready (New)";
      statusColor = "#16a34a"; 
    }
    
    const idHasError = item.errors.some(e => e.includes("ID") || e.includes("digits") || e.includes("section"));
    const nameHasError = item.errors.some(e => e.includes("Name"));
    const emailHasError = item.errors.some(e => e.includes("Email") || e.includes("email"));

    const updateToggleHtml = item.isExisting
      ? `<label style="display:inline-flex;align-items:center;gap:4px;margin-left:8px;font-size:0.78rem;color:#0284c7;cursor:pointer;font-weight:600;">
           <input type="checkbox" data-index="${index}" data-field="allowUpdate" ${item.allowUpdate ? "checked" : ""}> Allow Update
         </label>`
      : "";

    tr.innerHTML = `
      <td style="padding: 10px 8px; color: #64748b;">${item.rowNum}</td>
      <td style="padding: 10px 8px;">
        <input type="text" data-index="${index}" data-field="firstName" value="${item.firstName}" placeholder="First Name" style="width: 120px; border: 1px solid #cbd5e1; border-radius: 4px; padding: 4px; outline: none; background: transparent; ${nameHasError || !item.firstName ? 'border-color: #dc2626; color: #dc2626; font-weight: 600; background: #fff5f5;' : ''}">
      </td>
      <td style="padding: 10px 8px;">
        <input type="text" data-index="${index}" data-field="lastName" value="${item.lastName}" placeholder="Last Name" style="width: 120px; border: 1px solid #cbd5e1; border-radius: 4px; padding: 4px; outline: none; background: transparent; ${nameHasError || !item.lastName ? 'border-color: #dc2626; color: #dc2626; font-weight: 600; background: #fff5f5;' : ''}">
      </td>
      <td style="padding: 10px 8px;">
        <input type="text" data-index="${index}" data-field="studentId" value="${item.studentId}" placeholder="0026271000" style="width: 115px; border: 1px solid #cbd5e1; border-radius: 4px; padding: 4px; outline: none; background: transparent; ${idHasError ? 'border-color: #dc2626; color: #dc2626; font-weight: bold; background: #fff5f5;' : ''}">
      </td>
      <td style="padding: 10px 8px;">
        <input type="email" data-index="${index}" data-field="email" value="${item.email}" placeholder="Email Address" style="width: 170px; border: 1px solid #cbd5e1; border-radius: 4px; padding: 4px; outline: none; background: transparent; ${emailHasError ? 'border-color: #dc2626; color: #dc2626; font-weight: 600; background: #fff5f5;' : ''}">
      </td>
      <td style="padding: 10px 8px; color: ${statusColor}; font-size: 0.85rem; font-weight: 500;">
        <span>${statusBadge}</span>${updateToggleHtml}
      </td>
    `;
    tbody.appendChild(tr);
  });

  const inputs = tbody.querySelectorAll("input");
  inputs.forEach(input => {
    input.addEventListener("change", (e) => {
      const field = e.target.dataset.field;
      const val = field === "allowUpdate" ? e.target.checked : e.target.value;
      updateRowData(Number(e.target.dataset.index), field, val);
    });
  });

  document.getElementById("previewSection").hidden = false;
  
  let summaryText = `Found ${validCount} valid record(s)`;
  if (updateCount > 0) summaryText += ` (${updateCount} approved update(s))`;
  summaryText += `, ${errorCount} error(s)`;
  if (duplicateCount > 0) summaryText += ` (${duplicateCount} duplicate(s) flagged)`;
  summaryText += ".";
  
  document.getElementById("previewSummary").textContent = summaryText;
  
  const confirmBtn = document.getElementById("confirmPreviewBtn");
  if (validCount > 0 && errorCount === 0) {
    confirmBtn.disabled = false;
    confirmBtn.textContent = `Import/Update ${validCount} Record(s)`;
  } else {
    confirmBtn.disabled = true;
    confirmBtn.textContent = errorCount > 0 ? `Fix ${errorCount} Error(s) to Proceed` : "No valid records to import";
  }
  
  document.getElementById("dropTitle").textContent = selectedFile.name;
  document.getElementById("dropHint").textContent = "Review the table below. Edit any red highlighted cells or check 'Allow Update' for intentional updates.";
}

// --- IMPORT CONFIRMATION & FIRESTORE BATCH UPLOAD ---
const closeImportModal = () => importModal.classList.remove("open");

document.getElementById("confirmPreviewBtn").addEventListener("click", (event) => {
  event.stopPropagation();
  
  if (previewData.some(item => !item.isValid)) {
    alert("Please fix all highlighted duplicate or validation errors before proceeding.");
    return;
  }

  parsedStudents = previewData
    .filter(item => item.isValid)
    .map(item => ({
      firstName: item.firstName,
      lastName: item.lastName,
      fullName: item.fullName,
      studentId: item.studentId,
      email: item.email,
      isExisting: item.isExisting
    }));

  if (!selectedFile || parsedStudents.length === 0) return;

  const targetSec = sections.find((s) => s.classCode === sectionSelect.value);
  const secLabel = targetSec ? targetSec.label : sectionSelect.value;

  importSummary.textContent = `You are about to securely import/update ${parsedStudents.length} student(s) from “${selectedFile.name}” into ${secLabel}.`;
  
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
  confirmImportBtn.setAttribute("aria-busy", "true");

  try {
    let newCount = 0;
    let updateCount = 0;

    for (const stu of parsedStudents) {
      let finalStudentId = stu.studentId;
      const finalEmail = stu.email || `${finalStudentId}@imars.edu`;

      const strictUpdateData = {
        firstName: stu.firstName,
        lastName: stu.lastName,
        displayName: stu.fullName,
        fullName: stu.fullName,
        updatedAt: serverTimestamp()
      };

      if (!dbExistingClaimedIds.has(finalStudentId)) {
        strictUpdateData.email = finalEmail;
        strictUpdateData.providedEmail = finalEmail;
      }
      
      if (!stu.isExisting) {
        const newStudentData = {
          ...strictUpdateData,
          schoolId: finalStudentId,
          role: "student",
          teacherId: currentTeacherId || "",
          email: finalEmail,
          providedEmail: finalEmail,
          classCode: targetSec.classCode,
          section: targetSec.label,
          avatarId: "scientist_01",
          active: true,
          isClaimed: false,
          completedQuizzes: {},
          gamification: {
            badgeCounts: {
              AccuracyBadgeCount: 0,
              OnFireBadgeCount: 0,
              PerfectStreakBadgeCount: 0,
              QuizChampionBadgeCount: 0,
              StreakMasterBadgeCount: 0
            }
          },
          createdAt: serverTimestamp()
        };
        
        await setDoc(doc(db, "users", finalStudentId), newStudentData);
        if (Number.isSafeInteger(targetSec.count)) targetSec.count++;
        newCount++;
      } else {
        await updateDoc(doc(db, "users", finalStudentId), strictUpdateData);
        updateCount++;
      }
    }

    targetSec.countCheckedAt = 0;
    updateSelectedSection();
    closeImportModal();

    uploadStatus.textContent = `Successfully imported ${newCount} new and updated ${updateCount} existing student(s) in ${targetSec.label}!`;
    uploadStatus.hidden = false;

    document.getElementById("previewSection").hidden = true;
    importBtn.hidden = true;
    fileInput.value = "";
    document.getElementById("dropTitle").textContent = "Drag & drop your Excel file here";
    document.getElementById("dropHint").textContent = "or click to browse · .xlsx, .csv supported";
  } catch (err) {
    console.error("Batch import error:", err);
    alert("Error processing students: " + err.message);
  } finally {
    confirmImportBtn.disabled = false;
    confirmImportBtn.setAttribute("aria-busy", "false");
    confirmImportBtn.textContent = "Confirm Import";
  }
});
