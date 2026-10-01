(() => {
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
