(() => {
  const sideNav = document.querySelector(".side-nav");
  const navigationPath = link => {
    try {
      const url = new URL(link.href, window.location.href);
      return url.origin === window.location.origin ? url.pathname.replace(/\.html\/?$/, "").replace(/\/$/, "") : "";
    } catch { return ""; }
  };
  const quizLinks = sideNav ? [...sideNav.querySelectorAll("a[href]")].filter(link => navigationPath(link) === "/quiz-generator") : [];
  const quizEntry = quizLinks.find(link => link.classList.contains("active")) || quizLinks[0];
  for (const duplicate of quizLinks) if (duplicate !== quizEntry) duplicate.remove();
  if (sideNav && !quizEntry) {
    const quizLink = document.createElement("a");
    quizLink.className = "nav-item";
    quizLink.href = "quiz-generator.html";
    quizLink.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke-width="1.8"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h5M8 16h8"/><path d="m15 11 1.5 1.5L19 10"/></svg>';
    quizLink.append("Quiz Generator");
    const schedulerLink = [...sideNav.querySelectorAll("a[href]")].find(link => navigationPath(link) === "/topic-scheduler");
    if (schedulerLink) schedulerLink.after(quizLink);
    else sideNav.append(quizLink);
  }

  const helpBtn = document.getElementById("helpBtn");
  if (helpBtn && !document.getElementById("manual")) {
    helpBtn.onclick = () => {
      window.location.href = "teacher-manual.html";
    };
  }

  const closeScan = document.getElementById("closeScan");
  const scanModal = document.getElementById("scanModal");
  if (closeScan && scanModal) {
    closeScan.onclick = () => scanModal.classList.remove("open");
    scanModal.onclick = (e) => {
      if (e.target === scanModal) scanModal.classList.remove("open");
    };
  }
})();
