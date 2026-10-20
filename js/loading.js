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

let indicator;
let hideScheduled = false;
function renderLoading({ active, message }) {
  if (!active) {
    if (!indicator) return;
    // Keep sequential reads in the same frame from flickering the status message.
    if (hideScheduled) return;
    hideScheduled = true;
    requestAnimationFrame(() => {
      hideScheduled = false;
      if (tracker.pendingCount || !indicator) return;
      indicator.hidden = true;
    });
    return;
  }
  if (!indicator) {
    indicator = document.createElement("div");
    indicator.id = "appLoadingIndicator";
    indicator.className = "app-loading-indicator";
    indicator.setAttribute("role", "status");
    indicator.setAttribute("aria-live", "polite");
    indicator.setAttribute("aria-atomic", "true");
    indicator.hidden = true;
    indicator.innerHTML = `
      <div class="app-loading-card">
        <img class="app-loading-logo" alt="" aria-hidden="true" />
        <p class="app-loading-title" id="appLoadingTitle"></p>
      </div>`;
    indicator.querySelector("img").src = new URL("../assets/imars-loader-transparent.png", import.meta.url).href;
    document.body.append(indicator);
  }
  indicator.querySelector("#appLoadingTitle").textContent = message?.title || "Loading your data…";
  indicator.hidden = false;
}

const tracker = createLoadingTracker(renderLoading, { delayMs: 150 });
export const startLoading = (message) => tracker.start(message);
export const withLoading = (operation, message) => tracker.run(operation, message);
