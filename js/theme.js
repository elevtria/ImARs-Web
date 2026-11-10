// Run in the head so the preferred palette is applied before the page paints.
(() => {
  const key = "imars-theme";
  const root = document.documentElement;
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  const valid = value => value === "dark" || value === "light";
  let preference;
  try { preference = localStorage.getItem(key); } catch { /* Storage may be disabled. */ }
  let toggle;

  function apply() {
    const dark = valid(preference) ? preference === "dark" : system.matches;
    root.dataset.theme = dark ? "dark" : "light";
    if (toggle) {
      toggle.setAttribute("aria-pressed", String(dark));
      toggle.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
      toggle.title = toggle.getAttribute("aria-label");
    }
  }
  apply();
  system.addEventListener("change", apply);
  window.addEventListener("storage", event => {
    if (event.key === key || event.key === null) {
      preference = event.newValue;
      apply();
    }
  });

  document.addEventListener("DOMContentLoaded", () => {
    toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "theme-toggle";
    toggle.innerHTML = '<svg class="theme-moon" aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z"/></svg><svg class="theme-sun" aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5"/></svg>';
    toggle.addEventListener("click", () => {
      if (root.classList.contains("theme-switching")) return;
      preference = root.dataset.theme === "dark" ? "light" : "dark";
      try { localStorage.setItem(key, preference); } catch { /* Keep the session choice. */ }
      if (!document.startViewTransition || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        apply();
        return;
      }

      root.classList.add("theme-switching");
      const transition = document.startViewTransition(apply);
      const finish = () => root.classList.remove("theme-switching");
      transition.finished.then(finish, finish);
    });
    const toolbar = document.querySelector(".topbar-right, .admin-topbar-right");
    if (toolbar) toolbar.prepend(toggle);
    else {
      toggle.classList.add("theme-toggle-floating");
      document.body.append(toggle);
    }
    apply();
  }, { once: true });
})();
