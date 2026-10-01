const sectionSelect = document.getElementById("sectionSelect");
const sectionName = document.getElementById("sectionName");
const existingCount = document.getElementById("existingCount");
const sectionModal = document.getElementById("sectionModal");
const sectionForm = document.getElementById("sectionForm");
const newSectionName = document.getElementById("newSectionName");
const importModal = document.getElementById("importModal");
const importSummary = document.getElementById("importSummary");
const uploadStatus = document.getElementById("uploadStatus");
const fileInput = document.getElementById("fileInput");
const dropZone = document.getElementById("dropZone");
const browseBtn = document.getElementById("browseBtn");
const importBtn = document.getElementById("importBtn");

const defaultSections = [
  { name: "Grade 8 – Malinao", count: 6 },
  { name: "Grade 8 – Sampaguita", count: 0 },
];
const sectionsKey = "imars-upload-sections";
let sections = defaultSections;
let selectedFile = null;

try {
  const savedSections = JSON.parse(localStorage.getItem(sectionsKey) || "null");
  if (Array.isArray(savedSections)) {
    sections = defaultSections.map((item) => {
      const saved = savedSections.find((section) => section.name === item.name);
      return saved ? { ...item, ...saved } : item;
    });
    savedSections.forEach((section) => {
      if (!sections.some((item) => item.name === section.name)) sections.push(section);
    });
  }
} catch {
  sections = defaultSections;
}

const saveSections = () => {
  try {
    localStorage.setItem(sectionsKey, JSON.stringify(sections));
  } catch {
    // Section creation still works for the current page session when storage is unavailable.
  }
};

function renderSections(selectedName = sectionSelect.value) {
  sectionSelect.replaceChildren(
    ...sections.map((section) => {
      const option = document.createElement("option");
      option.value = section.name;
      option.textContent = section.name;
      return option;
    })
  );
  sectionSelect.value = sections.some((section) => section.name === selectedName)
    ? selectedName
    : sections[0].name;
  updateSelectedSection();
}

function updateSelectedSection() {
  const section = sections.find((item) => item.name === sectionSelect.value);
  sectionName.textContent = section?.name || sectionSelect.value;
  existingCount.textContent = `(${section?.count || 0} existing students)`;
}

renderSections();
sectionSelect.addEventListener("change", updateSelectedSection);

const csv = "Student Name,Section,LRN,Email\nAna Cruz,Grade 8 – Malinao,123456789012,ana@school.edu\n";
const download = (name, type, text) => {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
};

document.getElementById("dlCsv").onclick = () => download("student-batch-template.csv", "text/csv;charset=utf-8", csv);
document.getElementById("dlXlsx").onclick = () => {
  const xml = `<?xml version="1.0"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Worksheet ss:Name="Students"><Table>
  <Row><Cell><Data ss:Type="String">Student Name</Data></Cell><Cell><Data ss:Type="String">Section</Data></Cell><Cell><Data ss:Type="String">LRN</Data></Cell><Cell><Data ss:Type="String">Email</Data></Cell></Row>
  <Row><Cell><Data ss:Type="String">Ana Cruz</Data></Cell><Cell><Data ss:Type="String">Grade 8 – Malinao</Data></Cell><Cell><Data ss:Type="String">123456789012</Data></Cell><Cell><Data ss:Type="String">ana@school.edu</Data></Cell></Row>
 </Table></Worksheet>
</Workbook>`;
  download("student-batch-template.xls", "application/vnd.ms-excel", xml);
};

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
sectionForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = newSectionName.value.trim();
  if (!name) {
    newSectionName.setCustomValidity("Enter a section name.");
    newSectionName.reportValidity();
    return;
  }
  const duplicate = sections.some((section) => section.name.toLowerCase() === name.toLowerCase());
  if (duplicate) {
    newSectionName.setCustomValidity("That section already exists.");
    newSectionName.reportValidity();
    return;
  }

  sections.push({ name, count: 0 });
  saveSections();
  renderSections(name);
  closeSectionModal();
});

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
  if (file) showFile(file);
});
fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) showFile(fileInput.files[0]);
});

function showFile(file) {
  selectedFile = file;
  document.getElementById("dropTitle").textContent = file.name;
  document.getElementById("dropHint").textContent = "File selected · choose Confirm Import to continue";
  importBtn.hidden = false;
  uploadStatus.hidden = true;
}

const closeImportModal = () => importModal.classList.remove("open");
importBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  if (!selectedFile) return;
  importSummary.textContent = `You are about to import “${selectedFile.name}” to ${sectionSelect.value}.`;
  importModal.classList.add("open");
});
document.getElementById("cancelImport").addEventListener("click", closeImportModal);
importModal.addEventListener("click", (event) => {
  if (event.target === importModal) closeImportModal();
});
document.getElementById("confirmImport").addEventListener("click", () => {
  if (!selectedFile) return;
  closeImportModal();
  uploadStatus.textContent = `Import confirmation recorded for ${selectedFile.name}. Uploaded rows are not saved by this prototype.`;
  uploadStatus.hidden = false;
});
