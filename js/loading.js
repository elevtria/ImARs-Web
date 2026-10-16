export function createLoadingTracker(render, { delayMs = 0, schedule = setTimeout, cancel = clearTimeout } = {}) {
  const pending = new Set();
  let revealTimer = null;
  let visible = false;
  const reveal = () => {
    revealTimer = null;
    if (!pending.size) return;
    visible = true;
    render({ active: true, message: pending.values().next().value });
  };
  const notify = () => {
    if (!pending.size) {
      if (revealTimer !== null) cancel(revealTimer);
      revealTimer = null;
      visible = false;
      render({ active: false });
    } else if (visible || delayMs === 0) {
      reveal();
    } else if (revealTimer === null) {
      revealTimer = schedule(reveal, delayMs);
    }
  };
  return {
    get pendingCount() { return pending.size; },
    start(message) {
      const task = { ...message };
      pending.add(task);
      notify();
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        pending.delete(task);
        notify();
      };
    },
    async run(operation, message) {
      const finish = this.start(message);
      try {
        return await operation();
      } finally {
        finish();
      }
    }
  };
}

let overlay;
let hideScheduled = false;
function renderLoading({ active, message }) {
  if (!active) {
    if (!overlay) return;
    // Keep sequential reads in the same frame from closing and reopening the dialog.
    if (hideScheduled) return;
    hideScheduled = true;
    requestAnimationFrame(() => {
      hideScheduled = false;
      if (tracker.pendingCount || !overlay) return;
      overlay.close();
      overlay.hidden = true;
      overlay.setAttribute("aria-busy", "false");
    });
    return;
  }
  if (!overlay) {
    overlay = document.createElement("dialog");
    overlay.id = "appLoadingOverlay";
    overlay.className = "app-loading-overlay";
    overlay.setAttribute("aria-labelledby", "appLoadingTitle");
    overlay.setAttribute("aria-describedby", "appLoadingDetail");
    overlay.innerHTML = `
      <div class="app-loading-card" role="status" aria-live="polite" aria-atomic="true">
        <img class="app-loading-logo" alt="" aria-hidden="true" />
        <p class="app-loading-title" id="appLoadingTitle"></p>
        <p class="app-loading-detail" id="appLoadingDetail"></p>
        <span class="app-loading-dots" aria-hidden="true"><i></i><i></i><i></i></span>
      </div>`;
    overlay.querySelector("img").src = new URL("../assets/imars-loader-transparent.png", import.meta.url).href;
    overlay.addEventListener("cancel", (event) => event.preventDefault());
    document.body.append(overlay);
  }
  overlay.querySelector("#appLoadingTitle").textContent = message?.title || "Loading your data";
  overlay.querySelector("#appLoadingDetail").textContent = message?.detail || "Please wait while we fetch the latest information.";
  overlay.hidden = false;
  overlay.setAttribute("aria-busy", "true");
  if (!overlay.open) overlay.showModal();
}

const tracker = createLoadingTracker(renderLoading, { delayMs: 150 });
export const startLoading = (message) => tracker.start(message);
export const withLoading = (operation, message) => tracker.run(operation, message);
