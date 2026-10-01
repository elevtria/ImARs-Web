const teacherResults = [
  { name: "Ma'am Reyes", initials: "MR", sections: "Grade 8 – Malinao, Grade 8 – Sampaguita", pre: 65, post: 88, color: "#7048ff" },
  { name: "Sir Bautista", initials: "SB", sections: "Grade 8 – Rosal", pre: 60, post: 82, color: "#ec168d" },
  { name: "Ma'am Santos", initials: "MS", sections: "Grade 9 – Narra, Grade 9 – Acacia", pre: 58, post: 79, color: "#12a8df" },
  { name: "Sir Lim", initials: "SL", sections: "Grade 10 – Molave", pre: 70, post: 91, color: "#10b981" }
];

const sectionResults = [
  { name: "Grade 8 – Malinao", students: 6, pre: 65, post: 88, color: "#7048ff" },
  { name: "Grade 8 – Sampaguita", students: 2, pre: 60, post: 85, color: "#ec168d" },
  { name: "Grade 8 – Rosal", students: 1, pre: 80, post: 90, color: "#12a8df" },
  { name: "Grade 9 – Narra", students: 1, pre: 60, post: 100, color: "#10b981" }
];

const teacherContainer = document.getElementById("teacherAnalytics");
const sectionContainer = document.getElementById("sectionAnalytics");

teacherContainer.innerHTML = teacherResults.map((teacher) => {
  const gain = teacher.post - teacher.pre;
  return `
    <article class="teacher-analytics-card" style="--teacher-color:${teacher.color};--score:${teacher.post}%">
      <span class="analytics-avatar">${teacher.initials}</span>
      <h2 class="analytics-teacher-name">${teacher.name}</h2>
      <p class="analytics-teacher-sections">${teacher.sections}</p>
      <div class="analytics-donut" role="img" aria-label="${teacher.post} percent average post-test">
        <div class="analytics-donut-inner" aria-hidden="true"></div>
      </div>
      <strong class="analytics-post-score">${teacher.post}%</strong>
      <span class="analytics-post-label">avg post-test</span>
      <div class="analytics-card-footer"><span>Pre: <strong>${teacher.pre}%</strong></span><span class="teacher-gain">+${gain}% gain</span></div>
    </article>
  `;
}).join("");

sectionContainer.innerHTML = sectionResults.map((section) => {
  const gain = section.post - section.pre;
  return `
    <article class="section-analytics-card" style="--section-color:${section.color}">
      <div class="section-title-row">
        <span class="section-color-dot" aria-hidden="true"></span>
        <h2>${section.name}</h2>
        <span class="section-student-count">${section.students} ${section.students === 1 ? "student" : "students"}</span>
        <span class="section-improvement">+${gain}% improvement</span>
      </div>
      <div class="section-meter">
        <div class="section-meter-head"><span>Pre-Test Average</span><strong>${section.pre}%</strong></div>
        <div class="section-meter-track"><i style="width:${section.pre}%"></i></div>
      </div>
      <div class="section-meter post">
        <div class="section-meter-head"><span>Post-Test Average</span><strong>${section.post}%</strong></div>
        <div class="section-meter-track"><i style="width:${section.post}%"></i></div>
      </div>
    </article>
  `;
}).join("");

const viewButtons = [...document.querySelectorAll("[data-view]")];

function setAnalyticsView(view) {
  const showTeachers = view === "teachers";

  viewButtons.forEach((button) => {
    const selected = button.dataset.view === view;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });

  teacherContainer.hidden = !showTeachers;
  sectionContainer.hidden = showTeachers;
  // Set explicit display values too, so the panels switch reliably with the hidden state.
  teacherContainer.style.display = showTeachers ? "grid" : "none";
  sectionContainer.style.display = showTeachers ? "none" : "grid";
}

viewButtons.forEach((button) => {
  button.addEventListener("click", () => setAnalyticsView(button.dataset.view));
});

setAnalyticsView("teachers");
