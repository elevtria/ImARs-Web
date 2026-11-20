// Presentation controls shared by the teacher and admin sidebars.
const navigationDrawer = document.getElementById("drawer");
if (navigationDrawer) {
  const teacherNavigation = !document.body.classList.contains("admin-portal") && navigationDrawer.querySelector(".side-nav");
  if (teacherNavigation && !teacherNavigation.querySelector('a[href="leaderboard.html"]')) {
    const link = document.createElement("a");
    link.className = "nav-item";
    link.href = "leaderboard.html";
    if (/^\/leaderboard(?:\.html)?\/?$/.test(window.location.pathname)) {
      link.classList.add("active");
      link.setAttribute("aria-current", "page");
    }
    link.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3h8v6a4 4 0 0 1-8 0V3ZM8 5H4v2a4 4 0 0 0 4 4m8-6h4v2a4 4 0 0 1-4 4M12 13v5m-4 3h8m-7-3h6v3H9z"/></svg>Leaderboard';
    const records = teacherNavigation.querySelector('a[href="student-records.html"]');
    if (records) records.after(link);
    else teacherNavigation.append(link);
  }
  if (teacherNavigation && !teacherNavigation.querySelector('a[href="teacher-ar.html"]')) {
    const link = document.createElement("a");
    link.className = "nav-item";
    link.href = "teacher-ar.html";
    if (/^\/teacher-ar(?:\.html)?\/?$/.test(window.location.pathname)) { link.classList.add("active"); link.setAttribute("aria-current", "page"); }
    link.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke-width="1.8" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/><path d="m12 7 5 3v5l-5 3-5-3v-5zM7 10l5 3 5-3m-5 3v5"/></svg>AR Classroom';
    const scan = teacherNavigation.querySelector('a[href="sync-offline-results.html"]');
    if (scan) scan.before(link); else teacherNavigation.append(link);
  }
  const panel = navigationDrawer.querySelector(".drawer-panel");
  const brand = panel?.querySelector(".brand");
  if (panel && brand) {
    const menuButton = document.getElementById("menuBtn");
    const accountButton = document.getElementById("accountBtn");
    const accountMenu = document.getElementById("accountMenu");
    const setAccountOpen = open => {
      if (!accountMenu) return;
      accountMenu.hidden = !open;
      accountButton?.setAttribute("aria-expanded", String(open));
    };
    const svg = paths => `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
    const desktop = window.matchMedia("(min-width:1000px)");
    let hovering = desktop.matches && panel.matches(":hover");
    let keyboardFocus = false;
    const syncDrawer = () => {
      const expanded = desktop.matches && (hovering || (keyboardFocus && panel.contains(document.activeElement)));
      navigationDrawer.classList.toggle("is-compact", desktop.matches && !expanded);
      navigationDrawer.setAttribute("data-desktop-open", String(expanded));
      const open = !desktop.matches && navigationDrawer.classList.contains("open");
      const hidden = !desktop.matches && !open;
      navigationDrawer.setAttribute("aria-hidden", String(hidden));
      navigationDrawer.inert = hidden;
      menuButton?.setAttribute("aria-expanded", String(open));
    };
    const closeNavigation = (restoreFocus = false) => {
      const wasOpen = navigationDrawer.classList.contains("open");
      hovering = keyboardFocus = false;
      navigationDrawer.classList.remove("open");
      setAccountOpen(false);
      if (wasOpen && restoreFocus) menuButton?.focus();
      syncDrawer();
    };
    panel.addEventListener("pointerenter", event => {
      if (!desktop.matches || event.pointerType === "touch") return;
      hovering = true;
      syncDrawer();
    });
    const leavePanel = () => {
      if (!desktop.matches) return;
      hovering = false;
      setAccountOpen(false);
      syncDrawer();
    };
    panel.addEventListener("pointerleave", leavePanel);
    panel.addEventListener("pointercancel", leavePanel);
    panel.addEventListener("focusin", syncDrawer);
    panel.addEventListener("focusout", () => queueMicrotask(syncDrawer));
    document.addEventListener("pointerdown", event => {
      if (!desktop.matches) return;
      keyboardFocus = false;
      hovering = panel.contains(event.target);
      syncDrawer();
    });
    document.addEventListener("pointermove", event => {
      if (!desktop.matches || event.pointerType === "touch") return;
      const inside = panel.contains(event.target);
      if (inside === hovering) return;
      hovering = inside;
      if (!inside) setAccountOpen(false);
      syncDrawer();
    });
    desktop.addEventListener("change", () => closeNavigation());
    window.addEventListener("blur", () => closeNavigation());
    window.addEventListener("pagehide", () => { if (!desktop.matches) closeNavigation(); });
    window.addEventListener("pageshow", () => {
      if (!desktop.matches) { closeNavigation(); return; }
      hovering = panel.matches(":hover");
      syncDrawer();
    });
    menuButton?.addEventListener("click", () => {
      if (desktop.matches) return;
      navigationDrawer.classList.add("open");
      syncDrawer();
      brand.focus();
    });
    syncDrawer();

    const close = document.createElement("button");
    close.type = "button";
    close.className = "nav-close";
    close.setAttribute("aria-label", "Close navigation");
    close.innerHTML = svg('<path d="m6 6 12 12M18 6 6 18"/>');
    panel.append(close);
    close.addEventListener("click", () => closeNavigation(true));
    navigationDrawer.addEventListener("click", event => {
      if (event.target === navigationDrawer) closeNavigation(true);
      else if (!desktop.matches && event.target.closest(".nav-item[href], .brand[href]")) closeNavigation();
    });
    accountButton?.addEventListener("click", () => setAccountOpen(accountMenu?.hidden === true));
    document.addEventListener("click", event => {
      if (!event.target.closest(".account")) setAccountOpen(false);
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Tab") { keyboardFocus = true; syncDrawer(); return; }
      if (event.key !== "Escape") return;
      if (accountMenu && !accountMenu.hidden) {
        setAccountOpen(false);
        accountButton?.focus();
        return;
      }
      if (desktop.matches) closeNavigation();
      else if (navigationDrawer.classList.contains("open")) closeNavigation(true);
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

// Warm only a hovered destination's public code and styles. Loading a module
// with rel=prefetch does not run it or request that page's private data.
const warmedAssets = new Set(Array.from(document.querySelectorAll("script[src], link[rel='stylesheet']"), node => node.src || node.href));
let warmTimer;
function warmNavigation(link) {
  const connection = navigator.connection;
  if (connection?.saveData || ["slow-2g", "2g"].includes(connection?.effectiveType)) return;
  let assets;
  try { assets = JSON.parse(link.dataset.navAssets); } catch { return; }
  if (!Array.isArray(assets)) return;
  for (const asset of assets.slice(0, 12)) {
    if (warmedAssets.size >= 40 || !asset || typeof asset.href !== "string" || !["script", "style"].includes(asset.as)) continue;
    let url;
    try { url = new URL(asset.href, window.location.href); } catch { continue; }
    if (url.origin !== window.location.origin || !/^\/assets\/site-[a-f0-9]{20}\/(?:app|chunk|style)-[\w-]+\.(?:js|css)$/.test(url.pathname) || url.search || url.hash || warmedAssets.has(url.href)) continue;
    warmedAssets.add(url.href);
    const hint = document.createElement("link");
    hint.rel = "prefetch"; hint.as = asset.as; hint.href = url.href;
    hint.setAttribute("fetchpriority", "low");
    document.head.append(hint);
  }
}
document.addEventListener("pointerover", event => {
  const link = event.target.closest("a[data-nav-assets]");
  if (!link || link.contains(event.relatedTarget)) return;
  clearTimeout(warmTimer);
  warmTimer = setTimeout(() => warmNavigation(link), 120);
});
document.addEventListener("pointerout", event => {
  const link = event.target.closest("a[data-nav-assets]");
  if (link && !link.contains(event.relatedTarget)) clearTimeout(warmTimer);
});
document.addEventListener("focusin", event => {
  const link = event.target.closest("a[data-nav-assets]");
  if (link) warmNavigation(link);
});
window.addEventListener("pagehide", () => clearTimeout(warmTimer));

if (navigator.serviceWorker) {
  const register = () => navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch(() => {});
  if (document.readyState === "complete") void register();
  else window.addEventListener("load", register, { once: true });
}
