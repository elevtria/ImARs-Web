(() => {
  const sideNav = document.querySelector(".side-nav");
  if (sideNav && !sideNav.querySelector('a[href="quiz-generator.html"]')) {
    const quizLink = document.createElement("a");
    quizLink.className = "nav-item";
    quizLink.href = "quiz-generator.html";
    quizLink.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke-width="1.8"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h5M8 16h8"/><path d="m15 11 1.5 1.5L19 10"/></svg>';
    quizLink.append("Quiz Generator");
    const schedulerLink = sideNav.querySelector('a[href="topic-scheduler.html"]');
    if (schedulerLink) schedulerLink.after(quizLink);
    else sideNav.append(quizLink);
  }

  const drawer = document.getElementById("drawer");
  const menuBtn = document.getElementById("menuBtn");
  if (drawer && menuBtn) {
    menuBtn.onclick = () => {
      drawer.classList.add("open");
      drawer.setAttribute("aria-hidden", "false");
    };
    drawer.onclick = (e) => {
      if (e.target === drawer) {
        drawer.classList.remove("open");
        drawer.setAttribute("aria-hidden", "true");
      }
    };
  }

  const accountBtn = document.getElementById("accountBtn");
  const accountMenu = document.getElementById("accountMenu");
  if (accountBtn && accountMenu) {
    accountBtn.onclick = (e) => {
      e.stopPropagation();
      accountMenu.hidden = !accountMenu.hidden;
    };
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".account")) accountMenu.hidden = true;
    });
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
