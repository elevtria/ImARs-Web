const rows = [...document.querySelectorAll(".student-row")];
const empty = document.getElementById("emptyState");
const search = document.getElementById("studentSearch");
const sectionFilter = document.getElementById("sectionFilter");
const sectionSummary = document.getElementById("sectionSummary");
const studentCount = document.getElementById("studentCount");

const sectionLabels = new Map(
  [...sectionFilter.options].map((option) => [option.value, option.textContent])
);

const filterStudents = () => {
  const query = search.value.trim().toLowerCase();
  const selectedSection = sectionFilter.value;
  let shown = 0;

  rows.forEach((row) => {
    const matchesName = row.dataset.name.includes(query);
    const matchesSection = selectedSection === "all" || row.dataset.section === selectedSection;
    const visible = matchesName && matchesSection;
    row.classList.toggle("hidden", !visible);
    if (visible) shown += 1;
  });

  studentCount.textContent = shown;
  sectionSummary.textContent = sectionLabels.get(selectedSection) || "All Sections";
  empty.hidden = shown > 0;
};

search.addEventListener("input", filterStudents);
sectionFilter.addEventListener("change", filterStudents);
