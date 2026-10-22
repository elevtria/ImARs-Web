// Presentation controls for the teacher navigation; account actions stay in teacher-nav.
const navigationDrawer = document.getElementById("drawer");
if (navigationDrawer) {
  const panel = navigationDrawer.querySelector(".drawer-panel");
  const brand = panel?.querySelector(".brand");
  if (panel && brand) {
    const svg = paths => `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
    const collapse = document.createElement("button");
    collapse.type = "button";
    collapse.className = "nav-collapse";
    collapse.setAttribute("aria-label", "Collapse navigation labels");
    collapse.setAttribute("aria-expanded", "true");
    collapse.innerHTML = svg('<path d="m14 6-6 6 6 6"/>');
    brand.append(collapse);
    collapse.addEventListener("click", () => {
      const compact = navigationDrawer.classList.toggle("is-compact");
      collapse.setAttribute("aria-expanded", String(!compact));
      collapse.setAttribute("aria-label", compact ? "Expand navigation labels" : "Collapse navigation labels");
    });
    const close = document.createElement("button");
    close.type = "button";
    close.className = "nav-close";
    close.setAttribute("aria-label", "Close navigation");
    close.innerHTML = svg('<path d="m6 6 12 12M18 6 6 18"/>');
    panel.append(close);
    const closeNavigation = () => {
      navigationDrawer.classList.remove("open");
      navigationDrawer.setAttribute("aria-hidden", "true");
      document.getElementById("menuBtn")?.focus();
    };
    close.addEventListener("click", closeNavigation);
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && navigationDrawer.classList.contains("open")) closeNavigation();
    });
    panel.querySelectorAll(".nav-item").forEach(link => {
      const label = Array.from(link.childNodes).filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join("").trim();
      const span = document.createElement("span");
      span.className = "nav-label";
      span.textContent = label;
      Array.from(link.childNodes).filter(node => node.nodeType === Node.TEXT_NODE).forEach(node => node.remove());
      link.append(span);
      link.title = label;
      link.setAttribute("aria-label", label);
      if (link.classList.contains("active")) link.setAttribute("aria-current", "page");
    });
  }
}
