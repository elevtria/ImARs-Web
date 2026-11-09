// Presentation controls shared by the teacher and admin sidebars.
const navigationDrawer = document.getElementById("drawer");
if (navigationDrawer) {
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
    const hoverPointer = window.matchMedia("(hover:hover) and (pointer:fine)");
    let pointerInside = false;
    let keyboardNavigation = false;
    let collapseTimer;
    const updateCompact = () => {
      const focused = keyboardNavigation && panel.contains(document.activeElement) && document.activeElement.matches(":focus-visible");
      const compact = desktop.matches && hoverPointer.matches && !pointerInside && !focused;
      navigationDrawer.classList.toggle("is-compact", compact);
      if (compact) setAccountOpen(false);
    };
    const setPointerInside = inside => {
      if (inside === pointerInside) return;
      pointerInside = inside;
      clearTimeout(collapseTimer);
      if (inside) updateCompact();
      else collapseTimer = setTimeout(updateCompact, 220);
    };
    const resetHover = () => {
      pointerInside = false;
      keyboardNavigation = false;
      clearTimeout(collapseTimer);
      updateCompact();
    };
    panel.addEventListener("pointerenter", event => { if (event.pointerType !== "touch") setPointerInside(true); });
    panel.addEventListener("pointerleave", () => setPointerInside(false));
    // Pointerleave can be missed when the page, window or hit-tested element
    // changes. An outside pointer move must not leave the menu expanded.
    document.addEventListener("pointermove", event => {
      if (!desktop.matches || !hoverPointer.matches || event.pointerType === "touch") return;
      const wasKeyboardNavigation = keyboardNavigation;
      keyboardNavigation = false;
      setPointerInside(panel.contains(event.target));
      if (!pointerInside && wasKeyboardNavigation) updateCompact();
    }, { passive: true });
    document.addEventListener("pointerdown", event => {
      keyboardNavigation = false;
      if (desktop.matches && hoverPointer.matches) setPointerInside(panel.contains(event.target));
      updateCompact();
    }, { passive: true });
    document.addEventListener("pointerleave", () => setPointerInside(false));
    document.addEventListener("keydown", event => {
      if (event.key === "Tab") keyboardNavigation = true;
    });
    window.addEventListener("blur", resetHover);
    window.addEventListener("pagehide", resetHover);
    window.addEventListener("pageshow", resetHover);
    panel.addEventListener("focusin", updateCompact);
    panel.addEventListener("focusout", () => queueMicrotask(updateCompact));
    hoverPointer.addEventListener("change", resetHover);
    const syncDrawer = () => {
      const open = !desktop.matches && navigationDrawer.classList.contains("open");
      const hidden = !desktop.matches && !open;
      navigationDrawer.setAttribute("aria-hidden", String(hidden));
      navigationDrawer.inert = hidden;
      menuButton?.setAttribute("aria-expanded", String(open));
    };
    desktop.addEventListener("change", () => {
      navigationDrawer.classList.remove("open");
      resetHover();
      syncDrawer();
    });
    menuButton?.addEventListener("click", () => {
      navigationDrawer.classList.add("open");
      syncDrawer();
      brand.focus();
    });
    resetHover();
    syncDrawer();

    const close = document.createElement("button");
    close.type = "button";
    close.className = "nav-close";
    close.setAttribute("aria-label", "Close navigation");
    close.innerHTML = svg('<path d="m6 6 12 12M18 6 6 18"/>');
    panel.append(close);
    const closeNavigation = () => {
      navigationDrawer.classList.remove("open");
      setAccountOpen(false);
      syncDrawer();
      menuButton?.focus();
    };
    close.addEventListener("click", closeNavigation);
    navigationDrawer.addEventListener("click", event => {
      if (event.target === navigationDrawer) closeNavigation();
    });
    accountButton?.addEventListener("click", () => setAccountOpen(accountMenu?.hidden === true));
    document.addEventListener("click", event => {
      if (!event.target.closest(".account")) setAccountOpen(false);
    });
    document.addEventListener("keydown", event => {
      if (event.key !== "Escape") return;
      if (accountMenu && !accountMenu.hidden) {
        setAccountOpen(false);
        accountButton?.focus();
        return;
      }
      if (desktop.matches) {
        resetHover();
        if (panel.contains(document.activeElement)) document.activeElement.blur();
      } else if (navigationDrawer.classList.contains("open")) closeNavigation();
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
