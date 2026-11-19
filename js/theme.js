// Run in the head so the preferred palette is applied before the page paints.
(() => {
  const key = "imars-theme";
  const root = document.documentElement;
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  const valid = value => value === "dark" || value === "light";
  let preference;
  try { preference = localStorage.getItem(key); } catch { /* Storage may be disabled. */ }
  let toggle, switchTimer, transition, animation, revision = 0;

  function apply() {
    const dark = valid(preference) ? preference === "dark" : system.matches;
    root.dataset.theme = dark ? "dark" : "light";
    if (toggle) {
      toggle.setAttribute("aria-pressed", String(dark));
      toggle.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
      toggle.title = toggle.getAttribute("aria-label");
    }
  }

  function finishSwitch() {
    revision++;
    clearTimeout(switchTimer);
    const previous = transition;
    transition = null;
    previous?.skipTransition();
    animation?.cancel();
    animation = null;
    root.classList.remove("theme-switching");
    root.classList.remove("theme-fading");
    root.style.removeProperty("--theme-switch-canvas");
    delete root.dataset.themeFrom;
    delete root.dataset.themeReveal;
  }
  function spreadFrames(x, y, radius) {
    return Array.from({ length: 9 }, (_, frame) => {
      const progress = frame / 8;
      const points = Array.from({ length: 96 }, (_, index) => {
        const angle = index * Math.PI / 48;
        const edge = .85 + .07 * Math.sin(5 * angle + progress * 1.2)
          + .04 * Math.cos(9 * angle - progress * .8) + .025 * Math.sin(13 * angle);
        const reach = radius * progress * edge;
        return `${(x + Math.cos(angle) * reach).toFixed(1)}px ${(y + Math.sin(angle) * reach).toFixed(1)}px`;
      });
      return { clipPath: `polygon(${points.join(",")})` };
    });
  }
  function fade() {
    root.classList.add("theme-fading");
    apply();
    switchTimer = setTimeout(finishSwitch, 300);
  }
  window.addEventListener("pagehide", finishSwitch);
  apply();
  system.addEventListener("change", () => { finishSwitch(); apply(); });
  window.addEventListener("storage", event => {
    if (event.key === key || event.key === null) {
      finishSwitch();
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
      const interrupted = Boolean(transition);
      const next = (valid(preference) ? preference : root.dataset.theme) === "dark" ? "light" : "dark";
      finishSwitch();
      const from = root.dataset.theme;
      preference = next;
      try { localStorage.setItem(key, preference); } catch { /* Keep the session choice. */ }
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        apply();
        return;
      }
      if (interrupted || !document.startViewTransition || !root.animate) { fade(); return; }
      const dark = preference === "dark";
      const bounds = toggle.getBoundingClientRect();
      const x = bounds.left + bounds.width / 2, y = bounds.top + bounds.height / 2;
      const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y)) * 1.6 + 32;
      const frames = spreadFrames(x, y, radius);
      // Keep an opaque outgoing canvas and its native color-scheme until the
      // reveal finishes. The old page stays visible beneath the growing mask.
      root.style.setProperty("--theme-switch-canvas", from === "dark" ? "#101824" : "#e9f5ff");
      root.dataset.themeFrom = from;
      root.dataset.themeReveal = dark ? "spread" : "retract";
      root.classList.add("theme-switching");
      const current = revision;
      const complete = () => { if (revision === current) finishSwitch(); };
      try {
        transition = document.startViewTransition(apply);
        transition.ready.then(() => {
          if (revision !== current) return;
          animation = root.animate(dark ? frames : frames.slice().reverse(), {
            duration: 1100, easing: "cubic-bezier(.4,0,.2,1)", fill: "both",
            pseudoElement: dark ? "::view-transition-new(root)" : "::view-transition-old(root)"
          });
          animation.finished.then(complete, complete);
        }).catch(() => { if (revision === current) { apply(); complete(); } });
        transition.finished.then(complete, complete);
        switchTimer = setTimeout(() => { if (revision === current) { apply(); complete(); } }, 2600);
      } catch {
        finishSwitch();
        fade();
      }
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
