const teachers = [
  { name: "Ma'am Reyes", email: "reyes@arlearn.edu.ph", subject: "Science", joined: "Jun 2, 2026", sections: ["Grade 8 – Malinao", "Grade 8 – Sampaguita"], students: 42, pre: 65, post: 88, hours: 320, active: true },
  { name: "Sir Bautista", email: "bautista@arlearn.edu.ph", subject: "Science", joined: "Jun 5, 2026", sections: ["Grade 8 – Rosal"], students: 38, pre: 60, post: 82, hours: 275, active: true },
  { name: "Ma'am Santos", email: "santos@arlearn.edu.ph", subject: "Biology", joined: "Jun 5, 2026", sections: ["Grade 9 – Narra", "Grade 9 – Acacia"], students: 45, pre: 58, post: 79, hours: 290, active: true },
  { name: "Sir Lim", email: "lim@arlearn.edu.ph", subject: "Physics", joined: "Jun 10, 2026", sections: ["Grade 10 – Molave"], students: 30, pre: 70, post: 91, hours: 210, active: false }
];

const list = document.getElementById("teacherList");
const search = document.getElementById("teacherSearch");
const noTeachers = document.getElementById("noTeachers");
const dialog = document.getElementById("teacherDialog");
const form = document.getElementById("teacherForm");

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[char]));

const initials = (name) => name.trim().split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase();

function render() {
  const query = search.value.trim().toLowerCase();
  const visible = teachers.map((teacher, index) => ({ teacher, index })).filter(({ teacher }) => {
    const searchable = [teacher.name, teacher.email, teacher.subject, ...teacher.sections].join(" ").toLowerCase();
    return searchable.includes(query);
  });

  document.getElementById("activeCount").textContent = teachers.filter((teacher) => teacher.active).length;
  document.getElementById("inactiveCount").textContent = teachers.filter((teacher) => !teacher.active).length;
  document.getElementById("teacherSummary").textContent = `${teachers.filter((teacher) => teacher.active).length} active · ${teachers.length} total`;
  document.getElementById("sectionCount").textContent = new Set(teachers.flatMap((teacher) => teacher.sections)).size;
  document.getElementById("studentCount").textContent = teachers.reduce((sum, teacher) => sum + teacher.students, 0);
  const teacherCountLabel = document.querySelector(".teacher-count");
  if (teacherCountLabel) teacherCountLabel.textContent = `${teachers.length} teachers`;

  list.innerHTML = visible.map(({ teacher, index }) => `
    <article class="teacher-record">
      <div class="teacher-record-top">
        <div class="teacher-profile">
          <span class="record-avatar ${teacher.active ? "" : "inactive"}">${escapeHtml(initials(teacher.name))}</span>
          <div class="teacher-info">
            <div class="teacher-name-line">
              <strong>${escapeHtml(teacher.name)}</strong>
              <span class="teacher-status ${teacher.active ? "" : "inactive"}">${teacher.active ? "active" : "inactive"}</span>
            </div>
            <small class="teacher-contact">${escapeHtml(teacher.email)} · ${escapeHtml(teacher.subject)} · Joined ${escapeHtml(teacher.joined)}</small>
            <div class="section-chips">${teacher.sections.map((section) => `<span class="section-chip">${escapeHtml(section)}</span>`).join("")}</div>
          </div>
        </div>
        <div class="teacher-stats" aria-label="${escapeHtml(teacher.name)} performance">
          <div class="teacher-stat"><small>Students</small><strong>${teacher.students}</strong></div>
          <div class="teacher-stat"><small>Pre-Test</small><strong>${teacher.pre}%</strong></div>
          <div class="teacher-stat"><small>Post-Test</small><strong>${teacher.post}%</strong></div>
          <div class="teacher-stat"><small>AR hrs</small><strong>${teacher.hours}h</strong></div>
          <div class="teacher-actions">
            <button class="record-action ${teacher.active ? "deactivate" : "activate"}" type="button" data-toggle-teacher="${index}" aria-label="${teacher.active ? "Deactivate" : "Activate"} ${escapeHtml(teacher.name)}" title="${teacher.active ? "Deactivate" : "Activate"}">
              ${teacher.active
                ? `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="m6 18 12-12"/></svg>`
                : `<svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg>`}
            </button>
            <button class="record-action delete" type="button" data-delete-teacher="${index}" aria-label="Remove ${escapeHtml(teacher.name)}" title="Remove teacher">
              <svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3m3 0-.8 13H6.8L6 7m4 4v5m4-5v5"/></svg>
            </button>
          </div>
        </div>
      </div>
      <div class="teacher-progress">
        <div class="teacher-progress-item">
          <div class="progress-label"><span>Avg Pre-Test</span><strong>${teacher.pre}%</strong></div>
          <div class="progress-track"><i style="width:${Math.max(0, Math.min(100, teacher.pre))}%"></i></div>
        </div>
        <div class="teacher-progress-item post">
          <div class="progress-label"><span>Avg Post-Test</span><strong>${teacher.post}%</strong></div>
          <div class="progress-track"><i style="width:${Math.max(0, Math.min(100, teacher.post))}%"></i></div>
        </div>
      </div>
    </article>
  `).join("");

  noTeachers.hidden = visible.length !== 0;
}

search.addEventListener("input", render);
list.addEventListener("click", (event) => {
  const toggleButton = event.target.closest("[data-toggle-teacher]");
  if (toggleButton) {
    const teacher = teachers[Number(toggleButton.dataset.toggleTeacher)];
    if (teacher) teacher.active = !teacher.active;
    render();
    return;
  }

  const deleteButton = event.target.closest("[data-delete-teacher]");
  if (deleteButton) {
    const index = Number(deleteButton.dataset.deleteTeacher);
    const teacher = teachers[index];
    if (teacher && window.confirm(`Remove ${teacher.name} from this preview?`)) {
      teachers.splice(index, 1);
      render();
    }
  }
});

document.getElementById("addTeacherButton").addEventListener("click", () => dialog.showModal());
document.getElementById("closeTeacherDialog").addEventListener("click", () => dialog.close());
document.getElementById("cancelTeacherDialog").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
});
form.addEventListener("submit", (event) => {
  event.preventDefault();
  const formData = new FormData(form);
  const name = String(formData.get("name") || "").trim();
  const email = String(formData.get("email") || "").trim();
  const subject = String(formData.get("subject") || "").trim();
  const sections = String(formData.get("sections") || "").split(",").map((section) => section.trim()).filter(Boolean);
  if (!name || !email || !subject) return;

  teachers.unshift({
    name,
    email,
    subject,
    joined: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
    sections,
    students: 0,
    pre: 0,
    post: 0,
    hours: 0,
    active: true
  });
  form.reset();
  dialog.close();
  search.value = "";
  render();
});

render();
