// Presentation controls for the teacher navigation; account actions stay in teacher-nav.
const navigationDrawer = document.getElementById("drawer");
if (navigationDrawer) {
  const panel = navigationDrawer.querySelector(".drawer-panel");
  const brand = panel?.querySelector(".brand");
  if (panel && brand) {
    const svg = paths => `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
    const desktop = window.matchMedia("(min-width:1000px)");
    const hoverPointer = window.matchMedia("(hover:hover) and (pointer:fine)");
    let pointerInside = false;
    let collapseTimer;
    const updateCompact = () => {
      const focused = panel.contains(document.activeElement) && document.activeElement.matches(":focus-visible");
      navigationDrawer.classList.toggle("is-compact", desktop.matches && hoverPointer.matches && !pointerInside && !focused);
    };
    panel.addEventListener("pointerenter", () => { clearTimeout(collapseTimer); pointerInside = true; updateCompact(); });
    panel.addEventListener("pointerleave", () => { pointerInside = false; clearTimeout(collapseTimer); collapseTimer = setTimeout(updateCompact, 220); });
    panel.addEventListener("focusin", updateCompact);
    panel.addEventListener("focusout", () => queueMicrotask(updateCompact));
    hoverPointer.addEventListener("change", updateCompact);
    const syncLayout = () => {
      updateCompact();
      navigationDrawer.setAttribute("aria-hidden", String(!desktop.matches && !navigationDrawer.classList.contains("open")));
    };
    desktop.addEventListener("change", syncLayout);
    new MutationObserver(() => {
      const hidden = String(!desktop.matches && !navigationDrawer.classList.contains("open"));
      if (navigationDrawer.getAttribute("aria-hidden") !== hidden) navigationDrawer.setAttribute("aria-hidden", hidden);
    }).observe(navigationDrawer, { attributes:true, attributeFilter:["aria-hidden", "class"] });
    document.getElementById("menuBtn")?.addEventListener("click", event => {
      if (!desktop.matches) return;
      event.stopImmediatePropagation();
      pointerInside = true;
      updateCompact();
    }, true);
    syncLayout();

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
